from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from loguru import logger
from pathlib import Path as _Path
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
import re as _re

from ..background_jobs import schedule_candidate_embeddings
from ..config import settings
from ..db import get_db
from ..deps import get_current_admin
from ..models import Candidate, Job
from ..pipeline_service import apply_progress_update, get_or_create_progress, hydrate_candidate_progress_rows
from ..resume_parser import extract_text_from_pdf, parse_resume_pdf
from ..schemas import CandidateDetailResponse, CandidateProgressUpdateRequest, CandidateResponse, JobCandidateProgressResponse, UserResponse

from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/candidates", tags=["candidates"])

_ALLOWED_RESUME_MIMES = {
    "application/pdf",
    # Some browsers send these for PDF — still allowed.
    "application/x-pdf",
    "application/octet-stream",  # Twilio/curl/etc; we still magic-byte check below.
}
_PDF_MAGIC = b"%PDF"
_FILENAME_SAFE_RE = _re.compile(r"[^A-Za-z0-9._-]+")


def _safe_download_filename(name: str | None, default: str) -> str:
    base = _Path(name or default).name or default
    cleaned = _FILENAME_SAFE_RE.sub("_", base).strip("._") or default
    return cleaned[:120]


@router.get("")
async def list_candidates(
    db: AsyncSession = Depends(get_db),
    _user: UserResponse = Depends(get_current_admin),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    result = await db.execute(
        select(Candidate)
        .order_by(Candidate.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    all_candidates = list(result.scalars().all())

    # Gather job titles for each candidate via JobCandidateProgress (only the
    # ones we returned, to avoid scanning the whole table).
    from ..models import JobCandidateProgress
    candidate_ids = [c.id for c in all_candidates]
    candidate_jobs: dict[int, list[str]] = {}
    if candidate_ids:
        progress_result = await db.execute(
            select(JobCandidateProgress.candidate_id, Job.title)
            .join(Job, Job.id == JobCandidateProgress.job_id)
            .where(JobCandidateProgress.candidate_id.in_(candidate_ids))
        )
        for cid, jtitle in progress_result.all():
            candidate_jobs.setdefault(cid, []).append(jtitle)

    skip_cols = {"resume_pdf"}
    out = []
    for c in all_candidates:
        row = {}
        for col in Candidate.__table__.columns:
            if col.name in skip_cols:
                continue
            val = getattr(c, col.name)
            if isinstance(val, bytes):
                continue
            row[col.name] = val
        row["job_titles"] = candidate_jobs.get(c.id, [])
        out.append(row)
    return JSONResponse(content=[
        {k: (v.isoformat() if hasattr(v, 'isoformat') else v) for k, v in r.items()}
        for r in out
    ])


@router.get("/{candidate_id}", response_model=CandidateDetailResponse)
async def get_candidate_detail(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _user: UserResponse = Depends(get_current_admin),
) -> dict:
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    payload = {column.name: getattr(candidate, column.name) for column in Candidate.__table__.columns}
    payload["job_progress"] = await hydrate_candidate_progress_rows(db=db, candidate_id=candidate_id)
    return payload


@router.post("/upload", response_model=CandidateResponse)
async def upload_resume(
    response: Response,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _user: UserResponse = Depends(get_current_admin),
) -> Candidate:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    declared_ct = (file.content_type or "").lower().strip()
    if declared_ct and declared_ct not in _ALLOWED_RESUME_MIMES:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {declared_ct}")

    max_bytes = int(getattr(settings, "max_upload_bytes", 10 * 1024 * 1024) or 10 * 1024 * 1024)
    contents = await file.read(max_bytes + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File too large (>{max_bytes} bytes)")
    if not contents.startswith(_PDF_MAGIC):
        raise HTTPException(status_code=415, detail="Only PDF resumes are supported")

    resume_text = extract_text_from_pdf(contents)
    parsed = await parse_resume_pdf(contents, resume_text=resume_text)

    email = str(parsed.email).lower()
    existing = await db.scalar(select(Candidate).where(func.lower(Candidate.email) == email))

    if existing:
        # Duplicate by email: overwrite fields and resume content.
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
        existing.resume_filename = _safe_download_filename(file.filename, default="resume.pdf")
        existing.resume_pdf = contents

        await db.commit()
        await db.refresh(existing)

        try:
            schedule_candidate_embeddings(existing.id)
        except Exception as exc:
            logger.warning("Embeddings queue skipped for candidate {} ({}): {}", existing.id, existing.email, exc)
        response.status_code = status.HTTP_200_OK
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
        resume_filename=_safe_download_filename(file.filename, default="resume.pdf"),
        resume_pdf=contents,
    )

    db.add(candidate)
    await db.commit()
    await db.refresh(candidate)

    try:
        schedule_candidate_embeddings(candidate.id)
    except Exception as exc:
        logger.warning("Embeddings queue skipped for candidate {} ({}): {}", candidate.id, candidate.email, exc)
    response.status_code = status.HTTP_201_CREATED
    return candidate


@router.get("/{candidate_id}/resume")
async def download_resume(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _user: UserResponse = Depends(get_current_admin),
) -> Response:
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    filename = _safe_download_filename(
        candidate.resume_filename, default=f"candidate-{candidate.id}.pdf"
    )
    headers = {"Content-Disposition": f'inline; filename="{filename}"'}
    return Response(content=candidate.resume_pdf, media_type="application/pdf", headers=headers)


@router.patch("/{candidate_id}/progress/{job_id}", response_model=JobCandidateProgressResponse)
async def update_candidate_progress(
    candidate_id: int,
    job_id: int,
    payload: CandidateProgressUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: UserResponse = Depends(get_current_admin),
) -> dict:
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    progress = await get_or_create_progress(db=db, job_id=job_id, candidate_id=candidate_id)
    apply_progress_update(
        progress,
        actor=admin.email,
        action="candidate_progress_updated",
        stage=payload.stage,
        recruiter_notes=payload.recruiter_notes,
        manual_rank_score=payload.manual_rank_score,
        manual_assessment_score=payload.manual_assessment_score,
        assessment_status=payload.assessment_status,
        assessment_passed=payload.assessment_passed,
        last_assessment_session_code=payload.last_assessment_session_code,
        interview_scheduled_for=payload.interview_scheduled_for,
        interview_status=payload.interview_status,
        append_note=payload.append_history_note,
        details={"source": "candidates_route"},
    )
    await db.commit()
    await db.refresh(progress)

    return {
        "id": progress.id,
        "job_id": progress.job_id,
        "job_title": job.title,
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
