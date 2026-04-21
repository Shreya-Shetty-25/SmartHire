from __future__ import annotations
import asyncio
import csv
import io
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from loguru import logger
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Response, UploadFile
import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..candidate_ranker import rank_candidates_with_llm
from ..background_jobs import schedule_candidate_embeddings
from ..db import SessionLocal, get_db
from ..deps import get_current_admin
from ..emailer import send_test_link_email
from ..models import Candidate, Job, JobCandidateProgress, JobRankResult, JobRankRun, User
from ..pipeline_service import apply_progress_update, build_job_pipeline_rows, get_or_create_progress
from ..realtime import publish_realtime_event
from ..resume_parser import extract_text_from_pdf, parse_resume_pdf, extract_email_from_pdf_text
from ..shortlist import JobRequirements, bm25_shortlist
from ..schemas import (
    CandidateBulkActionRequest,
    CandidateBulkActionResponse,
    CandidateResponse,
    HireJobPipelineResponse,
    HireRankRequest,
    HireRankResponse,
    HireRankResultItem,
    HireSendTestLinkEmailRequest,
    HireSendTestLinkEmailResponse,
    HireShortlistRequest,
    HireShortlistResponse,
    HireShortlistItem,
)
from ..embeddings import cosine_shortlist
from ..config import settings

router = APIRouter(prefix="/api/hire", tags=["hire"])


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _email_key(email: str | None) -> str:
    return str(email or "").strip().lower()


async def _build_dashboard_counters_snapshot(db: AsyncSession) -> dict:
    total_jobs = await db.scalar(select(func.count(Job.id))) or 0
    total_candidates = await db.scalar(select(func.count(Candidate.id))) or 0
    total_ranked = await db.scalar(select(func.count(JobRankResult.id))) or 0
    total_passed = await db.scalar(
        select(func.count(JobRankResult.id)).where(JobRankResult.passed.is_(True))
    ) or 0

    rows = (await db.execute(select(JobCandidateProgress.stage))).all()
    pipeline_overview: dict[str, int] = {}
    for row in rows:
        stage = str(getattr(row, "stage", None) or row[0] or "applied")
        pipeline_overview[stage] = int(pipeline_overview.get(stage, 0) + 1)

    return {
        "total_jobs": int(total_jobs),
        "total_candidates": int(total_candidates),
        "total_ranked": int(total_ranked),
        "total_passed": int(total_passed),
        "pipeline_overview": pipeline_overview,
        "updated_at": _now_utc().isoformat(),
    }


async def _publish_dashboard_counters(db: AsyncSession) -> None:
    try:
        snapshot = await _build_dashboard_counters_snapshot(db)
        publish_realtime_event("dashboard_counters_updated", snapshot)
    except Exception as exc:
        logger.debug("Could not publish dashboard realtime counters: {}", exc)


async def _record_invite_delivery_status(
    *,
    db: AsyncSession,
    job_id: int | None,
    candidate_email: str,
    session_code: str | None,
    status: str,
    attempt: int,
    max_attempts: int,
    error: str | None = None,
) -> None:
    normalized_email = _email_key(candidate_email)
    if job_id:
        candidate = await db.scalar(select(Candidate).where(func.lower(Candidate.email) == normalized_email))
        if candidate:
            progress = await get_or_create_progress(
                db=db,
                job_id=int(job_id),
                candidate_id=int(candidate.id),
                default_stage="assessment_sent",
            )
            apply_progress_update(
                progress,
                actor="system",
                action="assessment_invite_email_status",
                stage=progress.stage or "assessment_sent",
                recruiter_notes=progress.recruiter_notes,
                last_assessment_session_code=session_code,
                details={
                    "session_code": session_code,
                    "delivery_status": status,
                    "attempt": int(attempt),
                    "max_attempts": int(max_attempts),
                    "error": (str(error)[:400] if error else None),
                },
            )
            if str(status).lower() == "sent":
                progress.last_contacted_at = _now_utc()
            await db.commit()

    payload = {
        "job_id": int(job_id) if job_id else None,
        "candidate_email": normalized_email,
        "session_code": session_code,
        "status": str(status).lower(),
        "attempt": int(attempt),
        "max_attempts": int(max_attempts),
        "error": (str(error)[:400] if error else None),
        "updated_at": _now_utc().isoformat(),
    }
    publish_realtime_event("invite_delivery_status", payload)

    if job_id:
        await _publish_dashboard_counters(db)


