"""Persist immutable production write permissions on draft test reports.

Revision ID: 019_skill_test_permissions
Revises: 018_xagent_business_skills
Create Date: 2026-09-12
"""

from alembic import op

revision = "019_skill_test_permissions"
down_revision = "018_xagent_business_skills"
branch_labels = None
depends_on = None


def _require_empty() -> None:
    op.execute("LOCK TABLE public.business_skill_test_runs IN ACCESS EXCLUSIVE MODE")
    op.execute("""
        DO $migration$
        BEGIN
            IF EXISTS (SELECT 1 FROM public.business_skill_test_runs) THEN
                RAISE EXCEPTION 'cannot migrate nonempty Business Skill test permission history';
            END IF;
        END $migration$
    """)


def upgrade() -> None:
    _require_empty()
    op.execute("""
        ALTER TABLE public.business_skill_test_runs
            ADD COLUMN unexecuted_write_tools jsonb NOT NULL,
            ADD CONSTRAINT ck_business_skill_test_write_tools
                CHECK (unexecuted_write_tools IN ('[]'::jsonb, '["propose_fact"]'::jsonb));
    """)


def downgrade() -> None:
    _require_empty()
    op.execute("ALTER TABLE public.business_skill_test_runs DROP COLUMN unexecuted_write_tools")
