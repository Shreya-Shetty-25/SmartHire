from collections.abc import Generator

from fastapi import HTTPException, status
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings

assessment_engine = create_engine(settings.assessment_database_url, future=True, pool_pre_ping=True)
jobs_engine = create_engine(settings.jobs_database_url, future=True, pool_pre_ping=True) if settings.jobs_database_url else None

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
