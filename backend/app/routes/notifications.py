"""Notification endpoints — in-app notification centre for all users."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_user
from ..models import Notification, User
from ..schemas import NotificationResponse

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    unread_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[Notification]:
    q = (
        select(Notification)
        .where(Notification.user_id == int(current_user.id))
        .order_by(Notification.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if unread_only:
        q = q.where(Notification.is_read.is_(False))
    result = await db.execute(q)
    return list(result.scalars().all())


@router.get("/unread-count")
async def unread_count(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    from sqlalchemy import func, select
    count = await db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == int(current_user.id),
            Notification.is_read.is_(False),
        )
    ) or 0
    return {"unread_count": int(count)}


@router.post("/{notification_id}/read", response_model=NotificationResponse)
async def mark_read(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Notification:
    notif = await db.get(Notification, notification_id)
    if not notif or int(notif.user_id) != int(current_user.id):
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.is_read = True
    await db.commit()
    await db.refresh(notif)
    return notif


@router.post("/read-all")
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == int(current_user.id), Notification.is_read.is_(False))
        .values(is_read=True)
    )
    await db.commit()
    return {"ok": True}
