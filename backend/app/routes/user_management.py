"""User management — admin assigns roles to users."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_admin
from ..models import User
from ..schemas import UserListResponse, UserRoleUpdateRequest

router = APIRouter(prefix="/api/users", tags=["user_management"])

_VALID_ROLES = frozenset({"admin", "recruiter", "hiring_manager", "interviewer", "candidate"})


@router.get("", response_model=list[UserListResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
    role: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[User]:
    q = select(User).order_by(User.created_at.desc()).limit(limit).offset(offset)
    if role:
        q = q.where(User.role == role)
    result = await db.execute(q)
    return list(result.scalars().all())


@router.get("/staff", response_model=list[UserListResponse])
async def list_staff(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> list[User]:
    """Return all non-candidate users (recruiters, hiring managers, interviewers, admins)."""
    result = await db.execute(
        select(User).where(User.role != "candidate").order_by(User.full_name)
    )
    return list(result.scalars().all())


@router.patch("/{user_id}/role", response_model=UserListResponse)
async def update_user_role(
    user_id: int,
    payload: UserRoleUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_admin: User = Depends(get_current_admin),
) -> User:
    if payload.role not in _VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {payload.role}")
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Prevent admin from demoting themselves
    if int(user.id) == int(current_admin.id) and payload.role != "admin":
        raise HTTPException(status_code=400, detail="Cannot change your own admin role")
    user.role = payload.role
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/{user_id}/active", response_model=UserListResponse)
async def toggle_user_active(
    user_id: int,
    is_active: bool,
    db: AsyncSession = Depends(get_db),
    current_admin: User = Depends(get_current_admin),
) -> User:
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if int(user.id) == int(current_admin.id):
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")
    user.is_active = is_active
    await db.commit()
    await db.refresh(user)
    return user
