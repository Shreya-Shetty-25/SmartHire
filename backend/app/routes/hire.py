from __future__ import annotations
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from uuid import uuid4

from loguru import logger
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..candidate_ranker import rank_candidates_with_llm
from ..db import get_db
from ..deps import get_current_user
from ..models import Candidate, Job, JobRankResult, JobRankRun, User
from ..resume_parser import extract_text_from_pdf, parse_resume_pdf
from ..shortlist import JobRequirements, bm25_shortlist
from ..schemas import (
    CandidateResponse,
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
from ..embeddings import upsert_candidate_embeddings
from ..emailer import send_test_link_email
from ..config import settings

router = APIRouter(prefix="/api/hire", tags=["hire"])


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


def _generate_dynamic_session_code() -> str:
    return f"EXAM-{uuid4().hex[:10].upper()}"


@router.post("/send-test-link", response_model=HireSendTestLinkEmailResponse)
async def send_test_link(
    payload: HireSendTestLinkEmailRequest,
    _user: User = Depends(get_current_user),
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

        assessment_base = (settings.assessment_api_base_url or "").rstrip("/")
        if not assessment_base:
            raise HTTPException(status_code=500, detail="ASSESSMENT_API_BASE_URL is not configured")

        # Look up candidate skills from DB for resume-based question generation
        candidate_skills: list[str] | None = None
        try:
            candidate = await db.scalar(
                select(Candidate).where(Candidate.email.ilike(str(payload.candidate_email).lower()))
            )
            if candidate and candidate.skills:
                candidate_skills = candidate.skills
        except Exception:
            pass

        create_payload: dict = {
            "job_id": int(payload.job_id),
            "job_title": job.title,
            "job_description": job.description,
            "skills_required": job.skills_required,
            "additional_skills": job.additional_skills,
            "candidate_name": (payload.candidate_name or "Candidate").strip() or "Candidate",
            "candidate_email": str(payload.candidate_email),
            "question_count": 10,
            "difficulty": "hard",
        }
        if candidate_skills:
            create_payload["resume_skills"] = candidate_skills
        if payload.duration_minutes is not None:
            create_payload["duration_minutes"] = int(payload.duration_minutes)
        if payload.question_count is not None:
            create_payload["question_count"] = int(payload.question_count)
        if payload.difficulty and payload.difficulty.strip():
            create_payload["difficulty"] = payload.difficulty.strip()

        logger.info(
            "Creating assessment session before sending invite: candidate_email={} job_id={}",
            str(payload.candidate_email),
            int(payload.job_id),
        )

        resp = None
        try:
            async with httpx.AsyncClient(timeout=35.0) as client:
                resp = await client.post(f"{assessment_base}/api/exams/create", json=create_payload)
        except httpx.RequestError as exc:
            session_code = _generate_dynamic_session_code()
            logger.warning(
                "Assessment service unreachable while creating session: {}. Using fallback session_code={} for email.",
                exc,
                session_code,
            )
        except httpx.TimeoutException:
            session_code = _generate_dynamic_session_code()
            logger.warning(
                "Assessment service timed out while creating session. Using fallback session_code={} for email.",
                session_code,
            )

        if resp is not None:
            if resp.status_code >= 400:
                session_code = _generate_dynamic_session_code()
                try:
                    data = resp.json()
                    detail = data.get("detail") if isinstance(data, dict) else None
                except Exception:
                    detail = None
                logger.warning(
                    "Assessment create failed (status={} detail={}). Using fallback session_code={} for email.",
                    resp.status_code,
                    detail or (resp.text or "")[:200],
                    session_code,
                )
            else:
                data = resp.json()
                created_code = str(data.get("session_code") or "").strip().upper() or None
                session_code = created_code or _generate_dynamic_session_code()

    final_test_link = _compose_test_link_with_code(raw_link=payload.test_link, session_code=session_code or "")

    try:
        send_test_link_email(
            to_email=str(payload.candidate_email),
            candidate_name=payload.candidate_name,
            job_title=payload.job_title,
            test_link=final_test_link,
            session_code=session_code,
        )
    except Exception as exc:
        logger.exception(
            "Failed to send test link email: to={} session_code={} job_title={}",
            str(payload.candidate_email),
            session_code,
            payload.job_title,
        )
        raise HTTPException(status_code=502, detail=f"Email delivery failed: {exc}")

    logger.info(
        "Sent test link email: to={} job_title={} session_code={}",
        str(payload.candidate_email),
        payload.job_title,
        session_code,
    )

    return HireSendTestLinkEmailResponse(to=str(payload.candidate_email))


async def _upsert_candidate_from_pdf(
    *,
    db: AsyncSession,
    filename: str,
    pdf_bytes: bytes,
) -> Candidate:
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

        # Build/update embeddings for retrieval.
        try:
            await upsert_candidate_embeddings(db=db, candidate=existing, resume_text=resume_text)
        except Exception as exc:
            logger.warning(
                "Embeddings skipped for candidate {} ({}): {}",
                existing.id,
                existing.email,
                exc,
            )
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

    # Build embeddings for retrieval.
    try:
        await upsert_candidate_embeddings(db=db, candidate=candidate, resume_text=resume_text)
    except Exception as exc:
        logger.warning(
            "Embeddings skipped for candidate {} ({}): {}",
            candidate.id,
            candidate.email,
            exc,
        )
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

    # Use embedding cosine similarity over existing candidate dump.
    result = await db.execute(select(Candidate))
    candidates = list(result.scalars().all())

    effective_limit = min(int(payload.limit), 5)
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
