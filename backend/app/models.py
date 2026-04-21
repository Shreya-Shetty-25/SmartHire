from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint, func
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
  role: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate", server_default="candidate")
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


class CandidateDocument(Base):
  __tablename__ = "candidate_documents"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True, nullable=False)
  doc_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
  file_name: Mapped[str] = mapped_column(String(255), nullable=False)
  content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
  file_size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  file_data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JobCandidateProgress(Base):
  __tablename__ = "job_candidate_progress"
  __table_args__ = (UniqueConstraint("job_id", "candidate_id", name="uq_job_candidate_progress"),)

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
  candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True)

  stage: Mapped[str] = mapped_column(String(32), nullable=False, default="applied", server_default="applied")
  recruiter_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
  decision_history: Mapped[list[dict] | None] = mapped_column(JSONB, nullable=True)

  manual_rank_score: Mapped[float | None] = mapped_column(Float, nullable=True)
  manual_assessment_score: Mapped[float | None] = mapped_column(Float, nullable=True)
  last_assessment_session_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
  assessment_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
  assessment_score: Mapped[float | None] = mapped_column(Float, nullable=True)
  assessment_passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

  interview_scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
  interview_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
  last_contacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


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


class CandidateEmbeddingChunk(Base):
  __tablename__ = "candidate_embedding_chunks"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True)

  model_name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
  chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
  text: Mapped[str] = mapped_column(String, nullable=False)
  embedding: Mapped[list[float]] = mapped_column(JSONB, nullable=False)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JobEmbeddingChunk(Base):
  __tablename__ = "job_embedding_chunks"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)

  model_name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
  chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
  text: Mapped[str] = mapped_column(String, nullable=False)
  embedding: Mapped[list[float]] = mapped_column(JSONB, nullable=False)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CallRecording(Base):
  __tablename__ = "call_recordings"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  call_sid: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
  recording_sid: Mapped[str | None] = mapped_column(String(128), nullable=True)
  session_code: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
  file_name: Mapped[str] = mapped_column(String(255), nullable=False)
  duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
  audio_data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
  transcript_text: Mapped[str | None] = mapped_column(Text, nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CallAnalysis(Base):
  """LLM-generated analysis of an AI voice interview, keyed by session_code."""
  __tablename__ = "call_analysis"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  session_code: Mapped[str] = mapped_column(String(64), nullable=False, index=True, unique=True)

  # Scores (0–100)
  overall_score: Mapped[float | None] = mapped_column(Float, nullable=True)
  communication_score: Mapped[float | None] = mapped_column(Float, nullable=True)
  technical_score: Mapped[float | None] = mapped_column(Float, nullable=True)
  confidence_score: Mapped[float | None] = mapped_column(Float, nullable=True)

  # Qualitative fields
  sentiment: Mapped[str | None] = mapped_column(String(32), nullable=True)   # positive | neutral | negative
  recommendation: Mapped[str | None] = mapped_column(String(32), nullable=True)  # hire | consider | reject
  summary: Mapped[str | None] = mapped_column(Text, nullable=True)
  key_strengths: Mapped[list | None] = mapped_column(JSONB, nullable=True)
  concerns: Mapped[list | None] = mapped_column(JSONB, nullable=True)
  topic_coverage: Mapped[list | None] = mapped_column(JSONB, nullable=True)

  raw_llm_response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ── AI Insights models ───────────────────────────────────────────────────────


class CandidateRedFlag(Base):
  __tablename__ = "candidate_red_flags"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True, nullable=False)

  credibility_score: Mapped[float] = mapped_column(Float, nullable=False)
  flags: Mapped[list[dict] | None] = mapped_column(JSONB, nullable=True)
  summary: Mapped[str | None] = mapped_column(Text, nullable=True)
  raw_llm_response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class CandidateSkillDecay(Base):
  __tablename__ = "candidate_skill_decay"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True, nullable=False)

  stale_skills: Mapped[list[dict] | None] = mapped_column(JSONB, nullable=True)
  evergreen_skills: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  overall_freshness_score: Mapped[float] = mapped_column(Float, nullable=False)
  raw_llm_response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class CandidateMemory(Base):
  __tablename__ = "candidate_memory"

  id: Mapped[int] = mapped_column(primary_key=True, index=True)
  candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True, nullable=False)
  job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True, nullable=False)

  cycle_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
  outcome: Mapped[str] = mapped_column(String(32), nullable=False)
  gaps_identified: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  strengths_noted: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  rejection_reasons: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
  snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
