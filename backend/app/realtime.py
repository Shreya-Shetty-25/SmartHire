from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from threading import Lock


_MAX_EVENTS = 1000
_events: deque[dict] = deque(maxlen=_MAX_EVENTS)
_lock = Lock()
_next_event_id = 1


def publish_realtime_event(event_type: str, payload: dict | None = None) -> dict:
    global _next_event_id
    event = {
        "id": 0,
        "type": str(event_type or "event"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload or {},
    }
    with _lock:
        event["id"] = _next_event_id
        _next_event_id += 1
        _events.append(event)
    return event


def get_realtime_events_after(last_event_id: int) -> list[dict]:
    marker = int(last_event_id or 0)
    with _lock:
        if not _events:
            return []
        return [event for event in _events if int(event.get("id", 0)) > marker]

