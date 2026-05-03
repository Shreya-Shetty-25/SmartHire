"""Centralised rate limiter for the SmartHire API.

We use ``slowapi`` (Starlette/FastAPI port of Flask-Limiter) with an in-memory
backend. This is sufficient for a single-worker deployment (which is what the
audit recommends). For multi-worker deployments, replace the storage URI with
a Redis URL via the ``RATE_LIMIT_STORAGE_URL`` env var.
"""

from __future__ import annotations

import os

from slowapi import Limiter
from slowapi.util import get_remote_address


_storage_uri = os.environ.get("RATE_LIMIT_STORAGE_URL", "memory://")

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=_storage_uri,
    default_limits=[],  # opt-in per-route
    headers_enabled=True,
)
