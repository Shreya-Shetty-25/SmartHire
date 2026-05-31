from __future__ import annotations

from datetime import datetime, timezone

from loguru import logger
from sqlalchemy import and_, desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Candidate, Job, JobCandidateProgress, JobRankResult, JobRankRun, Notification, User
from .pipeline import PIPELINE_STAGES, append_history_entry, normalize_pipeline_stage

# Human-readable labels for pipeline stage notifications
_STAGE_MESSAGES: dict[str, tuple[str, str]] = {
    "shortlisted": ("Application Shortlisted", "Great news! Your application has been shortlisted."),
    "assessment_sent": ("Assessment Invitation", "You have been invited to take an assessment. Check your email for the link."),
    "assessment_passed": ("Assessment Passed", "Congratulations! You passed the assessment."),
    "assessment_failed": ("Assessment Result", "Thank you for taking the assessment. We will review your results."),
    "interview_scheduled": ("Interview Scheduled", "Your interview has been scheduled. Check your email for details."),
    "interview_completed": ("Interview Completed", "Your interview has been recorded as completed."),
    "offer_sent": ("Job Offer", "You have received a job offer! Log in to review and respond."),
    "offer_accepted": ("Offer Accepted", "You have successfully accepted the offer. Welcome aboard!"),
    "offer_rejected": ("Offer Declined", "You have declined the offer. Thank you for your time."),
    "hired": ("Hired!", "Congratulations — you have been hired!"),
    "rejected": ("Application Update", "Thank you for your interest. We have decided to move forward with other candidates at this time."),
}


async def _emit_stage_notification(
    db: AsyncSession,
    *,
    progress: JobCandidateProgress,
    new_stage: str,
) -> None:
    """Create an in-app notification and send an email when a pipeline stage changes."""
    if new_stage not in _STAGE_MESSAGES:
        return

    title, message = _STAGE_MESSAGES[new_stage]

    # Look up the candidate's user account
    try:
        candidate = await db.get(Candidate, int(progress.candidate_id))
        if not candidate:
            return
        candidate_user = await db.scalar(
            select(User).where(
                func.lower(User.email) == str(candidate.email or "").strip().lower()
            )
        )
        if candidate_user:
            notif = Notification(
                user_id=int(candidate_user.id),
                notif_type="stage_change",
                title=title,
                message=message,
                data={"stage": new_stage, "job_id": int(progress.job_id)},
            )
            db.add(notif)

        # Also send email notification
        try:
            import asyncio as _asyncio
            from .emailer import send_email
            job = await db.get(Job, int(progress.job_id))
            job_title = getattr(job, "title", "your applied role")
            await _asyncio.to_thread(
                send_email,
                to_email=str(candidate.email),
                subject=f"{title} — {job_title}",
                body=(
                    f"Hi {candidate.full_name or 'Candidate'},\n\n"
                    f"{message}\n\n"
                    f"Position: {job_title}\n\n"
                    "Log into SmartHire to view your application status.\n\n"
                    "Best regards,\nSmartHire Team"
                ),
            )
        except Exception as email_exc:
            logger.debug("Stage notification email failed: {}", email_exc)
    except Exception as exc:
        logger.debug("Could not emit stage notification: {}", exc)




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
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        progress = await db.scalar(stmt)
        if progress:
            return progress
        raise
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
    if stage is not None and str(stage).strip() and str(stage).strip() not in PIPELINE_STAGES:
        logger.warning(
            "pipeline_service.apply_progress_update: unknown stage {!r} requested for "
            "progress id={} job_id={} candidate_id={} — coercing to 'applied'",
            stage,
            progress.id,
            progress.job_id,
            progress.candidate_id,
        )
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


async def apply_progress_update_with_notification(
    db: AsyncSession,
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
    """Like apply_progress_update but also emits in-app notification + email on stage change."""
    old_stage = progress.stage
    apply_progress_update(
        progress,
        actor=actor,
        action=action,
        stage=stage,
        recruiter_notes=recruiter_notes,
        manual_rank_score=manual_rank_score,
        manual_assessment_score=manual_assessment_score,
        assessment_status=assessment_status,
        assessment_passed=assessment_passed,
        last_assessment_session_code=last_assessment_session_code,
        interview_scheduled_for=interview_scheduled_for,
        interview_status=interview_status,
        append_note=append_note,
        details=details,
    )
    if stage and progress.stage != old_stage:
        await _emit_stage_notification(db, progress=progress, new_stage=progress.stage)
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
