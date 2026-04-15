from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, status, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_user
from ..models import Candidate, CandidateDocument, Job, JobCandidateProgress, User
from ..pipeline_service import apply_progress_update, get_or_create_progress
from ..resume_parser import extract_text_from_pdf, parse_resume_pdf
from ..schemas import JobResponse

router = APIRouter(prefix="/api/candidate-portal", tags=["candidate_portal"])


class CandidateDocumentOut(BaseModel):
    id: int
    doc_type: str | None = None
    file_name: str
    content_type: str | None = None
    file_size: int
    created_at: datetime


class CandidateApplicationOut(BaseModel):
    job_id: int
    job_title: str | None = None
    stage: str
    updated_at: datetime | None = None
    created_at: datetime


class CandidateProfileOut(BaseModel):
    candidate_id: int | None = None
    email: str
    full_name: str | None = None
    phone_number: str | None = None
    college_details: str | None = None
    school_details: str | None = None
    projects: list[str] | None = None
    skills: list[str] | None = None
    work_experience: list[str] | None = None
    extra_curricular_activities: list[str] | None = None
    website_links: list[str] | None = None
    years_experience: int | None = None
    location: str | None = None
    certifications: list[str] | None = None
    resume_filename: str | None = None
    resume_uploaded: bool = False
    profile_completion: int = 0
    profile_checklist: list[dict[str, Any]] = []
    documents: list[CandidateDocumentOut] = []
    applications: list[CandidateApplicationOut] = []


class CandidateProfileUpdateRequest(BaseModel):
    full_name: str | None = Field(default=None, max_length=255)
    phone_number: str | None = Field(default=None, max_length=64)
    college_details: str | None = None
    school_details: str | None = None
    projects: list[str] | None = None
    skills: list[str] | None = None
    work_experience: list[str] | None = None
    extra_curricular_activities: list[str] | None = None
    website_links: list[str] | None = None
    years_experience: int | None = Field(default=None, ge=0)
    location: str | None = Field(default=None, max_length=255)
    certifications: list[str] | None = None


class CandidateRelatedJobOut(JobResponse):
    relevance_score: int = 0


class CandidateJobApplyRequest(BaseModel):
    note: str | None = Field(default=None, max_length=500)


def _normalize_role(user: User) -> str:
    return str(getattr(user, "role", "candidate") or "candidate").strip().lower()


