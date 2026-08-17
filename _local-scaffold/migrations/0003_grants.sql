-- 0003_grants: privileges for the application role.
--
-- The role is created by scripts/dev-setup.sh (or by your DBA in production) —
-- migrations grant, they do not create principals.
--
-- The one thing to notice: audit_logs gets INSERT and SELECT but no UPDATE and
-- no DELETE. An audit trail the application can rewrite is not an audit trail.

DO $$
DECLARE
    app_role text := current_setting('erp.app_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        app_role := 'schoolerp_app';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        RAISE EXCEPTION 'application role % does not exist — run scripts/dev-setup.sh first', app_role;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', app_role);

    -- Audit is append-only at the privilege level.
    EXECUTE format('REVOKE UPDATE, DELETE ON audit_logs FROM %I', app_role);
    EXECUTE format('REVOKE UPDATE, DELETE ON audit_logs_default FROM %I', app_role);

    -- The catalogue is read-only to the application.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON permissions FROM %I', app_role);

    -- The single RLS bypass, granted explicitly and to nobody else.
    EXECUTE format('GRANT EXECUTE ON FUNCTION auth_lookup_login(citext) TO %I', app_role);
END $$;
