from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, JSON, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class JobsBase(DeclarativeBase):
    pass


class AssessmentBase(DeclarativeBase):
    pass


class Job(JobsBase):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    skills_required: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    additional_skills: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)


class ExamSession(AssessmentBase):
    __tablename__ = "exam_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    session_code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    job_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    candidate_name: Mapped[str] = mapped_column(String(255), nullable=False)
    candidate_email: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="created", nullable=False)
    duration_minutes: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    questions_json: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    answers_json: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_questions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    percentage: Mapped[float | None] = mapped_column(Float, nullable=True)
    passed: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 1=pass, 0=fail
    result_analysis: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    email_sent: Mapped[str | None] = mapped_column(String(32), nullable=True)  # "pass" / "fail" / None
    call_sid: Mapped[str | None] = mapped_column(String(128), nullable=True)
    call_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    call_responses: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    resume_skills: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    job_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ProctorEvent(AssessmentBase):
    __tablename__ = "proctor_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    session_code: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), default="medium", nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
