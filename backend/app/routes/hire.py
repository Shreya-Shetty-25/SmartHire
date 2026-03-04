from __future__ import annotations

from loguru import logger
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..candidate_ranker import rank_candidates_with_llm
from ..db import get_db
from ..deps import get_current_user
from ..models import Candidate, Job, JobRankResult, JobRankRun, User
from ..resume_parser import parse_resume_pdf
from ..schemas import (
    CandidateResponse,
    HireRankRequest,
    HireRankResponse,
    HireRankResultItem,
    HireShortlistRequest,
    HireShortlistResponse,
    HireShortlistItem,
)
from ..shortlist import JobRequirements, bm25_shortlist

router = APIRouter(prefix="/api/hire", tags=["hire"])


async def _upsert_candidate_from_pdf(
    *,
    db: AsyncSession,
    filename: str,
    pdf_bytes: bytes,
) -> Candidate:
    parsed = await parse_resume_pdf(pdf_bytes)
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
    return candidate


@router.post("/resumes/upload", response_model=list[CandidateResponse])
async def bulk_upload_resumes(
    files: list[UploadFile] = File(...),
    job_id: int | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
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
        out.append(candidate)

    return out


@router.post("/shortlist", response_model=HireShortlistResponse)
async def shortlist_from_dump(
    payload: HireShortlistRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> HireShortlistResponse:
    job = await db.get(Job, payload.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Use a non-LLM lexical retrieval method (BM25) over existing candidate fields.
    result = await db.execute(select(Candidate))
    candidates = list(result.scalars().all())

    req = JobRequirements(
        skills_required=job.skills_required,
        additional_skills=job.additional_skills,
        education=job.education,
        location=job.location,
        years_experience=job.years_experience,
    )

    effective_limit = min(int(payload.limit), 5)
    scored = bm25_shortlist(job=req, candidates=candidates, limit=effective_limit, threshold=0.0)
    logger.info(
        "BM25 shortlist: job_id={} candidates={} scored={} (top_n={})",
        job.id,
        len(candidates),
        len(scored),
        effective_limit,
    )
    items = [HireShortlistItem(candidate=c, score=score) for (c, score) in scored]
    return HireShortlistResponse(job_id=job.id, results=items)


@router.post("/rank", response_model=HireRankResponse)
async def rank_candidates(
    payload: HireRankRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
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

        merged_results.append(
            HireRankResultItem(
                candidate=c,
                score=score,
                passed=passed,
                analysis=analysis,
            )
        )

    await db.commit()

    merged_results.sort(key=lambda x: x.score, reverse=True)

    return HireRankResponse(
        run_id=run.id,
        job_id=job.id,
        threshold_score=payload.threshold_score,
        results=merged_results,
    )
