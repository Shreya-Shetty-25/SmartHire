"""Dashboard analytics endpoint — aggregated stats for the admin dashboard."""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_user
from ..models import Candidate, Job, JobRankResult, JobRankRun, User

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/stats")
async def dashboard_stats(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
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

    # jobs with candidate counts
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
        .limit(10)
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

    # top ranked candidates across all jobs
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
        .limit(5)
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

    return {
        "total_jobs": total_jobs,
        "total_candidates": total_candidates,
        "total_rank_runs": total_rank_runs,
        "total_ranked": total_ranked,
        "total_passed": total_passed,
        "jobs_summary": jobs_summary,
        "recent_candidates": recent_candidates,
        "top_candidates": top_candidates,
    }
