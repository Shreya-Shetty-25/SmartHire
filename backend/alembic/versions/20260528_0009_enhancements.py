"""Enhancements: notifications, interview slots, scorecards, offers, new columns on jobs/jcp

Revision ID: 20260528_0009
Revises: 20260515_0008
Create Date: 2026-05-28
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260528_0009"
down_revision = "20260515_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. notifications table ─────────────────────────────────────────────
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("notif_type", sa.String(64), nullable=False, index=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("data", postgresql.JSONB(), nullable=True),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), index=True),
    )

    # ── 2. interview_slots table ────────────────────────────────────────────
    op.create_table(
        "interview_slots",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("interviewer_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_booked", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("progress_id", sa.Integer(), sa.ForeignKey("job_candidate_progress.id", ondelete="SET NULL"), nullable=True),
        sa.Column("meeting_link", sa.String(512), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── 3. interview_scorecards table ───────────────────────────────────────
    op.create_table(
        "interview_scorecards",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("progress_id", sa.Integer(), sa.ForeignKey("job_candidate_progress.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("interviewer_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("overall_rating", sa.Integer(), nullable=True),
        sa.Column("technical_rating", sa.Integer(), nullable=True),
        sa.Column("communication_rating", sa.Integer(), nullable=True),
        sa.Column("culture_fit_rating", sa.Integer(), nullable=True),
        sa.Column("recommendation", sa.String(32), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── 4. offers table ─────────────────────────────────────────────────────
    op.create_table(
        "offers",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("candidate_id", sa.Integer(), sa.ForeignKey("candidates.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("progress_id", sa.Integer(), sa.ForeignKey("job_candidate_progress.id", ondelete="SET NULL"), nullable=True),
        sa.Column("offered_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("offered_salary", sa.Numeric(12, 2), nullable=True),
        sa.Column("salary_currency", sa.String(8), nullable=False, server_default="INR"),
        sa.Column("response_deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("offer_letter_text", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("acceptance_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── 5. New columns on jobs ──────────────────────────────────────────────
    op.add_column("jobs", sa.Column("approval_status", sa.String(32), nullable=False, server_default="approved"))
    op.add_column("jobs", sa.Column("reviewed_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    op.add_column("jobs", sa.Column("review_notes", sa.Text(), nullable=True))

    # ── 6. New column on job_candidate_progress ─────────────────────────────
    op.add_column("job_candidate_progress", sa.Column("interviewer_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))


def downgrade() -> None:
    op.drop_column("job_candidate_progress", "interviewer_user_id")
    op.drop_column("jobs", "review_notes")
    op.drop_column("jobs", "reviewed_by_user_id")
    op.drop_column("jobs", "approval_status")
    op.drop_table("offers")
    op.drop_table("interview_scorecards")
    op.drop_table("interview_slots")
    op.drop_table("notifications")
