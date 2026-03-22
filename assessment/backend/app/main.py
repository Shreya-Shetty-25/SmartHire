from datetime import datetime, timezone
from urllib.parse import quote_plus
from uuid import uuid4

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from loguru import logger
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import settings
from .db import assessment_engine, get_assessment_db, get_jobs_db, get_optional_jobs_db
from .models import AssessmentBase, ExamSession, Job, ProctorEvent
from .schemas import (
    ExamAccessRequest,
    ExamCreateRequest,
    ExamCreateResponse,
    ExamDetailsResponse,
    ExamQuestion,
    ExamResultResponse,
    ExamSubmitRequest,
    ExamSubmitResponse,
    FaceIdVerificationRequest,
    FaceIdVerificationResponse,
    JobOut,
    ProctorEventRequest,
    ProctorFrameRequest,
    SecondaryRegisterRequest,
    SecondaryStatusResponse,
    SecondaryUploadRequest,
)
from .services.proctoring import (
    analyze_frame,
    analyze_secondary_environment_frame,
    detect_audio_anomaly,
    get_secondary_stream_status,
    register_secondary_stream,
    verify_face_id_match,
)
from .services.question_generator import generate_questions

app = FastAPI(title="SmartHire Assessment API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _summarize_payload(payload: object, max_len: int = 420) -> str:
    if payload is None:
        return ""
    try:
        text = str(payload)
    except Exception:
        return ""
    text = " ".join(text.split())
    return text if len(text) <= max_len else f"{text[:max_len]}…"


# ---------------------------------------------------------------------------
# Email helper
# ---------------------------------------------------------------------------
import smtplib
from email.message import EmailMessage


def _send_email(*, to_email: str, subject: str, body: str) -> None:
    mode = (settings.email_mode or "log").strip().lower()
    if mode == "log":
        logger.info("Email (log mode): to={} subject={} body={}...", to_email, subject, body[:300])
        return
    if mode != "smtp":
        raise RuntimeError(f"Unsupported EMAIL_MODE: {settings.email_mode!r}")

    host = settings.smtp_host
    port = int(settings.smtp_port or 587)
    from_addr = settings.smtp_from
    username = settings.smtp_user
    password = settings.smtp_password

    if not host or not from_addr:
        raise RuntimeError("SMTP not configured (SMTP_HOST/SMTP_FROM missing)")

    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP(host=host, port=port, timeout=15) as server:
        if settings.smtp_tls:
            server.starttls()
        if username and password:
            server.login(username, password)
        server.send_message(msg)


def _send_result_email(session: ExamSession) -> str:
    """Send pass/fail email and return the type sent."""
    percentage = float(session.percentage or 0)
    name = (session.candidate_name or "Candidate").strip()
    job_title = (session.job_title or "the role").strip()

    if percentage >= 60:
        subject = f"SmartHire Assessment Result - Congratulations, {name}!"
        body = (
            f"Hi {name},\n\n"
            f"Congratulations! You have successfully passed the assessment for {job_title} "
            f"with a score of {session.score}/{session.total_questions} ({percentage:.0f}%).\n\n"
            f"Our team will call you shortly to proceed with the next round of interviews "
            f"(Technical + HR).\n\n"
            f"Please keep your phone available.\n\n"
            f"Best regards,\nSmartHire HR Team\n"
        )
        email_type = "pass"
    else:
        subject = f"SmartHire Assessment Result - {name}"
        body = (
            f"Hi {name},\n\n"
            f"Thank you for taking the assessment for {job_title}. "
            f"Your score was {session.score}/{session.total_questions} ({percentage:.0f}%).\n\n"
            f"Unfortunately, we will not be moving forward with your application at this time.\n\n"
            f"We appreciate your interest and encourage you to apply again in the future.\n\n"
            f"Best regards,\nSmartHire HR Team\n"
        )
        email_type = "fail"

    try:
        _send_email(to_email=session.candidate_email, subject=subject, body=body)
    except Exception as exc:
        logger.warning("Failed to send result email to {}: {}", session.candidate_email, exc)

    return email_type


# ---------------------------------------------------------------------------
# Azure LLM helper for result analysis and call
# ---------------------------------------------------------------------------
def _generate_result_analysis(session: ExamSession) -> dict:
    """Generate a detailed result analysis using Azure OpenAI or fallback."""
    questions = session.questions_json or []
    answers = session.answers_json or []
    answer_lookup = {item.get("question_id"): item.get("answer") for item in answers}

    correct_topics = []
    incorrect_topics = []
    for q in questions:
        q_text = q.get("question", "")[:100]
        user_ans = answer_lookup.get(q["id"], "")
        correct_ans = q.get("answer", "")
        if user_ans == correct_ans:
            correct_topics.append(q_text)
        else:
            incorrect_topics.append({"question": q_text, "user_answer": user_ans, "correct_answer": correct_ans})

    analysis = {
        "total_questions": len(questions),
        "correct": len(correct_topics),
        "incorrect": len(incorrect_topics),
        "percentage": round((len(correct_topics) / max(len(questions), 1)) * 100, 1),
        "correct_topics": correct_topics,
        "incorrect_details": incorrect_topics,
        "strengths": correct_topics[:5],
        "weaknesses": [i["question"] for i in incorrect_topics[:5]],
    }

    # Try to get LLM-based summary
    if settings.use_azure_openai and settings.azure_openai_endpoint and settings.azure_openai_api_key:
        try:
            endpoint = settings.azure_openai_endpoint.strip().rstrip("/")
            deployment = (settings.azure_openai_deployment or "").strip()
            url = (
                f"{endpoint}/openai/deployments/{deployment}/chat/completions"
                f"?api-version={settings.azure_openai_api_version}"
            )
            prompt = (
                f"Analyze this exam result for a {session.job_title or 'technical'} role:\n"
                f"Score: {session.score}/{len(questions)} ({analysis['percentage']}%)\n"
                f"Correct topics: {', '.join(correct_topics[:5])}\n"
                f"Incorrect topics: {', '.join([i['question'][:50] for i in incorrect_topics[:5]])}\n\n"
                f"Give a brief 2-3 sentence performance summary and key improvement areas."
            )
            resp = httpx.post(
                url,
                headers={"api-key": settings.azure_openai_api_key, "Content-Type": "application/json"},
                json={"messages": [{"role": "user", "content": prompt}], "max_completion_tokens": 300},
                timeout=30.0,
            )
            if resp.status_code < 400:
                data = resp.json()
                analysis["llm_summary"] = data["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            logger.warning("LLM analysis failed: {}", exc)

    return analysis


# ---------------------------------------------------------------------------
# Voice call helpers (Twilio + ElevenLabs + Azure LLM)
# ---------------------------------------------------------------------------
try:
    from twilio.rest import Client as TwilioClient
    from twilio.twiml.voice_response import VoiceResponse
except Exception:
    TwilioClient = None
    VoiceResponse = None


def _initiate_ai_call(session: ExamSession, assessment_db: Session) -> str | None:
    """Start an AI interview call to the candidate after passing the exam."""
    if TwilioClient is None:
        logger.warning("Twilio not installed, skipping AI call")
        return None

    account_sid = (settings.twilio_account_sid or "").strip()
    auth_token = (settings.twilio_auth_token or "").strip()
    from_number = (settings.twilio_from_number or "").strip()

    if not account_sid or not auth_token or not from_number:
        logger.warning("Twilio not configured, skipping AI call")
        return None

    # Look up phone from the main backend's candidate table if possible
    phone = None
    try:
        from .db import get_jobs_db, JobsSessionLocal
        if JobsSessionLocal is not None:
            jobs_db = JobsSessionLocal()
            try:
                from sqlalchemy import text
                row = jobs_db.execute(
                    text("SELECT phone_number FROM candidates WHERE LOWER(email) = :email LIMIT 1"),
                    {"email": session.candidate_email.lower()},
                ).first()
                if row and row[0]:
                    phone = str(row[0]).strip()
            finally:
                jobs_db.close()
    except Exception as exc:
        logger.warning("Could not look up phone for {}: {}", session.candidate_email, exc)

    if not phone:
        logger.warning("No phone number found for candidate {}, skipping AI call", session.candidate_email)
        return None

    base_url = (settings.public_call_base_url or "").strip().rstrip("/")
    if not base_url:
        logger.warning("PUBLIC_CALL_BASE_URL not configured, skipping AI call")
        return None

    twiml_url = (
        f"{base_url}/api/interview/twiml"
        f"?session_code={quote_plus(session.session_code)}"
        f"&name={quote_plus(session.candidate_name)}"
        f"&position={quote_plus(session.job_title or 'the role')}"
    )

    try:
        client = TwilioClient(account_sid, auth_token)
        call = client.calls.create(
            to=phone,
            from_=from_number,
            url=twiml_url,
            method="GET",
        )
        call_sid = str(call.sid)
        session.call_sid = call_sid
        session.call_status = "initiated"
        assessment_db.commit()
        logger.info("AI interview call initiated: sid={} to={}", call_sid, phone)
        return call_sid
    except Exception as exc:
        logger.warning("Failed to initiate AI call: {}", exc)
        return None


async def _generate_interview_line(*, turn: int, candidate_name: str, position: str, job_title: str, user_speech: str | None) -> str:
    """Generate the next AI interviewer utterance for Technical+HR round."""
    safe_name = (candidate_name or "there").strip() or "there"
    safe_pos = (position or "the role").strip()

    if not settings.use_azure_openai or not settings.azure_openai_endpoint:
        # Fallback
        lines = {
            1: f"Hello {safe_name}, this is the SmartHire AI interviewer. Congratulations on passing the assessment for {safe_pos}. Let me ask you a few technical and HR questions. First, can you tell me about your most challenging technical project?",
            2: f"That's interesting, {safe_name}. Now, can you explain how you handle tight deadlines and work pressure in a team environment?",
            3: f"Good answer. Here's a technical question: Can you walk me through how you would design a scalable API for a high-traffic application?",
            4: f"Nice approach, {safe_name}. What are your salary expectations and when would you be available to join?",
            5: f"Thank you {safe_name} for your time. That concludes our AI interview for {safe_pos}. Our team will review your responses and get back to you. Have a great day!",
        }
        return lines.get(turn, lines[5])

    endpoint = settings.azure_openai_endpoint.strip().rstrip("/")
    deployment = (settings.azure_openai_deployment or "").strip()
    url = (
        f"{endpoint}/openai/deployments/{deployment}/chat/completions"
        f"?api-version={settings.azure_openai_api_version}"
    )

    system = (
        "You are a professional AI interviewer conducting a combined Technical + HR phone interview. "
        "You speak naturally and concisely (2-3 sentences max). "
        "Ask one question at a time. Be warm but professional. "
        "Do not mention being an AI. Output plain text only, no emojis."
    )

    turn_instructions = {
        1: f"Greet {safe_name}, congratulate on passing the assessment for {safe_pos}, and ask about their most challenging technical project.",
        2: f"React to their answer: '{user_speech or 'no response'}'. Then ask an HR question about handling pressure and teamwork.",
        3: f"React to: '{user_speech or 'no response'}'. Ask a technical architecture/design question relevant to {safe_pos}.",
        4: f"React to: '{user_speech or 'no response'}'. Ask about salary expectations and availability to join.",
        5: f"React to: '{user_speech or 'no response'}'. Thank them warmly and say the team will review their responses. End the call.",
    }

    user_prompt = turn_instructions.get(turn, turn_instructions[5])

    try:
        resp = httpx.post(
            url,
            headers={"api-key": settings.azure_openai_api_key, "Content-Type": "application/json"},
            json={
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_prompt},
                ],
                "max_completion_tokens": 150,
            },
            timeout=30.0,
        )
        if resp.status_code < 400:
            data = resp.json()
            text = data["choices"][0]["message"]["content"].strip()
            if text:
                return text[:300]
    except Exception as exc:
        logger.warning("Azure interview line generation failed: {}", exc)

    # Fallback
    return await _generate_interview_line(turn=turn, candidate_name=candidate_name, position=position, job_title=job_title, user_speech=user_speech)


