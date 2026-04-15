from collections.abc import Generator
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from loguru import logger
from sqlalchemy.orm import Session, sessionmaker

from ..config import settings as core_settings
from .config import settings

_BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _assessment_database_url() -> str:
    url = str(settings.assessment_database_url or "").strip()
    if url.startswith("sqlite:///./"):
        db_path = (_BACKEND_ROOT / url.removeprefix("sqlite:///./")).resolve()
        return f"sqlite:///{db_path.as_posix()}"
    return url


assessment_engine = create_engine(_assessment_database_url(), future=True, pool_pre_ping=True)


def _as_sync_sqlalchemy_url(url: str) -> str:
    normalized = url.strip()
    if not normalized:
        return normalized

    parsed = make_url(normalized)
    drivername = parsed.drivername
    if drivername == "postgresql+asyncpg":
        parsed = parsed.set(drivername="postgresql+psycopg")
    elif drivername == "postgresql":
        parsed = parsed.set(drivername="postgresql+psycopg")
    elif drivername == "sqlite+aiosqlite":
        parsed = parsed.set(drivername="sqlite")
    return str(parsed)


def _jobs_database_url() -> str | None:
    configured = (settings.jobs_database_url or "").strip()
    if configured:
        return configured

    database_url = str(core_settings.database_url or "").strip()
    if not database_url:
        return None
    return _as_sync_sqlalchemy_url(database_url)


jobs_engine = None
jobs_database_url = _jobs_database_url()
if jobs_database_url:
    url = jobs_database_url.strip()
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
            detail=(
                "The assessment service could not connect to the jobs database. "
                "Set JOBS_DATABASE_URL explicitly or configure DATABASE_URL in backend/.env."
            ),
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
