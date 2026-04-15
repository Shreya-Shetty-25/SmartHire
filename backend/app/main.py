import asyncio

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
from sqlalchemy import select

from .auth import hash_password, verify_password
from .db import SessionLocal, init_db
from .logger import logging_middleware, log_routes, setup_logging
from .models import Base, User
from .routes.auth import router as auth_router
from .routes.candidates import router as candidates_router
from .routes.candidate_portal import router as candidate_portal_router
from .routes.calls import router as calls_router
from .routes.chat import router as chat_router
from .routes.dashboard import router as dashboard_router
from .routes.hire import router as hire_router
from .routes.jobs import router as jobs_router
from .routes.realtime import router as realtime_router
from .config import settings
from .assessment import assessment_app, init_assessment


app = FastAPI(title="SmartHire API")

# CORS for frontend
raw_origins = (settings.cors_allow_origins or "").strip()
cors_origins = [o.strip() for o in raw_origins.split(",") if o.strip()] or [
    "http://localhost:5173",
    # "http://localhost:5174",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

setup_logging()
app.middleware("http")(logging_middleware)

# Include routers
app.include_router(auth_router)
app.include_router(candidates_router)
app.include_router(candidate_portal_router)
app.include_router(calls_router)
app.include_router(chat_router)
app.include_router(dashboard_router)
app.include_router(jobs_router)
app.include_router(hire_router)
app.include_router(realtime_router)
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
            await ensure_bootstrap_admin()
        except Exception:
            logger.exception(
                "Database init failed (check DATABASE_URL). API will still start, but DB-backed endpoints may fail."
            )
    if settings.jwt_secret_key and len(settings.jwt_secret_key) < 32:
        logger.warning("JWT_SECRET_KEY is too short — set a strong random secret in backend/.env for production use.")
    try:
        init_assessment()
    except Exception:
        logger.exception("Assessment service init failed. Assessment endpoints may not work until the issue is resolved.")
    log_routes(app)


@app.get("/health", summary="Health check")
async def health_check() -> dict:
    return {"status": "ok"}
