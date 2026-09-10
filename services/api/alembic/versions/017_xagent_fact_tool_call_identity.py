"""Accept opaque provider tool-call identities in Fact audits.

Revision ID: 017_fact_tool_call_identity
Revises: 016_xagent_fact_approval
Create Date: 2026-09-10
"""

from alembic import op

revision = "017_fact_tool_call_identity"
down_revision = "016_xagent_fact_approval"
branch_labels = None
depends_on = None


LEGACY_VALIDATION = """OR value->>'tool_call_id' !~ '^call-[A-Za-z0-9-]{1,120}$'"""
OPAQUE_VALIDATION = """OR length(value->>'tool_call_id') NOT BETWEEN 1 AND 255"""


def _replace_validation(expected: str, replacement: str) -> None:
    op.execute(
        f"""
        DO $migration$
        DECLARE
            definition text;
        BEGIN
            SELECT pg_get_functiondef(
                'public.xagent_valid_fact_audit_details(text,jsonb)'::regprocedure
            ) INTO definition;
            IF position($expected${expected}$expected$ in definition) = 0
                OR position($replacement${replacement}$replacement$ in definition) <> 0 THEN
                RAISE EXCEPTION 'unexpected Fact audit validator definition';
            END IF;
            definition := replace(
                definition,
                $expected${expected}$expected$,
                $replacement${replacement}$replacement$
            );
            EXECUTE definition;
        END $migration$
        """
    )


def upgrade() -> None:
    _replace_validation(LEGACY_VALIDATION, OPAQUE_VALIDATION)


def downgrade() -> None:
    op.execute(
        """
        DO $migration$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM public.audit_events
                WHERE action LIKE 'fact.%'
                  AND details ? 'tool_call_id'
                  AND (
                      jsonb_typeof(details->'tool_call_id') <> 'string'
                      OR details->>'tool_call_id' !~ '^call-[A-Za-z0-9-]{1,120}$'
                  )
            ) THEN
                RAISE EXCEPTION
                    'cannot downgrade opaque Fact tool-call identities to revision 016';
            END IF;
        END $migration$
        """
    )
    _replace_validation(OPAQUE_VALIDATION, LEGACY_VALIDATION)
