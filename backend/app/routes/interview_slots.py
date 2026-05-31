"""Interview slot management — admin creates slots, candidates self-book."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_staff, get_current_user
from ..models import Candidate, InterviewScorecard, InterviewSlot, Job, JobCandidateProgress, Notification, User
from ..pipeline_service import apply_progress_update, get_or_create_progress
from ..pipeline import normalize_pipeline_stage
from ..schemas import InterviewSlotCreate, InterviewSlotResponse, ScorecardCreate
from ..emailer import send_email

router = APIRouter(prefix="/api/interview-slots", tags=["interview_slots"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _create_notification(
    db: AsyncSession,
    *,
    user_id: int,
    notif_type: str,
    title: str,
    message: str,
    data: dict | None = None,
) -> None:
    notif = Notification(
        user_id=user_id,
        notif_type=notif_type,
        title=title,
        message=message,
        data=data,
    )
    db.add(notif)


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.post("", response_model=InterviewSlotResponse)
async def create_slot(
    payload: InterviewSlotCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_staff),
) -> InterviewSlot:
    if payload.end_time <= payload.start_time:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")
    job = await db.get(Job, int(payload.job_id))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    slot = InterviewSlot(
        job_id=int(payload.job_id),
        interviewer_user_id=payload.interviewer_user_id,
        start_time=payload.start_time,
        end_time=payload.end_time,
        meeting_link=payload.meeting_link,
        notes=payload.notes,
    )
    db.add(slot)
    await db.commit()
    await db.refresh(slot)
    return slot


@router.get("", response_model=list[InterviewSlotResponse])
async def list_slots(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_staff),
    job_id: int | None = Query(default=None),
    available_only: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[InterviewSlot]:
    q = select(InterviewSlot).order_by(InterviewSlot.start_time).limit(limit).offset(offset)
    if job_id is not None:
        q = q.where(InterviewSlot.job_id == int(job_id))
    if available_only:
        q = q.where(InterviewSlot.is_booked.is_(False))
    result = await db.execute(q)
    return list(result.scalars().all())


@router.delete("/{slot_id}")
async def delete_slot(
    slot_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_staff),
) -> dict:
    slot = await db.get(InterviewSlot, slot_id)
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")
    if slot.is_booked:
        raise HTTPException(status_code=400, detail="Cannot delete a booked slot")
    await db.delete(slot)
    await db.commit()
    return {"ok": True}


@router.patch("/{slot_id}/assign-interviewer")
async def assign_interviewer(
    slot_id: int,
    interviewer_user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_staff),
) -> InterviewSlotResponse:
    slot = await db.get(InterviewSlot, slot_id)
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")
    interviewer = await db.get(User, interviewer_user_id)
    if not interviewer:
        raise HTTPException(status_code=404, detail="Interviewer not found")
    slot.interviewer_user_id = interviewer_user_id
    await db.commit()
    await db.refresh(slot)
    return slot


# ── Candidate: view available slots for a job ─────────────────────────────────

@router.get("/available", response_model=list[InterviewSlotResponse])
async def candidate_available_slots(
    job_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[InterviewSlot]:
    result = await db.execute(
        select(InterviewSlot)
        .where(
            InterviewSlot.job_id == int(job_id),
            InterviewSlot.is_booked.is_(False),
            InterviewSlot.start_time > _now(),
        )
        .order_by(InterviewSlot.start_time)
        .limit(50)
    )
    return list(result.scalars().all())


@router.post("/{slot_id}/book")
async def book_slot(
    slot_id: int,
    job_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Candidate self-books an available interview slot."""
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role != "candidate":
        raise HTTPException(status_code=403, detail="Only candidates can book slots")

    slot = await db.scalar(
        select(InterviewSlot).where(InterviewSlot.id == slot_id).with_for_update()
    )
    if not slot or int(slot.job_id) != int(job_id):
        raise HTTPException(status_code=404, detail="Slot not found for this job")
    if slot.is_booked:
        raise HTTPException(status_code=409, detail="This slot is already booked")
    if slot.start_time <= _now():
        raise HTTPException(status_code=400, detail="This slot is in the past")

    # Get candidate record
    from sqlalchemy import func
    candidate = await db.scalar(
        select(Candidate).where(
            func.lower(Candidate.email) == str(current_user.email or "").strip().lower()
        )
    )
    if not candidate:
        raise HTTPException(status_code=400, detail="Complete your candidate profile first")

    progress = await get_or_create_progress(
        db=db, job_id=int(job_id), candidate_id=int(candidate.id), default_stage="applied"
    )
    apply_progress_update(
        progress,
        actor=str(current_user.email),
        action="interview_scheduled",
        stage="interview_scheduled",
        interview_scheduled_for=slot.start_time,
        interview_status="scheduled",
        details={"slot_id": slot_id, "meeting_link": slot.meeting_link},
    )
    progress.interviewer_user_id = slot.interviewer_user_id

    slot.is_booked = True
    slot.progress_id = int(progress.id)

    # Notify candidate
    await _create_notification(
        db,
        user_id=int(current_user.id),
        notif_type="interview_scheduled",
        title="Interview Scheduled",
        message=f"Your interview for this role is scheduled on {slot.start_time.strftime('%d %b %Y at %H:%M')} UTC.",
        data={"slot_id": slot_id, "meeting_link": slot.meeting_link},
    )

    # Notify interviewer if assigned
    if slot.interviewer_user_id:
        await _create_notification(
            db,
            user_id=int(slot.interviewer_user_id),
            notif_type="interview_scheduled",
            title="Interview Booked",
            message=f"A candidate has booked your interview slot on {slot.start_time.strftime('%d %b %Y at %H:%M')} UTC.",
            data={"slot_id": slot_id, "candidate_email": str(current_user.email)},
        )

    await db.commit()

    # Send confirmation email to candidate
    try:
        job = await db.get(Job, int(job_id))
        job_title = getattr(job, "title", "the role")
        meeting_info = f"\nMeeting Link: {slot.meeting_link}" if slot.meeting_link else ""
        send_email(
            to_email=str(current_user.email),
            subject=f"Interview Scheduled — {job_title}",
            body=(
                f"Hi {getattr(candidate, 'full_name', 'Candidate')},\n\n"
                f"Your interview for '{job_title}' is confirmed.\n"
                f"Date & Time: {slot.start_time.strftime('%d %B %Y at %H:%M')} UTC{meeting_info}\n\n"
                "Best of luck!\nSmartHire Team"
            ),
        )
    except Exception:
        pass  # Email failure should not block booking

    return {"ok": True, "slot_id": slot_id, "start_time": slot.start_time.isoformat()}


