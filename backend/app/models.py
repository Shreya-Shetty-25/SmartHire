from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
  pass


class User(Base):
  __tablename__ = "users"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
  hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
  full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
  is_active: Mapped[bool] = mapped_column(Boolean, default=True)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Candidate(Base):
  __tablename__ = "candidates"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)

  full_name: Mapped[str] = mapped_column(String(255), nullable=False)
  email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
  phone_number: Mapped[str | None] = mapped_column(String(64), nullable=True)

  college_details: Mapped[str | None] = mapped_column(String, nullable=True)
  school_details: Mapped[str | None] = mapped_column(String, nullable=True)

  projects: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  skills: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  work_experience: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  extra_curricular_activities: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  website_links: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)

  years_experience: Mapped[int | None] = mapped_column(Integer, nullable=True)
  location: Mapped[str | None] = mapped_column(String(255), nullable=True)
  certifications: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)

  resume_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
  resume_pdf: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Job(Base):
  __tablename__ = "jobs"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)

  title: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
  description: Mapped[str] = mapped_column(String, nullable=False)
  education: Mapped[str | None] = mapped_column(String(255), nullable=True)
  years_experience: Mapped[int | None] = mapped_column(Integer, nullable=True)
  skills_required: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  additional_skills: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  location: Mapped[str | None] = mapped_column(String(255), nullable=True)
  employment_type: Mapped[str | None] = mapped_column(String(64), nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JobRankRun(Base):
  __tablename__ = "job_rank_runs"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
  created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

  threshold_score: Mapped[float] = mapped_column(Float, nullable=False, default=70.0)
  source: Mapped[str] = mapped_column(String(32), nullable=False)  # upload | dump

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JobRankResult(Base):
  __tablename__ = "job_rank_results"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  run_id: Mapped[int] = mapped_column(ForeignKey("job_rank_runs.id", ondelete="CASCADE"), index=True)
  candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True)

  score: Mapped[float] = mapped_column(Float, nullable=False)
  passed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
  analysis: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
