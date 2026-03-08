import asyncio

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger

from .db import init_db
from .logger import logging_middleware, log_routes, setup_logging
from .models import Base
from .routes.auth import router as auth_router
from .routes.candidates import router as candidates_router
from .routes.calls import router as calls_router
from .routes.hire import router as hire_router
from .routes.jobs import router as jobs_router
from .config import settings


app = FastAPI(title="SmartHire API")

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

setup_logging()
app.middleware("http")(logging_middleware)

# Include routers
app.include_router(auth_router)
app.include_router(candidates_router)
app.include_router(calls_router)
app.include_router(jobs_router)
app.include_router(hire_router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception(f"Unhandled exception for {request.method} {request.url.path}")
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


@app.on_event("startup")
async def startup_event() -> None:
    database_url = str(settings.database_url)

    if (
        "YOUR_PROJECT_REF" in database_url
        or "YOUR_PASSWORD" in database_url
        or "YOUR_LOCAL_POSTGRES_PASSWORD" in database_url
    ):
        logger.warning(
            "DATABASE_URL still contains placeholder values. Skipping DB init; auth endpoints will not work until backend/.env is updated."
        )
    elif "[" in database_url or "]" in database_url or database_url.count("@") > 1:
        logger.warning(
            "DATABASE_URL looks misformatted (brackets or unescaped '@' in password). Skipping DB init; fix backend/.env to enable DB-backed endpoints."
        )
    else:
        try:
            await asyncio.wait_for(init_db(Base.metadata), timeout=15)
        except Exception:
            logger.exception(
                "Database init failed (check DATABASE_URL). API will still start, but DB-backed endpoints may fail."
            )
    log_routes(app)


@app.get("/health", summary="Health check")
async def health_check() -> dict:
    return {"status": "ok"}
