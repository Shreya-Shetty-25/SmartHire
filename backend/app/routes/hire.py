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
from ..shortlist import bm25_shortlist

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

    query_parts = [job.title, job.description]
    if job.skills_required:
        query_parts.append(" ".join(job.skills_required))
    if job.additional_skills:
        query_parts.append(" ".join(job.additional_skills))
    query = "\n".join([p for p in query_parts if p]).strip()

    scored = bm25_shortlist(query=query, candidates=candidates, limit=payload.limit)
    logger.info(
        "BM25 shortlist: job_id={} candidates={} query_chars={} scored={}",
        job.id,
        len(candidates),
        len(query),
        len(scored),
    )
    print("BM25 shortlist results:")
    if not scored and candidates:
        # Extremely defensive fallback: if scoring returns nothing, still return top-N.
        scored = [(c, 0.0) for c in candidates[: payload.limit]]

    # Always return the top-N list (even if some scores are 0) so the UI has candidates to pick.
    items = [HireShortlistItem(candidate=c, score=score) for (c, score) in scored]
    print(items)
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

    ranked = await rank_candidates_with_llm(job=job, candidates=candidates, threshold_score=payload.threshold_score)

    run = JobRankRun(
        job_id=job.id,
        created_by_user_id=user.id,
        threshold_score=payload.threshold_score,
        source=payload.source,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    # Persist results
    results_sorted = sorted(ranked, key=lambda r: r.score, reverse=True)
    for r in results_sorted:
        analysis = {
            "strengths": r.strengths,
            "concerns": r.concerns,
            "summary": r.summary,
        }
        db.add(
            JobRankResult(
                run_id=run.id,
                candidate_id=r.candidate_id,
                score=r.score,
                passed=bool(r.passed),
                analysis=analysis,
            )
        )

    await db.commit()

    # Response includes candidate details for UI
    by_id = {c.id: c for c in candidates}
    response_items: list[HireRankResultItem] = []
    for r in results_sorted:
        c = by_id.get(r.candidate_id)
        if not c:
            continue
        response_items.append(
            HireRankResultItem(
                candidate=c,
                score=r.score,
                passed=bool(r.passed),
                analysis={
                    "strengths": r.strengths,
                    "concerns": r.concerns,
                    "summary": r.summary,
                },
            )
        )

    return HireRankResponse(
        run_id=run.id,
        job_id=job.id,
        threshold_score=payload.threshold_score,
        results=response_items,
    )
