from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Candidate, Job, JobCandidateProgress, JobRankResult, JobRankRun
from .pipeline import append_history_entry, normalize_pipeline_stage


async def get_or_create_progress(
    *,
    db: AsyncSession,
    job_id: int,
    candidate_id: int,
    default_stage: str = "applied",
) -> JobCandidateProgress:
    stmt = select(JobCandidateProgress).where(
        JobCandidateProgress.job_id == int(job_id),
        JobCandidateProgress.candidate_id == int(candidate_id),
    )
    progress = await db.scalar(stmt)
    if progress:
        return progress

    progress = JobCandidateProgress(
        job_id=int(job_id),
        candidate_id=int(candidate_id),
        stage=normalize_pipeline_stage(default_stage),
        decision_history=append_history_entry(
            [],
            action="created",
            stage=default_stage,
            actor="system",
            details={"source": "auto_upsert"},
        ),
    )
    db.add(progress)
    await db.flush()
    return progress


def apply_progress_update(
    progress: JobCandidateProgress,
    *,
    actor: str,
    action: str,
    stage: str | None = None,
    recruiter_notes: str | None = None,
    manual_rank_score: float | None = None,
    manual_assessment_score: float | None = None,
    assessment_status: str | None = None,
    assessment_passed: bool | None = None,
    last_assessment_session_code: str | None = None,
    interview_scheduled_for: datetime | None = None,
    interview_status: str | None = None,
    append_note: str | None = None,
    details: dict | None = None,
) -> JobCandidateProgress:
    normalized_stage = normalize_pipeline_stage(stage or progress.stage)
    stage_changed = normalized_stage != progress.stage

    if stage:
        progress.stage = normalized_stage
    if recruiter_notes is not None:
        progress.recruiter_notes = recruiter_notes.strip() or None
    if manual_rank_score is not None:
        progress.manual_rank_score = float(manual_rank_score)
    if manual_assessment_score is not None:
        progress.manual_assessment_score = float(manual_assessment_score)
    if assessment_status is not None:
        progress.assessment_status = str(assessment_status).strip() or None
    if assessment_passed is not None:
        progress.assessment_passed = bool(assessment_passed)
    if last_assessment_session_code is not None:
        progress.last_assessment_session_code = str(last_assessment_session_code).strip() or None
    if interview_scheduled_for is not None:
        progress.interview_scheduled_for = interview_scheduled_for
    if interview_status is not None:
        progress.interview_status = str(interview_status).strip() or None

    if stage_changed or recruiter_notes is not None or append_note or details or action:
        progress.decision_history = append_history_entry(
            progress.decision_history,
            action=action,
            stage=progress.stage,
            actor=actor,
            note=append_note or recruiter_notes,
            details=details,
        )

    progress.updated_at = datetime.now(timezone.utc)
    return progress


async def hydrate_candidate_progress_rows(
    *,
    db: AsyncSession,
    candidate_id: int,
) -> list[dict]:
    stmt = (
        select(JobCandidateProgress, Job.title)
        .join(Job, Job.id == JobCandidateProgress.job_id)
        .where(JobCandidateProgress.candidate_id == int(candidate_id))
        .order_by(desc(JobCandidateProgress.updated_at), desc(JobCandidateProgress.created_at))
    )
    rows = (await db.execute(stmt)).all()
    out: list[dict] = []
    for progress, job_title in rows:
        out.append(
            {
                "id": progress.id,
                "job_id": progress.job_id,
                "job_title": job_title,
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
        )
    return out


async def latest_progress_by_candidate(
    *,
    db: AsyncSession,
    candidate_ids: list[int],
) -> dict[int, JobCandidateProgress]:
    if not candidate_ids:
        return {}

    latest_ts = (
        select(
            JobCandidateProgress.candidate_id.label("candidate_id"),
            func.max(func.coalesce(JobCandidateProgress.updated_at, JobCandidateProgress.created_at)).label("latest_ts"),
        )
        .where(JobCandidateProgress.candidate_id.in_(candidate_ids))
        .group_by(JobCandidateProgress.candidate_id)
        .subquery()
    )

    stmt = (
        select(JobCandidateProgress)
        .join(
            latest_ts,
            and_(
                latest_ts.c.candidate_id == JobCandidateProgress.candidate_id,
                latest_ts.c.latest_ts == func.coalesce(JobCandidateProgress.updated_at, JobCandidateProgress.created_at),
            ),
        )
    )
    rows = (await db.execute(stmt)).scalars().all()
    return {row.candidate_id: row for row in rows}


async def build_job_pipeline_rows(
    *,
    db: AsyncSession,
    job_id: int,
) -> list[dict]:
    latest_rank = (
        select(
            JobRankRun.job_id.label("job_id"),
            JobRankResult.candidate_id.label("candidate_id"),
            JobRankResult.score.label("score"),
            JobRankResult.passed.label("passed"),
            func.row_number()
            .over(
                partition_by=JobRankResult.candidate_id,
                order_by=(JobRankRun.created_at.desc(), JobRankResult.id.desc()),
            )
            .label("row_num"),
        )
        .join(JobRankRun, JobRankRun.id == JobRankResult.run_id)
        .where(JobRankRun.job_id == int(job_id))
        .subquery()
    )

    stmt = (
        select(Candidate, JobCandidateProgress, latest_rank.c.score, latest_rank.c.passed)
        .join(JobCandidateProgress, JobCandidateProgress.candidate_id == Candidate.id)
        .outerjoin(
            latest_rank,
            and_(
                latest_rank.c.candidate_id == Candidate.id,
                latest_rank.c.row_num == 1,
            ),
        )
        .where(JobCandidateProgress.job_id == int(job_id))
        .order_by(desc(JobCandidateProgress.updated_at), Candidate.full_name.asc())
    )
    rows = (await db.execute(stmt)).all()
    out: list[dict] = []
    for candidate, progress, score, passed in rows:
        out.append(
            {
                "candidate": candidate,
                "progress": {
                    "id": progress.id,
                    "job_id": progress.job_id,
                    "job_title": None,
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
                },
                "latest_rank_score": (float(score) if score is not None else None),
                "latest_rank_passed": (bool(passed) if passed is not None else None),
            }
        )
    return out
