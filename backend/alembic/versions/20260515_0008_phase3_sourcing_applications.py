"""Phase 3: Sourcing & Applications - referrals, knockout questions, source tracking, gdpr, cover letter, duplicate detection

Revision ID: 20260515_0008
Revises: 20260515_0007
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260515_0008"
down_revision = "20260515_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. referrals table ─────────────────────────────────────────────────
    op.create_table(
        "referrals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("referrer_name", sa.String(255), nullable=False),
        sa.Column("referrer_email", sa.String(255), nullable=False),
        sa.Column("referrer_employee_id", sa.String(64), nullable=True),
        sa.Column("candidate_name", sa.String(255), nullable=False),
        sa.Column("candidate_email", sa.String(255), nullable=False),
        sa.Column("candidate_phone", sa.String(64), nullable=True),
        sa.Column("relationship", sa.String(128), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),  # pending | reviewed | hired | rejected
        sa.Column("candidate_id", sa.Integer(), sa.ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── 2. knockout_questions table ────────────────────────────────────────
    op.create_table(
        "knockout_questions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("question_text", sa.Text(), nullable=False),
        sa.Column("expected_answer", sa.String(8), nullable=False, server_default="yes"),  # yes | no
        sa.Column("is_required", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── 3. Extend job_candidate_progress with source tracking, gdpr, cover letter ──
    op.add_column("job_candidate_progress", sa.Column("source", sa.String(64), nullable=True))
    # source values: careers_page | referral | linkedin | indeed | job_board | direct | bulk_import | other
    op.add_column("job_candidate_progress", sa.Column("source_detail", sa.String(255), nullable=True))
    op.add_column("job_candidate_progress", sa.Column("referral_id", sa.Integer(), sa.ForeignKey("referrals.id", ondelete="SET NULL"), nullable=True))
    op.add_column("job_candidate_progress", sa.Column("cover_letter", sa.Text(), nullable=True))
    op.add_column("job_candidate_progress", sa.Column("custom_fields", postgresql.JSONB(), nullable=True))
    op.add_column("job_candidate_progress", sa.Column("gdpr_consent", sa.Boolean(), nullable=True))
    op.add_column("job_candidate_progress", sa.Column("gdpr_consent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("job_candidate_progress", sa.Column("knockout_answers", postgresql.JSONB(), nullable=True))
    op.add_column("job_candidate_progress", sa.Column("knockout_passed", sa.Boolean(), nullable=True))
    # auto-reject flag set when knockout_passed=False
    op.add_column("job_candidate_progress", sa.Column("auto_rejected", sa.Boolean(), nullable=False, server_default="false"))

    # ── 4. Extend candidates with source + duplicate detection fields ──────
    op.add_column("candidates", sa.Column("phone_normalized", sa.String(32), nullable=True))
    op.add_column("candidates", sa.Column("duplicate_of_id", sa.Integer(), sa.ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True))
    op.add_column("candidates", sa.Column("is_duplicate", sa.Boolean(), nullable=False, server_default="false"))

    # Index for fast duplicate detection
    op.create_index("ix_candidates_phone_normalized", "candidates", ["phone_normalized"])


def downgrade() -> None:
    op.drop_index("ix_candidates_phone_normalized", "candidates")
    op.drop_column("candidates", "is_duplicate")
    op.drop_column("candidates", "duplicate_of_id")
    op.drop_column("candidates", "phone_normalized")

    op.drop_column("job_candidate_progress", "auto_rejected")
    op.drop_column("job_candidate_progress", "knockout_passed")
    op.drop_column("job_candidate_progress", "knockout_answers")
    op.drop_column("job_candidate_progress", "gdpr_consent_at")
    op.drop_column("job_candidate_progress", "gdpr_consent")
    op.drop_column("job_candidate_progress", "custom_fields")
    op.drop_column("job_candidate_progress", "cover_letter")
    op.drop_column("job_candidate_progress", "referral_id")
    op.drop_column("job_candidate_progress", "source_detail")
    op.drop_column("job_candidate_progress", "source")

    op.drop_table("knockout_questions")
    op.drop_table("referrals")
