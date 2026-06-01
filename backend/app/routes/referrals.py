"""Referral portal routes — employees submit candidate referrals."""
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_admin
from ..models import Job, Referral, User
from ..rate_limit import limiter
from ..schemas import ReferralCreate, ReferralResponse

router = APIRouter(prefix="/api/referrals", tags=["referrals"])

_STATUS_VALUES = {"pending", "reviewed", "hired", "rejected"}


@router.get("/active-jobs")
async def public_active_jobs(db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Public endpoint — returns id/title/location for active jobs (used by the referral form)."""
    result = await db.execute(
        select(Job.id, Job.title, Job.location).where(Job.status == "active").order_by(Job.title)
    )
    rows = result.all()
    return [{"id": r.id, "title": r.title, "location": r.location} for r in rows]


@router.get("", response_model=list[ReferralResponse])
async def list_referrals(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
    job_id: int | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[Referral]:
    q = select(Referral).order_by(Referral.created_at.desc()).limit(limit).offset(offset)
    if job_id:
        q = q.where(Referral.job_id == job_id)
    if status_filter and status_filter in _STATUS_VALUES:
        q = q.where(Referral.status == status_filter)
    result = await db.execute(q)
    return list(result.scalars().all())


@router.post("", response_model=ReferralResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/hour")
async def create_referral(
    payload: ReferralCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Referral:
    """Public endpoint — no auth required so any employee can submit."""
    job = await db.get(Job, payload.job_id)
    if not job or job.status not in ("active",):
        raise HTTPException(status_code=404, detail="Job not found or not accepting referrals")

    referral = Referral(
        job_id=payload.job_id,
        referrer_name=payload.referrer_name.strip(),
        referrer_email=str(payload.referrer_email).lower().strip(),
        referrer_employee_id=payload.referrer_employee_id,
        candidate_name=payload.candidate_name.strip(),
        candidate_email=str(payload.candidate_email).lower().strip(),
        candidate_phone=payload.candidate_phone,
        relationship=payload.relationship,
        note=payload.note,
        status="pending",
    )
    db.add(referral)
    await db.commit()
    await db.refresh(referral)
    return referral


@router.get("/{referral_id}", response_model=ReferralResponse)
async def get_referral(
    referral_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> Referral:
    r = await db.get(Referral, referral_id)
    if not r:
        raise HTTPException(status_code=404, detail="Referral not found")
    return r


@router.patch("/{referral_id}/status", response_model=ReferralResponse)
async def update_referral_status(
    referral_id: int,
    new_status: str = Query(..., pattern="^(pending|reviewed|hired|rejected)$"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> Referral:
    r = await db.get(Referral, referral_id)
    if not r:
        raise HTTPException(status_code=404, detail="Referral not found")
    r.status = new_status
    await db.commit()
    await db.refresh(r)
    return r


@router.delete("/{referral_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_referral(
    referral_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> None:
    r = await db.get(Referral, referral_id)
    if not r:
        raise HTTPException(status_code=404, detail="Referral not found")
    await db.delete(r)
    await db.commit()
