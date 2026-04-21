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
    conn = op.get_bind()

    # ── candidate_red_flags ──
    conn.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS candidate_red_flags (
            id SERIAL NOT NULL,
            candidate_id INTEGER NOT NULL,
            credibility_score FLOAT NOT NULL,
            flags JSONB,
            summary TEXT,
            raw_llm_response JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
            PRIMARY KEY (id),
            FOREIGN KEY(candidate_id) REFERENCES candidates (id) ON DELETE CASCADE
        )
    """))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_candidate_red_flags_id ON candidate_red_flags (id)"))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_candidate_red_flags_candidate_id ON candidate_red_flags (candidate_id)"))

    # ── candidate_skill_decay ──
    conn.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS candidate_skill_decay (
            id SERIAL NOT NULL,
            candidate_id INTEGER NOT NULL,
            stale_skills JSONB,
            evergreen_skills JSONB,
            overall_freshness_score FLOAT NOT NULL,
            raw_llm_response JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
            PRIMARY KEY (id),
            FOREIGN KEY(candidate_id) REFERENCES candidates (id) ON DELETE CASCADE
        )
    """))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_candidate_skill_decay_id ON candidate_skill_decay (id)"))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_candidate_skill_decay_candidate_id ON candidate_skill_decay (candidate_id)"))

    # ── candidate_memory ──
    conn.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS candidate_memory (
            id SERIAL NOT NULL,
            candidate_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            cycle_number INTEGER NOT NULL,
            outcome VARCHAR(32) NOT NULL,
            gaps_identified JSONB,
            strengths_noted JSONB,
            rejection_reasons JSONB,
            snapshot JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
            PRIMARY KEY (id),
            FOREIGN KEY(candidate_id) REFERENCES candidates (id) ON DELETE CASCADE,
            FOREIGN KEY(job_id) REFERENCES jobs (id) ON DELETE CASCADE
        )
    """))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_candidate_memory_id ON candidate_memory (id)"))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_candidate_memory_candidate_id ON candidate_memory (candidate_id)"))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_candidate_memory_job_id ON candidate_memory (job_id)"))


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