# ── Scorecard endpoints ───────────────────────────────────────────────────────

@router.post("/scorecards/{progress_id}")
async def submit_scorecard(
    progress_id: int,
    payload: ScorecardCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    progress = await db.get(JobCandidateProgress, progress_id)
    if not progress:
        raise HTTPException(status_code=404, detail="Progress record not found")
    scorecard = InterviewScorecard(
        progress_id=progress_id,
        interviewer_user_id=int(current_user.id),
        overall_rating=payload.overall_rating,
        technical_rating=payload.technical_rating,
        communication_rating=payload.communication_rating,
        culture_fit_rating=payload.culture_fit_rating,
        recommendation=payload.recommendation,
        notes=payload.notes,
    )
    db.add(scorecard)
    apply_progress_update(
        progress,
        actor=str(current_user.email),
        action="scorecard_submitted",
        stage="interview_completed",
        details={"recommendation": payload.recommendation, "overall_rating": payload.overall_rating},
    )
    await db.commit()
    await db.refresh(scorecard)
    return {
        "id": scorecard.id,
        "progress_id": progress_id,
        "recommendation": scorecard.recommendation,
        "overall_rating": scorecard.overall_rating,
    }


@router.get("/scorecards/{progress_id}")
async def get_scorecard(
    progress_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_staff),
) -> dict:
    result = await db.execute(
        select(InterviewScorecard).where(InterviewScorecard.progress_id == progress_id).order_by(InterviewScorecard.created_at.desc())
    )
    rows = list(result.scalars().all())
    return {
        "progress_id": progress_id,
        "scorecards": [
            {
                "id": sc.id,
                "interviewer_user_id": sc.interviewer_user_id,
                "overall_rating": sc.overall_rating,
                "technical_rating": sc.technical_rating,
                "communication_rating": sc.communication_rating,
                "culture_fit_rating": sc.culture_fit_rating,
                "recommendation": sc.recommendation,
                "notes": sc.notes,
                "created_at": sc.created_at.isoformat() if sc.created_at else None,
            }
            for sc in rows
        ],
    }
