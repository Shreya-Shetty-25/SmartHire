from typing import Any, Dict, List
import os

from fastapi import FastAPI, Request
from fastapi.routing import APIRoute
from loguru import logger
from starlette.exceptions import HTTPException as StarletteHTTPException


def setup_logging() -> None:
    log_path = os.path.join("logs", "smarthire.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    logger.add(log_path, rotation="10 MB", retention="7 days", level="INFO", enqueue=True)
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
    logger.info(f"Request: {request.method} {request.url.path}")
    try:
        response = await call_next(request)
    except StarletteHTTPException as exc:
        # Expected/handled HTTP errors (401/403/422/502/503, etc.) should not emit full tracebacks.
        logger.warning(
            "HTTP error during {} {} -> {} ({})",
            request.method,
            request.url.path,
            exc.status_code,
            getattr(exc, "detail", None),
        )
        raise
    except Exception:
        logger.exception(f"Unhandled exception during {request.method} {request.url.path}")
        raise
    logger.info(f"Response: {request.method} {request.url.path} -> {response.status_code}")
    return response
