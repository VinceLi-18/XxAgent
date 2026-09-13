"""Add immutable publications and project-governed Business Skill storage.

Revision ID: 018_xagent_business_skills
Revises: 017_fact_tool_call_identity
"""

from alembic import op

revision = "018_xagent_business_skills"
down_revision = "017_fact_tool_call_identity"
branch_labels = None
depends_on = None

TABLES = ("business_skills", "business_skill_drafts", "business_skill_versions", "business_skill_test_runs", "business_skill_authorizations")
AUDIT_CHECK = (
    "jsonb_typeof(details) = 'object' AND octet_length(details::text) <= CASE "
    "WHEN action = 'retrieval.citation_authorize' THEN 32768 ELSE 8192 END AND "
    "(action NOT LIKE 'retrieval.%' OR public.xagent_valid_retrieval_audit_details(action, details)) AND "
    "(action NOT LIKE 'fact.%' OR public.xagent_valid_fact_audit_details(action, details))"
)


def _role(option: str) -> str:
    value = op.get_context().config.get_main_option(option)
    if not value:
        raise RuntimeError(f"Alembic {option} configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(value)


def _create_tables() -> None:
    op.execute("""
        CREATE FUNCTION public.xagent_valid_business_skill_tools(value jsonb, complete boolean)
        RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
        DECLARE item jsonb; previous text := ''; tool text;
        BEGIN
            IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
            FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
                IF jsonb_typeof(item) <> 'string' THEN RETURN false; END IF;
                tool := item #>> '{}';
                IF tool COLLATE "C" <= previous COLLATE "C" OR tool NOT IN
                    ('list_accessible_projects','search_artifacts','propose_fact','skill','submit_cited_answer')
                    OR (NOT complete AND tool IN ('skill','submit_cited_answer')) THEN RETURN false; END IF;
                previous := tool;
            END LOOP;
            RETURN NOT complete OR value ? 'skill';
        END $$
    """)
    op.execute("ALTER TABLE xagent_sessions ADD COLUMN purpose varchar(32) NOT NULL DEFAULT 'conversation'")
    op.create_check_constraint("ck_xagent_session_purpose", "xagent_sessions", "purpose IN ('conversation','business_skill_test')")
    op.create_check_constraint("ck_xagent_session_test_project", "xagent_sessions", "purpose <> 'business_skill_test' OR visibility = 'project'")
    op.execute("""
        CREATE TABLE business_skills (
            id uuid PRIMARY KEY,
            project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
            slug varchar(128) NOT NULL,
            display_name varchar(255) NOT NULL,
            current_version_id uuid,
            status varchar(16) NOT NULL DEFAULT 'active',
            created_by_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_business_skill_slug UNIQUE(project_id, slug),
            CONSTRAINT uq_business_skill_project_identity UNIQUE(id, project_id),
            CONSTRAINT ck_business_skill_slug CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
            CONSTRAINT ck_business_skill_display_name CHECK(octet_length(display_name) BETWEEN 1 AND 255),
            CONSTRAINT ck_business_skill_status CHECK(status IN ('active','retired'))
        )
    """)
    op.execute("""
        CREATE TABLE business_skill_drafts (
            skill_id uuid PRIMARY KEY,
            project_id uuid NOT NULL,
            revision bigint NOT NULL,
            description text NOT NULL,
            instructions text NOT NULL,
            primary_tools jsonb NOT NULL,
            content_digest varchar(64) NOT NULL,
            edited_by_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY(skill_id, project_id) REFERENCES business_skills(id, project_id) ON DELETE RESTRICT,
            CONSTRAINT ck_business_skill_draft_revision CHECK(revision >= 1),
            CONSTRAINT ck_business_skill_draft_description CHECK(octet_length(description) BETWEEN 1 AND 2048 AND length(btrim(description)) > 0),
            CONSTRAINT ck_business_skill_draft_instructions CHECK(octet_length(instructions) BETWEEN 1 AND 65536 AND length(btrim(instructions)) > 0),
            CONSTRAINT ck_business_skill_draft_digest CHECK(content_digest ~ '^[0-9a-f]{64}$'),
            CONSTRAINT ck_business_skill_draft_tools CHECK(public.xagent_valid_business_skill_tools(primary_tools, false))
        )
    """)
    op.execute("""
        CREATE TABLE business_skill_versions (
            id uuid PRIMARY KEY,
            skill_id uuid NOT NULL,
            project_id uuid NOT NULL,
            version_number bigint NOT NULL,
            description text NOT NULL,
            instructions text NOT NULL,
            primary_tools jsonb NOT NULL,
            complete_tools jsonb NOT NULL,
            content_digest varchar(64) NOT NULL,
            tool_policy_digest varchar(64) NOT NULL,
            source_draft_revision bigint NOT NULL,
            published_by_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            published_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY(skill_id, project_id) REFERENCES business_skills(id, project_id) ON DELETE RESTRICT,
            CONSTRAINT uq_business_skill_version_identity UNIQUE(id, skill_id, project_id),
            CONSTRAINT uq_business_skill_project_version UNIQUE(project_id, version_number),
            CONSTRAINT ck_business_skill_version_revisions CHECK(version_number >= 1 AND source_draft_revision >= 1),
            CONSTRAINT ck_business_skill_version_description CHECK(octet_length(description) BETWEEN 1 AND 2048 AND length(btrim(description)) > 0),
            CONSTRAINT ck_business_skill_version_instructions CHECK(octet_length(instructions) BETWEEN 1 AND 65536 AND length(btrim(instructions)) > 0),
            CONSTRAINT ck_business_skill_version_digests CHECK(content_digest ~ '^[0-9a-f]{64}$' AND tool_policy_digest ~ '^[0-9a-f]{64}$'),
            CONSTRAINT ck_business_skill_version_tools CHECK(public.xagent_valid_business_skill_tools(primary_tools, false) AND public.xagent_valid_business_skill_tools(complete_tools, true)),
            CONSTRAINT ck_business_skill_version_tool_closure CHECK(complete_tools - 'skill' - 'submit_cited_answer' = primary_tools AND (complete_tools ? 'submit_cited_answer') = (primary_tools ? 'search_artifacts'))
        )
    """)
    op.create_foreign_key("fk_business_skill_current_version", "business_skills", "business_skill_versions", ["current_version_id", "id", "project_id"], ["id", "skill_id", "project_id"], ondelete="RESTRICT")
    op.execute("""
        CREATE TABLE business_skill_test_runs (
            id uuid PRIMARY KEY,
            skill_id uuid NOT NULL,
            project_id uuid NOT NULL,
            run_number bigint NOT NULL,
            draft_revision bigint NOT NULL,
            content_digest varchar(64) NOT NULL,
            tool_policy_digest varchar(64) NOT NULL,
            session_id uuid NOT NULL,
            status varchar(16) NOT NULL DEFAULT 'running',
            termination_reason varchar(32),
            verdict varchar(16),
            started_by_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            verdict_by_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
            started_at timestamptz NOT NULL DEFAULT now(),
            settled_at timestamptz,
            verdict_at timestamptz,
            FOREIGN KEY(skill_id, project_id) REFERENCES business_skills(id, project_id) ON DELETE RESTRICT,
            FOREIGN KEY(session_id, project_id) REFERENCES xagent_sessions(id, project_id) ON DELETE RESTRICT,
            CONSTRAINT uq_business_skill_project_run UNIQUE(project_id, run_number),
            CONSTRAINT uq_business_skill_test_session UNIQUE(session_id),
            CONSTRAINT ck_business_skill_test_revisions CHECK(run_number >= 1 AND draft_revision >= 1),
            CONSTRAINT ck_business_skill_test_digests CHECK(content_digest ~ '^[0-9a-f]{64}$' AND tool_policy_digest ~ '^[0-9a-f]{64}$'),
            CONSTRAINT ck_business_skill_test_status CHECK(status IN ('running','completed','failed','cancelled')),
            CONSTRAINT ck_business_skill_test_verdict CHECK(verdict IS NULL OR verdict IN ('pass','reject')),
            CONSTRAINT ck_business_skill_test_settlement CHECK((status = 'running' AND settled_at IS NULL AND termination_reason IS NULL) OR (status <> 'running' AND settled_at IS NOT NULL AND termination_reason IS NOT NULL)),
            CONSTRAINT ck_business_skill_test_verdict_identity CHECK((verdict IS NULL AND verdict_by_id IS NULL AND verdict_at IS NULL) OR (verdict IS NOT NULL AND verdict_by_id IS NOT NULL AND verdict_at IS NOT NULL AND status <> 'running' AND (verdict <> 'pass' OR status = 'completed'))),
            CONSTRAINT ck_business_skill_test_termination_reason CHECK(termination_reason IS NULL OR termination_reason IN ('completed','failed','cancelled','tool-denied','authorization-denied','skill-not-loaded','service-unavailable')),
            CONSTRAINT ck_business_skill_test_completed CHECK(status <> 'completed' OR termination_reason = 'completed')
        )
    """)
    op.execute("""
        CREATE TABLE business_skill_authorizations (
            id uuid PRIMARY KEY,
            skill_id uuid NOT NULL,
            project_id uuid NOT NULL,
            authorized_by_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            authorized_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY(skill_id, project_id) REFERENCES business_skills(id, project_id) ON DELETE RESTRICT,
            CONSTRAINT uq_business_skill_authorization UNIQUE(skill_id)
        )
    """)


def _create_triggers() -> None:
    op.execute("""
        CREATE FUNCTION public.xagent_session_purpose_immutable() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
            IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
                RAISE EXCEPTION 'session purpose is immutable' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END $$
    """)
    op.execute("CREATE TRIGGER xagent_session_purpose_immutable BEFORE UPDATE ON xagent_sessions FOR EACH ROW EXECUTE FUNCTION public.xagent_session_purpose_immutable()")
    op.execute("""
        CREATE FUNCTION public.xagent_business_skill_identity() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
            IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'skill identity is immutable' USING ERRCODE = '23514'; END IF;
            IF (NEW.id, NEW.project_id, NEW.slug, NEW.created_by_id, NEW.created_at)
                IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.slug, OLD.created_by_id, OLD.created_at) THEN
                RAISE EXCEPTION 'skill identity is immutable' USING ERRCODE = '23514'; END IF;
            IF OLD.status = 'retired' AND NEW IS DISTINCT FROM OLD THEN
                RAISE EXCEPTION 'retired skill is immutable' USING ERRCODE = '23514'; END IF;
            RETURN NEW;
        END $$
    """)
    op.execute("CREATE TRIGGER business_skill_identity BEFORE UPDATE OR DELETE ON business_skills FOR EACH ROW EXECUTE FUNCTION public.xagent_business_skill_identity()")
    # The trigger may lock project rows without granting callers project UPDATE.
    op.execute("""
        CREATE FUNCTION public.xagent_business_skill_project_number() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        DECLARE last_number bigint; requested_number bigint;
        BEGIN
            PERFORM 1 FROM public.projects WHERE id = NEW.project_id FOR UPDATE;
            IF TG_TABLE_NAME = 'business_skill_versions' THEN
                SELECT coalesce(max(version_number),0) INTO last_number FROM public.business_skill_versions WHERE project_id = NEW.project_id;
                requested_number := NEW.version_number;
            ELSIF TG_TABLE_NAME = 'business_skill_test_runs' THEN
                SELECT coalesce(max(run_number),0) INTO last_number FROM public.business_skill_test_runs WHERE project_id = NEW.project_id;
                requested_number := NEW.run_number;
            ELSE
                RAISE EXCEPTION 'invalid project number relation' USING ERRCODE = '23514';
            END IF;
            IF requested_number <= last_number THEN RAISE EXCEPTION 'project number must increase' USING ERRCODE = '23514'; END IF;
            RETURN NEW;
        END $$
    """)
    op.execute("REVOKE ALL ON FUNCTION public.xagent_business_skill_project_number() FROM PUBLIC")
    for table in ("business_skill_versions", "business_skill_test_runs"):
        op.execute(f"CREATE TRIGGER {table}_allocate BEFORE INSERT ON {table} FOR EACH ROW EXECUTE FUNCTION public.xagent_business_skill_project_number()")
    op.execute("""
        CREATE FUNCTION public.xagent_business_skill_child() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
        DECLARE skill_status text; current_version uuid;
        BEGIN
            IF TG_TABLE_NAME = 'business_skill_versions' AND TG_OP <> 'INSERT' THEN
                RAISE EXCEPTION 'business skill versions are immutable' USING ERRCODE = '23514'; END IF;
            IF TG_OP = 'DELETE' THEN
                IF TG_TABLE_NAME = 'business_skill_test_runs' THEN
                    RAISE EXCEPTION 'business skill test history is immutable' USING ERRCODE = '23514'; END IF;
                RETURN OLD;
            END IF;
            SELECT status, current_version_id INTO skill_status, current_version
                FROM public.business_skills WHERE id = NEW.skill_id AND project_id = NEW.project_id FOR UPDATE;
            IF skill_status = 'retired' AND (TG_OP = 'INSERT' OR TG_TABLE_NAME = 'business_skill_drafts') THEN
                RAISE EXCEPTION 'retired skill cannot accept new content or authorization' USING ERRCODE = '23514'; END IF;
            IF TG_TABLE_NAME = 'business_skill_authorizations' THEN
                IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'authorization identity is immutable' USING ERRCODE = '23514'; END IF;
                IF current_version IS NULL THEN RAISE EXCEPTION 'authorization requires a publication' USING ERRCODE = '23514'; END IF;
            ELSIF TG_TABLE_NAME = 'business_skill_drafts' AND TG_OP = 'UPDATE' THEN
                IF (NEW.skill_id, NEW.project_id, NEW.created_at) IS DISTINCT FROM (OLD.skill_id, OLD.project_id, OLD.created_at) THEN
                    RAISE EXCEPTION 'draft identity is immutable' USING ERRCODE = '23514'; END IF;
                IF (NEW.instructions, NEW.description, NEW.primary_tools) IS DISTINCT FROM (OLD.instructions, OLD.description, OLD.primary_tools) THEN
                    IF NEW.revision <> OLD.revision + 1 OR NEW.content_digest = OLD.content_digest THEN
                        RAISE EXCEPTION 'draft edit requires next revision and new digest' USING ERRCODE = '23514'; END IF;
                ELSIF (NEW.revision, NEW.content_digest) IS DISTINCT FROM (OLD.revision, OLD.content_digest) THEN
                    RAISE EXCEPTION 'draft revision requires changed content' USING ERRCODE = '23514'; END IF;
            ELSIF TG_TABLE_NAME = 'business_skill_test_runs' THEN
                IF TG_OP = 'INSERT' THEN
                    IF NOT EXISTS (SELECT 1 FROM public.xagent_sessions WHERE id = NEW.session_id AND project_id = NEW.project_id AND purpose = 'business_skill_test') THEN
                        RAISE EXCEPTION 'test run requires its project test session' USING ERRCODE = '23514'; END IF;
                ELSE
                    IF (to_jsonb(NEW) - ARRAY['status','termination_reason','settled_at','verdict','verdict_by_id','verdict_at'])
                        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','termination_reason','settled_at','verdict','verdict_by_id','verdict_at']) THEN
                        RAISE EXCEPTION 'test input identity is immutable' USING ERRCODE = '23514'; END IF;
                    IF OLD.status <> 'running' AND (NEW.status, NEW.termination_reason, NEW.settled_at) IS DISTINCT FROM (OLD.status, OLD.termination_reason, OLD.settled_at) THEN
                        RAISE EXCEPTION 'test settlement is immutable' USING ERRCODE = '23514'; END IF;
                END IF;
            END IF;
            RETURN NEW;
        END $$
    """)
    for table in TABLES[1:]:
        op.execute(f"CREATE TRIGGER {table}_guard BEFORE INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION public.xagent_business_skill_child()")
    op.execute("""
        CREATE FUNCTION public.xagent_business_skill_retirement() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
            IF EXISTS (SELECT 1 FROM public.business_skills s JOIN public.business_skill_authorizations a ON a.skill_id = s.id
                WHERE s.id = NEW.id AND (s.status = 'retired' OR s.current_version_id IS NULL)) THEN
                RAISE EXCEPTION 'retired skill cannot be authorized' USING ERRCODE = '23514'; END IF;
            RETURN NULL;
        END $$
    """)
    op.execute("CREATE CONSTRAINT TRIGGER business_skill_retirement AFTER UPDATE ON business_skills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.xagent_business_skill_retirement()")


def _create_audit_validator() -> None:
    op.execute("""
        CREATE FUNCTION public.xagent_valid_business_skill_audit_details(action_name text, value jsonb)
        RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
        DECLARE key text; item jsonb; outcome text;
        BEGIN
            IF value IS NULL OR jsonb_typeof(value) <> 'object' OR NOT value ?& ARRAY['project_id','skill_id','result'] THEN RETURN false; END IF;
            FOR key, item IN SELECT * FROM jsonb_each(value) LOOP
                IF key IN ('project_id','skill_id','session_id','version_id','test_run_id','authorization_id') THEN
                    IF jsonb_typeof(item) <> 'string' OR item #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
                ELSIF key IN ('content_digest','tool_policy_digest','request_sha256') THEN
                    IF jsonb_typeof(item) <> 'string' OR item #>> '{}' !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
                ELSIF key IN ('version_number','run_number','draft_revision') THEN
                    IF jsonb_typeof(item) <> 'number' OR item::text !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
                ELSIF key = 'latency_ms' THEN
                    IF jsonb_typeof(item) <> 'number' OR item::text !~ '^[0-9]+$' THEN RETURN false; END IF;
                ELSIF key = 'tool_name' THEN
                    IF jsonb_typeof(item) <> 'string' OR item #>> '{}' NOT IN ('list_accessible_projects','search_artifacts','propose_fact','skill','submit_cited_answer') THEN RETURN false; END IF;
                ELSIF key = 'verdict' THEN
                    IF jsonb_typeof(item) <> 'string' OR item #>> '{}' NOT IN ('pass','reject') THEN RETURN false; END IF;
                ELSIF key <> 'result' THEN RETURN false;
                END IF;
            END LOOP;
            IF jsonb_typeof(value->'result') <> 'string' THEN RETURN false; END IF;
            outcome := value->>'result';
            CASE action_name
                WHEN 'business_skill.create' THEN RETURN outcome = 'created';
                WHEN 'business_skill.draft_update' THEN RETURN outcome = 'updated' AND value ?& ARRAY['draft_revision','content_digest'];
                WHEN 'business_skill.test_start' THEN RETURN outcome = 'running' AND value ?& ARRAY['run_number','draft_revision','content_digest','tool_policy_digest','session_id'];
                WHEN 'business_skill.test_settle' THEN RETURN outcome IN ('completed','failed','cancelled') AND value ? 'run_number';
                WHEN 'business_skill.test_verdict' THEN RETURN outcome = 'reviewed' AND value ?& ARRAY['run_number','verdict'];
                WHEN 'business_skill.publish' THEN RETURN outcome = 'published' AND value ?& ARRAY['version_number','draft_revision','content_digest','tool_policy_digest'];
                WHEN 'business_skill.authorize' THEN RETURN outcome = 'authorized';
                WHEN 'business_skill.unauthorize' THEN RETURN outcome = 'unauthorized';
                WHEN 'business_skill.rollback' THEN RETURN outcome = 'selected' AND value ? 'version_number';
                WHEN 'business_skill.retire' THEN RETURN outcome = 'retired';
                WHEN 'business_skill.load_denied', 'business_skill.tool_authorization_denied', 'business_skill.authorization_denied' THEN
                    RETURN outcome IN ('not-found','forbidden','stale-permission','business-skill-not-authorized','business-skill-retired','business-skill-tool-denied','service-unavailable','cancelled');
                ELSE RETURN false;
            END CASE;
        END $$
    """)
    op.drop_constraint("ck_audit_event_details", "audit_events", type_="check")
    op.create_check_constraint("ck_audit_event_details", "audit_events", AUDIT_CHECK + " AND (action NOT LIKE 'business_skill.%' OR public.xagent_valid_business_skill_audit_details(action, details))")


def _create_rls_and_grants(application: str, worker: str) -> None:
    op.execute("""
        CREATE FUNCTION public.xagent_business_skill_project_ids() RETURNS SETOF uuid
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
            SELECT m.project_id FROM public.project_memberships m JOIN public.accounts a ON a.id = m.account_id
            WHERE m.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                AND a.is_active AND a.role::text = current_setting('app.actor_role', true)
                AND a.role::text IN ('specialist','manager')
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION public.xagent_business_skill_project_ids() FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION public.xagent_business_skill_project_ids() TO {application}")
    scope = "project_id IN (SELECT public.xagent_business_skill_project_ids())"
    for table in TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY {table}_project ON {table} FOR ALL TO {application} USING ({scope}) WITH CHECK ({scope})")
        op.execute(f"REVOKE ALL ON {table} FROM PUBLIC, {worker}, {application}")
        op.execute(f"GRANT SELECT, INSERT ON {table} TO {application}")
    for table, columns in {
        "business_skills": "display_name, current_version_id, status, updated_at",
        "business_skill_drafts": "revision, description, instructions, primary_tools, content_digest, edited_by_id, updated_at",
        "business_skill_test_runs": "status, termination_reason, settled_at, verdict, verdict_by_id, verdict_at",
    }.items():
        op.execute(f"GRANT UPDATE ({columns}) ON {table} TO {application}")
    op.execute(f"GRANT DELETE ON business_skill_drafts, business_skill_authorizations TO {application}")


def upgrade() -> None:
    application, worker = _role("application_role"), _role("worker_role")
    _create_tables()
    _create_triggers()
    _create_audit_validator()
    _create_rls_and_grants(application, worker)


def downgrade() -> None:
    nonempty = " OR ".join(f"EXISTS (SELECT 1 FROM public.{table})" for table in TABLES)
    op.execute(f"""
        DO $$ BEGIN
            IF {nonempty} OR EXISTS (SELECT 1 FROM public.xagent_sessions WHERE purpose <> 'conversation')
                OR EXISTS (SELECT 1 FROM public.audit_events WHERE action LIKE 'business_skill.%') THEN
                RAISE EXCEPTION 'cannot downgrade business skills with stored data';
            END IF;
        END $$
    """)
    op.drop_constraint("ck_audit_event_details", "audit_events", type_="check")
    op.create_check_constraint("ck_audit_event_details", "audit_events", AUDIT_CHECK)
    op.drop_constraint("fk_business_skill_current_version", "business_skills", type_="foreignkey")
    for table in reversed(TABLES):
        op.drop_table(table)
    op.execute("DROP TRIGGER xagent_session_purpose_immutable ON xagent_sessions")
    op.drop_constraint("ck_xagent_session_test_project", "xagent_sessions", type_="check")
    op.drop_constraint("ck_xagent_session_purpose", "xagent_sessions", type_="check")
    op.drop_column("xagent_sessions", "purpose")
    for function in ("xagent_session_purpose_immutable()", "xagent_business_skill_identity()", "xagent_business_skill_project_number()", "xagent_business_skill_child()", "xagent_business_skill_retirement()", "xagent_business_skill_project_ids()", "xagent_valid_business_skill_tools(jsonb,boolean)", "xagent_valid_business_skill_audit_details(text,jsonb)"):
        op.execute(f"DROP FUNCTION public.{function}")
