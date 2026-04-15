from typing import AsyncGenerator

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from urllib.parse import urlsplit

from .config import settings


# Add a connect timeout so startup doesn't hang forever if the DB URL is wrong/unreachable.
engine = create_async_engine(
  str(settings.database_url),
  echo=False,
  future=True,
  connect_args={"timeout": 10},
)
SessionLocal = async_sessionmaker(bind=engine, expire_on_commit=False, class_=AsyncSession)


def _database_url_is_placeholder(database_url: str) -> bool:
  return (
    ("YOUR_PROJECT_REF" in database_url)
    or ("YOUR_PASSWORD" in database_url)
    or ("YOUR_LOCAL_POSTGRES_PASSWORD" in database_url)
  )


def _database_url_seems_misformatted(database_url: str) -> str | None:
  if "[" in database_url or "]" in database_url:
    return "Remove '[' and ']' from DATABASE_URL (do not wrap the password in brackets)."

  try:
    parsed = urlsplit(database_url)
  except Exception:
    return "DATABASE_URL could not be parsed as a URL."

  if not parsed.scheme or not parsed.netloc:
    return "DATABASE_URL is missing scheme/host (expected postgresql+asyncpg://...)."

  # If the password contains an unescaped '@', the hostname portion often becomes garbage.
  if "@" in (parsed.username or ""):
    return "DATABASE_URL username contains '@' (likely due to an unescaped '@' in the password). URL-encode special characters in the password."

  # Very common mistake: password contains '@' but isn't URL-encoded.
  if database_url.count("@") > 1:
    return "DATABASE_URL contains multiple '@' characters (password likely has '@' and must be URL-encoded as %40)."

  return None


async def get_db() -> AsyncGenerator[AsyncSession, None]:
  database_url = str(settings.database_url)
  if _database_url_is_placeholder(database_url):
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="DATABASE_URL is not configured (still contains placeholder values). Update backend/.env with your Postgres connection string.",
    )

  misformatted_reason = _database_url_seems_misformatted(database_url)
  if misformatted_reason:
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail=f"DATABASE_URL is misformatted. {misformatted_reason}",
    )

  async with SessionLocal() as session:
    # Force an actual DB connection early so we can return an actionable HTTP error
    # instead of letting a deep async SQLAlchemy stack trace bubble up.
    try:
      await session.connection()
    except OperationalError as exc:
      parsed = urlsplit(database_url)
      username = parsed.username or "<missing user>"
      host = parsed.hostname or "<missing host>"
      port = parsed.port or 5432
      database_name = (parsed.path or "").lstrip("/") or "<missing db>"

      original_message = str(getattr(exc, "orig", exc))
      lowered = original_message.lower()

      if "password authentication failed" in lowered:
        raise HTTPException(
          status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
          detail=(
            f"Database authentication failed for user '{username}' on {host}:{port}/{database_name}. "
            "The password in backend/.env does not match the Postgres server. "
            "In pgAdmin, confirm you're connecting to the same host/port and reset the role password if needed."
          ),
        )

      if "does not exist" in lowered and "database" in lowered:
        raise HTTPException(
          status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
          detail=(
            f"Database '{database_name}' does not exist on {host}:{port}. "
            "Create it in pgAdmin (Databases → Create → Database…) or change the DATABASE_URL db name."
          ),
        )

      raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
          f"Database connection failed to {host}:{port}/{database_name}. "
          "Check Postgres is running and DATABASE_URL in backend/.env is correct."
        ),
      )

    yield session


async def init_db(metadata) -> None:
  async with engine.begin() as connection:
    await connection.run_sync(metadata.create_all)

    # Lightweight schema evolution for local dev (no Alembic): add new columns if missing.
    # Safe on Postgres due to IF NOT EXISTS.
    await connection.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'candidate'"))
    await connection.execute(text("ALTER TABLE candidates ADD COLUMN IF NOT EXISTS years_experience INTEGER"))
    await connection.execute(text("ALTER TABLE candidates ADD COLUMN IF NOT EXISTS location TEXT"))
    await connection.execute(text("ALTER TABLE candidates ADD COLUMN IF NOT EXISTS certifications JSONB"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS recruiter_notes TEXT"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS decision_history JSONB"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS manual_rank_score DOUBLE PRECISION"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS manual_assessment_score DOUBLE PRECISION"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS last_assessment_session_code VARCHAR(64)"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS assessment_status VARCHAR(32)"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS assessment_score DOUBLE PRECISION"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS assessment_passed BOOLEAN"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS interview_scheduled_for TIMESTAMPTZ"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS interview_status VARCHAR(32)"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ"))
    await connection.execute(text("ALTER TABLE IF EXISTS job_candidate_progress ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"))
