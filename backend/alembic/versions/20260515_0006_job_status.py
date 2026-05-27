"""Add status column to jobs table

Revision ID: 20260515_0006
Revises: 20260416_0005
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa

revision = "20260515_0006"
down_revision = "20260416_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active'"
    ))


def downgrade() -> None:
    op.drop_column("jobs", "status")
