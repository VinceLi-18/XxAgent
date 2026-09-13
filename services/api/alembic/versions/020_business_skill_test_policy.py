"""Persist the immutable read-only tool set that authorizes each draft test.

Revision ID: 020_skill_test_policy
Revises: 019_skill_test_permissions
Create Date: 2026-09-12
"""

from alembic import op

revision = "020_skill_test_policy"
down_revision = "019_skill_test_permissions"
branch_labels = None
depends_on = None


def _require_empty() -> None:
    op.execute("LOCK TABLE public.business_skill_test_runs IN ACCESS EXCLUSIVE MODE")
    op.execute("""
        DO $migration$
        BEGIN
            IF EXISTS (SELECT 1 FROM public.business_skill_test_runs) THEN
                RAISE EXCEPTION 'cannot migrate nonempty Business Skill test tool policy';
            END IF;
        END $migration$
    """)


def upgrade() -> None:
    _require_empty()
    op.execute("""
        ALTER TABLE public.business_skill_test_runs
            ADD COLUMN test_tools jsonb NOT NULL,
            ADD CONSTRAINT ck_business_skill_test_tools CHECK (
                public.xagent_valid_business_skill_tools(test_tools, true)
                AND NOT test_tools ? 'propose_fact'
                AND (test_tools ? 'search_artifacts') = (test_tools ? 'submit_cited_answer'));
    """)


def downgrade() -> None:
    _require_empty()
    op.execute("ALTER TABLE public.business_skill_test_runs DROP COLUMN test_tools")
