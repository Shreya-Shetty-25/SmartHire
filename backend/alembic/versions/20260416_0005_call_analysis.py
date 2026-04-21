"""Add call_analysis table for AI voice interview analysis

Revision ID: 20260416_0005
Revises: 20260416_0004
Create Date: 2026-04-16
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260416_0005"
down_revision = "20260416_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS call_analysis (
            id SERIAL NOT NULL,
            session_code VARCHAR(64) NOT NULL,
            overall_score FLOAT,
            communication_score FLOAT,
            technical_score FLOAT,
            confidence_score FLOAT,
            sentiment VARCHAR(32),
            recommendation VARCHAR(32),
            summary TEXT,
            key_strengths JSONB,
            concerns JSONB,
            topic_coverage JSONB,
            raw_llm_response JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
            PRIMARY KEY (id),
            UNIQUE (session_code)
        )
    """))
    conn.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_call_analysis_id ON call_analysis (id)"))
    conn.execute(sa.text("CREATE UNIQUE INDEX IF NOT EXISTS ix_call_analysis_session_code ON call_analysis (session_code)"))


def downgrade() -> None:
    op.drop_index(op.f("ix_call_analysis_session_code"), table_name="call_analysis")
    op.drop_index(op.f("ix_call_analysis_id"), table_name="call_analysis")
    op.drop_table("call_analysis")
