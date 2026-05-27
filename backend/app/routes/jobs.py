import json

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..background_jobs import schedule_job_embeddings
from ..config import settings
from ..db import get_db
from ..deps import get_current_admin
from ..models import Job, User
from ..resume_parser import _call_azure_openai, _call_groq, _call_gemini, _call_cerebras, _selected_provider
from ..schemas import JDGenerateRequest, JDGenerateResponse, JobCreate, JobResponse

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


async def _call_llm(prompt: str) -> str:
    provider = _selected_provider()
    if provider == "azure":
        return await _call_azure_openai(prompt)
    if provider == "groq":
        return await _call_groq(prompt)
    if provider == "cerebras":
        return await _call_cerebras(prompt)
    return await _call_gemini(prompt)


@router.get("", response_model=list[JobResponse])
async def list_jobs(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    templates_only: bool = Query(default=False),
) -> list[Job]:
    q = select(Job).order_by(Job.created_at.desc()).limit(limit).offset(offset)
    if templates_only:
        q = q.where(Job.is_template == True)  # noqa: E712
    result = await db.execute(q)
    return list(result.scalars().all())


@router.post("/generate-jd", response_model=JDGenerateResponse)
async def generate_jd(
    payload: JDGenerateRequest,
    _user: User = Depends(get_current_admin),
) -> JDGenerateResponse:
    salary_hint = ""
    if payload.salary_min and payload.salary_max:
        salary_hint = f"Salary range: {payload.salary_currency} {payload.salary_min:,.0f} – {payload.salary_max:,.0f} per annum."
    elif payload.salary_min:
        salary_hint = f"Salary: {payload.salary_currency} {payload.salary_min:,.0f}+ per annum."

    prompt = f"""You are an expert HR professional. Generate a complete, professional job description as strict JSON.

Role details:
- Title: {payload.role_title}
- Department: {payload.department or 'Not specified'}
- Employment type: {payload.employment_type or 'Full-time'}
- Years of experience required: {payload.years_experience if payload.years_experience is not None else 'Not specified'}
- Location: {payload.location or 'Not specified'}
- Key responsibilities hint: {payload.key_responsibilities or 'None provided'}
- Must-have skills hint: {payload.must_have_skills or 'None provided'}
{salary_hint}

Return ONLY this JSON (no markdown, no code fences):
{{
  "title": "<exact job title>",
  "description": "<full JD text: 4-6 paragraphs covering role overview, responsibilities, qualifications, and why join us>",
  "education": "<minimum education e.g. Bachelor's in Computer Science>",
  "years_experience": <integer or null>,
  "skills_required": ["skill1", "skill2", ...],
  "additional_skills": ["nice-to-have1", ...],
  "location": "<city/remote/hybrid>",
  "employment_type": "<Full-time/Part-time/Contract>",
  "salary_min": <number or null>,
  "salary_max": <number or null>
}}"""

    raw = await _call_llm(prompt)

    try:
        # Strip markdown fences if present
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```")[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
        data = json.loads(cleaned.strip())
    except Exception:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON for JD generation")

    return JDGenerateResponse(
        title=str(data.get("title") or payload.role_title),
        description=str(data.get("description") or ""),
        education=data.get("education"),
        years_experience=data.get("years_experience"),
        skills_required=data.get("skills_required") or [],
        additional_skills=data.get("additional_skills") or [],
        location=data.get("location") or payload.location,
        employment_type=data.get("employment_type") or payload.employment_type,
        salary_min=data.get("salary_min") or payload.salary_min,
        salary_max=data.get("salary_max") or payload.salary_max,
    )


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
        status=payload.status or "active",
        department_id=payload.department_id,
        salary_min=payload.salary_min,
        salary_max=payload.salary_max,
        salary_currency=payload.salary_currency or "INR",
        requisition_id=payload.requisition_id,
        is_template=payload.is_template,
        template_name=payload.template_name,
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
    job.status = payload.status or "active"
    job.department_id = payload.department_id
    job.salary_min = payload.salary_min
    job.salary_max = payload.salary_max
    job.salary_currency = payload.salary_currency or "INR"
    job.requisition_id = payload.requisition_id
    job.is_template = payload.is_template
    job.template_name = payload.template_name
    await db.commit()
    await db.refresh(job)

    try:
        schedule_job_embeddings(job.id)
    except Exception as exc:
        logger.warning("Failed to queue job embeddings for job {}: {}", job.id, exc)
    return job


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> None:
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    await db.delete(job)
    await db.commit()

