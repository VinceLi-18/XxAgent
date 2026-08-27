"""Add the restricted XAgent Session project-reference copy function.

Revision ID: 010_xagent_ref_copy
Revises: 009_xagent_project_workbench
Create Date: 2026-08-25
"""

from alembic import op

revision = "010_xagent_ref_copy"
down_revision = "009_xagent_project_workbench"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION public.xagent_copy_private_session_project_refs(
            source_session_id uuid,
            target_session_id uuid
        )
        RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            actor_id uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid;
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM public.xagent_sessions
                WHERE id = source_session_id
                  AND visibility = 'private'
                  AND owner_id = actor_id
            ) OR NOT EXISTS (
                SELECT 1 FROM public.xagent_sessions
                WHERE id = target_session_id
                  AND visibility = 'private'
                  AND owner_id = actor_id
            ) THEN
                RAISE EXCEPTION 'xagent project reference copy requires owned private sessions'
                    USING ERRCODE = '42501';
            END IF;
            IF EXISTS (
                SELECT 1
                FROM public.xagent_session_project_refs
                WHERE session_id = source_session_id
                  AND project_id NOT IN (SELECT public.authorized_project_ids())
            ) THEN
                RAISE EXCEPTION 'xagent project reference copy requires authorized source references'
                    USING ERRCODE = '42501';
            END IF;

            INSERT INTO public.xagent_session_project_refs (session_id, project_id)
            SELECT target_session_id, project_id
            FROM public.xagent_session_project_refs
            WHERE session_id = source_session_id
            ON CONFLICT DO NOTHING;
        END
        $$
        """
    )
    application_role = _application_role()
    op.execute(
        "REVOKE ALL ON FUNCTION public.xagent_copy_private_session_project_refs(uuid, uuid) "
        "FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "public.xagent_copy_private_session_project_refs(uuid, uuid) "
        f"TO {application_role}"
    )


def downgrade() -> None:
    application_role = _application_role()
    op.execute(
        "REVOKE ALL ON FUNCTION "
        "public.xagent_copy_private_session_project_refs(uuid, uuid) "
        f"FROM {application_role}"
    )
    op.execute(
        "DROP FUNCTION public.xagent_copy_private_session_project_refs(uuid, uuid)"
    )
