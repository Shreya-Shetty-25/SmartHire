"""add call_attempt_count to exam_sessions

Revision ID: 20260416_0004
Revises: 20260416_0003_ai_insights
Create Date: 2026-04-16
"""
from alembic import op
import sqlalchemy as sa

revision = "20260416_0004"
down_revision = "20260416_0003_ai_insights"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Use batch mode for SQLite compatibility (assessment backend uses SQLite)
    with op.batch_alter_table("exam_sessions") as batch_op:
        batch_op.add_column(
            sa.Column(
                "call_attempt_count",
                sa.Integer(),
                nullable=False,
                server_default="0",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("exam_sessions") as batch_op:
        batch_op.drop_column("call_attempt_count")
