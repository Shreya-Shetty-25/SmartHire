from typing import Any, Dict, List
import os
import re

from fastapi import FastAPI, Request
from fastapi.routing import APIRoute
from loguru import logger
from starlette.exceptions import HTTPException as StarletteHTTPException


# Replace numeric IDs in URL paths so candidate IDs / job IDs / etc. don't leak into logs
# (and become trivially correlatable across log lines).
_NUMERIC_SEGMENT_RE = re.compile(r"/\d+(?=/|$)")
# Strip query strings entirely from access logs — they may carry tokens, emails, etc.
_QUERY_RE = re.compile(r"\?.*$")
# Drop email-looking tokens that may appear inline.
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def _safe_path(raw_path: str) -> str:
    if not raw_path:
        return ""
    cleaned = _QUERY_RE.sub("", raw_path)
    cleaned = _NUMERIC_SEGMENT_RE.sub("/{id}", cleaned)
    cleaned = _EMAIL_RE.sub("{email}", cleaned)
    return cleaned


def setup_logging() -> None:
    log_path = os.path.join("logs", "smarthire.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    try:
        logger.add(log_path, rotation="10 MB", retention="7 days", level="INFO", enqueue=True)
    except Exception as exc:
        logger.warning("Async log sink unavailable, falling back to sync mode: {}", exc)
        logger.add(log_path, rotation="10 MB", retention="7 days", level="INFO", enqueue=False)
    logger.info("Logging initialized for SmartHire backend")


def _route_signature(route: APIRoute) -> Dict[str, Any]:
    param_names: List[str] = []
    if route.dependant:
        for param in list(route.dependant.path_params or []) + list(route.dependant.query_params or []):
            param_names.append(param.name)

    return_annotation = None
    if hasattr(route.endpoint, "__annotations__"):
        return_annotation = route.endpoint.__annotations__.get("return")

    return {
        "path": route.path,
        "methods": sorted(route.methods or []),
        "endpoint": route.endpoint.__name__,
        "params": param_names,
        "response_model": getattr(route, "response_model", None).__name__ if getattr(route, "response_model", None) else None,
        "return_type": str(return_annotation) if return_annotation is not None else None,
    }


def log_routes(app: FastAPI) -> None:
    for route in app.routes:
        if isinstance(route, APIRoute):
            signature = _route_signature(route)
            logger.info("Registered route", extra=signature)


async def logging_middleware(request: Request, call_next):
    safe_path = _safe_path(request.url.path)
    logger.info("Request: {} {}", request.method, safe_path)
    try:
        response = await call_next(request)
    except StarletteHTTPException as exc:
        logger.warning(
            "HTTP error during {} {} -> {} ({})",
            request.method,
            safe_path,
            exc.status_code,
            getattr(exc, "detail", None),
        )
        raise
    except Exception:
        logger.exception("Unhandled exception during {} {}", request.method, safe_path)
        raise
    logger.info("Response: {} {} -> {}", request.method, safe_path, response.status_code)
    return response
