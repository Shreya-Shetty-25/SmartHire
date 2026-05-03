from __future__ import annotations

from datetime import datetime, timedelta, timezone

from jose import ExpiredSignatureError, JWTError, jwt
from loguru import logger

from .config import settings
from .security import hash_password, verify_password  # re-exported for legacy imports

ALGORITHM = "HS256"


def _secret() -> str:
    secret = (settings.jwt_secret_key or "").strip()
    if not secret:
        raise RuntimeError("JWT_SECRET_KEY is not configured")
    return secret


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """Create a signed access token. Always sets `iat` and `exp`."""
    to_encode = dict(data or {})
    now = datetime.now(timezone.utc)
    expires = expires_delta or timedelta(minutes=int(settings.access_token_expire_minutes))
    to_encode["iat"] = int(now.timestamp())
    to_encode["exp"] = int((now + expires).timestamp())
    return jwt.encode(to_encode, _secret(), algorithm=ALGORITHM)


def decode_token(token: str) -> dict | None:
    """Decode + validate a token. Returns None on any failure (logs the reason)."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, _secret(), algorithms=[ALGORITHM])
    except ExpiredSignatureError:
        logger.info("auth.decode_token: token expired")
        return None
    except JWTError as exc:
        logger.warning("auth.decode_token: invalid token ({})", exc)
        return None
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("auth.decode_token: unexpected error ({})", exc)
        return None

    # Defence-in-depth: ensure required claims are present.
    if not payload.get("exp"):
        logger.warning("auth.decode_token: token missing exp claim")
        return None
    if not (payload.get("user_id") or payload.get("service")):
        logger.warning("auth.decode_token: token missing user_id/service claim")
        return None

    return payload


# Backwards-compat: keep ACCESS_TOKEN_EXPIRE_MINUTES referenceable from old call sites.
ACCESS_TOKEN_EXPIRE_MINUTES = int(settings.access_token_expire_minutes)
SECRET_KEY = settings.jwt_secret_key  # noqa: F401 — legacy export

__all__ = [
    "ALGORITHM",
    "ACCESS_TOKEN_EXPIRE_MINUTES",
    "SECRET_KEY",
    "create_access_token",
    "decode_token",
    "hash_password",
    "verify_password",
]
