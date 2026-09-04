"""Add durable cited-answer provenance.

Revision ID: 014_xagent_citation_provenance
Revises: 013_xagent_rag_retrieval
Create Date: 2026-09-04
"""

import sqlalchemy as sa
from alembic import op

revision = "014_xagent_citation_provenance"
down_revision = "013_xagent_rag_retrieval"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    application_role = _application_role()
    op.create_unique_constraint(
        "uq_artifact_text_index_complete_identity",
        "artifact_text_indexes",
        ["id", "artifact_id", "version_id", "generation"],
    )
    op.create_unique_constraint(
        "uq_artifact_text_chunk_id_index",
        "artifact_text_chunks",
        ["id", "index_id"],
    )
    op.create_table(
        "xagent_cited_answer_evidence",
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("answer_event_sequence", sa.BigInteger(), nullable=False),
        sa.Column("citation_id", sa.String(length=32), nullable=False),
        sa.Column("admission_event_sequence", sa.BigInteger(), nullable=False),
        sa.Column("artifact_id", sa.UUID(), nullable=False),
        sa.Column("version_id", sa.UUID(), nullable=False),
        sa.Column("index_id", sa.UUID(), nullable=False),
        sa.Column("index_generation", sa.Integer(), nullable=False),
        sa.Column("chunk_id", sa.UUID(), nullable=False),
        sa.CheckConstraint(
            "citation_id ~ '^\\[资料[1-9][0-9]*\\]$'",
            name="ck_xagent_cited_answer_evidence_citation_id",
        ),
        sa.CheckConstraint(
            "admission_event_sequence >= 0 AND answer_event_sequence > admission_event_sequence",
            name="ck_xagent_cited_answer_evidence_event_order",
        ),
        sa.CheckConstraint(
            "index_generation >= 1",
            name="ck_xagent_cited_answer_evidence_index_generation",
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "answer_event_sequence"],
            ["xagent_session_events.session_id", "xagent_session_events.sequence"],
            name="fk_xagent_cited_answer_evidence_answer_event",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "admission_event_sequence"],
            ["xagent_session_events.session_id", "xagent_session_events.sequence"],
            name="fk_xagent_cited_answer_evidence_admission_event",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["index_id", "artifact_id", "version_id", "index_generation"],
            [
                "artifact_text_indexes.id",
                "artifact_text_indexes.artifact_id",
                "artifact_text_indexes.version_id",
                "artifact_text_indexes.generation",
            ],
            name="fk_xagent_cited_answer_evidence_index_identity",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["chunk_id", "index_id"],
            ["artifact_text_chunks.id", "artifact_text_chunks.index_id"],
            name="fk_xagent_cited_answer_evidence_chunk_identity",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "session_id",
            "answer_event_sequence",
            "citation_id",
            name="pk_xagent_cited_answer_evidence",
        ),
    )
    op.create_index(
        "ix_xagent_cited_answer_evidence_lookup",
        "xagent_cited_answer_evidence",
        ["session_id", "citation_id"],
    )
    op.execute("ALTER TABLE xagent_cited_answer_evidence ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_cited_answer_evidence FORCE ROW LEVEL SECURITY")
    actor_id = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    session_read = "session_id IN (SELECT id FROM public.xagent_sessions)"
    session_write = (
        "session_id IN (SELECT id FROM public.xagent_sessions WHERE "
        f"(visibility = 'private' AND owner_id = {actor_id}) OR "
        "(visibility = 'project' AND project_id IN "
        "(SELECT public.xagent_authorized_project_edit_ids())))"
    )
    op.execute(
        "CREATE POLICY xagent_cited_answer_evidence_read "
        f"ON xagent_cited_answer_evidence FOR SELECT TO {application_role} USING ({session_read})"
    )
    op.execute(
        "CREATE POLICY xagent_cited_answer_evidence_insert "
        f"ON xagent_cited_answer_evidence FOR INSERT TO {application_role} WITH CHECK ({session_write})"
    )
    op.execute(
        f"GRANT SELECT, INSERT ON xagent_cited_answer_evidence TO {application_role}"
    )


def downgrade() -> None:
    application_role = _application_role()
    op.execute(
        f"REVOKE ALL PRIVILEGES ON xagent_cited_answer_evidence FROM {application_role}"
    )
    op.execute(
        "DROP POLICY xagent_cited_answer_evidence_insert ON xagent_cited_answer_evidence"
    )
    op.execute(
        "DROP POLICY xagent_cited_answer_evidence_read ON xagent_cited_answer_evidence"
    )
    op.drop_index(
        "ix_xagent_cited_answer_evidence_lookup",
        table_name="xagent_cited_answer_evidence",
    )
    op.drop_table("xagent_cited_answer_evidence")
    op.drop_constraint(
        "uq_artifact_text_chunk_id_index",
        "artifact_text_chunks",
        type_="unique",
    )
    op.drop_constraint(
        "uq_artifact_text_index_complete_identity",
        "artifact_text_indexes",
        type_="unique",
    )