def _normalize_str(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_list(values: list[str] | None) -> list[str] | None:
    if values is None:
        return None
    out: list[str] = []
    for value in values:
        item = str(value or "").strip()
        if item:
            out.append(item)
    return out or None


def _email_key(value: str) -> str:
    return str(value or "").strip().lower()


def _fallback_name_for_user(user: User) -> str:
    explicit_name = _normalize_str(getattr(user, "full_name", None))
    if explicit_name:
        return explicit_name
    base = str(getattr(user, "email", "") or "").split("@")[0].replace(".", " ").replace("_", " ").strip()
    return base.title() if base else "Candidate"


async def _require_candidate_user(current_user: User = Depends(get_current_user)) -> User:
    if _normalize_role(current_user) != "candidate":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Candidate access required")
    return current_user


async def _get_candidate_for_user(db: AsyncSession, user: User) -> Candidate | None:
    return await db.scalar(select(Candidate).where(Candidate.email == _email_key(user.email)))


async def _ensure_candidate_for_user(db: AsyncSession, user: User) -> Candidate:
    candidate = await _get_candidate_for_user(db, user)
    if candidate:
        return candidate

    candidate = Candidate(
        full_name=_fallback_name_for_user(user),
        email=_email_key(user.email),
        phone_number=None,
        college_details=None,
        school_details=None,
        projects=None,
        skills=None,
        work_experience=None,
        extra_curricular_activities=None,
        website_links=None,
        years_experience=None,
        location=None,
        certifications=None,
        resume_filename=None,
        resume_pdf=b"",
    )
    db.add(candidate)
    await db.flush()
    return candidate


async def _list_documents(db: AsyncSession, candidate_id: int) -> list[CandidateDocument]:
    result = await db.execute(
        select(CandidateDocument)
        .where(CandidateDocument.candidate_id == int(candidate_id))
        .order_by(CandidateDocument.created_at.desc(), CandidateDocument.id.desc())
    )
    return list(result.scalars().all())


async def _list_applications(db: AsyncSession, candidate_id: int) -> list[dict[str, Any]]:
    result = await db.execute(
        select(JobCandidateProgress, Job.title)
        .join(Job, Job.id == JobCandidateProgress.job_id)
        .where(JobCandidateProgress.candidate_id == int(candidate_id))
        .order_by(desc(JobCandidateProgress.updated_at), desc(JobCandidateProgress.created_at))
    )
    rows = result.all()
    out: list[dict[str, Any]] = []
    for progress, job_title in rows:
        out.append(
            {
                "job_id": int(progress.job_id),
                "job_title": job_title,
                "stage": str(progress.stage or "applied"),
                "updated_at": progress.updated_at,
                "created_at": progress.created_at,
            }
        )
    return out


def _profile_checklist(candidate: Candidate | None, documents: list[CandidateDocument]) -> list[dict[str, Any]]:
    checks = [
        {"key": "full_name", "label": "Full name", "completed": bool(_normalize_str(getattr(candidate, "full_name", None)))},
        {"key": "phone_number", "label": "Phone number", "completed": bool(_normalize_str(getattr(candidate, "phone_number", None)))},
        {"key": "location", "label": "Location", "completed": bool(_normalize_str(getattr(candidate, "location", None)))},
        {
            "key": "years_experience",
            "label": "Years of experience",
            "completed": getattr(candidate, "years_experience", None) is not None,
        },
        {"key": "skills", "label": "Skills", "completed": bool(getattr(candidate, "skills", None))},
        {"key": "work_experience", "label": "Work experience", "completed": bool(getattr(candidate, "work_experience", None))},
        {"key": "education", "label": "Education details", "completed": bool(_normalize_str(getattr(candidate, "college_details", None)))},
        {"key": "resume", "label": "Resume uploaded", "completed": bool(getattr(candidate, "resume_filename", None))},
        {"key": "documents", "label": "Supporting documents", "completed": len(documents) > 0},
        {"key": "links", "label": "Portfolio links", "completed": bool(getattr(candidate, "website_links", None))},
    ]
    return checks


def _document_to_out(document: CandidateDocument) -> CandidateDocumentOut:
    return CandidateDocumentOut(
        id=int(document.id),
        doc_type=_normalize_str(document.doc_type),
        file_name=str(document.file_name or "").strip() or f"document-{document.id}",
        content_type=_normalize_str(document.content_type),
        file_size=int(document.file_size or 0),
        created_at=document.created_at,
    )


async def _build_profile_response(*, db: AsyncSession, user: User, candidate: Candidate | None) -> CandidateProfileOut:
    documents = await _list_documents(db, int(candidate.id)) if candidate else []
    checklist = _profile_checklist(candidate, documents)
    completed = sum(1 for item in checklist if item.get("completed"))
    total = max(len(checklist), 1)
    completion = int(round((completed / total) * 100))

    applications = await _list_applications(db, int(candidate.id)) if candidate else []

    if candidate is None:
        return CandidateProfileOut(
            candidate_id=None,
            email=_email_key(user.email),
            full_name=_fallback_name_for_user(user),
            profile_completion=completion,
            profile_checklist=checklist,
            documents=[],
            applications=[],
        )

    return CandidateProfileOut(
        candidate_id=int(candidate.id),
        email=_email_key(candidate.email),
        full_name=_normalize_str(candidate.full_name),
        phone_number=_normalize_str(candidate.phone_number),
        college_details=_normalize_str(candidate.college_details),
        school_details=_normalize_str(candidate.school_details),
        projects=_normalize_list(candidate.projects),
        skills=_normalize_list(candidate.skills),
        work_experience=_normalize_list(candidate.work_experience),
        extra_curricular_activities=_normalize_list(candidate.extra_curricular_activities),
        website_links=_normalize_list(candidate.website_links),
        years_experience=candidate.years_experience,
        location=_normalize_str(candidate.location),
        certifications=_normalize_list(candidate.certifications),
        resume_filename=_normalize_str(candidate.resume_filename),
        resume_uploaded=bool(_normalize_str(candidate.resume_filename)),
        profile_completion=completion,
        profile_checklist=checklist,
        documents=[_document_to_out(doc) for doc in documents],
        applications=[CandidateApplicationOut(**item) for item in applications],
    )


@router.get("/jobs", response_model=list[JobResponse])
async def candidate_list_jobs(
    db: AsyncSession = Depends(get_db),
    _candidate_user: User = Depends(_require_candidate_user),
) -> list[Job]:
    result = await db.execute(select(Job).order_by(Job.created_at.desc()))
    return list(result.scalars().all())


@router.get("/jobs/{job_id}/related", response_model=list[CandidateRelatedJobOut])
async def candidate_related_jobs(
    job_id: int,
    limit: int = 6,
    db: AsyncSession = Depends(get_db),
    _candidate_user: User = Depends(_require_candidate_user),
) -> list[CandidateRelatedJobOut]:
    job = await db.get(Job, int(job_id))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    result = await db.execute(select(Job).where(Job.id != int(job_id)).order_by(Job.created_at.desc()))
    others = list(result.scalars().all())

    base_skills = {str(skill or "").strip().lower() for skill in (job.skills_required or []) if str(skill or "").strip()}
    base_extra = {str(skill or "").strip().lower() for skill in (job.additional_skills or []) if str(skill or "").strip()}
    base_all_skills = base_skills.union(base_extra)
    base_title_tokens = {part for part in str(job.title or "").lower().split() if len(part) > 2}

    scored: list[tuple[int, Job]] = []
    for item in others:
        item_skills = {
            str(skill or "").strip().lower()
            for skill in ((item.skills_required or []) + (item.additional_skills or []))
            if str(skill or "").strip()
        }
        overlap_score = len(base_all_skills.intersection(item_skills)) * 3
        title_tokens = {part for part in str(item.title or "").lower().split() if len(part) > 2}
        title_score = len(base_title_tokens.intersection(title_tokens))
        location_score = 1 if _normalize_str(item.location) and _normalize_str(item.location) == _normalize_str(job.location) else 0
        type_score = 1 if _normalize_str(item.employment_type) and _normalize_str(item.employment_type) == _normalize_str(job.employment_type) else 0
        score = overlap_score + title_score + location_score + type_score
        scored.append((score, item))

    scored.sort(key=lambda pair: (pair[0], pair[1].created_at), reverse=True)
    top = scored[: max(1, min(int(limit), 20))]

    return [
        CandidateRelatedJobOut(
            id=int(item.id),
            title=item.title,
            description=item.description,
            education=item.education,
            years_experience=item.years_experience,
            skills_required=item.skills_required,
            additional_skills=item.additional_skills,
            location=item.location,
            employment_type=item.employment_type,
            created_at=item.created_at,
            relevance_score=int(score),
        )
        for score, item in top
    ]


@router.get("/profile", response_model=CandidateProfileOut)
async def candidate_get_profile(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_require_candidate_user),
) -> CandidateProfileOut:
    candidate = await _get_candidate_for_user(db, current_user)
    return await _build_profile_response(db=db, user=current_user, candidate=candidate)


