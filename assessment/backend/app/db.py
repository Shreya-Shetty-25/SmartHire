from collections.abc import Generator

from fastapi import HTTPException, status
from sqlalchemy import create_engine
from loguru import logger
from sqlalchemy.orm import Session, sessionmaker

from .config import settings

assessment_engine = create_engine(settings.assessment_database_url, future=True, pool_pre_ping=True)

jobs_engine = None
if settings.jobs_database_url:
    url = settings.jobs_database_url.strip()
    if url.startswith("http://") or url.startswith("https://"):
        logger.warning(
            "JOBS_DATABASE_URL looks like an http(s) URL; skipping jobs DB setup. "
            "Set JOBS_DATABASE_URL to a SQLAlchemy DB URL (e.g. postgresql+psycopg://...)."
        )
    else:
        try:
            jobs_engine = create_engine(url, future=True, pool_pre_ping=True)
        except Exception as exc:
            logger.exception(
                "Failed to create jobs DB engine from JOBS_DATABASE_URL; starting without jobs DB. Error: {}",
                exc,
            )
            jobs_engine = None

JobsSessionLocal = sessionmaker(bind=jobs_engine, autoflush=False, autocommit=False, future=True) if jobs_engine else None
AssessmentSessionLocal = sessionmaker(bind=assessment_engine, autoflush=False, autocommit=False, future=True)


def get_jobs_db() -> Generator[Session, None, None]:
    if JobsSessionLocal is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JOBS_DATABASE_URL is not configured. Copy assessment/backend/.env.example to .env and set JOBS_DATABASE_URL to your SmartHire jobs database.",
        )

    db = JobsSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_optional_jobs_db() -> Generator[Session | None, None, None]:
    """Return a jobs DB session if configured, otherwise None.

    This allows endpoints like exam creation to work even when the assessment
    service is not wired to the SmartHire jobs database.
    """

    if JobsSessionLocal is None:
        yield None
        return

    db = JobsSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_assessment_db() -> Generator[Session, None, None]:
    db = AssessmentSessionLocal()
    try:
        yield db
    finally:
        db.close()
