from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token, decode_token, hash_password, verify_password
from ..auth_utils import resolve_access_token
from ..config import settings
from ..db import get_db
from ..models import User
from ..rate_limit import limiter
from ..schemas import Token, UserCreate, UserLogin, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])

bearer_scheme = HTTPBearer(auto_error=False)


def _validate_password_strength(password: str) -> None:
    pwd = password or ""
    if len(pwd) < 12:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 12 characters long.",
        )
    if not any(c.isupper() for c in pwd) or not any(c.islower() for c in pwd):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must contain both upper and lower case letters.",
        )
    if not any(c.isdigit() for c in pwd):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must contain at least one digit.",
        )


def _set_auth_cookie(response: Response, access_token: str) -> None:
    secure_cookie = str(settings.environment or "").lower() not in {"dev", "development", "local", "test"}
    response.set_cookie(
        key="access_token",
        value=access_token,
        httponly=True,
        secure=secure_cookie,
        samesite="lax",
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )


@router.post("/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def signup(
    request: Request,
    payload: UserCreate,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    # Defence in depth: NEVER trust the role from the request body.
    requested_role = str(payload.role or "candidate").lower()
    if requested_role == "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin accounts are provisioned internally. Please sign up as a candidate.",
        )

    _validate_password_strength(payload.password)

    normalized_email = str(payload.email).lower()
    existing_user = await db.scalar(select(User).where(User.email == normalized_email))
    if existing_user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")

    user = User(
        email=normalized_email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        role="candidate",
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/login", response_model=Token)
@limiter.limit("10/minute")
async def login(
    request: Request,
    payload: UserLogin,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> Token:
    user = await db.scalar(select(User).where(User.email == str(payload.email).lower()))
    if not user or not verify_password(payload.password, user.hashed_password):
        # Constant log shape for failed login auditing (no PII other than email lower-case).
        logger.bind(audit="login_failed", email=str(payload.email).lower()).info("Login failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if not getattr(user, "is_active", True):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")

    access_token = create_access_token(
        {"user_id": user.id, "role": str(user.role or "candidate").lower()}
    )
    _set_auth_cookie(response, access_token)
    logger.bind(audit="login_success", user_id=user.id, role=user.role).info("Login success")
    return Token(access_token=access_token, role=str(getattr(user, "role", "candidate") or "candidate"))


@router.get("/me", response_model=UserResponse)
async def me(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    token = resolve_access_token(request=request, credentials=credentials)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user_id = payload.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = await db.get(User, int(user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    return user


@router.post("/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(key="access_token", path="/")
    return {"ok": True}


class _PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=256)


@router.patch("/password", status_code=status.HTTP_200_OK)
async def change_password(
    payload: _PasswordChangeRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> dict:
    token_val = resolve_access_token(request=request, credentials=credentials)
    if not token_val:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    claims = decode_token(token_val)
    if not claims:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user_id = claims.get("user_id")
    user = await db.get(User, int(user_id))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")

    _validate_password_strength(payload.new_password)
    user.hashed_password = hash_password(payload.new_password)
    await db.commit()
    logger.info("User {} changed their password", user.email)
    return {"ok": True}
