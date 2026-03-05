from datetime import datetime, timezone
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import assessment_engine, get_assessment_db, get_jobs_db
from .models import AssessmentBase, ExamSession, Job, ProctorEvent
from .schemas import (
    ExamAccessRequest,
    ExamCreateRequest,
    ExamCreateResponse,
    ExamDetailsResponse,
    ExamQuestion,
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


@app.on_event("startup")
def on_startup() -> None:
    AssessmentBase.metadata.create_all(bind=assessment_engine)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/jobs", response_model=list[JobOut])
def list_jobs(db: Session = Depends(get_jobs_db)) -> list[Job]:
    result = db.execute(select(Job).order_by(Job.id.desc()).limit(100))
    return list(result.scalars().all())


@app.post("/api/exams/create", response_model=ExamCreateResponse)
def create_exam(payload: ExamCreateRequest, jobs_db: Session = Depends(get_jobs_db), assessment_db: Session = Depends(get_assessment_db)) -> ExamCreateResponse:
    job = jobs_db.get(Job, payload.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    generated = generate_questions(
        {
            "id": job.id,
            "title": job.title,
            "description": job.description,
            "skills_required": job.skills_required,
            "additional_skills": job.additional_skills,
        },
        payload.question_count,
        payload.difficulty,
    )

    session_code = f"EXAM-{uuid4().hex[:10].upper()}"
    session = ExamSession(
        session_code=session_code,
        job_id=job.id,
        candidate_name=payload.candidate_name,
        candidate_email=payload.candidate_email,
        duration_minutes=payload.duration_minutes,
        status="created",
        questions_json=generated,
    )
    assessment_db.add(session)
    assessment_db.commit()

    return ExamCreateResponse(
        session_code=session_code,
        exam_link=f"{settings.public_base_url}/?code={session_code}",
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
def submit_exam(session_code: str, payload: ExamSubmitRequest, assessment_db: Session = Depends(get_assessment_db)) -> ExamSubmitResponse:
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    answer_lookup = {item.get("question_id"): item.get("answer") for item in payload.answers}
    total = len(session.questions_json)
    score = 0
    for question in session.questions_json:
        if answer_lookup.get(question["id"]) == question.get("answer"):
            score += 1

    session.answers_json = payload.answers
    session.score = score
    session.status = "submitted"
    session.submitted_at = datetime.now(timezone.utc)
    assessment_db.commit()

    return ExamSubmitResponse(score=score, total=total, status=session.status)


@app.post("/api/proctor/analyze-frame")
def analyze_proctor_frame(payload: ProctorFrameRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    result = analyze_frame(payload.session_code, payload.camera_type, payload.image_base64)
    if result["flags"]:
        event = ProctorEvent(
            session_code=payload.session_code,
            event_type="camera_analysis",
            severity=result["severity"],
            payload={"camera_type": payload.camera_type, **result},
        )
        assessment_db.add(event)
        assessment_db.commit()
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
    if result["is_anomaly"] and session_code:
        event = ProctorEvent(
            session_code=session_code,
            event_type=result["event_type"],
            severity=result["severity"],
            payload=result,
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
