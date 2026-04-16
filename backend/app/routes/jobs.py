from fastapi import APIRouter, Depends, HTTPException, status
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..background_jobs import schedule_job_embeddings
from ..db import get_db
from ..deps import get_current_admin
from ..models import Job, User
from ..schemas import JobCreate, JobResponse

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("", response_model=list[JobResponse])
async def list_jobs(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> list[Job]:
    result = await db.execute(select(Job).order_by(Job.created_at.desc()))
    return list(result.scalars().all())


@router.post("", response_model=JobResponse, status_code=status.HTTP_201_CREATED)
async def create_job(
    payload: JobCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> Job:
    job = Job(
        title=payload.title.strip(),
        description=payload.description.strip(),
        education=(payload.education.strip() if payload.education else None),
        years_experience=payload.years_experience,
        skills_required=payload.skills_required,
        additional_skills=payload.additional_skills,
        location=(payload.location.strip() if payload.location else None),
        employment_type=(payload.employment_type.strip() if payload.employment_type else None),
    )

    db.add(job)
    await db.commit()
    await db.refresh(job)

    try:
        schedule_job_embeddings(job.id)
    except Exception as exc:
        logger.warning("Failed to queue job embeddings for job {}: {}", job.id, exc)
    return job


@router.get("/{job_id}", response_model=JobResponse)
async def get_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> Job:
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.put("/{job_id}", response_model=JobResponse)
async def update_job(
    job_id: int,
    payload: JobCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> Job:
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    job.title = payload.title.strip()
    job.description = payload.description.strip()
    job.education = payload.education.strip() if payload.education else None
    job.years_experience = payload.years_experience
    job.skills_required = payload.skills_required
    job.additional_skills = payload.additional_skills
    job.location = payload.location.strip() if payload.location else None
    job.employment_type = payload.employment_type.strip() if payload.employment_type else None

    await db.commit()
    await db.refresh(job)

    try:
        schedule_job_embeddings(job.id)
    except Exception as exc:
        logger.warning("Failed to queue job embeddings for job {}: {}", job.id, exc)
    return job
