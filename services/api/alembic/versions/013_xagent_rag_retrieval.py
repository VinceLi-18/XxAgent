"""Add the XAgent retrieval schema and restricted database roles.

Revision ID: 013_xagent_rag_retrieval
Revises: 012_xagent_artifact_lifecycle
Create Date: 2026-08-28
"""

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision = "013_xagent_rag_retrieval"
down_revision = "012_xagent_artifact_lifecycle"
branch_labels = None
depends_on = None


def _configured_role(option: str) -> str:
    role = op.get_context().config.get_main_option(option)
    if not role:
        raise RuntimeError(f"Alembic {option} configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    application_role = _configured_role("application_role")
    worker_role = _configured_role("worker_role")

    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.add_column(
        "xagent_sessions",
        sa.Column("next_citation_ordinal", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_check_constraint(
        "ck_xagent_session_next_citation_ordinal",
        "xagent_sessions",
        "next_citation_ordinal >= 1",
    )
    op.alter_column("xagent_sessions", "next_citation_ordinal", server_default=None)
    op.create_unique_constraint(
        "uq_artifact_version_id_artifact",
        "artifact_versions",
        ["id", "artifact_id"],
    )

    op.create_table(
        "artifact_text_indexes",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("artifact_id", sa.UUID(), nullable=False),
        sa.Column("version_id", sa.UUID(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("parser_revision", sa.String(length=128), nullable=False),
        sa.Column("embedding_model", sa.String(length=255), nullable=False),
        sa.Column("embedding_revision", sa.String(length=255), nullable=False),
        sa.Column("vector_dimensions", sa.Integer(), nullable=False, server_default="1024"),
        sa.Column("configuration_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="building"),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
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
        sa.CheckConstraint("generation >= 1", name="ck_artifact_text_index_generation"),
        sa.CheckConstraint("vector_dimensions = 1024", name="ck_artifact_text_index_vector_dimensions"),
        sa.CheckConstraint(
            "status IN ('building', 'ready', 'failed')",
            name="ck_artifact_text_index_status",
        ),
        sa.CheckConstraint("chunk_count >= 0", name="ck_artifact_text_index_chunk_count"),
        sa.ForeignKeyConstraint(
            ["version_id", "artifact_id"],
            ["artifact_versions.id", "artifact_versions.artifact_id"],
            name="fk_artifact_text_index_version_artifact",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("artifact_id", "generation", name="uq_artifact_text_index_artifact_generation"),
        sa.UniqueConstraint("id", "artifact_id", "version_id", name="uq_artifact_text_index_identity"),
    )
    op.create_index(
        "uq_artifact_text_index_building_configuration",
        "artifact_text_indexes",
        ["version_id", "configuration_fingerprint"],
        unique=True,
        postgresql_where=sa.text("status = 'building'"),
    )
    op.create_table(
        "artifact_text_chunks",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("index_id", sa.UUID(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("line_start", sa.Integer(), nullable=False),
        sa.Column("line_end", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("text_sha256", sa.String(length=64), nullable=False),
        sa.Column("embedding", Vector(1024), nullable=False),
        sa.Column(
            "lexical_document",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple'::regconfig, text)", persisted=True),
            nullable=False,
        ),
        sa.Column(
            "normalized_text",
            sa.Text(),
            sa.Computed("lower(text)", persisted=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_artifact_text_chunk_ordinal"),
        sa.CheckConstraint(
            "line_start >= 1 AND line_end >= line_start",
            name="ck_artifact_text_chunk_lines",
        ),
        sa.CheckConstraint("token_count BETWEEN 1 AND 512", name="ck_artifact_text_chunk_token_count"),
        sa.CheckConstraint("octet_length(text) <= 8192", name="ck_artifact_text_chunk_bytes"),
        sa.ForeignKeyConstraint(["index_id"], ["artifact_text_indexes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("index_id", "ordinal", name="uq_artifact_text_chunks_index_ordinal"),
    )
    op.create_index(
        "ix_artifact_text_chunks_lexical_document",
        "artifact_text_chunks",
        ["lexical_document"],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_artifact_text_chunks_normalized_text_trgm",
        "artifact_text_chunks",
        ["normalized_text"],
        postgresql_using="gin",
        postgresql_ops={"normalized_text": "gin_trgm_ops"},
    )
    op.create_table(
        "artifact_index_jobs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("index_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="ready"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
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
        sa.CheckConstraint("attempts BETWEEN 0 AND 5", name="ck_artifact_index_job_attempts"),
        sa.CheckConstraint(
            "status IN ('ready', 'leased', 'succeeded', 'dead')",
            name="ck_artifact_index_job_status",
        ),
        sa.CheckConstraint(
            "(status = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)",
            name="ck_artifact_index_job_lease",
        ),
        sa.ForeignKeyConstraint(["index_id"], ["artifact_text_indexes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("index_id"),
    )
    op.create_table(
        "artifact_search_heads",
        sa.Column("artifact_id", sa.UUID(), nullable=False),
        sa.Column("index_id", sa.UUID(), nullable=False),
        sa.Column("version_id", sa.UUID(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["artifact_id"], ["artifacts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["index_id", "artifact_id", "version_id"],
            [
                "artifact_text_indexes.id",
                "artifact_text_indexes.artifact_id",
                "artifact_text_indexes.version_id",
            ],
            name="fk_artifact_search_head_index_identity",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("artifact_id"),
        sa.UniqueConstraint("index_id"),
    )
    op.create_table(
        "xagent_retrieval_receipts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("tool_call_id", sa.String(length=255), nullable=False),
        sa.Column("query_sha256", sa.String(length=64), nullable=False),
        sa.Column("scope", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("permission_revision", sa.BigInteger(), nullable=False),
        sa.Column("project_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("index_generations", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("chunk_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consumed_event_sequence", sa.BigInteger(), nullable=True),
        sa.Column("consumed_payload_sha256", sa.String(length=64), nullable=True),
        sa.Column("citation_ordinal_start", sa.Integer(), nullable=True),
        sa.Column("citation_ordinal_end", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "kind IN ('project_discovery', 'artifact_search')",
            name="ck_xagent_retrieval_receipt_kind",
        ),
        sa.CheckConstraint(
            "permission_revision >= 1",
            name="ck_xagent_retrieval_receipt_permission_revision",
        ),
        sa.CheckConstraint(
            "expires_at = issued_at + INTERVAL '5 minutes'",
            name="ck_xagent_retrieval_receipt_expiry",
        ),
        sa.CheckConstraint(
            "(citation_ordinal_start IS NULL AND citation_ordinal_end IS NULL) OR "
            "(citation_ordinal_start >= 1 AND citation_ordinal_end >= citation_ordinal_start)",
            name="ck_xagent_retrieval_receipt_citation_ordinals",
        ),
        sa.CheckConstraint(
            "(consumed_at IS NULL AND consumed_event_sequence IS NULL AND consumed_payload_sha256 IS NULL) OR "
            "(consumed_at IS NOT NULL AND consumed_event_sequence IS NOT NULL AND consumed_payload_sha256 IS NOT NULL)",
            name="ck_xagent_retrieval_receipt_consumption",
        ),
        sa.ForeignKeyConstraint(["actor_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["session_id"], ["xagent_sessions.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id", "consumed_event_sequence", name="uq_xagent_retrieval_receipt_consumption"),
    )

    op.execute(
        "CREATE FUNCTION public.enforce_artifact_text_index_status_transition() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER "
        "SET search_path = pg_catalog, public AS $$ "
        "BEGIN "
        "IF OLD.id IS DISTINCT FROM NEW.id OR OLD.artifact_id IS DISTINCT FROM NEW.artifact_id "
        "OR OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.generation IS DISTINCT FROM NEW.generation "
        "OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256 "
        "OR OLD.parser_revision IS DISTINCT FROM NEW.parser_revision "
        "OR OLD.embedding_model IS DISTINCT FROM NEW.embedding_model "
        "OR OLD.embedding_revision IS DISTINCT FROM NEW.embedding_revision "
        "OR OLD.vector_dimensions IS DISTINCT FROM NEW.vector_dimensions "
        "OR OLD.configuration_fingerprint IS DISTINCT FROM NEW.configuration_fingerprint THEN "
        "RAISE EXCEPTION 'artifact text index identity is immutable' USING ERRCODE = '23514'; "
        "END IF; "
        "IF OLD.status IS DISTINCT FROM NEW.status AND NOT "
        "(OLD.status = 'building' AND NEW.status IN ('ready', 'failed')) THEN "
        "RAISE EXCEPTION 'invalid artifact text index status transition' USING ERRCODE = '23514'; "
        "END IF; "
        "NEW.updated_at := CURRENT_TIMESTAMP; RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER artifact_text_index_status_transition BEFORE UPDATE ON artifact_text_indexes "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_artifact_text_index_status_transition()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_artifact_search_head() RETURNS trigger LANGUAGE plpgsql "
        "SECURITY DEFINER SET search_path = pg_catalog, public AS $$ "
        "DECLARE indexed_artifact_id uuid; indexed_version_id uuid; indexed_status text; version_status text; "
        "BEGIN SELECT artifact_id, version_id, status INTO indexed_artifact_id, indexed_version_id, indexed_status "
        "FROM public.artifact_text_indexes WHERE id = NEW.index_id; "
        "SELECT scan_status INTO version_status FROM public.artifact_versions WHERE id = NEW.version_id; "
        "IF indexed_status IS DISTINCT FROM 'ready' OR indexed_artifact_id IS DISTINCT FROM NEW.artifact_id "
        "OR indexed_version_id IS DISTINCT FROM NEW.version_id OR version_status IS DISTINCT FROM 'clean' THEN "
        "RAISE EXCEPTION 'search heads require a ready index for a clean matching version' USING ERRCODE = '23514'; "
        "END IF; NEW.updated_at := CURRENT_TIMESTAMP; RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER artifact_search_head_valid BEFORE INSERT OR UPDATE ON artifact_search_heads "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_artifact_search_head()"
    )
    op.execute(
        "CREATE FUNCTION public.enforce_xagent_retrieval_receipt_consumption() "
        "RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER "
        "SET search_path = pg_catalog, public AS $$ "
        "BEGIN "
        "IF OLD.kind IS DISTINCT FROM NEW.kind OR OLD.actor_id IS DISTINCT FROM NEW.actor_id "
        "OR OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.tool_call_id IS DISTINCT FROM NEW.tool_call_id "
        "OR OLD.query_sha256 IS DISTINCT FROM NEW.query_sha256 OR OLD.scope IS DISTINCT FROM NEW.scope "
        "OR OLD.permission_revision IS DISTINCT FROM NEW.permission_revision "
        "OR OLD.project_ids IS DISTINCT FROM NEW.project_ids "
        "OR OLD.index_generations IS DISTINCT FROM NEW.index_generations "
        "OR OLD.chunk_ids IS DISTINCT FROM NEW.chunk_ids "
        "OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256 "
        "OR OLD.issued_at IS DISTINCT FROM NEW.issued_at OR OLD.expires_at IS DISTINCT FROM NEW.expires_at "
        "OR OLD.citation_ordinal_start IS DISTINCT FROM NEW.citation_ordinal_start "
        "OR OLD.citation_ordinal_end IS DISTINCT FROM NEW.citation_ordinal_end THEN "
        "RAISE EXCEPTION 'retrieval receipt claims are immutable' USING ERRCODE = '23514'; "
        "END IF; "
        "IF OLD.consumed_at IS NOT NULL THEN "
        "RAISE EXCEPTION 'retrieval receipt is already consumed' USING ERRCODE = '23514'; "
        "END IF; "
        "IF OLD.expires_at <= CURRENT_TIMESTAMP THEN "
        "RAISE EXCEPTION 'retrieval receipt is expired' USING ERRCODE = '23514'; "
        "END IF; "
        "IF NEW.consumed_at IS NULL OR NEW.consumed_event_sequence IS NULL "
        "OR NEW.consumed_payload_sha256 IS NULL THEN "
        "RAISE EXCEPTION 'retrieval receipt consumption must be complete' USING ERRCODE = '23514'; "
        "END IF; "
        "RETURN NEW; END $$"
    )
    op.execute(
        "CREATE TRIGGER xagent_retrieval_receipt_consumption BEFORE UPDATE ON xagent_retrieval_receipts "
        "FOR EACH ROW EXECUTE FUNCTION public.enforce_xagent_retrieval_receipt_consumption()"
    )

    for table in (
        "artifact_text_indexes",
        "artifact_text_chunks",
        "artifact_index_jobs",
        "artifact_search_heads",
        "xagent_retrieval_receipts",
    ):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

    actor_id = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    artifact_visible = "artifact_id IN (SELECT id FROM public.artifacts)"
    index_visible = "index_id IN (SELECT id FROM public.artifact_text_indexes)"
    receipt_visible = f"actor_id = {actor_id} AND session_id IN (SELECT id FROM public.xagent_sessions)"
    op.execute(
        f"CREATE POLICY artifact_text_index_read ON artifact_text_indexes FOR SELECT TO {application_role} "
        f"USING ({artifact_visible})"
    )
    op.execute(
        f"CREATE POLICY artifact_text_chunk_read ON artifact_text_chunks FOR SELECT TO {application_role} "
        f"USING ({index_visible})"
    )
    op.execute(
        f"CREATE POLICY artifact_search_head_read ON artifact_search_heads FOR SELECT TO {application_role} "
        f"USING ({artifact_visible})"
    )
    op.execute(
        f"CREATE POLICY xagent_retrieval_receipt_select ON xagent_retrieval_receipts "
        f"FOR SELECT TO {application_role} USING ({receipt_visible})"
    )
    op.execute(
        f"CREATE POLICY xagent_retrieval_receipt_insert ON xagent_retrieval_receipts "
        f"FOR INSERT TO {application_role} WITH CHECK ("
        f"{receipt_visible} AND consumed_at IS NULL AND consumed_event_sequence IS NULL "
        "AND consumed_payload_sha256 IS NULL)"
    )
    op.execute(
        f"CREATE POLICY xagent_retrieval_receipt_update ON xagent_retrieval_receipts "
        f"FOR UPDATE TO {application_role} USING ({receipt_visible}) WITH CHECK ({receipt_visible})"
    )

    for table in ("artifact_text_indexes", "artifact_index_jobs", "artifact_search_heads"):
        for operation, clause in (("SELECT", "USING (true)"), ("INSERT", "WITH CHECK (true)"), ("UPDATE", "USING (true) WITH CHECK (true)")):
            op.execute(
                f"CREATE POLICY {table}_worker_{operation.lower()} ON {table} "
                f"FOR {operation} TO {worker_role} {clause}"
            )
    op.execute(
        f"CREATE POLICY artifact_text_chunks_worker_insert ON artifact_text_chunks "
        f"FOR INSERT TO {worker_role} WITH CHECK (true)"
    )

    op.execute(
        f"GRANT SELECT ON artifact_text_indexes, artifact_text_chunks, artifact_search_heads TO {application_role}"
    )
    op.execute(
        f"GRANT SELECT, INSERT ON xagent_retrieval_receipts TO {application_role}"
    )
    op.execute(
        f"GRANT UPDATE (consumed_at, consumed_event_sequence, consumed_payload_sha256) "
        f"ON xagent_retrieval_receipts TO {application_role}"
    )
    op.execute(f"GRANT SELECT, INSERT ON artifact_text_indexes TO {worker_role}")
    op.execute(
        f"GRANT UPDATE (status, chunk_count, failure_code, updated_at) "
        f"ON artifact_text_indexes TO {worker_role}"
    )
    op.execute(f"GRANT INSERT ON artifact_text_chunks TO {worker_role}")
    op.execute(f"GRANT SELECT, INSERT ON artifact_index_jobs TO {worker_role}")
    op.execute(
        f"GRANT UPDATE (status, attempts, next_attempt_at, lease_token, lease_expires_at, failure_code, updated_at) "
        f"ON artifact_index_jobs TO {worker_role}"
    )
    op.execute(f"GRANT SELECT, INSERT ON artifact_search_heads TO {worker_role}")
    op.execute(
        f"GRANT UPDATE (index_id, version_id, updated_at) ON artifact_search_heads TO {worker_role}"
    )


def downgrade() -> None:
    application_role = _configured_role("application_role")
    worker_role = _configured_role("worker_role")

    op.execute(
        f"REVOKE ALL PRIVILEGES ON artifact_text_indexes, artifact_text_chunks, artifact_index_jobs, "
        f"artifact_search_heads, xagent_retrieval_receipts FROM {application_role}"
    )
    op.execute(
        f"REVOKE ALL PRIVILEGES ON artifact_text_indexes, artifact_text_chunks, artifact_index_jobs, "
        f"artifact_search_heads FROM {worker_role}"
    )
    for table, policies in (
        ("artifact_text_indexes", ("artifact_text_indexes_worker_update", "artifact_text_indexes_worker_insert", "artifact_text_indexes_worker_select", "artifact_text_index_read")),
        ("artifact_text_chunks", ("artifact_text_chunks_worker_insert", "artifact_text_chunk_read")),
        ("artifact_index_jobs", ("artifact_index_jobs_worker_update", "artifact_index_jobs_worker_insert", "artifact_index_jobs_worker_select")),
        ("artifact_search_heads", ("artifact_search_heads_worker_update", "artifact_search_heads_worker_insert", "artifact_search_heads_worker_select", "artifact_search_head_read")),
        ("xagent_retrieval_receipts", ("xagent_retrieval_receipt_update", "xagent_retrieval_receipt_insert", "xagent_retrieval_receipt_select")),
    ):
        for policy in policies:
            op.execute(f"DROP POLICY {policy} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.execute("DROP TRIGGER xagent_retrieval_receipt_consumption ON xagent_retrieval_receipts")
    op.execute("DROP FUNCTION public.enforce_xagent_retrieval_receipt_consumption()")
    op.execute("DROP TRIGGER artifact_search_head_valid ON artifact_search_heads")
    op.execute("DROP FUNCTION public.enforce_artifact_search_head()")
    op.execute("DROP TRIGGER artifact_text_index_status_transition ON artifact_text_indexes")
    op.execute("DROP FUNCTION public.enforce_artifact_text_index_status_transition()")
    op.drop_table("xagent_retrieval_receipts")
    op.drop_table("artifact_search_heads")
    op.drop_table("artifact_index_jobs")
    op.drop_index("ix_artifact_text_chunks_normalized_text_trgm", table_name="artifact_text_chunks")
    op.drop_index("ix_artifact_text_chunks_lexical_document", table_name="artifact_text_chunks")
    op.drop_table("artifact_text_chunks")
    op.drop_index("uq_artifact_text_index_building_configuration", table_name="artifact_text_indexes")
    op.drop_table("artifact_text_indexes")
    op.drop_constraint("uq_artifact_version_id_artifact", "artifact_versions", type_="unique")
    op.drop_constraint("ck_xagent_session_next_citation_ordinal", "xagent_sessions", type_="check")
    op.drop_column("xagent_sessions", "next_citation_ordinal")
    op.execute("DROP EXTENSION IF EXISTS pg_trgm")
    op.execute("DROP EXTENSION IF EXISTS vector")
