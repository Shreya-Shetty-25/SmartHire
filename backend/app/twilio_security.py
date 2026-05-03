"""Twilio webhook validation + idempotency helpers."""

from __future__ import annotations

import time
from threading import Lock
from typing import Mapping

from fastapi import HTTPException, Request, status
from loguru import logger

try:
    from twilio.request_validator import RequestValidator  # type: ignore
except Exception:  # pragma: no cover
    RequestValidator = None  # type: ignore

from .config import settings


# Idempotency: remember (CallSid, RecordingSid, event_kind) for a window.
# Twilio retries on 5xx — we want to ack but not double-process.
_IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 6  # 6 hours
_seen_events: dict[str, float] = {}
_seen_lock = Lock()


def _purge_expired_locked() -> None:
    cutoff = time.time() - _IDEMPOTENCY_TTL_SECONDS
    expired = [k for k, ts in _seen_events.items() if ts < cutoff]
    for k in expired:
        _seen_events.pop(k, None)


def claim_event(idempotency_key: str) -> bool:
    """Return True if this is the first time we've seen the key (i.e. process it).
    Return False if it's a duplicate (caller should short-circuit).
    """
    if not idempotency_key:
        return True
    now = time.time()
    with _seen_lock:
        _purge_expired_locked()
        if idempotency_key in _seen_events:
            return False
        _seen_events[idempotency_key] = now
        return True


async def validate_twilio_request(request: Request, form: Mapping[str, str]) -> None:
    """Verify Twilio's X-Twilio-Signature header.

    No-op if signature validation is explicitly disabled or no auth token is
    configured (with a warning). Raises 403 on mismatch.
    """
    if not settings.twilio_validate_signature:
        return

    auth_token = (settings.twilio_auth_token or "").strip()
    if not auth_token:
        # Without an auth token we cannot validate. In production, this is fatal.
        if settings.is_production:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Twilio webhook validation requires TWILIO_AUTH_TOKEN.",
            )
        logger.warning(
            "Twilio webhook signature validation skipped: TWILIO_AUTH_TOKEN not set"
        )
        return

    if RequestValidator is None:
        if settings.is_production:
            raise HTTPException(status_code=503, detail="twilio package unavailable")
        logger.warning("twilio package not importable; skipping signature validation")
        return

    signature = request.headers.get("X-Twilio-Signature", "")
    if not signature:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="missing twilio signature")

    # Reconstruct the URL Twilio signed. Trust forwarded proto/host when behind a proxy.
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    base = (
        f"{forwarded_proto}://{forwarded_host}"
        if forwarded_proto and forwarded_host
        else str(request.base_url).rstrip("/")
    )
    full_url = base + request.url.path
    if request.url.query:
        full_url += f"?{request.url.query}"

    validator = RequestValidator(auth_token)
    params = {k: str(v) for k, v in form.items()}
    if not validator.validate(full_url, params, signature):
        logger.warning(
            "Twilio signature mismatch for {} (origin={})", full_url, request.client.host if request.client else "?"
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid twilio signature")
