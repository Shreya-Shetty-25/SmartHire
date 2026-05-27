"""Phase 1 & 2: departments, hire_requisitions, job fields (salary, dept, template)

Revision ID: 20260515_0007
Revises: 20260515_0006
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa

revision = "20260515_0007"
down_revision = "20260515_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- departments ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS departments (
            id          SERIAL PRIMARY KEY,
            name        VARCHAR(255) NOT NULL UNIQUE,
            description TEXT,
            head_name   VARCHAR(255),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    # --- hire_requisitions ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS hire_requisitions (
            id                  SERIAL PRIMARY KEY,
            department_id       INTEGER REFERENCES departments(id) ON DELETE SET NULL,
            job_title           VARCHAR(255) NOT NULL,
            justification       TEXT,
            headcount           INTEGER NOT NULL DEFAULT 1,
            employment_type     VARCHAR(64),
            salary_budget_min   NUMERIC(12,2),
            salary_budget_max   NUMERIC(12,2),
            salary_currency     VARCHAR(8) NOT NULL DEFAULT 'INR',
            status              VARCHAR(32) NOT NULL DEFAULT 'draft',
            requested_by_name   VARCHAR(255),
            requested_by_email  VARCHAR(255),
            approver_notes      TEXT,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_hire_req_status ON hire_requisitions(status)")

    # --- extend jobs table ---
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min NUMERIC(12,2)")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max NUMERIC(12,2)")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_currency VARCHAR(8) NOT NULL DEFAULT 'INR'")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requisition_id INTEGER REFERENCES hire_requisitions(id) ON DELETE SET NULL")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT FALSE")
    op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS template_name VARCHAR(255)")


def downgrade() -> None:
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS template_name")
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS is_template")
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS requisition_id")
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS salary_currency")
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS salary_max")
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS salary_min")
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS department_id")
    op.execute("DROP TABLE IF EXISTS hire_requisitions")
    op.execute("DROP TABLE IF EXISTS departments")
