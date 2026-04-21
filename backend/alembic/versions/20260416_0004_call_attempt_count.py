"""add call_attempt_count to exam_sessions

Revision ID: 20260416_0004
Revises: 20260416_0003_ai_insights
Create Date: 2026-04-16
"""
from alembic import op
import sqlalchemy as sa

revision = "20260416_0004"
down_revision = "20260416_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # exam_sessions lives in the assessment SQLite DB, not PostgreSQL.
    # Skip gracefully if the table doesn't exist in this DB.
    conn = op.get_bind()
    table_exists = conn.execute(sa.text(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_name='exam_sessions' LIMIT 1"
    )).fetchone()
    if not table_exists:
        return

    col_exists = conn.execute(sa.text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name='exam_sessions' AND column_name='call_attempt_count' LIMIT 1"
    )).fetchone()
    if col_exists is None:
        op.add_column(
            "exam_sessions",
            sa.Column("call_attempt_count", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    conn = op.get_bind()
    col_exists = conn.execute(sa.text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name='exam_sessions' AND column_name='call_attempt_count' LIMIT 1"
    )).fetchone()
    if col_exists is not None:
        op.drop_column("exam_sessions", "call_attempt_count")
