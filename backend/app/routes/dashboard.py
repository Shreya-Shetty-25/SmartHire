"""Dashboard analytics endpoint — aggregated stats for the admin dashboard."""

from collections import Counter, defaultdict
from datetime import datetime, timezone
from statistics import median

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..background_jobs import list_background_jobs
from ..db import get_db
from ..deps import get_current_admin, get_current_staff
from ..models import Candidate, Job, JobCandidateProgress, JobRankResult, JobRankRun, User
from ..pipeline import PIPELINE_STAGES

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/stats")
async def dashboard_stats(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> dict:
    # total jobs
    total_jobs = await db.scalar(select(func.count(Job.id))) or 0

    # total candidates
    total_candidates = await db.scalar(select(func.count(Candidate.id))) or 0

    # total rank runs (assessments triggered)
    total_rank_runs = await db.scalar(select(func.count(JobRankRun.id))) or 0

    # candidates ranked that passed
    total_passed = await db.scalar(
        select(func.count(JobRankResult.id)).where(JobRankResult.passed.is_(True))
    ) or 0
    total_ranked = await db.scalar(select(func.count(JobRankResult.id))) or 0

    # jobs with candidate counts (cap at top 100 most-recent jobs)
    stmt = (
        select(
            Job.id,
            Job.title,
            Job.location,
            Job.employment_type,
            Job.created_at,
            func.count(JobRankResult.candidate_id.distinct()).label("candidate_count"),
        )
        .outerjoin(JobRankRun, JobRankRun.job_id == Job.id)
        .outerjoin(JobRankResult, JobRankResult.run_id == JobRankRun.id)
        .group_by(Job.id)
        .order_by(Job.created_at.desc())
        .limit(100)
    )
    rows = (await db.execute(stmt)).all()
    jobs_summary = [
        {
            "id": r.id,
            "title": r.title,
            "location": r.location,
            "employment_type": r.employment_type,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "candidate_count": r.candidate_count or 0,
        }
        for r in rows
    ]

    # recent candidates (last 8)
    recent_cands = (
        await db.execute(
            select(Candidate.id, Candidate.full_name, Candidate.email, Candidate.skills, Candidate.created_at)
            .order_by(Candidate.created_at.desc())
            .limit(8)
        )
    ).all()
    recent_candidates = [
        {
            "id": c.id,
            "full_name": c.full_name,
            "email": c.email,
            "skills": (c.skills or [])[:5],
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in recent_cands
    ]

    # top ranked candidates across all jobs (cap at 50)
    top_stmt = (
        select(
            JobRankResult.candidate_id,
            JobRankResult.score,
            JobRankResult.passed,
            Candidate.full_name,
            Candidate.email,
            Job.title.label("job_title"),
        )
        .join(Candidate, Candidate.id == JobRankResult.candidate_id)
        .join(JobRankRun, JobRankRun.id == JobRankResult.run_id)
        .join(Job, Job.id == JobRankRun.job_id)
        .order_by(JobRankResult.score.desc())
        .limit(50)
    )
    top_rows = (await db.execute(top_stmt)).all()
    top_candidates = [
        {
            "candidate_id": r.candidate_id,
            "full_name": r.full_name,
            "email": r.email,
            "score": round(r.score, 1),
            "passed": r.passed,
            "job_title": r.job_title,
        }
        for r in top_rows
    ]

    progress_rows = (
        await db.execute(
            select(
                JobCandidateProgress.job_id,
                JobCandidateProgress.stage,
                JobCandidateProgress.assessment_score,
                JobCandidateProgress.manual_assessment_score,
                JobCandidateProgress.manual_rank_score,
                JobCandidateProgress.decision_history,
            )
        )
    ).all()

    pipeline_counter: Counter[str] = Counter()
    analytics_by_job: dict[int, dict] = defaultdict(
        lambda: {
            "funnel": Counter(),
            "assessment_scores": [],
            "drop_off_reasons": Counter(),
        }
    )

    for row in progress_rows:
        stage = str(row.stage or "applied")
        pipeline_counter[stage] += 1
        job_bucket = analytics_by_job[int(row.job_id)]
        job_bucket["funnel"][stage] += 1

        score = row.manual_assessment_score if row.manual_assessment_score is not None else row.assessment_score
        if score is not None:
            try:
                job_bucket["assessment_scores"].append(float(score))
            except Exception:
                pass

        if stage == "rejected":
            history = row.decision_history if isinstance(row.decision_history, list) else []
            reason = None
            for item in reversed(history):
                if not isinstance(item, dict):
                    continue
                details = item.get("details")
                if isinstance(details, dict) and details.get("reason"):
                    reason = str(details["reason"]).strip()
                    break
                note = str(item.get("note") or "").strip()
                if note:
                    reason = note
                    break
            job_bucket["drop_off_reasons"][reason or "manual review"] += 1

    job_meta = {
        int(job.id): job
        for job in (
            await db.execute(
                select(Job).order_by(Job.created_at.desc()).limit(500)
            )
        ).scalars().all()
    }
    job_analytics = []
    for job_id, bucket in analytics_by_job.items():
        scores = bucket["assessment_scores"]
        drop_off_reasons = bucket["drop_off_reasons"].most_common(3)
        shortlisted = int(bucket["funnel"].get("shortlisted", 0))
        hired = int(bucket["funnel"].get("hired", 0))
        job = job_meta.get(job_id)
        job_analytics.append(
            {
                "job_id": job_id,
                "job_title": getattr(job, "title", f"Job {job_id}"),
                "funnel": dict(bucket["funnel"]),
                "median_assessment_score": round(float(median(scores)), 1) if scores else None,
                "drop_off_reasons": [
                    {"reason": reason, "count": count}
                    for reason, count in drop_off_reasons
                ],
                "shortlist_to_hire_ratio": round((hired / shortlisted), 2) if shortlisted else 0.0,
            }
        )
    job_analytics.sort(key=lambda item: str(item.get("job_title") or ""))

    return {
        "total_jobs": total_jobs,
        "total_candidates": total_candidates,
        "total_rank_runs": total_rank_runs,
        "total_ranked": total_ranked,
        "total_passed": total_passed,
        "pipeline_overview": dict(pipeline_counter),
        "job_analytics": job_analytics,
        "background_jobs": list_background_jobs()[:10],
        "jobs_summary": jobs_summary,
        "recent_candidates": recent_candidates,
        "top_candidates": top_candidates,
    }


@router.get("/funnel")
async def hiring_funnel(
    db: AsyncSession = Depends(get_db),
    _staff: User = Depends(get_current_staff),
    job_id: int | None = Query(default=None),
) -> dict:
    """Hiring funnel: conversion rates and counts across all pipeline stages."""
    q = select(JobCandidateProgress.stage, func.count(JobCandidateProgress.id).label("cnt"))
    if job_id:
        q = q.where(JobCandidateProgress.job_id == job_id)
    q = q.group_by(JobCandidateProgress.stage)
    rows = (await db.execute(q)).all()

    stage_counts: dict[str, int] = {r.stage: int(r.cnt) for r in rows}
    total = sum(stage_counts.values()) or 1

    funnel = []
    for stage in PIPELINE_STAGES:
        count = stage_counts.get(stage, 0)
        funnel.append({
            "stage": stage,
            "count": count,
            "percent": round(count / total * 100, 1),
        })

    # Time-to-hire: average days from applied → hired
    time_to_hire_rows = (await db.execute(
        select(
            JobCandidateProgress.created_at,
            JobCandidateProgress.updated_at,
        ).where(JobCandidateProgress.stage == "hired")
    )).all()
    times = []
    for row in time_to_hire_rows:
        if row.created_at and row.updated_at:
            diff = (row.updated_at - row.created_at).total_seconds() / 86400
            if diff >= 0:
                times.append(diff)
    avg_days_to_hire = round(sum(times) / len(times), 1) if times else None

    # Stage-by-stage drop off
    ordered_counts = [stage_counts.get(s, 0) for s in PIPELINE_STAGES]
    drop_off = []
    for i in range(1, len(PIPELINE_STAGES)):
        prev = ordered_counts[i - 1]
        curr = ordered_counts[i]
        dropped = max(0, prev - curr)
        drop_off.append({
            "from_stage": PIPELINE_STAGES[i - 1],
            "to_stage": PIPELINE_STAGES[i],
            "dropped": dropped,
            "drop_rate": round(dropped / prev * 100, 1) if prev else 0.0,
        })

    return {
        "funnel": funnel,
        "drop_off": drop_off,
        "avg_days_to_hire": avg_days_to_hire,
        "total_in_pipeline": sum(stage_counts.values()),
        "job_id": job_id,
    }
