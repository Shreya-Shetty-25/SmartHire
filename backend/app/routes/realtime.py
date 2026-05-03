from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from loguru import logger

from ..auth import decode_token
from ..auth_utils import resolve_access_token
from ..db import SessionLocal
from ..models import User
from ..realtime import get_realtime_events_after

router = APIRouter(prefix="/api/realtime", tags=["realtime"])


async def _require_admin_from_token(token: str) -> User:
    payload = decode_token(str(token or "").strip())
    if not payload or not payload.get("user_id"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user_id = int(payload["user_id"])
    async with SessionLocal() as session:
        user = await session.get(User, user_id)
        if not user or not bool(getattr(user, "is_active", True)):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        if str(getattr(user, "role", "candidate")).lower() != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
        return user


@router.get("/stream")
async def realtime_stream(
    request: Request,
    token: str | None = Query(default=None),
    event_types: str | None = Query(default=None),
) -> StreamingResponse:
    # Prefer cookie/Authorization header (does not leak in URL/referers/proxy
    # access logs). The legacy ?token= query parameter remains supported only
    # as a fallback for browsers that cannot send credentials with EventSource.
    resolved = resolve_access_token(request=request, credentials=None) or (token or "")
    if not resolved:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    await _require_admin_from_token(resolved)

    allowed_types = {
        item.strip()
        for item in str(event_types or "").split(",")
        if item.strip()
    }

    async def _event_generator():
        try:
            last_event_id = int(request.headers.get("last-event-id") or 0)
        except (TypeError, ValueError):
            last_event_id = 0
        heartbeat_at = time.monotonic() + 15.0
        yield "retry: 3000\n\n"
        try:
            while True:
                # Bail out as soon as the client disconnects so we don't
                # accumulate ghost generators in long-running deployments.
                if await request.is_disconnected():
                    break
                emitted = False
                for event in get_realtime_events_after(last_event_id):
                    last_event_id = max(last_event_id, int(event.get("id", 0)))
                    event_type = str(event.get("type") or "event")
                    if allowed_types and event_type not in allowed_types:
                        continue
                    payload = event.get("payload") or {}
                    yield (
                        f"id: {int(event.get('id', 0))}\n"
                        f"event: {event_type}\n"
                        f"data: {json.dumps(payload, default=str)}\n\n"
                    )
                    emitted = True
                now = time.monotonic()
                if not emitted and now >= heartbeat_at:
                    heartbeat_at = now + 15.0
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.75)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("realtime stream generator failed")

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
