import asyncio

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import select, text

from .auth import hash_password, verify_password
from .db import SessionLocal, init_db
from .logger import logging_middleware, log_routes, setup_logging
from .models import Base, User
from .rate_limit import limiter
from .routes.auth import router as auth_router
from .routes.candidates import router as candidates_router
from .routes.candidate_portal import router as candidate_portal_router
from .routes.calls import router as calls_router
from .routes.chat import router as chat_router
from .routes.dashboard import router as dashboard_router
from .routes.departments import router as departments_router
from .routes.hire import router as hire_router
from .routes.jobs import router as jobs_router
from .routes.knockout import router as knockout_router
from .routes.realtime import router as realtime_router
from .routes.referrals import router as referrals_router
from .routes.requisitions import router as requisitions_router
from .routes.bulk_import import router as bulk_import_router
from .routes.insights import router as insights_router
from .config import settings
from .assessment import assessment_app, init_assessment


app = FastAPI(title="SmartHire API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS for frontend
raw_origins = (settings.cors_allow_origins or "").strip()
cors_origins = [o.strip() for o in raw_origins.split(",") if o.strip()] or [
    "http://localhost:5173",
]
if settings.is_production and any(o == "*" for o in cors_origins):
    raise RuntimeError("CORS_ALLOW_ORIGINS must not contain '*' in production")

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    # Explicit methods/headers — never use "*" with allow_credentials=True.
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Requested-With",
        "X-CSRF-Token",
        "Accept",
    ],
    expose_headers=["X-Request-Id"],
)

setup_logging()
app.middleware("http")(logging_middleware)


@app.middleware("http")
async def request_size_guard(request: Request, call_next):
    """Reject requests larger than configured max_upload_bytes upfront.

    File-upload endpoints have stricter checks of their own; this is an outer
    safety net to prevent unbounded memory consumption from malicious clients.
    """
    cl = request.headers.get("content-length")
    try:
        if cl is not None and int(cl) > int(settings.max_upload_bytes) * 6:
            return JSONResponse(status_code=413, content={"detail": "Payload too large"})
    except (TypeError, ValueError):
        pass
    return await call_next(request)

# Include routers
app.include_router(auth_router)
app.include_router(candidates_router)
app.include_router(candidate_portal_router)
app.include_router(calls_router)
app.include_router(chat_router)
app.include_router(dashboard_router)
app.include_router(departments_router)
app.include_router(jobs_router)
app.include_router(hire_router)
app.include_router(bulk_import_router)
app.include_router(knockout_router)
app.include_router(realtime_router)
app.include_router(referrals_router)
app.include_router(requisitions_router)
app.include_router(insights_router)
app.mount("/assessment-api", assessment_app)


async def ensure_bootstrap_admin() -> None:
    if not settings.bootstrap_admin_enabled:
        return

    email = str(settings.bootstrap_admin_email or "").strip().lower()
    password = str(settings.bootstrap_admin_password or "").strip()
    full_name = str(settings.bootstrap_admin_name or "").strip() or "Admin"
    if not email or not password:
        logger.warning("Bootstrap admin is enabled but email/password are missing; skipping admin seeding.")
        return

    async with SessionLocal() as session:
        existing = await session.scalar(select(User).where(User.email == email))
        if existing:
            changed = False
            if (existing.full_name or "") != full_name:
                existing.full_name = full_name
                changed = True
            if str(existing.role or "").lower() != "admin":
                existing.role = "admin"
                changed = True
            if not existing.is_active:
                existing.is_active = True
                changed = True
            if password and (not existing.hashed_password or not verify_password(password, existing.hashed_password)):
                existing.hashed_password = hash_password(password)
                changed = True
            if changed:
                await session.commit()
            logger.info("Bootstrap admin account is ready for {}", email)
            return

        session.add(
            User(
                email=email,
                full_name=full_name,
                hashed_password=hash_password(password),
                role="admin",
                is_active=True,
            )
        )
        await session.commit()
        logger.info("Created bootstrap admin account for {}", email)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception for {} {}", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


@app.on_event("startup")
async def startup_event() -> None:
    database_url = str(settings.database_url)

    placeholder = (
        "YOUR_PROJECT_REF" in database_url
        or "YOUR_PASSWORD" in database_url
        or "YOUR_LOCAL_POSTGRES_PASSWORD" in database_url
    )
    misformatted = "[" in database_url or "]" in database_url or database_url.count("@") > 1

    if placeholder or misformatted:
        msg = (
            "DATABASE_URL is not configured correctly: "
            f"{'placeholder values present' if placeholder else 'misformatted URL'}."
        )
        if settings.is_production:
            raise RuntimeError(msg + " Refusing to start in production.")
        logger.warning(msg + " Skipping DB init; auth endpoints will not work until backend/.env is updated.")
    else:
        try:
            await asyncio.wait_for(init_db(Base.metadata), timeout=15)
            await ensure_bootstrap_admin()
        except Exception:
            logger.exception("Database init failed (check DATABASE_URL).")
            if settings.is_production:
                raise

    if settings.jwt_secret_key and len(settings.jwt_secret_key) < 32:
        if settings.is_production:
            raise RuntimeError("JWT_SECRET_KEY must be at least 32 characters in production.")
        logger.warning("JWT_SECRET_KEY is too short — set a strong random secret in backend/.env for production use.")

    try:
        init_assessment()
    except Exception:
        logger.exception("Assessment service init failed.")
        if settings.is_production:
            raise

    log_routes(app)


@app.get("/health", summary="Health check")
async def health_check(deep: bool = False) -> dict:
    """Liveness probe.

    By default returns ``{"status": "ok"}``. Pass ``?deep=true`` to also verify
    that the database connection is alive — useful for readiness probes.
    """
    if not deep:
        return {"status": "ok"}

    db_ok = False
    db_error: str | None = None
    try:
        async with SessionLocal() as session:
            await session.execute(text("SELECT 1"))
        db_ok = True
    except Exception as exc:
        db_error = f"{type(exc).__name__}: {exc}"

    overall = "ok" if db_ok else "degraded"
    return {
        "status": overall,
        "database": "ok" if db_ok else "error",
        "database_error": db_error,
        "environment": settings.environment,
    }
