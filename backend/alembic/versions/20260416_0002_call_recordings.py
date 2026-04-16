"""Add call_recordings table for storing interview recordings in DB

Revision ID: 20260416_0002
Revises: 20260414_0001
Create Date: 2026-04-16 10:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260416_0002"
down_revision = "20260414_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "call_recordings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("call_sid", sa.String(length=128), nullable=True),
        sa.Column("recording_sid", sa.String(length=128), nullable=True),
        sa.Column("session_code", sa.String(length=64), nullable=True),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("audio_data", sa.LargeBinary(), nullable=False),
        sa.Column("transcript_text", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_call_recordings_id"), "call_recordings", ["id"], unique=False)
    op.create_index(op.f("ix_call_recordings_call_sid"), "call_recordings", ["call_sid"], unique=False)
    op.create_index(op.f("ix_call_recordings_session_code"), "call_recordings", ["session_code"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_call_recordings_session_code"), table_name="call_recordings")
    op.drop_index(op.f("ix_call_recordings_call_sid"), table_name="call_recordings")
    op.drop_index(op.f("ix_call_recordings_id"), table_name="call_recordings")
    op.drop_table("call_recordings")