async def _send_test_link_email_with_retries(
    *,
    job_id: int | None,
    candidate_email: str,
    candidate_name: str | None,
    job_title: str | None,
    test_link: str,
    session_code: str | None,
    max_attempts: int = 3,
) -> None:
    attempts = max(1, int(max_attempts or 1))
    retry_delays = (2, 5, 10)
    normalized_email = _email_key(candidate_email)

    async with SessionLocal() as db:
        await _record_invite_delivery_status(
            db=db,
            job_id=job_id,
            candidate_email=normalized_email,
            session_code=session_code,
            status="queued",
            attempt=0,
            max_attempts=attempts,
        )

    for attempt in range(1, attempts + 1):
        try:
            async with SessionLocal() as db:
                await _record_invite_delivery_status(
                    db=db,
                    job_id=job_id,
                    candidate_email=normalized_email,
                    session_code=session_code,
                    status="sending",
                    attempt=attempt,
                    max_attempts=attempts,
                )
            await asyncio.to_thread(
                send_test_link_email,
                to_email=normalized_email,
                candidate_name=candidate_name,
                job_title=job_title,
                test_link=test_link,
                session_code=session_code,
            )
            async with SessionLocal() as db:
                await _record_invite_delivery_status(
                    db=db,
                    job_id=job_id,
                    candidate_email=normalized_email,
                    session_code=session_code,
                    status="sent",
                    attempt=attempt,
                    max_attempts=attempts,
                )
            return
        except Exception as exc:
            error_text = str(exc)
            final_attempt = attempt >= attempts
            next_status = "failed" if final_attempt else "retrying"
            async with SessionLocal() as db:
                await _record_invite_delivery_status(
                    db=db,
                    job_id=job_id,
                    candidate_email=normalized_email,
                    session_code=session_code,
                    status=next_status,
                    attempt=attempt,
                    max_attempts=attempts,
                    error=error_text,
                )
            if final_attempt:
                logger.warning(
                    "Invite email delivery failed after retries: to={} session_code={} err={}",
                    normalized_email,
                    session_code,
                    error_text,
                )
                return
            delay = retry_delays[min(attempt - 1, len(retry_delays) - 1)]
            await asyncio.sleep(delay)


def _candidate_response_dict(candidate: Candidate) -> dict:
    return {
        "id": candidate.id,
        "full_name": candidate.full_name,
        "email": candidate.email,
        "phone_number": candidate.phone_number,
        "college_details": candidate.college_details,
        "school_details": candidate.school_details,
        "projects": candidate.projects,
        "skills": candidate.skills,
        "work_experience": candidate.work_experience,
        "extra_curricular_activities": candidate.extra_curricular_activities,
        "website_links": candidate.website_links,
        "years_experience": candidate.years_experience,
        "location": candidate.location,
        "certifications": candidate.certifications,
        "resume_filename": candidate.resume_filename,
        "created_at": candidate.created_at,
    }


def _progress_response_dict(progress: JobCandidateProgress | dict | None, *, job_title: str | None = None) -> dict | None:
    if progress is None:
        return None
    if isinstance(progress, dict):
        out = dict(progress)
        if job_title is not None:
            out["job_title"] = job_title
        return out
    return {
        "id": progress.id,
        "job_id": progress.job_id,
        "job_title": job_title,
        "candidate_id": progress.candidate_id,
        "stage": progress.stage,
        "recruiter_notes": progress.recruiter_notes,
        "manual_rank_score": progress.manual_rank_score,
        "manual_assessment_score": progress.manual_assessment_score,
        "last_assessment_session_code": progress.last_assessment_session_code,
        "assessment_status": progress.assessment_status,
        "assessment_score": progress.assessment_score,
        "assessment_passed": progress.assessment_passed,
        "interview_scheduled_for": progress.interview_scheduled_for,
        "interview_status": progress.interview_status,
        "last_contacted_at": progress.last_contacted_at,
        "decision_history": progress.decision_history or [],
        "created_at": progress.created_at,
        "updated_at": progress.updated_at,
    }