@app.on_event("startup")
def on_startup() -> None:
    AssessmentBase.metadata.create_all(bind=assessment_engine)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/assessment/stats")
def assessment_stats(assessment_db: Session = Depends(get_assessment_db)) -> dict:
    """Aggregated assessment statistics for the admin dashboard."""
    total_exams = assessment_db.scalar(select(func.count(ExamSession.id))) or 0
    total_submitted = assessment_db.scalar(
        select(func.count(ExamSession.id)).where(ExamSession.status == "submitted")
    ) or 0
    total_passed = assessment_db.scalar(
        select(func.count(ExamSession.id)).where(ExamSession.passed == 1)
    ) or 0
    total_failed = assessment_db.scalar(
        select(func.count(ExamSession.id)).where(ExamSession.passed == 0, ExamSession.status == "submitted")
    ) or 0
    avg_score = assessment_db.scalar(
        select(func.avg(ExamSession.percentage)).where(ExamSession.status == "submitted")
    )
    avg_score = round(float(avg_score), 1) if avg_score is not None else 0.0

    # recent exam sessions with scores
    recent_rows = assessment_db.execute(
        select(
            ExamSession.session_code,
            ExamSession.candidate_name,
            ExamSession.candidate_email,
            ExamSession.job_title,
            ExamSession.score,
            ExamSession.total_questions,
            ExamSession.percentage,
            ExamSession.passed,
            ExamSession.status,
            ExamSession.email_sent,
            ExamSession.call_status,
            ExamSession.submitted_at,
            ExamSession.created_at,
        )
        .order_by(ExamSession.created_at.desc())
        .limit(20)
    ).all()

    recent_exams = [
        {
            "session_code": r.session_code,
            "candidate_name": r.candidate_name,
            "candidate_email": r.candidate_email,
            "job_title": r.job_title,
            "score": r.score,
            "total": r.total_questions,
            "percentage": round(float(r.percentage), 1) if r.percentage is not None else None,
            "passed": bool(r.passed) if r.passed is not None else None,
            "status": r.status,
            "email_sent": r.email_sent,
            "call_status": r.call_status,
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in recent_rows
    ]

    return {
        "total_exams": total_exams,
        "total_submitted": total_submitted,
        "total_passed": total_passed,
        "total_failed": total_failed,
        "avg_score": avg_score,
        "recent_exams": recent_exams,
    }


@app.get("/api/jobs", response_model=list[JobOut])
def list_jobs(db: Session = Depends(get_jobs_db)) -> list[Job]:
    result = db.execute(select(Job).order_by(Job.id.desc()).limit(100))
    return list(result.scalars().all())


@app.post("/api/exams/create", response_model=ExamCreateResponse)
def create_exam(
    payload: ExamCreateRequest,
    jobs_db: Session | None = Depends(get_optional_jobs_db),
    assessment_db: Session = Depends(get_assessment_db),
) -> ExamCreateResponse:
    job_id = int(payload.job_id) if payload.job_id is not None else 0

    job_data: dict
    job: Job | None = None
    if jobs_db is not None and payload.job_id is not None:
        job = jobs_db.get(Job, payload.job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        job_data = {
            "id": job.id,
            "title": job.title,
            "description": job.description,
            "skills_required": job.skills_required,
            "additional_skills": job.additional_skills,
        }
        job_id = job.id
    else:
        title = (payload.job_title or "").strip()
        description = (payload.job_description or "").strip()
        if not title or not description:
            raise HTTPException(
                status_code=400,
                detail="Provide job_title and job_description when JOBS_DATABASE_URL is not configured",
            )
        job_data = {
            "id": job_id,
            "title": title,
            "description": description,
            "skills_required": payload.skills_required,
            "additional_skills": payload.additional_skills,
        }

    # Default to 10 hard questions
    question_count = payload.question_count or 10
    difficulty = payload.difficulty or "hard"

    generated = generate_questions(job_data, question_count, difficulty, payload.resume_skills)

    session_code = f"EXAM-{uuid4().hex[:10].upper()}"
    job_title = job_data.get("title", "")
    session = ExamSession(
        session_code=session_code,
        job_id=job_id,
        candidate_name=payload.candidate_name,
        candidate_email=payload.candidate_email,
        duration_minutes=payload.duration_minutes,
        status="created",
        questions_json=generated,
        total_questions=len(generated),
        job_title=job_title,
        resume_skills=payload.resume_skills,
    )
    assessment_db.add(session)
    assessment_db.commit()

    return ExamCreateResponse(
        session_code=session_code,
        exam_link=f"{settings.public_base_url.rstrip('/')}/assessment?code={session_code}",
        duration_minutes=payload.duration_minutes,
        questions=[ExamQuestion(id=q["id"], question=q["question"], options=q["options"]) for q in generated],
    )


@app.post("/api/exams/access", response_model=ExamDetailsResponse)
def access_exam(payload: ExamAccessRequest, assessment_db: Session = Depends(get_assessment_db)) -> ExamDetailsResponse:
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == payload.session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    if session.status == "created":
        session.status = "in_progress"
        session.started_at = datetime.now(timezone.utc)
        assessment_db.commit()

    return ExamDetailsResponse(
        session_code=session.session_code,
        candidate_name=session.candidate_name,
        duration_minutes=session.duration_minutes,
        status=session.status,
        questions=[ExamQuestion(id=q["id"], question=q["question"], options=q["options"]) for q in session.questions_json],
    )


@app.post("/api/exams/{session_code}/submit", response_model=ExamSubmitResponse)
def submit_exam(
    session_code: str,
    payload: ExamSubmitRequest,
    background: BackgroundTasks,
    assessment_db: Session = Depends(get_assessment_db),
) -> ExamSubmitResponse:
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    answer_lookup = {item.get("question_id"): item.get("answer") for item in payload.answers}
    total = len(session.questions_json)
    score = 0
    for question in session.questions_json:
        if answer_lookup.get(question["id"]) == question.get("answer"):
            score += 1

    percentage = round((score / max(total, 1)) * 100, 1)
    passed = percentage >= 60

    session.answers_json = payload.answers
    session.score = score
    session.total_questions = total
    session.percentage = percentage
    session.passed = 1 if passed else 0
    session.status = "submitted"
    session.submitted_at = datetime.now(timezone.utc)

    # Generate result analysis
    analysis = _generate_result_analysis(session)
    session.result_analysis = analysis

    assessment_db.commit()

    # Send result email in background
    def _background_post_exam(sc: str):
        db = assessment_db
        try:
            sess = db.execute(select(ExamSession).where(ExamSession.session_code == sc)).scalar_one_or_none()
            if not sess:
                return

            email_type = _send_result_email(sess)
            sess.email_sent = email_type
            db.commit()

            # If passed, initiate AI interview call
            if sess.passed:
                _initiate_ai_call(sess, db)
        except Exception as exc:
            logger.warning("Background post-exam task failed for {}: {}", sc, exc)

    background.add_task(_background_post_exam, session_code)

    # Log proctor report
    try:
        events = (
            assessment_db.execute(
                select(ProctorEvent)
                .where(ProctorEvent.session_code == session_code)
                .order_by(ProctorEvent.created_at.asc())
            )
            .scalars()
            .all()
        )

        severity_count = {"low": 0, "medium": 0, "high": 0}
        for event in events:
            if event.severity in severity_count:
                severity_count[event.severity] += 1

        logger.info(
            "ASSESSMENT PROCTOR REPORT session_code={} total_events={} severity={} score={}/{} percentage={}% passed={}",
            session_code,
            len(events),
            severity_count,
            score,
            total,
            percentage,
            passed,
        )

        for event in events[-25:]:
            logger.info(
                "PROCTOR_EVENT {} {} {} payload={}",
                event.created_at,
                event.severity,
                event.event_type,
                event.payload,
            )
    except Exception as exc:
        logger.warning("Failed to build proctor report for {}: {}", session_code, exc)

    return ExamSubmitResponse(
        score=score,
        total=total,
        percentage=percentage,
        passed=passed,
        status=session.status,
        result_analysis=analysis,
    )


@app.get("/api/exams/{session_code}/result", response_model=ExamResultResponse)
def get_exam_result(session_code: str, assessment_db: Session = Depends(get_assessment_db)) -> ExamResultResponse:
    """Get full exam result with analysis, email status, and call info."""
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    return ExamResultResponse(
        session_code=session.session_code,
        candidate_name=session.candidate_name,
        candidate_email=session.candidate_email,
        job_title=session.job_title,
        score=session.score or 0,
        total=session.total_questions or len(session.questions_json),
        percentage=session.percentage or 0.0,
        passed=bool(session.passed),
        status=session.status,
        result_analysis=session.result_analysis,
        email_sent=session.email_sent,
        call_sid=session.call_sid,
        call_status=session.call_status,
        call_responses=session.call_responses,
        submitted_at=session.submitted_at,
    )


# ---------------------------------------------------------------------------
# AI Interview Call Endpoints (Twilio TwiML)
# ---------------------------------------------------------------------------
async def _generate_elevenlabs_audio(text: str) -> bytes | None:
    api_key = (settings.elevenlabs_api_key or "").strip()
    voice_id = (settings.elevenlabs_voice_id or "").strip()
    model_id = (settings.elevenlabs_model_id or "").strip() or "eleven_multilingual_v2"

    if not api_key or not voice_id:
        return None

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {"xi-api-key": api_key, "accept": "audio/mpeg", "content-type": "application/json"}
    payload = {"text": text, "model_id": model_id}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        logger.warning("ElevenLabs TTS failed: {}", resp.status_code)
        return None

    return resp.content


def _build_interview_audio_url(base_url: str, text: str) -> str:
    safe_text = (text or "").strip()[:300]
    return f"{base_url}/api/interview/audio?text={quote_plus(safe_text)}"


def _build_interview_continue_url(base_url: str, turn: int, session_code: str, name: str, position: str) -> str:
    return (
        f"{base_url}/api/interview/continue"
        f"?turn={turn}"
        f"&session_code={quote_plus(session_code)}"
        f"&name={quote_plus(name)}"
        f"&position={quote_plus(position)}"
    )


@app.get("/api/interview/twiml", include_in_schema=False)
async def interview_twiml(session_code: str = "", name: str = "there", position: str = "the role") -> Response:
    if VoiceResponse is None:
        raise HTTPException(status_code=500, detail="Twilio not installed")

    base_url = (settings.public_call_base_url or "").strip().rstrip("/")
    hr_text = await _generate_interview_line(
        turn=1, candidate_name=name, position=position, job_title=position, user_speech=None,
    )

    vr = VoiceResponse()
    gather = vr.gather(
        input="speech",
        action=_build_interview_continue_url(base_url, 2, session_code, name, position),
        method="POST",
        timeout=8,
        speech_timeout="auto",
        language="en-IN",
    )
    gather.play(_build_interview_audio_url(base_url, hr_text))
    return Response(content=str(vr), media_type="application/xml")


@app.post("/api/interview/continue", include_in_schema=False)
async def interview_continue(
    request: Request,
    turn: int = 2,
    session_code: str = "",
    name: str = "there",
    position: str = "the role",
) -> Response:
    if VoiceResponse is None:
        raise HTTPException(status_code=500, detail="Twilio not installed")

    # Get speech from Twilio form data
    speech = ""
    try:
        form = await request.form()
        speech = str(form.get("SpeechResult") or "").strip()
    except Exception:
        pass

    base_url = (settings.public_call_base_url or "").strip().rstrip("/")
    hr_text = await _generate_interview_line(
        turn=int(turn), candidate_name=name, position=position, job_title=position, user_speech=speech or None,
    )

    # Store the call response in DB
    if session_code:
        try:
            from .db import AssessmentSessionLocal
            db = AssessmentSessionLocal()
            try:
                sess = db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
                if sess:
                    responses = sess.call_responses or []
                    responses.append({
                        "turn": int(turn),
                        "interviewer": hr_text,
                        "candidate_speech": speech or "",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                    sess.call_responses = responses
                    sess.call_status = "in_progress" if int(turn) < 5 else "completed"
                    db.commit()
            finally:
                db.close()
        except Exception as exc:
            logger.warning("Failed to store call response: {}", exc)

    vr = VoiceResponse()
    if int(turn) >= 5:
        vr.play(_build_interview_audio_url(base_url, hr_text))
        vr.hangup()
        return Response(content=str(vr), media_type="application/xml")

    gather = vr.gather(
        input="speech",
        action=_build_interview_continue_url(base_url, int(turn) + 1, session_code, name, position),
        method="POST",
        timeout=8,
        speech_timeout="auto",
        language="en-IN",
    )
    gather.play(_build_interview_audio_url(base_url, hr_text))
    return Response(content=str(vr), media_type="application/xml")


@app.get("/api/interview/audio", include_in_schema=False)
async def interview_audio(text: str | None = None) -> Response:
    if not text or not text.strip():
        text = "Hello, this is SmartHire AI interviewer."

    text = str(text).strip()[:300]
    audio_bytes = await _generate_elevenlabs_audio(text)

    if audio_bytes:
        return Response(content=audio_bytes, media_type="audio/mpeg")

    # Fallback: use Twilio's built-in TTS via a simple TwiML
    if VoiceResponse is not None:
        vr = VoiceResponse()
        vr.say(text, voice=settings.twilio_voice or "Polly.Aditi")
        return Response(content=str(vr), media_type="application/xml")

    raise HTTPException(status_code=500, detail="No TTS engine available")


@app.post("/api/proctor/analyze-frame")
def analyze_proctor_frame(payload: ProctorFrameRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    result = analyze_frame(payload.session_code, payload.camera_type, payload.image_base64)
    event = ProctorEvent(
        session_code=payload.session_code,
        event_type="camera_analysis",
        severity=result.get("severity", "low"),
        payload={"camera_type": payload.camera_type, **result},
    )
    assessment_db.add(event)
    assessment_db.commit()

    try:
        flags = result.get("flags") or []
        severity = str(result.get("severity") or "low")
        if flags or severity in {"medium", "high"}:
            logger.info(
                "PROCTOR_CAMERA session_code={} camera_type={} severity={} flags={}",
                payload.session_code,
                payload.camera_type,
                severity,
                list(flags)[:8],
            )
    except Exception:
        pass
    return result


@app.post("/api/proctor/verify-identity", response_model=FaceIdVerificationResponse)
def verify_identity(payload: FaceIdVerificationRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    result = verify_face_id_match(payload.session_code, payload.id_image_base64, payload.selfie_image_base64)

    event = ProctorEvent(
        session_code=payload.session_code,
        event_type="face_id_verification",
        severity="low" if result["verified"] else "high",
        payload=result,
    )
    assessment_db.add(event)
    assessment_db.commit()

    return result


@app.post("/api/proctor/secondary/register")
def register_secondary(payload: SecondaryRegisterRequest) -> dict:
    return register_secondary_stream(payload.session_code, payload.pairing_token)


@app.post("/api/proctor/secondary/upload")
def upload_secondary_frame(payload: SecondaryUploadRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    result = analyze_secondary_environment_frame(payload.session_code, payload.pairing_token, payload.image_base64)

    if result["flags"]:
        event = ProctorEvent(
            session_code=payload.session_code,
            event_type="secondary_environment_analysis",
            severity=result["severity"],
            payload=result,
        )
        assessment_db.add(event)
        assessment_db.commit()

    return result


@app.get("/api/proctor/secondary/status", response_model=SecondaryStatusResponse)
def secondary_status(session_code: str, pairing_token: str) -> dict:
    return get_secondary_stream_status(session_code, pairing_token)


@app.post("/api/proctor/audio")
def analyze_audio(payload: dict, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    session_code = payload.get("session_code")
    rms = float(payload.get("rms", 0.0))

    result = detect_audio_anomaly(rms)
    if session_code:
        event = ProctorEvent(
            session_code=session_code,
            event_type=result["event_type"] if result.get("is_anomaly") else "audio_check",
            severity=result.get("severity", "low"),
            payload={"rms": rms, **result},
        )
        assessment_db.add(event)
        assessment_db.commit()
    return result


@app.post("/api/proctor/events")
def log_event(payload: ProctorEventRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    event = ProctorEvent(
        session_code=payload.session_code,
        event_type=payload.event_type,
        severity=payload.severity,
        payload=payload.payload,
    )
    assessment_db.add(event)
    assessment_db.commit()

    try:
        severity = str(payload.severity or "medium").lower()
        if severity in {"medium", "high"}:
            logger.warning(
                "PROCTOR_EVENT session_code={} severity={} event_type={} payload={}",
                payload.session_code,
                severity,
                payload.event_type,
                _summarize_payload(payload.payload),
            )
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/exams/{session_code}/proctor-report")
def proctor_report(session_code: str, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    events = assessment_db.execute(
        select(ProctorEvent).where(ProctorEvent.session_code == session_code).order_by(ProctorEvent.created_at.asc())
    ).scalars().all()

    severity_count = {"low": 0, "medium": 0, "high": 0}
    for event in events:
        if event.severity in severity_count:
            severity_count[event.severity] += 1

    return {
        "session_code": session_code,
        "total_events": len(events),
        "severity": severity_count,
        "events": [
            {
                "event_type": event.event_type,
                "severity": event.severity,
                "payload": event.payload,
                "created_at": event.created_at,
            }
            for event in events
        ],
    }
