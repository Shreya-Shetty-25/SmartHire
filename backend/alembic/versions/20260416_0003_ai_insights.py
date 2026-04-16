"""Add AI insights tables: red_flags, skill_decay, candidate_memory

Revision ID: 20260416_0003
Revises: 20260416_0002
Create Date: 2026-04-16 17:00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "20260416_0003"
down_revision = "20260416_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── candidate_red_flags ──
    op.create_table(
        "candidate_red_flags",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("candidate_id", sa.Integer(), nullable=False),
        sa.Column("credibility_score", sa.Float(), nullable=False),
        sa.Column("flags", JSONB(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("raw_llm_response", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["candidate_id"], ["candidates.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_candidate_red_flags_id"), "candidate_red_flags", ["id"], unique=False)
    op.create_index(op.f("ix_candidate_red_flags_candidate_id"), "candidate_red_flags", ["candidate_id"], unique=False)

    # ── candidate_skill_decay ──
    op.create_table(
        "candidate_skill_decay",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("candidate_id", sa.Integer(), nullable=False),
        sa.Column("stale_skills", JSONB(), nullable=True),
        sa.Column("evergreen_skills", JSONB(), nullable=True),
        sa.Column("overall_freshness_score", sa.Float(), nullable=False),
        sa.Column("raw_llm_response", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["candidate_id"], ["candidates.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_candidate_skill_decay_id"), "candidate_skill_decay", ["id"], unique=False)
    op.create_index(op.f("ix_candidate_skill_decay_candidate_id"), "candidate_skill_decay", ["candidate_id"], unique=False)

    # ── candidate_memory ──
    op.create_table(
        "candidate_memory",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("candidate_id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("cycle_number", sa.Integer(), nullable=False),
        sa.Column("outcome", sa.String(length=32), nullable=False),
        sa.Column("gaps_identified", JSONB(), nullable=True),
        sa.Column("strengths_noted", JSONB(), nullable=True),
        sa.Column("rejection_reasons", JSONB(), nullable=True),
        sa.Column("snapshot", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["candidate_id"], ["candidates.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_candidate_memory_id"), "candidate_memory", ["id"], unique=False)
    op.create_index(op.f("ix_candidate_memory_candidate_id"), "candidate_memory", ["candidate_id"], unique=False)
    op.create_index(op.f("ix_candidate_memory_job_id"), "candidate_memory", ["job_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_candidate_memory_job_id"), table_name="candidate_memory")
    op.drop_index(op.f("ix_candidate_memory_candidate_id"), table_name="candidate_memory")
    op.drop_index(op.f("ix_candidate_memory_id"), table_name="candidate_memory")
    op.drop_table("candidate_memory")

    op.drop_index(op.f("ix_candidate_skill_decay_candidate_id"), table_name="candidate_skill_decay")
    op.drop_index(op.f("ix_candidate_skill_decay_id"), table_name="candidate_skill_decay")
    op.drop_table("candidate_skill_decay")

    op.drop_index(op.f("ix_candidate_red_flags_candidate_id"), table_name="candidate_red_flags")
    op.drop_index(op.f("ix_candidate_red_flags_id"), table_name="candidate_red_flags")
    op.drop_table("candidate_red_flags")