def _session_code_from_test_link(test_link: str | None) -> str | None:
    raw = (test_link or "").strip()
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
        qs = parse_qs(parsed.query or "")
        candidates = qs.get("code") or qs.get("session_code") or []
        if candidates:
            val = str(candidates[0] or "").strip().upper()
            if val:
                return val
    except Exception:
        return None
    return None


def _compose_test_link_with_code(*, raw_link: str | None, session_code: str) -> str:
    base = (raw_link or "").strip() or (settings.exam_portal_base_url or "").strip() or "http://localhost:5173/assessment"
    code = (session_code or "").strip().upper()
    if not code:
        return base

    try:
        parsed = urlparse(base)
        qs = parse_qs(parsed.query or "", keep_blank_values=True)
        qs["code"] = [code]
        query = urlencode(qs, doseq=True)
        return urlunparse(parsed._replace(query=query))
    except Exception:
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}code={code}"


async def _create_assessment_session(
    *,
    db: AsyncSession,
    job: Job,
    candidate_email: str,
    candidate_name: str | None,
    duration_minutes: int | None,
    question_count: int | None,
    difficulty: str | None,
) -> str:
    candidate_skills: list[str] | None = None
    try:
        candidate = await db.scalar(select(Candidate).where(Candidate.email.ilike(str(candidate_email).lower())))
        if candidate and candidate.skills:
            candidate_skills = candidate.skills
    except Exception:
        pass

    generation_mode = str(getattr(settings, "assessment_question_generation_mode", "auto") or "auto").strip().lower()
    if generation_mode not in {"auto", "fast"}:
        generation_mode = "auto"

    create_payload: dict = {
        "job_id": int(job.id),
        "job_title": job.title,
        "job_description": job.description,
        "skills_required": job.skills_required,
        "additional_skills": job.additional_skills,
        "candidate_name": (candidate_name or "Candidate").strip() or "Candidate",
        "candidate_email": str(candidate_email),
        "question_count": int(question_count or 10),
        "difficulty": (difficulty or "hard").strip() or "hard",
        # Keep invite/send flow fast by default; can be switched to "auto" via env.
        "question_generation_mode": generation_mode,
    }
    if candidate_skills:
        create_payload["resume_skills"] = candidate_skills
    if duration_minutes is not None:
        create_payload["duration_minutes"] = int(duration_minutes)
    logger.info(
        "Creating assessment session via assessment-api: candidate_email={} job_id={} mode={} question_count={}",
        str(candidate_email),
        int(job.id),
        generation_mode,
        int(question_count or 10),
    )

    # Call the assessment service directly (in-process) to avoid self-HTTP deadlocks on Windows.
    from ..assessment.main import create_exam as _create_exam
    from ..assessment.schemas import ExamCreateRequest as _AssessExamCreateRequest
    from ..assessment.db import AssessmentSessionLocal as _AssessmentSessionLocal, JobsSessionLocal as _JobsSessionLocal

    exam_req = _AssessExamCreateRequest(
        job_id=create_payload.get("job_id"),
        job_title=create_payload.get("job_title"),
        job_description=create_payload.get("job_description"),
        skills_required=create_payload.get("skills_required"),
        additional_skills=create_payload.get("additional_skills"),
        candidate_name=create_payload["candidate_name"],
        candidate_email=create_payload["candidate_email"],
        question_count=create_payload.get("question_count", 10),
        difficulty=create_payload.get("difficulty", "hard"),
        question_generation_mode=create_payload.get("question_generation_mode", "auto"),
        resume_skills=create_payload.get("resume_skills"),
        duration_minutes=create_payload.get("duration_minutes", 30),
    )

    def _call_direct() -> str:
        _a_db = _AssessmentSessionLocal()
        _j_db = _JobsSessionLocal() if _JobsSessionLocal else None
        try:
            result = _create_exam(exam_req, jobs_db=_j_db, assessment_db=_a_db)
            return str(result.session_code)
        finally:
            _a_db.close()
            if _j_db:
                _j_db.close()

    try:
        session_code = await asyncio.get_event_loop().run_in_executor(None, _call_direct)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Assessment session creation failed: {}", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Assessment service failed: {exc}",
        ) from exc

    if not session_code:
        raise HTTPException(status_code=502, detail="Assessment service returned no session code.")
    return session_code


