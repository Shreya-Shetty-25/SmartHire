from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import decode_token
from .auth_utils import resolve_access_token
from .db import get_db
from .models import User

bearer_scheme = HTTPBearer(auto_error=False)

# Roles that have staff-level (recruiter-side) access
_STAFF_ROLES = frozenset({"admin", "recruiter", "hiring_manager", "interviewer"})


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    token = resolve_access_token(request=request, credentials=credentials)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # Internal service tokens carry role + service flag — skip DB lookup.
    if payload.get("service") and str(payload.get("role", "")).lower() == "admin":
        synthetic = User(
            id=0,
            email="service@smarthire.internal",
            hashed_password="",
            role="admin",
            is_active=True,
        )
        setattr(synthetic, "is_service_account", True)
        logger.bind(audit="service_token_used", path=request.url.path).info(
            "Service token used for {}", request.url.path
        )
        return synthetic

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    try:
        user = await db.get(User, int(user_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if not user or not getattr(user, "is_active", True):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    return user


async def get_current_admin(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> User:
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role != "admin":
        logger.bind(
            audit="admin_access_denied",
            user_id=getattr(current_user, "id", None),
            email=getattr(current_user, "email", None),
            path=request.url.path,
        ).warning("Non-admin attempted admin endpoint")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    logger.bind(
        audit="admin_action",
        user_id=getattr(current_user, "id", None),
        email=getattr(current_user, "email", None),
        method=request.method,
        path=request.url.path,
    ).info("admin endpoint accessed")
    return current_user


async def get_current_staff(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> User:
    """Allow admin, recruiter, hiring_manager, and interviewer roles."""
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role not in _STAFF_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Staff access required")
    return current_user


async def get_current_recruiter(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> User:
    """Allow admin and recruiter roles."""
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role not in {"admin", "recruiter"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Recruiter access required")
    return current_user


async def get_current_hiring_manager(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> User:
    """Allow admin and hiring_manager roles."""
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role not in {"admin", "hiring_manager"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hiring manager access required")
    return current_user


async def get_current_interviewer(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> User:
    """Allow admin, hiring_manager, and interviewer roles."""
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role not in {"admin", "hiring_manager", "interviewer"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Interviewer access required")
    return current_user
    token = resolve_access_token(request=request, credentials=credentials)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # Internal service tokens carry role + service flag — skip DB lookup.
    if payload.get("service") and str(payload.get("role", "")).lower() == "admin":
        synthetic = User(
            id=0,
            email="service@smarthire.internal",
            hashed_password="",
            role="admin",
            is_active=True,
        )
        # Tag for downstream audit log filtering.
        setattr(synthetic, "is_service_account", True)
        logger.bind(audit="service_token_used", path=request.url.path).info(
            "Service token used for {}", request.url.path
        )
        return synthetic

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    try:
        user = await db.get(User, int(user_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if not user or not getattr(user, "is_active", True):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    return user


async def get_current_admin(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> User:
    role = str(getattr(current_user, "role", "candidate")).lower()
    if role != "admin":
        logger.bind(
            audit="admin_access_denied",
            user_id=getattr(current_user, "id", None),
            email=getattr(current_user, "email", None),
            path=request.url.path,
        ).warning("Non-admin attempted admin endpoint")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    logger.bind(
        audit="admin_action",
        user_id=getattr(current_user, "id", None),
        email=getattr(current_user, "email", None),
        method=request.method,
        path=request.url.path,
    ).info("admin endpoint accessed")
    return current_user
