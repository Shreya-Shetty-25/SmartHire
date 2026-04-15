"""Add job candidate progress workflow table and role column

Revision ID: 20260414_0001
Revises:
Create Date: 2026-04-14 11:30:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260414_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("role", sa.String(length=32), nullable=False, server_default="candidate"))
    op.add_column("candidates", sa.Column("years_experience", sa.Integer(), nullable=True))
    op.add_column("candidates", sa.Column("location", sa.Text(), nullable=True))
    op.add_column("candidates", sa.Column("certifications", postgresql.JSONB(astext_type=sa.Text()), nullable=True))

    op.create_table(
        "job_candidate_progress",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("candidate_id", sa.Integer(), nullable=False),
        sa.Column("stage", sa.String(length=32), nullable=False, server_default="applied"),
        sa.Column("recruiter_notes", sa.Text(), nullable=True),
        sa.Column("decision_history", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("manual_rank_score", sa.Float(), nullable=True),
        sa.Column("manual_assessment_score", sa.Float(), nullable=True),
        sa.Column("last_assessment_session_code", sa.String(length=64), nullable=True),
        sa.Column("assessment_status", sa.String(length=32), nullable=True),
        sa.Column("assessment_score", sa.Float(), nullable=True),
        sa.Column("assessment_passed", sa.Boolean(), nullable=True),
        sa.Column("interview_scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("interview_status", sa.String(length=32), nullable=True),
        sa.Column("last_contacted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["candidate_id"], ["candidates.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "candidate_id", name="uq_job_candidate_progress"),
    )
    op.create_index(op.f("ix_job_candidate_progress_id"), "job_candidate_progress", ["id"], unique=False)
    op.create_index(op.f("ix_job_candidate_progress_job_id"), "job_candidate_progress", ["job_id"], unique=False)
    op.create_index(op.f("ix_job_candidate_progress_candidate_id"), "job_candidate_progress", ["candidate_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_job_candidate_progress_candidate_id"), table_name="job_candidate_progress")
    op.drop_index(op.f("ix_job_candidate_progress_job_id"), table_name="job_candidate_progress")
    op.drop_index(op.f("ix_job_candidate_progress_id"), table_name="job_candidate_progress")
    op.drop_table("job_candidate_progress")
    op.drop_column("candidates", "certifications")
    op.drop_column("candidates", "location")
    op.drop_column("candidates", "years_experience")
    op.drop_column("users", "role")
