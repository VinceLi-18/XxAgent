"""Add governed project Fact proposal and approval storage.

Revision ID: 016_xagent_fact_approval
Revises: 015_citation_authorization
Create Date: 2026-09-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "016_xagent_fact_approval"
down_revision = "015_citation_authorization"
branch_labels = None
depends_on = None


def _configured_role(option: str) -> str:
    role = op.get_context().config.get_main_option(option)
    if not role:
        raise RuntimeError(f"Alembic {option} configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def _value_check() -> str:
    return (
        "(value_type = 'text' AND jsonb_typeof(value) = 'string' "
        "AND octet_length(value #>> '{}') <= 16384) OR "
        "(value_type = 'number' AND jsonb_typeof(value) = 'number') OR "
        "(value_type = 'boolean' AND jsonb_typeof(value) = 'boolean') OR "
        "(value_type = 'date' AND jsonb_typeof(value) = 'string' "
        "AND (value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' "
        "AND to_char(to_date(value #>> '{}', 'YYYY-MM-DD'), 'YYYY-MM-DD') = (value #>> '{}'))"
    )


def _field_key_check() -> str:
    return (
        "field_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$' "
        "AND octet_length(field_key) <= 128"
    )


def _create_tables() -> None:
    op.create_unique_constraint(
        "uq_xagent_session_project_identity",
        "xagent_sessions",
        ["id", "project_id"],
    )
    op.create_unique_constraint(
        "uq_artifact_text_chunk_exact_range",
        "artifact_text_chunks",
        ["id", "index_id", "line_start", "line_end"],
    )
    op.create_table(
        "fact_proposals",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("field_key", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("value_type", sa.String(length=16), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("proposer_id", sa.UUID(), nullable=False),
        sa.Column("source_session_id", sa.UUID(), nullable=False),
        sa.Column("source_tool_call_id", sa.String(length=255), nullable=False),
        sa.Column("base_revision", sa.BigInteger(), nullable=False),
        sa.Column("assertion_reason", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="prepared"),
        sa.Column("decision_actor_id", sa.UUID(), nullable=True),
        sa.Column("decision_reason", sa.Text(), nullable=True),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("permission_revision", sa.BigInteger(), nullable=False),
        sa.Column("admission_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("admitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(_field_key_check(), name="ck_fact_proposal_field_key"),
        sa.CheckConstraint("octet_length(label) BETWEEN 1 AND 255", name="ck_fact_proposal_label"),
        sa.CheckConstraint(_value_check(), name="ck_fact_proposal_value"),
        sa.CheckConstraint("base_revision >= 0", name="ck_fact_proposal_base_revision"),
        sa.CheckConstraint("permission_revision >= 1", name="ck_fact_proposal_permission_revision"),
        sa.CheckConstraint(
            "assertion_reason IS NULL OR octet_length(assertion_reason) BETWEEN 1 AND 4096",
            name="ck_fact_proposal_assertion_reason",
        ),
        sa.CheckConstraint(
            "decision_reason IS NULL OR octet_length(decision_reason) BETWEEN 1 AND 4096",
            name="ck_fact_proposal_decision_reason",
        ),
        sa.CheckConstraint(
            "payload_sha256 ~ '^[0-9a-f]{64}$'",
            name="ck_fact_proposal_payload_hash",
        ),
        sa.CheckConstraint(
            "status IN ('prepared', 'pending', 'confirmed', 'rejected', 'withdrawn', 'conflicted', 'expired')",
            name="ck_fact_proposal_status",
        ),
        sa.CheckConstraint(
            "admission_expires_at = created_at + INTERVAL '5 minutes'",
            name="ck_fact_proposal_admission_expiry",
        ),
        sa.CheckConstraint(
            "(status = 'prepared' AND admitted_at IS NULL AND decided_at IS NULL "
            "AND decision_actor_id IS NULL AND decision_reason IS NULL) OR "
            "(status = 'pending' AND admitted_at IS NOT NULL AND decided_at IS NULL "
            "AND decision_actor_id IS NULL AND decision_reason IS NULL) OR "
            "(status = 'expired' AND admitted_at IS NULL AND decided_at IS NOT NULL "
            "AND decision_actor_id IS NULL AND decision_reason IS NULL) OR "
            "(status IN ('confirmed', 'rejected', 'withdrawn', 'conflicted') "
            "AND admitted_at IS NOT NULL AND decided_at IS NOT NULL "
            "AND decision_actor_id IS NOT NULL "
            "AND (status <> 'rejected' OR decision_reason IS NOT NULL))",
            name="ck_fact_proposal_lifecycle_fields",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["proposer_id"], ["accounts.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["decision_actor_id"], ["accounts.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["source_session_id", "project_id"],
            ["xagent_sessions.id", "xagent_sessions.project_id"],
            name="fk_fact_proposal_project_session",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "project_id", name="uq_fact_proposal_project_identity"),
        sa.UniqueConstraint(
            "id", "project_id", "field_key",
            name="uq_fact_proposal_field_identity",
        ),
        sa.UniqueConstraint(
            "id", "source_session_id",
            name="uq_fact_proposal_session_identity",
        ),
        sa.UniqueConstraint(
            "id", "project_id", "source_session_id",
            name="uq_fact_proposal_project_session_identity",
        ),
        sa.UniqueConstraint(
            "id", "project_id", "field_key", "base_revision",
            name="uq_fact_proposal_revision_identity",
        ),
        sa.UniqueConstraint(
            "id", "project_id", "proposer_id", "source_session_id",
            "source_tool_call_id", "permission_revision", "payload_sha256",
            name="uq_fact_proposal_receipt_claims",
        ),
        sa.UniqueConstraint(
            "proposer_id", "source_session_id", "idempotency_key",
            name="uq_fact_proposal_prepare_idempotency",
        ),
    )
    op.create_index(
        "ix_fact_proposals_project_status_created",
        "fact_proposals",
        ["project_id", "status", "created_at", "id"],
    )
    op.create_table(
        "project_fact_revisions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("field_key", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("value_type", sa.String(length=16), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content_revision", sa.BigInteger(), nullable=False),
        sa.Column("proposal_id", sa.UUID(), nullable=False),
        sa.Column("confirmed_by_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(_field_key_check(), name="ck_project_fact_revision_field_key"),
        sa.CheckConstraint(
            "octet_length(label) BETWEEN 1 AND 255",
            name="ck_project_fact_revision_label",
        ),
        sa.CheckConstraint(_value_check(), name="ck_project_fact_revision_value"),
        sa.CheckConstraint(
            "content_revision >= 1",
            name="ck_project_fact_revision_content_revision",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["confirmed_by_id"], ["accounts.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["proposal_id", "project_id", "field_key"],
            ["fact_proposals.id", "fact_proposals.project_id", "fact_proposals.field_key"],
            name="fk_project_fact_revision_proposal_identity",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "field_key", "content_revision",
            name="uq_project_fact_revision_content_revision",
        ),
        sa.UniqueConstraint("proposal_id", name="uq_project_fact_revision_proposal"),
        sa.UniqueConstraint(
            "id", "project_id",
            name="uq_project_fact_revision_project_identity",
        ),
        sa.UniqueConstraint(
            "id", "proposal_id", "project_id",
            name="uq_project_fact_revision_proposal_identity",
        ),
        sa.UniqueConstraint(
            "id", "project_id", "field_key", "content_revision",
            name="uq_project_fact_revision_head_identity",
        ),
    )
    op.create_table(
        "project_fact_heads",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("field_key", sa.String(length=128), nullable=False),
        sa.Column("revision_id", sa.UUID(), nullable=False),
        sa.Column("content_revision", sa.BigInteger(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(_field_key_check(), name="ck_project_fact_head_field_key"),
        sa.CheckConstraint("content_revision >= 1", name="ck_project_fact_head_content_revision"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["revision_id", "project_id", "field_key", "content_revision"],
            [
                "project_fact_revisions.id", "project_fact_revisions.project_id",
                "project_fact_revisions.field_key", "project_fact_revisions.content_revision",
            ],
            name="fk_project_fact_head_revision_identity",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("project_id", "field_key"),
        sa.UniqueConstraint("revision_id", name="uq_project_fact_head_revision"),
    )
    op.create_table(
        "fact_proposal_evidence",
        sa.Column("proposal_id", sa.UUID(), nullable=False),
        sa.Column("citation_id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("admission_event_sequence", sa.BigInteger(), nullable=False),
        sa.Column("artifact_id", sa.UUID(), nullable=False),
        sa.Column("version_id", sa.UUID(), nullable=False),
        sa.Column("index_id", sa.UUID(), nullable=False),
        sa.Column("index_generation", sa.Integer(), nullable=False),
        sa.Column("chunk_id", sa.UUID(), nullable=False),
        sa.Column("line_start", sa.Integer(), nullable=False),
        sa.Column("line_end", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "citation_id ~ '^\\[资料[1-9][0-9]*\\]$'",
            name="ck_fact_proposal_evidence_citation_id",
        ),
        sa.CheckConstraint(
            "admission_event_sequence >= 0",
            name="ck_fact_proposal_evidence_event",
        ),
        sa.CheckConstraint(
            "index_generation >= 1",
            name="ck_fact_proposal_evidence_generation",
        ),
        sa.CheckConstraint(
            "line_start >= 1 AND line_end >= line_start",
            name="ck_fact_proposal_evidence_lines",
        ),
        sa.ForeignKeyConstraint(
            ["proposal_id", "project_id", "session_id"],
            ["fact_proposals.id", "fact_proposals.project_id", "fact_proposals.source_session_id"],
            name="fk_fact_proposal_evidence_proposal_identity",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            [
                "session_id", "citation_id", "admission_event_sequence", "artifact_id",
                "version_id", "index_id", "index_generation", "chunk_id",
            ],
            [
                "xagent_admitted_evidence.session_id", "xagent_admitted_evidence.citation_id",
                "xagent_admitted_evidence.admission_event_sequence",
                "xagent_admitted_evidence.artifact_id", "xagent_admitted_evidence.version_id",
                "xagent_admitted_evidence.index_id", "xagent_admitted_evidence.index_generation",
                "xagent_admitted_evidence.chunk_id",
            ],
            name="fk_fact_proposal_evidence_admitted_identity",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["chunk_id", "index_id", "line_start", "line_end"],
            [
                "artifact_text_chunks.id", "artifact_text_chunks.index_id",
                "artifact_text_chunks.line_start", "artifact_text_chunks.line_end",
            ],
            name="fk_fact_proposal_evidence_chunk_range",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("proposal_id", "citation_id"),
    )
    op.create_table(
        "fact_proposal_receipts",
        sa.Column("receipt_digest_id", sa.UUID(), nullable=False),
        sa.Column("proposal_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("tool_call_id", sa.String(length=255), nullable=False),
        sa.Column("permission_revision", sa.BigInteger(), nullable=False),
        sa.Column("source_event_sequence", sa.BigInteger(), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consumed_event_sequence", sa.BigInteger(), nullable=True),
        sa.Column("consumed_payload_sha256", sa.String(length=64), nullable=True),
        sa.CheckConstraint(
            "permission_revision >= 1",
            name="ck_fact_proposal_receipt_permission_revision",
        ),
        sa.CheckConstraint(
            "source_event_sequence >= 1",
            name="ck_fact_proposal_receipt_event",
        ),
        sa.CheckConstraint(
            "payload_sha256 ~ '^[0-9a-f]{64}$'",
            name="ck_fact_proposal_receipt_payload_hash",
        ),
        sa.CheckConstraint(
            "expires_at = issued_at + INTERVAL '5 minutes'",
            name="ck_fact_proposal_receipt_expiry",
        ),
        sa.CheckConstraint(
            "(consumed_at IS NULL AND consumed_event_sequence IS NULL AND consumed_payload_sha256 IS NULL) OR "
            "(consumed_at IS NOT NULL AND consumed_event_sequence IS NOT NULL "
            "AND consumed_event_sequence = source_event_sequence "
            "AND consumed_payload_sha256 = payload_sha256)",
            name="ck_fact_proposal_receipt_consumption",
        ),
        sa.ForeignKeyConstraint(
            [
                "proposal_id", "project_id", "actor_id", "session_id",
                "tool_call_id", "permission_revision", "payload_sha256",
            ],
            [
                "fact_proposals.id", "fact_proposals.project_id", "fact_proposals.proposer_id",
                "fact_proposals.source_session_id", "fact_proposals.source_tool_call_id",
                "fact_proposals.permission_revision", "fact_proposals.payload_sha256",
            ],
            name="fk_fact_proposal_receipt_claims",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("receipt_digest_id"),
        sa.UniqueConstraint(
            "session_id", "consumed_event_sequence",
            name="uq_fact_proposal_receipt_consumption",
        ),
    )
    op.create_table(
        "business_outbox",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("aggregate_kind", sa.String(length=32), nullable=False, server_default="fact_proposal"),
        sa.Column("aggregate_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("source_session_id", sa.UUID(), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consumed_event_sequence", sa.BigInteger(), nullable=True),
        sa.CheckConstraint(
            "aggregate_kind = 'fact_proposal'",
            name="ck_business_outbox_aggregate_kind",
        ),
        sa.CheckConstraint(
            "payload_sha256 ~ '^[0-9a-f]{64}$'",
            name="ck_business_outbox_payload_hash",
        ),
        sa.CheckConstraint(
            "(consumed_at IS NULL AND consumed_event_sequence IS NULL) OR "
            "(consumed_at IS NOT NULL AND consumed_event_sequence IS NOT NULL "
            "AND consumed_event_sequence >= 0)",
            name="ck_business_outbox_consumption",
        ),
        sa.ForeignKeyConstraint(
            ["aggregate_id", "project_id", "source_session_id"],
            ["fact_proposals.id", "fact_proposals.project_id", "fact_proposals.source_session_id"],
            name="fk_business_outbox_fact_proposal_identity",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("aggregate_id", name="uq_business_outbox_fact_proposal"),
        sa.UniqueConstraint("id", "project_id", name="uq_business_outbox_project_identity"),
        sa.UniqueConstraint(
            "id", "aggregate_id", "project_id",
            name="uq_business_outbox_operation_identity",
        ),
        sa.UniqueConstraint(
            "source_session_id", "consumed_event_sequence",
            name="uq_business_outbox_session_event",
        ),
    )
    op.create_index(
        "ix_business_outbox_session_created",
        "business_outbox",
        ["source_session_id", "created_at", "id"],
    )
    op.create_table(
        "fact_operation_idempotency",
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("operation", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("request_sha256", sa.String(length=64), nullable=False),
        sa.Column("proposal_id", sa.UUID(), nullable=False),
        sa.Column("response_status", sa.String(length=16), nullable=False),
        sa.Column("revision_id", sa.UUID(), nullable=True),
        sa.Column("outbox_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "operation IN ('prepare', 'approve', 'reject', 'withdraw', 'outbox_append')",
            name="ck_fact_operation_idempotency_operation",
        ),
        sa.CheckConstraint(
            "request_sha256 ~ '^[0-9a-f]{64}$'",
            name="ck_fact_operation_idempotency_request_hash",
        ),
        sa.CheckConstraint(
            "response_status IN ('prepared', 'pending', 'confirmed', 'rejected', 'withdrawn', 'conflicted')",
            name="ck_fact_operation_idempotency_response_status",
        ),
        sa.CheckConstraint(
            "operation NOT IN ('prepare', 'approve', 'reject', 'withdraw') OR "
            "(operation = 'prepare' AND response_status = 'prepared') OR "
            "(operation = 'approve' AND response_status IN ('confirmed', 'conflicted')) OR "
            "(operation = 'reject' AND response_status = 'rejected') OR "
            "(operation = 'withdraw' AND response_status = 'withdrawn')",
            name="ck_fact_operation_idempotency_decision_status",
        ),
        sa.CheckConstraint(
            "operation NOT IN ('approve', 'reject', 'withdraw') OR "
            "((response_status = 'confirmed') = (revision_id IS NOT NULL))",
            name="ck_fact_operation_idempotency_revision_identity",
        ),
        sa.CheckConstraint(
            "operation NOT IN ('approve', 'reject', 'withdraw') OR outbox_id IS NOT NULL",
            name="ck_fact_operation_idempotency_outbox_identity",
        ),
        sa.ForeignKeyConstraint(["actor_id"], ["accounts.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["proposal_id", "project_id"],
            ["fact_proposals.id", "fact_proposals.project_id"],
            name="fk_fact_operation_idempotency_proposal",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["revision_id", "proposal_id", "project_id"],
            [
                "project_fact_revisions.id",
                "project_fact_revisions.proposal_id",
                "project_fact_revisions.project_id",
            ],
            name="fk_fact_operation_idempotency_revision_proposal",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["outbox_id", "proposal_id", "project_id"],
            ["business_outbox.id", "business_outbox.aggregate_id", "business_outbox.project_id"],
            name="fk_fact_operation_idempotency_outbox_proposal",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("actor_id", "operation", "idempotency_key"),
    )


def _create_fact_audit_validator() -> None:
    op.execute(
        """
        CREATE FUNCTION public.xagent_valid_fact_audit_details(action_name text, value jsonb)
        RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
        DECLARE
            key text;
            allowed_keys text[];
            allowed_operations text[];
            allowed_results text[];
            allowed_statuses text[];
            status_required boolean;
        BEGIN
            IF jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
            CASE action_name
                WHEN 'fact.prepare' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','tool_call_id',
                        'operation','request_sha256','payload_sha256','permission_revision',
                        'evidence_count','result','status','latency_ms'];
                    allowed_operations := ARRAY['prepare'];
                    allowed_results := ARRAY['prepared'];
                    allowed_statuses := ARRAY['prepared'];
                    status_required := true;
                WHEN 'fact.admit' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','tool_call_id',
                        'event_sequence','operation','request_sha256','payload_sha256',
                        'permission_revision','evidence_count','result','status','latency_ms'];
                    allowed_operations := ARRAY['admit'];
                    allowed_results := ARRAY['pending'];
                    allowed_statuses := ARRAY['pending'];
                    status_required := true;
                WHEN 'fact.expire' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','operation',
                        'request_sha256','payload_sha256','result','status','latency_ms'];
                    allowed_operations := ARRAY['expire'];
                    allowed_results := ARRAY['expired'];
                    allowed_statuses := ARRAY['expired'];
                    status_required := true;
                WHEN 'fact.withdraw' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','outbox_id',
                        'operation','request_sha256','payload_sha256','result','status','latency_ms'];
                    allowed_operations := ARRAY['withdraw'];
                    allowed_results := ARRAY['withdrawn'];
                    allowed_statuses := ARRAY['withdrawn'];
                    status_required := true;
                WHEN 'fact.approve' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','fact_revision_id',
                        'outbox_id','operation','request_sha256','payload_sha256','evidence_count',
                        'result','status','latency_ms'];
                    allowed_operations := ARRAY['approve'];
                    allowed_results := ARRAY['confirmed'];
                    allowed_statuses := ARRAY['confirmed'];
                    status_required := true;
                WHEN 'fact.reject' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','outbox_id',
                        'operation','request_sha256','payload_sha256','evidence_count','result',
                        'status','latency_ms'];
                    allowed_operations := ARRAY['reject'];
                    allowed_results := ARRAY['rejected'];
                    allowed_statuses := ARRAY['rejected'];
                    status_required := true;
                WHEN 'fact.conflict' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','outbox_id',
                        'operation','request_sha256','payload_sha256','evidence_count','result',
                        'status','latency_ms'];
                    allowed_operations := ARRAY['approve'];
                    allowed_results := ARRAY['conflicted'];
                    allowed_statuses := ARRAY['conflicted'];
                    status_required := true;
                WHEN 'fact.confirm' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','fact_revision_id',
                        'outbox_id','operation','request_sha256','payload_sha256','evidence_count',
                        'result','status','latency_ms'];
                    allowed_operations := ARRAY['approve'];
                    allowed_results := ARRAY['confirmed'];
                    allowed_statuses := ARRAY['confirmed'];
                    status_required := true;
                WHEN 'fact.outbox.project' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','fact_revision_id',
                        'outbox_id','event_sequence','operation','payload_sha256','result','status',
                        'request_sha256','latency_ms'];
                    allowed_operations := ARRAY['outbox_append'];
                    allowed_results := ARRAY['projected'];
                    allowed_statuses := ARRAY['confirmed','rejected','withdrawn','conflicted'];
                    status_required := true;
                WHEN 'fact.replay' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','fact_revision_id',
                        'outbox_id','tool_call_id','event_sequence','operation','request_sha256',
                        'payload_sha256','permission_revision','evidence_count','result','status',
                        'latency_ms'];
                    allowed_operations := ARRAY['prepare','admit','expire','withdraw','approve',
                        'reject','outbox_append'];
                    allowed_results := ARRAY['replayed'];
                    allowed_statuses := ARRAY[
                        'prepared','pending','confirmed','rejected','withdrawn','conflicted','expired'];
                    status_required := true;
                WHEN 'fact.cancel' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','fact_revision_id',
                        'outbox_id','tool_call_id','event_sequence','operation','request_sha256',
                        'payload_sha256','permission_revision','evidence_count','result','status',
                        'latency_ms'];
                    allowed_operations := ARRAY['prepare','admit','expire','withdraw','approve',
                        'reject','outbox_append'];
                    allowed_results := ARRAY['cancelled'];
                    allowed_statuses := ARRAY[
                        'prepared','pending','confirmed','rejected','withdrawn','conflicted','expired'];
                    status_required := false;
                WHEN 'fact.authorization_denied' THEN
                    allowed_keys := ARRAY['project_id','session_id','proposal_id','fact_revision_id',
                        'outbox_id','tool_call_id','event_sequence','operation','request_sha256',
                        'payload_sha256','permission_revision','evidence_count','result','latency_ms'];
                    allowed_operations := ARRAY['prepare','admit','expire','withdraw','approve',
                        'reject','outbox_append'];
                    allowed_results := ARRAY[
                        'not-found','stale-permission','fact-receipt-invalid'];
                    allowed_statuses := ARRAY[]::text[];
                    status_required := false;
                ELSE RETURN false;
            END CASE;
            IF allowed_keys IS NULL OR allowed_operations IS NULL OR allowed_results IS NULL
                OR allowed_statuses IS NULL OR status_required IS NULL THEN RETURN false; END IF;
            IF value - allowed_keys <> '{}'::jsonb
                OR NOT value ?& ARRAY['operation','result','latency_ms']
                OR jsonb_typeof(value->'operation') <> 'string'
                OR (value->>'operation') <> ALL(allowed_operations)
                OR jsonb_typeof(value->'result') <> 'string'
                OR (value->>'result') <> ALL(allowed_results) THEN RETURN false; END IF;
            IF value ? 'status' THEN
                IF jsonb_typeof(value->'status') <> 'string'
                    OR (value->>'status') <> ALL(allowed_statuses) THEN RETURN false; END IF;
            ELSIF status_required THEN RETURN false;
            END IF;
            IF value ? 'tool_call_id' AND (jsonb_typeof(value->'tool_call_id') <> 'string'
                OR value->>'tool_call_id' !~ '^call-[A-Za-z0-9-]{1,120}$') THEN RETURN false; END IF;
            FOREACH key IN ARRAY ARRAY[
                'project_id','session_id','proposal_id','fact_revision_id','outbox_id'
            ] LOOP
                IF value ? key AND (jsonb_typeof(value->key) <> 'string'
                    OR value->>key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                    THEN RETURN false; END IF;
            END LOOP;
            FOREACH key IN ARRAY ARRAY['request_sha256','payload_sha256'] LOOP
                IF value ? key AND (jsonb_typeof(value->key) <> 'string'
                    OR value->>key !~ '^[0-9a-f]{64}$') THEN RETURN false; END IF;
            END LOOP;
            FOREACH key IN ARRAY ARRAY[
                'evidence_count','event_sequence','permission_revision','latency_ms'
            ] LOOP
                IF value ? key AND (jsonb_typeof(value->key) <> 'number'
                    OR value->>key !~ '^[0-9]+$' OR (value->>key)::numeric < 0)
                    THEN RETURN false; END IF;
            END LOOP;
            IF value ? 'evidence_count' AND (value->>'evidence_count')::numeric > 64
                THEN RETURN false; END IF;
            RETURN true;
        EXCEPTION WHEN others THEN RETURN false;
        END $$
        """
    )


def _create_triggers() -> None:
    op.execute(
        "CREATE FUNCTION public.enforce_fact_proposal_transition() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "DECLARE actor_id uuid; BEGIN "
        "actor_id := NULLIF(current_setting('app.actor_id', true), '')::uuid; "
        "IF OLD.id IS DISTINCT FROM NEW.id OR OLD.project_id IS DISTINCT FROM NEW.project_id "
        "OR OLD.field_key IS DISTINCT FROM NEW.field_key OR OLD.label IS DISTINCT FROM NEW.label "
        "OR OLD.value_type IS DISTINCT FROM NEW.value_type OR OLD.value IS DISTINCT FROM NEW.value "
        "OR OLD.proposer_id IS DISTINCT FROM NEW.proposer_id "
        "OR OLD.source_session_id IS DISTINCT FROM NEW.source_session_id "
        "OR OLD.source_tool_call_id IS DISTINCT FROM NEW.source_tool_call_id "
        "OR OLD.base_revision IS DISTINCT FROM NEW.base_revision "
        "OR OLD.assertion_reason IS DISTINCT FROM NEW.assertion_reason "
        "OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256 "
        "OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key "
        "OR OLD.permission_revision IS DISTINCT FROM NEW.permission_revision "
        "OR OLD.admission_expires_at IS DISTINCT FROM NEW.admission_expires_at "
        "OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN "
        "RAISE EXCEPTION 'fact proposal candidate is immutable' USING ERRCODE = '23514'; END IF; "
        "IF OLD.status IN ('confirmed','rejected','withdrawn','conflicted','expired') THEN "
        "RAISE EXCEPTION 'terminal fact proposals are immutable' USING ERRCODE = '23514'; END IF; "
        "IF OLD.status IS DISTINCT FROM NEW.status AND NOT ((OLD.status = 'prepared' "
        "AND NEW.status IN ('pending','expired')) OR (OLD.status = 'pending' "
        "AND NEW.status IN ('confirmed','rejected','withdrawn','conflicted'))) THEN "
        "RAISE EXCEPTION 'invalid fact proposal status transition' USING ERRCODE = '23514'; END IF; "
        "IF actor_id IS NOT NULL AND NEW.status IN ('confirmed','rejected','withdrawn','conflicted') "
        "AND NEW.decision_actor_id IS DISTINCT FROM actor_id THEN "
        "RAISE EXCEPTION 'fact proposal decision actor must be current actor' "
        "USING ERRCODE = '23514'; END IF; "
        "NEW.updated_at := CURRENT_TIMESTAMP; RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER fact_proposal_transition BEFORE UPDATE ON fact_proposals "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_fact_proposal_transition()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_project_fact_revision() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "DECLARE proposal_base bigint; proposal_status text; actor_id uuid; BEGIN "
        "actor_id := NULLIF(current_setting('app.actor_id', true), '')::uuid; "
        "IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'confirmed fact revisions are immutable' "
        "USING ERRCODE = '23514'; END IF; "
        "IF actor_id IS NOT NULL AND NEW.confirmed_by_id IS DISTINCT FROM actor_id THEN "
        "RAISE EXCEPTION 'fact revision confirmer must be current actor' USING ERRCODE = '23514'; END IF; "
        "SELECT base_revision, status INTO proposal_base, proposal_status FROM public.fact_proposals "
        "WHERE id = NEW.proposal_id AND project_id = NEW.project_id AND field_key = NEW.field_key; "
        "IF NEW.content_revision >= 1 AND "
        "(proposal_base IS NULL OR NEW.content_revision <> proposal_base + 1) "
        "OR proposal_status NOT IN ('pending','confirmed') THEN "
        "RAISE EXCEPTION 'fact revision must be the proposal next revision' USING ERRCODE = '23514'; END IF; "
        "RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER project_fact_revision_immutable "
        "BEFORE INSERT OR UPDATE OR DELETE ON project_fact_revisions FOR EACH ROW "
        "EXECUTE FUNCTION public.enforce_project_fact_revision()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_fact_proposal_evidence_insert() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "DECLARE actor_id uuid; proposal_proposer uuid; proposal_status text; evidence_count bigint; BEGIN "
        "actor_id := NULLIF(current_setting('app.actor_id', true), '')::uuid; "
        "SELECT proposer_id, status INTO proposal_proposer, proposal_status "
        "FROM public.fact_proposals WHERE id = NEW.proposal_id AND project_id = NEW.project_id "
        "AND source_session_id = NEW.session_id FOR UPDATE; "
        "IF proposal_proposer IS NULL OR actor_id IS NULL OR proposal_proposer IS DISTINCT FROM actor_id THEN "
        "RAISE EXCEPTION 'fact proposal evidence requires current proposal owner' "
        "USING ERRCODE = '42501'; END IF; "
        "IF proposal_status <> 'prepared' THEN "
        "RAISE EXCEPTION 'fact proposal evidence requires prepared proposal' "
        "USING ERRCODE = '23514'; END IF; "
        "SELECT count(*) INTO evidence_count FROM public.fact_proposal_evidence "
        "WHERE proposal_id = NEW.proposal_id; "
        "IF evidence_count >= 64 THEN RAISE EXCEPTION 'fact proposal accepts at most 64 evidence rows' "
        "USING ERRCODE = '23514'; END IF; RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER fact_proposal_evidence_insert_guard "
        "BEFORE INSERT ON fact_proposal_evidence FOR EACH ROW "
        "EXECUTE FUNCTION public.enforce_fact_proposal_evidence_insert()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_project_fact_head() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "BEGIN IF TG_OP = 'INSERT' AND NEW.content_revision <> 1 THEN "
        "RAISE EXCEPTION 'first fact head must name revision one' USING ERRCODE = '23514'; END IF; "
        "IF TG_OP = 'UPDATE' THEN "
        "IF OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.field_key IS DISTINCT FROM NEW.field_key THEN "
        "RAISE EXCEPTION 'fact head identity is immutable' USING ERRCODE = '23514'; END IF; "
        "IF NEW.content_revision <> OLD.content_revision + 1 THEN "
        "RAISE EXCEPTION 'fact head must advance by exactly one revision' USING ERRCODE = '23514'; END IF; "
        "END IF; NEW.updated_at := CURRENT_TIMESTAMP; RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER project_fact_head_advance BEFORE INSERT OR UPDATE ON project_fact_heads "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_project_fact_head()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_fact_receipt_consumption() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "BEGIN IF OLD.receipt_digest_id IS DISTINCT FROM NEW.receipt_digest_id "
        "OR OLD.proposal_id IS DISTINCT FROM NEW.proposal_id OR OLD.project_id IS DISTINCT FROM NEW.project_id "
        "OR OLD.actor_id IS DISTINCT FROM NEW.actor_id OR OLD.session_id IS DISTINCT FROM NEW.session_id "
        "OR OLD.tool_call_id IS DISTINCT FROM NEW.tool_call_id "
        "OR OLD.permission_revision IS DISTINCT FROM NEW.permission_revision "
        "OR OLD.source_event_sequence IS DISTINCT FROM NEW.source_event_sequence "
        "OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256 "
        "OR OLD.issued_at IS DISTINCT FROM NEW.issued_at OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN "
        "RAISE EXCEPTION 'fact proposal receipt claims are immutable' USING ERRCODE = '23514'; END IF; "
        "IF OLD.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'fact proposal receipt is already consumed' "
        "USING ERRCODE = '23514'; END IF; "
        "IF OLD.expires_at <= CURRENT_TIMESTAMP THEN RAISE EXCEPTION 'fact proposal receipt is expired' "
        "USING ERRCODE = '23514'; END IF; RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER fact_proposal_receipt_consumption BEFORE UPDATE ON fact_proposal_receipts "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_fact_receipt_consumption()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_business_outbox_consumption() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "BEGIN IF OLD.id IS DISTINCT FROM NEW.id OR OLD.aggregate_kind IS DISTINCT FROM NEW.aggregate_kind "
        "OR OLD.aggregate_id IS DISTINCT FROM NEW.aggregate_id OR OLD.project_id IS DISTINCT FROM NEW.project_id "
        "OR OLD.source_session_id IS DISTINCT FROM NEW.source_session_id "
        "OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256 OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN "
        "RAISE EXCEPTION 'business outbox decision is immutable' USING ERRCODE = '23514'; END IF; "
        "IF OLD.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'business outbox row is already consumed' "
        "USING ERRCODE = '23514'; END IF; RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER business_outbox_consumption BEFORE UPDATE ON business_outbox "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_business_outbox_consumption()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_terminal_fact_outbox() "
        "RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ "
        "DECLARE target_proposal uuid; proposal_status text; outbox_count bigint; BEGIN "
        "IF TG_TABLE_NAME = 'fact_proposals' THEN target_proposal := NEW.id; "
        "ELSIF TG_OP = 'DELETE' THEN target_proposal := OLD.aggregate_id; "
        "ELSE target_proposal := NEW.aggregate_id; END IF; "
        "SELECT status INTO proposal_status FROM public.fact_proposals WHERE id = target_proposal; "
        "SELECT count(*) INTO outbox_count FROM public.business_outbox "
        "WHERE aggregate_kind = 'fact_proposal' AND aggregate_id = target_proposal; "
        "IF proposal_status IN ('confirmed','rejected','withdrawn','conflicted') AND outbox_count <> 1 THEN "
        "RAISE EXCEPTION 'terminal fact proposals require exactly one outbox row' USING ERRCODE = '23514'; END IF; "
        "IF proposal_status IS NOT NULL AND proposal_status NOT IN ('confirmed','rejected','withdrawn','conflicted') "
        "AND outbox_count <> 0 THEN RAISE EXCEPTION 'non-terminal fact proposals cannot have an outbox row' "
        "USING ERRCODE = '23514'; END IF; RETURN NULL; END $$"
    )
    op.execute(
        "CREATE CONSTRAINT TRIGGER fact_proposal_terminal_outbox "
        "AFTER INSERT OR UPDATE OF status ON fact_proposals DEFERRABLE INITIALLY DEFERRED "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_terminal_fact_outbox()"
    )
    op.execute(
        "CREATE CONSTRAINT TRIGGER business_outbox_terminal_proposal "
        "AFTER INSERT OR UPDATE OR DELETE ON business_outbox DEFERRABLE INITIALLY DEFERRED "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_terminal_fact_outbox()"
    )


def _create_rls_and_grants(application_role: str, worker_role: str) -> None:
    op.execute(
        "CREATE FUNCTION public.xagent_fact_authorized_project_ids() RETURNS SETOF uuid "
        "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "SELECT memberships.project_id FROM public.project_memberships AS memberships "
        "JOIN public.accounts ON accounts.id = memberships.account_id "
        "WHERE memberships.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid "
        "AND accounts.is_active AND accounts.role::text = current_setting('app.actor_role', true) "
        "AND accounts.role::text IN ('specialist','manager') $$"
    )
    op.execute("REVOKE ALL ON FUNCTION public.xagent_fact_authorized_project_ids() FROM PUBLIC")
    op.execute(
        f"GRANT EXECUTE ON FUNCTION public.xagent_fact_authorized_project_ids() TO {application_role}"
    )
    op.execute(
        "CREATE FUNCTION public.xagent_fact_prepare_context("
        "target_session_id uuid, expected_revision bigint, target_field_key text, "
        "target_tool_call_id text) "
        "RETURNS TABLE(project_id uuid, source_event_sequence bigint, base_revision bigint) "
        "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "DECLARE actor uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid; "
        "locked_revision bigint; BEGIN "
        "UPDATE public.xagent_permission_revisions SET revision = revision "
        "WHERE account_id = actor AND revision = expected_revision "
        "RETURNING revision INTO locked_revision; "
        "IF locked_revision IS NULL THEN RETURN; END IF; "
        "RETURN QUERY SELECT sessions.project_id, sessions.last_event_sequence + 1, "
        "COALESCE(heads.content_revision, 0) FROM public.xagent_sessions AS sessions "
        "LEFT JOIN public.project_fact_heads AS heads ON heads.project_id = sessions.project_id "
        "AND heads.field_key = target_field_key "
        "WHERE sessions.id = target_session_id AND sessions.visibility = 'project' "
        "AND sessions.project_id IN (SELECT public.xagent_fact_authorized_project_ids()) "
        "AND EXISTS (SELECT 1 FROM public.xagent_session_events AS calls "
        "WHERE calls.session_id = sessions.id "
        "AND calls.sequence = sessions.last_event_sequence "
        "AND calls.event_type = 'tool/call' AND calls.schema_version = 1 "
        "AND calls.actor_id = actor AND calls.tool_call_id = target_tool_call_id "
        "AND calls.payload->>'type' = 'tool/call' "
        "AND calls.payload->'data'->>'callId' = target_tool_call_id "
        "AND calls.payload->'data'->>'name' = 'propose_fact') "
        "AND sessions.last_event_sequence + 1 >= 1 FOR UPDATE OF sessions; END $$"
    )
    op.execute(
        "REVOKE ALL ON FUNCTION public.xagent_fact_prepare_context(uuid, bigint, text, text) "
        "FROM PUBLIC"
    )
    op.execute(
        f"GRANT EXECUTE ON FUNCTION public.xagent_fact_prepare_context(uuid, bigint, text, text) "
        f"TO {application_role}"
    )
    op.execute(
        "CREATE FUNCTION public.xagent_admit_fact_proposal("
        "target_receipt_digest uuid, target_proposal_id uuid, target_project_id uuid, "
        "target_actor_id uuid, target_session_id uuid, target_tool_call_id text, "
        "expected_revision bigint, target_event_sequence bigint, target_payload_sha256 text) "
        "RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER "
        "SET search_path = pg_catalog, public AS $$ "
        "DECLARE actor uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid; "
        "locked_revision bigint; proposal_expires timestamptz; receipt_expires timestamptz; "
        "checked_at timestamptz; BEGIN "
        "IF actor IS NULL OR actor IS DISTINCT FROM target_actor_id "
        "OR target_event_sequence < 1 THEN RETURN false; END IF; "
        "UPDATE public.xagent_permission_revisions SET revision = revision "
        "WHERE account_id = actor AND revision = expected_revision "
        "RETURNING revision INTO locked_revision; "
        "IF locked_revision IS NULL THEN RETURN false; END IF; "
        "PERFORM 1 FROM public.xagent_sessions AS sessions "
        "WHERE sessions.id = target_session_id AND sessions.visibility = 'project' "
        "AND sessions.project_id = target_project_id "
        "AND sessions.last_event_sequence = target_event_sequence - 1 "
        "AND sessions.project_id IN (SELECT public.xagent_fact_authorized_project_ids()) "
        "FOR UPDATE; IF NOT FOUND THEN RETURN false; END IF; "
        "SELECT proposal.admission_expires_at INTO proposal_expires "
        "FROM public.fact_proposals AS proposal "
        "WHERE proposal.id = target_proposal_id AND proposal.project_id = target_project_id "
        "AND proposal.proposer_id = actor AND proposal.source_session_id = target_session_id "
        "AND proposal.source_tool_call_id = target_tool_call_id "
        "AND proposal.permission_revision = expected_revision "
        "AND proposal.payload_sha256 = target_payload_sha256 "
        "AND proposal.status = 'prepared' FOR UPDATE; "
        "IF NOT FOUND THEN RETURN false; END IF; "
        "SELECT receipt.expires_at INTO receipt_expires "
        "FROM public.fact_proposal_receipts AS receipt "
        "WHERE receipt.receipt_digest_id = target_receipt_digest "
        "AND receipt.proposal_id = target_proposal_id "
        "AND receipt.project_id = target_project_id AND receipt.actor_id = actor "
        "AND receipt.session_id = target_session_id "
        "AND receipt.tool_call_id = target_tool_call_id "
        "AND receipt.permission_revision = expected_revision "
        "AND receipt.source_event_sequence = target_event_sequence "
        "AND receipt.payload_sha256 = target_payload_sha256 "
        "AND receipt.consumed_at IS NULL FOR UPDATE; "
        "IF NOT FOUND THEN RETURN false; END IF; "
        "checked_at := clock_timestamp(); "
        "IF proposal_expires <= checked_at OR receipt_expires <= checked_at "
        "THEN RETURN false; END IF; "
        "UPDATE public.fact_proposals SET status = 'pending', admitted_at = checked_at "
        "WHERE id = target_proposal_id; "
        "UPDATE public.fact_proposal_receipts SET consumed_at = checked_at, "
        "consumed_event_sequence = target_event_sequence, "
        "consumed_payload_sha256 = target_payload_sha256 "
        "WHERE receipt_digest_id = target_receipt_digest; RETURN true; END $$"
    )
    op.execute(
        "REVOKE ALL ON FUNCTION public.xagent_admit_fact_proposal("
        "uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text) FROM PUBLIC"
    )
    op.execute(
        f"GRANT EXECUTE ON FUNCTION public.xagent_admit_fact_proposal("
        f"uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text) TO {application_role}"
    )
    op.execute(
        "CREATE FUNCTION public.xagent_expire_fact_proposal("
        "target_receipt_digest uuid, target_proposal_id uuid, target_project_id uuid, "
        "target_actor_id uuid, target_session_id uuid, target_tool_call_id text, "
        "expected_revision bigint, target_event_sequence bigint, target_payload_sha256 text) "
        "RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER "
        "SET search_path = pg_catalog, public AS $$ "
        "DECLARE actor uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid; "
        "locked_revision bigint; proposal_expires timestamptz; receipt_expires timestamptz; "
        "checked_at timestamptz; BEGIN "
        "IF actor IS NULL OR actor IS DISTINCT FROM target_actor_id "
        "OR target_event_sequence < 1 THEN RETURN false; END IF; "
        "UPDATE public.xagent_permission_revisions SET revision = revision "
        "WHERE account_id = actor AND revision = expected_revision "
        "RETURNING revision INTO locked_revision; "
        "IF locked_revision IS NULL THEN RETURN false; END IF; "
        "PERFORM 1 FROM public.xagent_sessions AS sessions "
        "WHERE sessions.id = target_session_id AND sessions.visibility = 'project' "
        "AND sessions.project_id = target_project_id "
        "AND sessions.project_id IN (SELECT public.xagent_fact_authorized_project_ids()) "
        "FOR UPDATE; IF NOT FOUND THEN RETURN false; END IF; "
        "SELECT proposal.admission_expires_at INTO proposal_expires "
        "FROM public.fact_proposals AS proposal "
        "WHERE proposal.id = target_proposal_id AND proposal.project_id = target_project_id "
        "AND proposal.proposer_id = actor AND proposal.source_session_id = target_session_id "
        "AND proposal.source_tool_call_id = target_tool_call_id "
        "AND proposal.permission_revision = expected_revision "
        "AND proposal.payload_sha256 = target_payload_sha256 "
        "AND proposal.status = 'prepared' FOR UPDATE; "
        "IF NOT FOUND THEN RETURN false; END IF; "
        "SELECT receipt.expires_at INTO receipt_expires "
        "FROM public.fact_proposal_receipts AS receipt "
        "WHERE receipt.receipt_digest_id = target_receipt_digest "
        "AND receipt.proposal_id = target_proposal_id "
        "AND receipt.project_id = target_project_id AND receipt.actor_id = actor "
        "AND receipt.session_id = target_session_id "
        "AND receipt.tool_call_id = target_tool_call_id "
        "AND receipt.permission_revision = expected_revision "
        "AND receipt.source_event_sequence = target_event_sequence "
        "AND receipt.payload_sha256 = target_payload_sha256 "
        "AND receipt.consumed_at IS NULL FOR UPDATE; "
        "IF NOT FOUND THEN RETURN false; END IF; "
        "checked_at := clock_timestamp(); "
        "IF proposal_expires > checked_at OR receipt_expires > checked_at "
        "THEN RETURN false; END IF; "
        "UPDATE public.fact_proposals SET status = 'expired', decided_at = checked_at "
        "WHERE id = target_proposal_id; RETURN true; END $$"
    )
    op.execute(
        "REVOKE ALL ON FUNCTION public.xagent_expire_fact_proposal("
        "uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text) FROM PUBLIC"
    )
    op.execute(
        f"GRANT EXECUTE ON FUNCTION public.xagent_expire_fact_proposal("
        f"uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text) TO {application_role}"
    )
    op.execute(
        "CREATE FUNCTION public.xagent_fact_can_add_evidence("
        "target_proposal_id uuid, target_project_id uuid, target_session_id uuid) RETURNS boolean "
        "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "SELECT EXISTS (SELECT 1 FROM public.fact_proposals AS proposal "
        "WHERE proposal.id = target_proposal_id AND proposal.project_id = target_project_id "
        "AND proposal.source_session_id = target_session_id AND proposal.status = 'prepared' "
        "AND proposal.proposer_id = NULLIF(current_setting('app.actor_id', true), '')::uuid "
        "AND proposal.project_id IN (SELECT public.xagent_fact_authorized_project_ids())) $$"
    )
    op.execute(
        "REVOKE ALL ON FUNCTION public.xagent_fact_can_add_evidence(uuid, uuid, uuid) FROM PUBLIC"
    )
    op.execute(
        f"GRANT EXECUTE ON FUNCTION public.xagent_fact_can_add_evidence(uuid, uuid, uuid) "
        f"TO {application_role}"
    )
    for table in (
        "fact_proposals",
        "project_fact_revisions",
        "project_fact_heads",
        "fact_proposal_evidence",
        "fact_proposal_receipts",
        "business_outbox",
        "fact_operation_idempotency",
    ):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

    actor = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    projects = "SELECT public.xagent_fact_authorized_project_ids()"
    manager = "current_setting('app.actor_role', true) = 'manager'"
    scope = f"project_id IN ({projects})"
    op.execute(
        f"CREATE POLICY fact_proposal_select ON fact_proposals FOR SELECT TO {application_role} "
        f"USING ({scope} AND status <> 'prepared')"
    )
    op.execute(
        f"CREATE POLICY fact_proposal_insert ON fact_proposals FOR INSERT TO {application_role} "
        f"WITH CHECK ({scope} AND proposer_id = {actor} AND status = 'prepared')"
    )
    op.execute(
        f"CREATE POLICY fact_proposal_update ON fact_proposals FOR UPDATE TO {application_role} "
        f"USING ({scope} AND ({manager} OR proposer_id = {actor})) "
        f"WITH CHECK ({scope} AND ((proposer_id = {actor} AND "
        f"((status = 'pending' AND decision_actor_id IS NULL) "
        f"OR (status = 'withdrawn' AND decision_actor_id = {actor}))) "
        f"OR ({manager} AND status IN ('confirmed','rejected','conflicted') "
        f"AND decision_actor_id = {actor})))"
    )
    for table in ("project_fact_revisions", "project_fact_heads"):
        op.execute(
            f"CREATE POLICY {table}_select ON {table} FOR SELECT TO {application_role} USING ({scope})"
        )
        op.execute(
            f"CREATE POLICY {table}_insert ON {table} FOR INSERT TO {application_role} "
            f"WITH CHECK ({scope} AND {manager}"
            + (f" AND confirmed_by_id = {actor}" if table == "project_fact_revisions" else "")
            + ")"
        )
    op.execute(
        f"CREATE POLICY project_fact_heads_update ON project_fact_heads FOR UPDATE TO {application_role} "
        f"USING ({scope} AND {manager}) WITH CHECK ({scope} AND {manager})"
    )
    op.execute(
        f"CREATE POLICY fact_proposal_evidence_select ON fact_proposal_evidence "
        f"FOR SELECT TO {application_role} USING ({scope} AND proposal_id IN "
        "(SELECT id FROM public.fact_proposals))"
    )
    op.execute(
        f"CREATE POLICY fact_proposal_evidence_insert ON fact_proposal_evidence "
        f"FOR INSERT TO {application_role} WITH CHECK ({scope} AND "
        "public.xagent_fact_can_add_evidence(proposal_id, project_id, session_id))"
    )
    op.execute(
        f"CREATE POLICY fact_proposal_receipt_select ON fact_proposal_receipts "
        f"FOR SELECT TO {application_role} USING ({scope} AND actor_id = {actor})"
    )
    op.execute(
        f"CREATE POLICY fact_proposal_receipt_insert ON fact_proposal_receipts "
        f"FOR INSERT TO {application_role} WITH CHECK ({scope} AND actor_id = {actor} "
        "AND consumed_at IS NULL AND consumed_event_sequence IS NULL AND consumed_payload_sha256 IS NULL)"
    )
    op.execute(
        f"CREATE POLICY fact_proposal_receipt_update ON fact_proposal_receipts "
        f"FOR UPDATE TO {application_role} USING ({scope} AND actor_id = {actor}) "
        f"WITH CHECK ({scope} AND actor_id = {actor})"
    )
    op.execute(
        f"CREATE POLICY business_outbox_select ON business_outbox FOR SELECT TO {application_role} "
        f"USING ({scope})"
    )
    op.execute(
        f"CREATE POLICY business_outbox_insert ON business_outbox FOR INSERT TO {application_role} "
        f"WITH CHECK ({scope})"
    )
    op.execute(
        f"CREATE POLICY business_outbox_update ON business_outbox FOR UPDATE TO {application_role} "
        f"USING ({scope}) WITH CHECK ({scope})"
    )
    op.execute(
        f"CREATE POLICY fact_operation_idempotency_select ON fact_operation_idempotency "
        f"FOR SELECT TO {application_role} USING ({scope} AND actor_id = {actor})"
    )
    op.execute(
        f"CREATE POLICY fact_operation_idempotency_insert ON fact_operation_idempotency "
        f"FOR INSERT TO {application_role} WITH CHECK ({scope} AND actor_id = {actor})"
    )

    op.execute(
        f"GRANT SELECT, INSERT ON fact_proposals, project_fact_revisions, project_fact_heads, "
        f"fact_proposal_evidence, fact_proposal_receipts, business_outbox, "
        f"fact_operation_idempotency TO {application_role}"
    )
    op.execute(
        "GRANT UPDATE (status, decision_actor_id, decision_reason, admitted_at, decided_at, updated_at) "
        f"ON fact_proposals TO {application_role}"
    )
    op.execute(
        "GRANT UPDATE (revision_id, content_revision, updated_at) "
        f"ON project_fact_heads TO {application_role}"
    )
    op.execute(
        "GRANT UPDATE (consumed_at, consumed_event_sequence, consumed_payload_sha256) "
        f"ON fact_proposal_receipts TO {application_role}"
    )
    op.execute(
        "GRANT UPDATE (consumed_at, consumed_event_sequence) "
        f"ON business_outbox TO {application_role}"
    )
    op.execute(
        f"REVOKE ALL PRIVILEGES ON fact_proposals, project_fact_revisions, project_fact_heads, "
        f"fact_proposal_evidence, fact_proposal_receipts, business_outbox, "
        f"fact_operation_idempotency FROM {worker_role}"
    )


def upgrade() -> None:
    application_role = _configured_role("application_role")
    worker_role = _configured_role("worker_role")
    _create_tables()
    _create_triggers()
    _create_rls_and_grants(application_role, worker_role)
    op.drop_constraint("ck_audit_event_details", "audit_events", type_="check")
    _create_fact_audit_validator()
    op.create_check_constraint(
        "ck_audit_event_details",
        "audit_events",
        "jsonb_typeof(details) = 'object' AND octet_length(details::text) <= CASE "
        "WHEN action = 'retrieval.citation_authorize' THEN 32768 ELSE 8192 END AND "
        "(action NOT LIKE 'retrieval.%' OR "
        "public.xagent_valid_retrieval_audit_details(action, details)) AND "
        "(action NOT LIKE 'fact.%' OR public.xagent_valid_fact_audit_details(action, details))",
    )


def downgrade() -> None:
    application_role = _configured_role("application_role")
    op.execute(
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.fact_proposals) "
        "OR EXISTS (SELECT 1 FROM public.project_fact_revisions) "
        "OR EXISTS (SELECT 1 FROM public.project_fact_heads) "
        "OR EXISTS (SELECT 1 FROM public.fact_proposal_evidence) "
        "OR EXISTS (SELECT 1 FROM public.fact_proposal_receipts) "
        "OR EXISTS (SELECT 1 FROM public.fact_operation_idempotency) "
        "OR EXISTS (SELECT 1 FROM public.business_outbox) "
        "OR EXISTS (SELECT 1 FROM public.audit_events WHERE action LIKE 'fact.%') THEN "
        "RAISE EXCEPTION 'cannot downgrade fact approval with stored data'; END IF; END $$"
    )
    op.drop_constraint("ck_audit_event_details", "audit_events", type_="check")
    op.execute("DROP FUNCTION public.xagent_valid_fact_audit_details(text, jsonb)")
    op.create_check_constraint(
        "ck_audit_event_details",
        "audit_events",
        "jsonb_typeof(details) = 'object' AND octet_length(details::text) <= CASE "
        "WHEN action = 'retrieval.citation_authorize' THEN 32768 ELSE 8192 END AND "
        "(action NOT LIKE 'retrieval.%' OR "
        "public.xagent_valid_retrieval_audit_details(action, details))",
    )
    op.execute(
        f"REVOKE ALL PRIVILEGES ON fact_proposals, project_fact_revisions, project_fact_heads, "
        f"fact_proposal_evidence, fact_proposal_receipts, business_outbox, "
        f"fact_operation_idempotency FROM {application_role}"
    )
    op.execute(
        f"REVOKE ALL ON FUNCTION public.xagent_fact_authorized_project_ids() FROM {application_role}"
    )
    op.execute(
        f"REVOKE ALL ON FUNCTION public.xagent_fact_can_add_evidence(uuid, uuid, uuid) "
        f"FROM {application_role}"
    )
    op.execute(
        f"REVOKE ALL ON FUNCTION public.xagent_fact_prepare_context(uuid, bigint, text, text) "
        f"FROM {application_role}"
    )
    op.execute(
        f"REVOKE ALL ON FUNCTION public.xagent_admit_fact_proposal("
        f"uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text) FROM {application_role}"
    )
    op.execute(
        f"REVOKE ALL ON FUNCTION public.xagent_expire_fact_proposal("
        f"uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text) FROM {application_role}"
    )
    for table, policies in (
        ("fact_operation_idempotency", ("fact_operation_idempotency_insert", "fact_operation_idempotency_select")),
        ("business_outbox", ("business_outbox_update", "business_outbox_insert", "business_outbox_select")),
        ("fact_proposal_receipts", ("fact_proposal_receipt_update", "fact_proposal_receipt_insert", "fact_proposal_receipt_select")),
        ("fact_proposal_evidence", ("fact_proposal_evidence_insert", "fact_proposal_evidence_select")),
        ("project_fact_heads", ("project_fact_heads_update", "project_fact_heads_insert", "project_fact_heads_select")),
        ("project_fact_revisions", ("project_fact_revisions_insert", "project_fact_revisions_select")),
        ("fact_proposals", ("fact_proposal_update", "fact_proposal_insert", "fact_proposal_select")),
    ):
        for policy in policies:
            op.execute(f"DROP POLICY {policy} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute("DROP FUNCTION public.xagent_fact_can_add_evidence(uuid, uuid, uuid)")
    op.execute(
        "DROP FUNCTION public.xagent_expire_fact_proposal("
        "uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text)"
    )
    op.execute(
        "DROP FUNCTION public.xagent_admit_fact_proposal("
        "uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text)"
    )
    op.execute("DROP FUNCTION public.xagent_fact_prepare_context(uuid, bigint, text, text)")
    op.execute("DROP FUNCTION public.xagent_fact_authorized_project_ids()")
    op.execute("DROP TRIGGER business_outbox_terminal_proposal ON business_outbox")
    op.execute("DROP TRIGGER fact_proposal_terminal_outbox ON fact_proposals")
    op.execute("DROP FUNCTION public.enforce_terminal_fact_outbox()")
    op.execute("DROP TRIGGER business_outbox_consumption ON business_outbox")
    op.execute("DROP FUNCTION public.enforce_business_outbox_consumption()")
    op.execute("DROP TRIGGER fact_proposal_receipt_consumption ON fact_proposal_receipts")
    op.execute("DROP FUNCTION public.enforce_fact_receipt_consumption()")
    op.execute("DROP TRIGGER fact_proposal_evidence_insert_guard ON fact_proposal_evidence")
    op.execute("DROP FUNCTION public.enforce_fact_proposal_evidence_insert()")
    op.execute("DROP TRIGGER project_fact_head_advance ON project_fact_heads")
    op.execute("DROP FUNCTION public.enforce_project_fact_head()")
    op.execute("DROP TRIGGER project_fact_revision_immutable ON project_fact_revisions")
    op.execute("DROP FUNCTION public.enforce_project_fact_revision()")
    op.execute("DROP TRIGGER fact_proposal_transition ON fact_proposals")
    op.execute("DROP FUNCTION public.enforce_fact_proposal_transition()")
    op.drop_table("fact_operation_idempotency")
    op.drop_index("ix_business_outbox_session_created", table_name="business_outbox")
    op.drop_table("business_outbox")
    op.drop_table("fact_proposal_receipts")
    op.drop_table("fact_proposal_evidence")
    op.drop_table("project_fact_heads")
    op.drop_table("project_fact_revisions")
    op.drop_index("ix_fact_proposals_project_status_created", table_name="fact_proposals")
    op.drop_table("fact_proposals")
    op.drop_constraint(
        "uq_artifact_text_chunk_exact_range",
        "artifact_text_chunks",
        type_="unique",
    )
    op.drop_constraint(
        "uq_xagent_session_project_identity",
        "xagent_sessions",
        type_="unique",
    )
