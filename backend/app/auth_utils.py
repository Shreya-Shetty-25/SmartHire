from __future__ import annotations

from fastapi import Request
from fastapi.security import HTTPAuthorizationCredentials


_IGNORED_TOKEN_VALUES = {"", "null", "undefined"}


def _clean_token(raw: str | None) -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    if value.lower().startswith("bearer "):
        value = value[7:].strip()
    if value.lower() in _IGNORED_TOKEN_VALUES:
        return None
    return value


def resolve_access_token(
    *,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = None,
) -> str | None:
    if credentials and str(credentials.scheme or "").lower() == "bearer":
        token = _clean_token(credentials.credentials)
        if token:
            return token

    # Fallback: httpOnly cookie set on /auth/login.
    cookie_token = _clean_token(request.cookies.get("access_token"))
    if cookie_token:
        return cookie_token

    # NOTE: We deliberately do NOT accept tokens via `?token=` query parameters.
    # Query params leak into proxy logs, browser history, and Referer headers.
    # SSE/WebSocket streams must rely on the cookie set at login.
    return None
