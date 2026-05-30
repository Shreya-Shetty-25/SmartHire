"""Offer management — create, track, and respond to job offers."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_staff, get_current_user
from ..emailer import send_email
from ..models import Candidate, Job, JobCandidateProgress, Notification, Offer, User
from ..pipeline_service import apply_progress_update, get_or_create_progress
from ..schemas import OfferCreate, OfferResponse

router = APIRouter(prefix="/api/offers", tags=["offers"])


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
    notif = Notification(user_id=user_id, notif_type=notif_type, title=title, message=message, data=data)
    db.add(notif)


# ── Admin / Recruiter / Hiring Manager endpoints ──────────────────────────────

@router.post("", response_model=OfferResponse)
async def create_offer(
    payload: OfferCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_staff),
) -> Offer:
    job = await db.get(Job, int(payload.job_id))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    candidate = await db.get(Candidate, int(payload.candidate_id))
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    progress = await get_or_create_progress(
        db=db, job_id=int(payload.job_id), candidate_id=int(payload.candidate_id)
    )
    apply_progress_update(
        progress,
        actor=str(current_user.email),
        action="offer_sent",
        stage="offer_sent",
        details={"salary": str(payload.offered_salary or ""), "currency": payload.salary_currency},
    )

    offer = Offer(
        job_id=int(payload.job_id),
        candidate_id=int(payload.candidate_id),
        progress_id=int(progress.id),
        offered_by_user_id=int(current_user.id),
        offered_salary=payload.offered_salary,
        salary_currency=payload.salary_currency,
        response_deadline=payload.response_deadline,
        offer_letter_text=payload.offer_letter_text,
        notes=payload.notes,
        status="pending",
    )
    db.add(offer)
    await db.flush()

    # Find candidate's user account for notification
    from sqlalchemy import func
    candidate_user = await db.scalar(
        select(User).where(func.lower(User.email) == str(candidate.email or "").strip().lower())
    )
    if candidate_user:
        await _create_notification(
            db,
            user_id=int(candidate_user.id),
            notif_type="offer_sent",
            title="Job Offer Received",
            message=f"You have received a job offer for '{job.title}'. Please review and respond.",
            data={"offer_id": offer.id, "job_id": payload.job_id},
        )

    await db.commit()
    await db.refresh(offer)

    # Email candidate
    try:
        salary_line = f"\nOffered Salary: {payload.salary_currency} {payload.offered_salary:,.0f}" if payload.offered_salary else ""
        deadline_line = f"\nResponse Deadline: {payload.response_deadline.strftime('%d %B %Y')}" if payload.response_deadline else ""
        send_email(
            to_email=str(candidate.email),
            subject=f"Job Offer — {job.title}",
            body=(
                f"Dear {candidate.full_name},\n\n"
                f"We are pleased to extend an offer for the position of '{job.title}'."
                f"{salary_line}{deadline_line}\n\n"
                f"{payload.offer_letter_text or ''}\n\n"
                "Please log into SmartHire to accept or decline this offer.\n\nBest regards,\nSmartHire Team"
            ),
        )
    except Exception:
        pass

    return offer


@router.get("", response_model=list[OfferResponse])
async def list_offers(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_staff),
    job_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[Offer]:
    q = select(Offer).order_by(Offer.created_at.desc()).limit(limit).offset(offset)
    if job_id is not None:
        q = q.where(Offer.job_id == int(job_id))
    if status:
        q = q.where(Offer.status == status)
    result = await db.execute(q)
    return list(result.scalars().all())


@router.get("/{offer_id}", response_model=OfferResponse)
async def get_offer(
    offer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Offer:
    offer = await db.get(Offer, offer_id)
    if not offer:
        raise HTTPException(status_code=404, detail="Offer not found")
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role == "candidate":
        # Candidates can only see offers for themselves
        candidate = await db.scalar(
            select(Candidate).where(
                Candidate.email == str(current_user.email or "").strip().lower()
            )
        )
        if not candidate or int(offer.candidate_id) != int(candidate.id):
            raise HTTPException(status_code=403, detail="Access denied")
    return offer


# ── Candidate: accept or decline offer ───────────────────────────────────────

@router.post("/{offer_id}/respond")
async def respond_to_offer(
    offer_id: int,
    response: str = Query(..., pattern="^(accepted|rejected)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role != "candidate":
        raise HTTPException(status_code=403, detail="Only candidates can respond to offers")

    offer = await db.get(Offer, offer_id)
    if not offer:
        raise HTTPException(status_code=404, detail="Offer not found")

    # Verify the offer belongs to this candidate
    from sqlalchemy import func
    candidate = await db.scalar(
        select(Candidate).where(func.lower(Candidate.email) == str(current_user.email or "").strip().lower())
    )
    if not candidate or int(offer.candidate_id) != int(candidate.id):
        raise HTTPException(status_code=403, detail="Access denied")

    if offer.status != "pending":
        raise HTTPException(status_code=400, detail=f"Offer is already '{offer.status}'")

    if offer.response_deadline and offer.response_deadline < _now():
        offer.status = "expired"
        await db.commit()
        raise HTTPException(status_code=400, detail="Offer deadline has passed")

    offer.status = response
    if response == "accepted":
        offer.acceptance_at = _now()
    else:
        offer.rejection_at = _now()

    # Update pipeline
    if offer.progress_id:
        progress = await db.get(JobCandidateProgress, int(offer.progress_id))
        if progress:
            apply_progress_update(
                progress,
                actor=str(current_user.email),
                action=f"offer_{response}",
                stage="offer_accepted" if response == "accepted" else "offer_rejected",
                details={"offer_id": offer_id},
            )

    # Notify hiring team (offered_by)
    if offer.offered_by_user_id:
        job = await db.get(Job, int(offer.job_id))
        await _create_notification(
            db,
            user_id=int(offer.offered_by_user_id),
            notif_type="offer_responded",
            title=f"Offer {response.title()}",
            message=f"{candidate.full_name} has {response} the offer for '{getattr(job, 'title', 'the role')}'.",
            data={"offer_id": offer_id, "candidate_id": int(candidate.id)},
        )

    await db.commit()
    return {"ok": True, "status": response}


# ── Candidate: view own offers ────────────────────────────────────────────────

@router.get("/my/offers", response_model=list[OfferResponse])
async def my_offers(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[Offer]:
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role != "candidate":
        raise HTTPException(status_code=403, detail="Candidate access required")
    from sqlalchemy import func
    candidate = await db.scalar(
        select(Candidate).where(func.lower(Candidate.email) == str(current_user.email or "").strip().lower())
    )
    if not candidate:
        return []
    result = await db.execute(
        select(Offer).where(Offer.candidate_id == int(candidate.id)).order_by(Offer.created_at.desc())
    )
    return list(result.scalars().all())
