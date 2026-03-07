from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_user
from ..embeddings import upsert_candidate_embeddings
from ..models import Candidate, User
from ..resume_parser import extract_text_from_pdf, parse_resume_pdf
from ..schemas import CandidateResponse

router = APIRouter(prefix="/api/candidates", tags=["candidates"])


@router.get("", response_model=list[CandidateResponse])
async def list_candidates(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[Candidate]:
    result = await db.execute(select(Candidate).order_by(Candidate.created_at.desc()))
    return list(result.scalars().all())


@router.post("/upload", response_model=CandidateResponse)
async def upload_resume(
    response: Response,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Candidate:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")

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
        existing.resume_filename = file.filename
        existing.resume_pdf = contents

        await db.commit()
        await db.refresh(existing)

        await upsert_candidate_embeddings(db=db, candidate=existing, resume_text=resume_text)
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
        resume_filename=file.filename,
        resume_pdf=contents,
    )

    db.add(candidate)
    await db.commit()
    await db.refresh(candidate)
    await upsert_candidate_embeddings(db=db, candidate=candidate, resume_text=resume_text)
    response.status_code = status.HTTP_201_CREATED
    return candidate


@router.get("/{candidate_id}/resume")
async def download_resume(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Response:
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    filename = candidate.resume_filename or f"candidate-{candidate.id}.pdf"
    headers = {"Content-Disposition": f"inline; filename=\"{filename}\""}
    return Response(content=candidate.resume_pdf, media_type="application/pdf", headers=headers)
