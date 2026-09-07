"""Align citation authorization with terminal-answer bounds.

Revision ID: 015_citation_authorization
Revises: 014_xagent_citation_provenance
Create Date: 2026-09-08
"""

from alembic import op

revision = "015_citation_authorization"
down_revision = "014_xagent_citation_provenance"
branch_labels = None
depends_on = None


def _create_validator(arguments: str, evidence_limit: str) -> None:
    op.execute(
        f"CREATE FUNCTION public.xagent_valid_retrieval_audit_details({arguments}) "
        "RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$ "
        "DECLARE identity jsonb; BEGIN "
        "IF jsonb_typeof(value) <> 'object' OR NOT (value ?& ARRAY["
        "'session_id','tool_call_id','project_scope_sha256','query_sha256','candidate_count',"
        "'returned_count','result','latency_ms','evidence']) OR "
        "value - ARRAY['session_id','tool_call_id','project_scope_sha256','query_sha256',"
        "'candidate_count','returned_count','result','latency_ms','evidence'] <> '{}'::jsonb "
        "OR value->>'session_id' !~ '^[0-9a-f-]{36}$' "
        "OR length(value->>'tool_call_id') NOT BETWEEN 1 AND 255 "
        "OR value->>'project_scope_sha256' !~ '^[0-9a-f]{64}$' "
        "OR value->>'query_sha256' !~ '^[0-9a-f]{64}$' "
        "OR jsonb_typeof(value->'candidate_count') <> 'number' "
        "OR jsonb_typeof(value->'returned_count') <> 'number' "
        "OR jsonb_typeof(value->'latency_ms') <> 'number' "
        "OR value->>'candidate_count' !~ '^[0-9]+$' OR value->>'returned_count' !~ '^[0-9]+$' "
        "OR value->>'latency_ms' !~ '^[0-9]+$' "
        "OR (value->>'candidate_count')::numeric < 0 OR (value->>'returned_count')::numeric < 0 "
        "OR (value->>'latency_ms')::numeric < 0 OR length(value->>'result') NOT BETWEEN 1 AND 32 "
        "OR jsonb_typeof(value->'evidence') <> 'array' "
        f"OR jsonb_array_length(value->'evidence') > ({evidence_limit}) THEN RETURN false; END IF; "
        "FOR identity IN SELECT * FROM jsonb_array_elements(value->'evidence') LOOP "
        "IF jsonb_typeof(identity) <> 'object' OR NOT (identity ?& ARRAY["
        "'artifact_id','version_id','index_id','generation','chunk_id']) OR "
        "identity - ARRAY['artifact_id','version_id','index_id','generation','chunk_id'] <> '{}'::jsonb "
        "OR identity->>'artifact_id' !~ '^[0-9a-f-]{36}$' "
        "OR identity->>'version_id' !~ '^[0-9a-f-]{36}$' "
        "OR identity->>'index_id' !~ '^[0-9a-f-]{36}$' "
        "OR identity->>'chunk_id' !~ '^[0-9a-f-]{36}$' "
        "OR jsonb_typeof(identity->'generation') <> 'number' "
        "OR identity->>'generation' !~ '^[0-9]+$' "
        "OR (identity->>'generation')::numeric < 1 THEN RETURN false; END IF; END LOOP; "
        "RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$"
    )


def upgrade() -> None:
    op.drop_constraint("ck_audit_event_details", "audit_events", type_="check")
    _create_validator(
        "action_name text, value jsonb",
        "CASE WHEN action_name = 'retrieval.citation_authorize' THEN 64 ELSE 8 END",
    )
    op.execute("DROP FUNCTION public.xagent_valid_retrieval_audit_details(jsonb)")
    op.create_check_constraint(
        "ck_audit_event_details",
        "audit_events",
        "jsonb_typeof(details) = 'object' AND "
        "octet_length(details::text) <= CASE "
        "WHEN action = 'retrieval.citation_authorize' THEN 32768 ELSE 8192 END AND "
        "(action NOT LIKE 'retrieval.%' OR "
        "public.xagent_valid_retrieval_audit_details(action, details))",
    )


def downgrade() -> None:
    op.execute(
        "DO $$ BEGIN "
        "IF EXISTS (SELECT 1 FROM public.audit_events "
        "WHERE action = 'retrieval.citation_authorize' AND "
        "(octet_length(details::text) > 8192 OR "
        "jsonb_array_length(details->'evidence') > 8)) "
        "THEN RAISE EXCEPTION 'cannot downgrade citation authorization with audit evidence above legacy bounds'; "
        "END IF; END $$"
    )
    op.drop_constraint("ck_audit_event_details", "audit_events", type_="check")
    _create_validator("value jsonb", "8")
    op.execute("DROP FUNCTION public.xagent_valid_retrieval_audit_details(text, jsonb)")
    op.create_check_constraint(
        "ck_audit_event_details",
        "audit_events",
        "jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 8192 AND "
        "(action NOT LIKE 'retrieval.%' OR "
        "public.xagent_valid_retrieval_audit_details(details))",
    )