@router.put("/profile", response_model=CandidateProfileOut)
async def candidate_update_profile(
    payload: CandidateProfileUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_require_candidate_user),
) -> CandidateProfileOut:
    candidate = await _ensure_candidate_for_user(db, current_user)
    update_values = payload.model_dump(exclude_unset=True)

    if "full_name" in update_values:
        candidate.full_name = _normalize_str(update_values.get("full_name")) or _fallback_name_for_user(current_user)
    if "phone_number" in update_values:
        candidate.phone_number = _normalize_str(update_values.get("phone_number"))
    if "college_details" in update_values:
        candidate.college_details = _normalize_str(update_values.get("college_details"))
    if "school_details" in update_values:
        candidate.school_details = _normalize_str(update_values.get("school_details"))
    if "projects" in update_values:
        candidate.projects = _normalize_list(update_values.get("projects"))
    if "skills" in update_values:
        candidate.skills = _normalize_list(update_values.get("skills"))
    if "work_experience" in update_values:
        candidate.work_experience = _normalize_list(update_values.get("work_experience"))
    if "extra_curricular_activities" in update_values:
        candidate.extra_curricular_activities = _normalize_list(update_values.get("extra_curricular_activities"))
    if "website_links" in update_values:
        candidate.website_links = _normalize_list(update_values.get("website_links"))
    if "years_experience" in update_values:
        candidate.years_experience = update_values.get("years_experience")
    if "location" in update_values:
        candidate.location = _normalize_str(update_values.get("location"))
    if "certifications" in update_values:
        candidate.certifications = _normalize_list(update_values.get("certifications"))

    await db.commit()
    await db.refresh(candidate)
    return await _build_profile_response(db=db, user=current_user, candidate=candidate)