@router.post("/send-test-link", response_model=HireSendTestLinkEmailResponse)
async def send_test_link(
    payload: HireSendTestLinkEmailRequest,
    background: BackgroundTasks,
    _user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> HireSendTestLinkEmailResponse:
    mode = (settings.email_mode or "").strip().lower()
    if mode in {"", "auto"}:
        mode = "smtp" if (settings.smtp_host and settings.smtp_from) else "log"
    if mode not in {"log", "smtp"}:
        raise HTTPException(status_code=400, detail="EMAIL_MODE must be 'log' or 'smtp'")
    if mode == "smtp" and (not settings.smtp_host or not settings.smtp_from):
        raise HTTPException(status_code=400, detail="SMTP not configured (SMTP_HOST/SMTP_FROM missing)")

    session_code = payload.session_code.strip().upper() if payload.session_code and payload.session_code.strip() else None
    if not session_code:
        # If the frontend already provides an exam link with a code, use it directly
        # and skip auto-creating another session.
        session_code = _session_code_from_test_link(payload.test_link)

    if not session_code:
        if not payload.job_id:
            raise HTTPException(status_code=400, detail="job_id is required to auto-create an assessment session")

        job = await db.get(Job, int(payload.job_id))
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        logger.info(
            "Creating assessment session before sending invite: candidate_email={} job_id={}",
            str(payload.candidate_email),
            int(payload.job_id),
        )
        session_code = await _create_assessment_session(
            db=db,
            job=job,
            candidate_email=str(payload.candidate_email),
            candidate_name=payload.candidate_name,
            duration_minutes=payload.duration_minutes,
            question_count=payload.question_count,
            difficulty=payload.difficulty,
        )

    final_test_link = _compose_test_link_with_code(raw_link=payload.test_link, session_code=session_code or "")

    if payload.job_id:
        candidate = await db.scalar(select(Candidate).where(func.lower(Candidate.email) == str(payload.candidate_email).lower()))
        if candidate:
            progress = await get_or_create_progress(db=db, job_id=int(payload.job_id), candidate_id=int(candidate.id), default_stage="assessment_sent")
            apply_progress_update(
                progress,
                actor=str(_user.email),
                action="assessment_invited",
                stage="assessment_sent",
                recruiter_notes=progress.recruiter_notes,
                last_assessment_session_code=session_code,
                details={"session_code": session_code, "job_title": payload.job_title},
            )
            progress.last_contacted_at = _now_utc()
            await db.commit()
            await _publish_dashboard_counters(db)

    logger.info(
        "Queued test link email: to={} job_title={} session_code={}",
        str(payload.candidate_email),
        payload.job_title,
        session_code,
    )
    background.add_task(
        _send_test_link_email_with_retries,
        job_id=(int(payload.job_id) if payload.job_id else None),
        candidate_email=str(payload.candidate_email),
        candidate_name=payload.candidate_name,
        job_title=payload.job_title,
        test_link=final_test_link,
        session_code=session_code,
    )

    return HireSendTestLinkEmailResponse(to=str(payload.candidate_email), session_code=session_code)


async def _upsert_candidate_from_pdf(
    *,
    db: AsyncSession,
    filename: str,
    pdf_bytes: bytes,
) -> Candidate:
    # --- Fast path: extract email from raw PDF text (no LLM) and check DB ---
    quick_email = extract_email_from_pdf_text(pdf_bytes)
    if quick_email:
        existing = await db.scalar(
            select(Candidate).where(Candidate.email.ilike(quick_email.lower()))
        )
        if existing:
            logger.info(
                "Candidate already exists (email={}), skipping LLM re-parse",
                quick_email,
            )
            # Update PDF blob and filename in case the resume file changed.
            existing.resume_filename = filename
            existing.resume_pdf = pdf_bytes
            await db.commit()
            await db.refresh(existing)
            return existing

    # --- Slow path: new candidate → full LLM parse ---
    resume_text = extract_text_from_pdf(pdf_bytes)
    parsed = await parse_resume_pdf(pdf_bytes, resume_text=resume_text)
    email = str(parsed.email).lower()

    existing = await db.scalar(select(Candidate).where(Candidate.email.ilike(email)))
    if existing:
        existing.full_name = parsed.full_name.strip()
        existing.email = email
        existing.phone_number = parsed.phone_number.strip() if parsed.phone_number else None
        existing.college_details = parsed.college_details
        existing.school_details = parsed.school_details
        existing.projects = parsed.projects
        existing.skills = parsed.skills
        existing.work_experience = parsed.work_experience
        existing.extra_curricular_activities = parsed.extra_curricular_activities
        existing.website_links = parsed.website_links
        existing.years_experience = parsed.years_experience
        existing.location = parsed.location
        existing.certifications = parsed.certifications
        existing.resume_filename = filename
        existing.resume_pdf = pdf_bytes
        await db.commit()
        await db.refresh(existing)

        try:
            schedule_candidate_embeddings(existing.id)
        except Exception as exc:
            logger.warning("Embeddings queue skipped for candidate {} ({}): {}", existing.id, existing.email, exc)
        return existing

    candidate = Candidate(
        full_name=parsed.full_name.strip(),
        email=email,
        phone_number=(parsed.phone_number.strip() if parsed.phone_number else None),
        college_details=parsed.college_details,
        school_details=parsed.school_details,
        projects=parsed.projects,
        skills=parsed.skills,
        work_experience=parsed.work_experience,
        extra_curricular_activities=parsed.extra_curricular_activities,
        website_links=parsed.website_links,
        years_experience=parsed.years_experience,
        location=parsed.location,
        certifications=parsed.certifications,
        resume_filename=filename,
        resume_pdf=pdf_bytes,
    )

    db.add(candidate)
    await db.commit()
    await db.refresh(candidate)

    try:
        schedule_candidate_embeddings(candidate.id)
    except Exception as exc:
        logger.warning("Embeddings queue skipped for candidate {} ({}): {}", candidate.id, candidate.email, exc)
    return candidate


@router.post("/resumes/upload", response_model=list[CandidateResponse])
async def bulk_upload_resumes(
    files: list[UploadFile] = File(...),
    job_id: int | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> list[Candidate]:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    out: list[Candidate] = []
    for file in files:
        if not file.filename:
            raise HTTPException(status_code=400, detail="One of the files is missing a filename")
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail=f"Empty file: {file.filename}")

        candidate = await _upsert_candidate_from_pdf(db=db, filename=file.filename, pdf_bytes=contents)
        if job_id:
            progress = await get_or_create_progress(db=db, job_id=int(job_id), candidate_id=int(candidate.id), default_stage="applied")
            apply_progress_update(
                progress,
                actor="system",
                action="resume_uploaded",
                stage="applied",
                recruiter_notes=progress.recruiter_notes,
                details={"source": "bulk_upload"},
            )
        out.append(candidate)

    if job_id and out:
        await db.commit()
        await _publish_dashboard_counters(db)

    return out


@router.post("/shortlist", response_model=HireShortlistResponse)
async def shortlist_from_dump(
    payload: HireShortlistRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireShortlistResponse:
    job = await db.get(Job, payload.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Use embedding cosine similarity over existing candidate dump.
    result = await db.execute(select(Candidate))
    candidates = list(result.scalars().all())

    effective_limit = min(int(payload.limit), 20)
    used_bm25_fallback = False
    strategy = (settings.shortlist_strategy or "auto").strip().lower()

    if strategy == "bm25":
        scored = []
        used_bm25_fallback = True
    else:
        try:
            scored = await cosine_shortlist(db=db, job=job, candidates=candidates, limit=effective_limit)
        except HTTPException as exc:
            detail = str(getattr(exc, "detail", "") or "")
            if exc.status_code >= 500 and (
                "sentence-transformers is not installed" in detail
                or "Failed to import sentence-transformers" in detail
                or "Failed to import sentence-transformers dependencies" in detail
                or "Failed to load embedding model" in detail
            ):
                used_bm25_fallback = True
                logger.warning("Embeddings unavailable for shortlist (falling back to BM25): {}", detail)
                scored = bm25_shortlist(
                    job=JobRequirements(
                        skills_required=job.skills_required,
                        additional_skills=job.additional_skills,
                        education=job.education,
                        location=job.location,
                        years_experience=job.years_experience,
                    ),
                    candidates=candidates,
                    limit=effective_limit,
                )
            else:
                raise
    if not scored:
        scored = bm25_shortlist(
            job=JobRequirements(
                skills_required=job.skills_required,
                additional_skills=job.additional_skills,
                education=job.education,
                location=job.location,
                years_experience=job.years_experience,
            ),
            candidates=candidates,
            limit=effective_limit,
        )
        used_bm25_fallback = True

    logger.info(
        "Shortlist: job_id={} candidates={} scored={} (top_n={}) strategy={}",
        job.id,
        len(candidates),
        len(scored),
        effective_limit,
        ("bm25" if used_bm25_fallback else "embedding"),
    )
    for candidate, score in scored:
        progress = await get_or_create_progress(db=db, job_id=job.id, candidate_id=candidate.id, default_stage="shortlisted")
        apply_progress_update(
            progress,
            actor=str(_user.email),
            action="candidate_shortlisted",
            stage="shortlisted",
            recruiter_notes=progress.recruiter_notes,
            details={"score": float(score), "strategy": ("bm25" if used_bm25_fallback else "embedding")},
        )
    if scored:
        await db.commit()
        await _publish_dashboard_counters(db)
    items = [HireShortlistItem(candidate=c, score=score) for (c, score) in scored]
    return HireShortlistResponse(job_id=job.id, results=items)


@router.post("/rank", response_model=HireRankResponse)
async def rank_candidates(
    payload: HireRankRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
) -> HireRankResponse:
    job = await db.get(Job, payload.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Cap to avoid huge prompts.
    candidate_ids = payload.candidate_ids[:40]
    result = await db.execute(select(Candidate).where(Candidate.id.in_(candidate_ids)))
    candidates = list(result.scalars().all())

    if not candidates:
        raise HTTPException(status_code=400, detail="No candidates found for provided IDs")

    # Cache: reuse latest stored score/analysis per (job_id, candidate_id).
    # If a candidate is shortlisted again for the same job, we can skip the LLM.
    cache_stmt = (
        select(
            JobRankResult.candidate_id,
            JobRankResult.score,
            JobRankResult.analysis,
        )
        .join(JobRankRun, JobRankRun.id == JobRankResult.run_id)
        .where(
            JobRankRun.job_id == job.id,
            JobRankResult.candidate_id.in_(candidate_ids),
        )
        .order_by(
            JobRankResult.candidate_id,
            JobRankRun.created_at.desc(),
            JobRankResult.id.desc(),
        )
        .distinct(JobRankResult.candidate_id)
    )

    cache_rows = (await db.execute(cache_stmt)).all()
    cached_by_candidate_id: dict[int, dict] = {}
    for row in cache_rows:
        cached_by_candidate_id[int(row.candidate_id)] = {
            "score": float(row.score),
            "analysis": (row.analysis if isinstance(row.analysis, dict) else None),
        }

    missing_candidates = [c for c in candidates if c.id not in cached_by_candidate_id]
    if cached_by_candidate_id:
        logger.info(
            "Rank cache: job_id={} candidates={} cached={} missing={}",
            job.id,
            len(candidates),
            len(cached_by_candidate_id),
            len(missing_candidates),
        )

    ranked_missing = []
    if missing_candidates:
        ranked_missing = await rank_candidates_with_llm(
            job=job,
            candidates=missing_candidates,
            threshold_score=payload.threshold_score,
        )

    run = JobRankRun(
        job_id=job.id,
        created_by_user_id=user.id,
        threshold_score=payload.threshold_score,
        source=payload.source,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    # Merge cached + newly ranked, and persist a run containing all results.
    by_missing_id = {r.candidate_id: r for r in ranked_missing}
    progress_rows = (
        await db.execute(
            select(JobCandidateProgress).where(
                JobCandidateProgress.job_id == job.id,
                JobCandidateProgress.candidate_id.in_([c.id for c in candidates]),
            )
        )
    ).scalars().all()
    progress_by_candidate_id = {row.candidate_id: row for row in progress_rows}

    merged_results: list[HireRankResultItem] = []
    for c in candidates:
        cached = cached_by_candidate_id.get(c.id)
        if cached is not None:
            score = float(cached.get("score") or 0.0)
            analysis = cached.get("analysis") if isinstance(cached.get("analysis"), dict) else {}
            passed = bool(score >= float(payload.threshold_score))
        else:
            r = by_missing_id.get(c.id)
            if not r:
                score = 0.0
                analysis = {"strengths": [], "concerns": ["No ranking produced"], "summary": ""}
                passed = False
            else:
                score = float(r.score)
                analysis = {
                    "strengths": r.strengths,
                    "concerns": r.concerns,
                    "summary": r.summary,
                    "breakdown": r.breakdown,
                }
                passed = bool(r.passed)

        db.add(
            JobRankResult(
                run_id=run.id,
                candidate_id=c.id,
                score=score,
                passed=passed,
                analysis=analysis,
            )
        )

        progress = progress_by_candidate_id.get(c.id)
        if progress is None:
            progress = await get_or_create_progress(db=db, job_id=job.id, candidate_id=c.id, default_stage="shortlisted")
            progress_by_candidate_id[c.id] = progress
        apply_progress_update(
            progress,
            actor=str(user.email),
            action="candidate_ranked",
            stage=progress.stage or "shortlisted",
            recruiter_notes=progress.recruiter_notes,
            details={"job_id": job.id, "score": score, "threshold": payload.threshold_score, "passed": passed},
        )
        manual_rank_score = float(progress.manual_rank_score) if progress.manual_rank_score is not None else None
        effective_score = manual_rank_score if manual_rank_score is not None else score

        merged_results.append(
            HireRankResultItem(
                candidate=c,
                score=score,
                passed=passed,
                analysis=analysis,
                effective_score=effective_score,
                manual_rank_score=manual_rank_score,
                pipeline_stage=progress.stage,
                recruiter_notes=progress.recruiter_notes,
            )
        )

    await db.commit()
    await _publish_dashboard_counters(db)

    merged_results.sort(key=lambda x: float(x.effective_score if x.effective_score is not None else x.score), reverse=True)

    return HireRankResponse(
        run_id=run.id,
        job_id=job.id,
        threshold_score=payload.threshold_score,
        results=merged_results,
    )


@router.get("/jobs/{job_id}/pipeline", response_model=HireJobPipelineResponse)
async def get_job_pipeline(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireJobPipelineResponse:
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    rows = await build_job_pipeline_rows(db=db, job_id=job_id)
    candidates = [
        {
            "candidate": _candidate_response_dict(item["candidate"]),
            "progress": _progress_response_dict(item.get("progress"), job_title=job.title),
            "latest_rank_score": item.get("latest_rank_score"),
            "latest_rank_passed": item.get("latest_rank_passed"),
        }
        for item in rows
    ]
    return HireJobPipelineResponse(job_id=job.id, job_title=job.title, candidates=candidates)


@router.post("/jobs/{job_id}/bulk-action", response_model=CandidateBulkActionResponse)
async def bulk_job_action(
    job_id: int,
    payload: CandidateBulkActionRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_admin),
) -> CandidateBulkActionResponse:
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    candidate_ids = [int(cid) for cid in payload.candidate_ids]
    candidates = (
        await db.execute(select(Candidate).where(Candidate.id.in_(candidate_ids)).order_by(Candidate.full_name.asc()))
    ).scalars().all()
    if not candidates:
        raise HTTPException(status_code=404, detail="No candidates found for bulk action")

    updated_ids: list[int] = []
    action = str(payload.action or "").strip().lower()
    stage = payload.stage

    for candidate in candidates:
        progress = await get_or_create_progress(db=db, job_id=job.id, candidate_id=candidate.id, default_stage=stage or "applied")
        details: dict[str, object] = {"source": "bulk_action", "action": action}

        if action == "send_assessment":
            session_code = await _create_assessment_session(
                db=db,
                job=job,
                candidate_email=candidate.email,
                candidate_name=candidate.full_name,
                duration_minutes=payload.duration_minutes,
                question_count=payload.question_count,
                difficulty=payload.difficulty,
            )
            final_link = _compose_test_link_with_code(raw_link=None, session_code=session_code)
            background.add_task(
                _send_test_link_email_with_retries,
                job_id=int(job.id),
                candidate_email=candidate.email,
                candidate_name=candidate.full_name,
                job_title=job.title,
                test_link=final_link,
                session_code=session_code,
            )
            details["session_code"] = session_code
            progress.last_contacted_at = _now_utc()
            apply_progress_update(
                progress,
                actor=admin.email,
                action="assessment_invited",
                stage="assessment_sent",
                recruiter_notes=payload.recruiter_notes if payload.recruiter_notes is not None else progress.recruiter_notes,
                last_assessment_session_code=session_code,
                append_note=payload.recruiter_notes,
                details=details,
            )
        else:
            next_stage = stage
            if not next_stage:
                if action == "shortlist":
                    next_stage = "shortlisted"
                elif action == "reject":
                    next_stage = "rejected"
                elif action == "hire":
                    next_stage = "hired"
                elif action == "schedule_interview":
                    next_stage = "interview_scheduled"
                else:
                    next_stage = progress.stage
            apply_progress_update(
                progress,
                actor=admin.email,
                action=f"bulk_{action or 'update'}",
                stage=next_stage,
                recruiter_notes=payload.recruiter_notes if payload.recruiter_notes is not None else progress.recruiter_notes,
                manual_rank_score=payload.manual_rank_score,
                manual_assessment_score=payload.manual_assessment_score,
                interview_scheduled_for=payload.interview_scheduled_for,
                interview_status=payload.interview_status,
                append_note=payload.recruiter_notes,
                details=details,
            )
        updated_ids.append(candidate.id)

    await db.commit()
    await _publish_dashboard_counters(db)
    return CandidateBulkActionResponse(
        updated_count=len(updated_ids),
        updated_candidate_ids=updated_ids,
        message=f"Applied '{action or 'update'}' to {len(updated_ids)} candidate(s).",
    )


@router.get("/jobs/{job_id}/pipeline/export")
async def export_job_pipeline_csv(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> Response:
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    rows = await build_job_pipeline_rows(db=db, job_id=job_id)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "candidate_id",
            "full_name",
            "email",
            "stage",
            "latest_rank_score",
            "manual_rank_score",
            "assessment_score",
            "manual_assessment_score",
            "assessment_status",
            "interview_status",
            "interview_scheduled_for",
            "recruiter_notes",
        ]
    )
    for row in rows:
        candidate = row["candidate"]
        progress = row.get("progress") or {}
        writer.writerow(
            [
                candidate.id,
                candidate.full_name,
                candidate.email,
                progress.get("stage") or "",
                row.get("latest_rank_score") or "",
                progress.get("manual_rank_score") or "",
                progress.get("assessment_score") or "",
                progress.get("manual_assessment_score") or "",
                progress.get("assessment_status") or "",
                progress.get("interview_status") or "",
                progress.get("interview_scheduled_for") or "",
                progress.get("recruiter_notes") or "",
            ]
        )

    filename = f"job-{job_id}-pipeline.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\""},
    )