@router.post("/profile/resume-autofill", response_model=CandidateProfileOut)
async def candidate_resume_autofill(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_require_candidate_user),
) -> CandidateProfileOut:
    filename = str(file.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="Missing filename")
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF resume")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded resume is empty")
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Resume file too large (max 10 MB)")

    resume_text = extract_text_from_pdf(contents)
    parsed = await parse_resume_pdf(contents, resume_text=resume_text)

    candidate = await _ensure_candidate_for_user(db, current_user)
    candidate.full_name = _normalize_str(parsed.full_name) or _fallback_name_for_user(current_user)
    candidate.email = _email_key(current_user.email)
    candidate.phone_number = _normalize_str(parsed.phone_number)
    candidate.college_details = _normalize_str(parsed.college_details)
    candidate.school_details = _normalize_str(parsed.school_details)
    candidate.projects = _normalize_list(parsed.projects)
    candidate.skills = _normalize_list(parsed.skills)
    candidate.work_experience = _normalize_list(parsed.work_experience)
    candidate.extra_curricular_activities = _normalize_list(parsed.extra_curricular_activities)
    candidate.website_links = _normalize_list(parsed.website_links)
    candidate.years_experience = parsed.years_experience
    candidate.location = _normalize_str(parsed.location)
    candidate.certifications = _normalize_list(parsed.certifications)
    candidate.resume_filename = filename
    candidate.resume_pdf = contents

    await db.commit()
    await db.refresh(candidate)
    return await _build_profile_response(db=db, user=current_user, candidate=candidate)


@router.post("/profile/documents", response_model=CandidateProfileOut)
async def candidate_upload_document(
    file: UploadFile = File(...),
    doc_type: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_require_candidate_user),
) -> CandidateProfileOut:
    filename = str(file.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded document is empty")
    if len(contents) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Document file too large (max 8 MB)")

    candidate = await _ensure_candidate_for_user(db, current_user)
    doc = CandidateDocument(
        candidate_id=int(candidate.id),
        doc_type=_normalize_str(doc_type),
        file_name=filename,
        content_type=_normalize_str(file.content_type),
        file_size=len(contents),
        file_data=contents,
    )
    db.add(doc)
    await db.commit()
    return await _build_profile_response(db=db, user=current_user, candidate=candidate)


@router.delete("/profile/documents/{document_id}", response_model=CandidateProfileOut)
async def candidate_delete_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_require_candidate_user),
) -> CandidateProfileOut:
    candidate = await _ensure_candidate_for_user(db, current_user)
    document = await db.get(CandidateDocument, int(document_id))
    if not document or int(document.candidate_id) != int(candidate.id):
        raise HTTPException(status_code=404, detail="Document not found")

    await db.delete(document)
    await db.commit()
    return await _build_profile_response(db=db, user=current_user, candidate=candidate)


@router.get("/profile/documents/{document_id}/download")
async def candidate_download_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_require_candidate_user),
) -> Response:
    candidate = await _ensure_candidate_for_user(db, current_user)
    document = await db.get(CandidateDocument, int(document_id))
    if not document or int(document.candidate_id) != int(candidate.id):
        raise HTTPException(status_code=404, detail="Document not found")

    filename = str(document.file_name or f"document-{document.id}").replace('"', "")
    media_type = _normalize_str(document.content_type) or "application/octet-stream"
    headers = {"Content-Disposition": f"attachment; filename=\"{filename}\""}
    return Response(content=document.file_data, media_type=media_type, headers=headers)


@router.post("/jobs/{job_id}/apply")
async def candidate_apply_job(
    job_id: int,
    payload: CandidateJobApplyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_require_candidate_user),
) -> dict[str, Any]:
    job = await db.get(Job, int(job_id))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    candidate = await _ensure_candidate_for_user(db, current_user)
    progress = await get_or_create_progress(
        db=db,
        job_id=int(job.id),
        candidate_id=int(candidate.id),
        default_stage="applied",
    )
    apply_progress_update(
        progress,
        actor=_email_key(current_user.email),
        action="candidate_applied_via_careers",
        stage="applied",
        append_note=_normalize_str(payload.note),
        details={"source": "candidate_portal"},
    )
    await db.commit()
    await db.refresh(progress)

    return {
        "ok": True,
        "job_id": int(job.id),
        "job_title": job.title,
        "stage": progress.stage,
        "candidate_id": int(candidate.id),
        "applied_at": progress.updated_at or progress.created_at,
    }
