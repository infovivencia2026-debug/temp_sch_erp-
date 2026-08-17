-- 0002_rls: tenant isolation enforced by the database, not by remembering a WHERE.
--
-- The application connects as a NON-OWNER, NON-SUPERUSER role. That matters:
-- Postgres bypasses RLS for superusers and for the table owner unless FORCE ROW
-- LEVEL SECURITY is set. We set FORCE as well, so even a mistake in which role
-- the app connects as does not silently disable isolation.
--
-- Every request opens a transaction and issues:
--     SET LOCAL app.organization_id = '<uuid>';
-- SET LOCAL (not SET) because pgbouncer in transaction mode hands the connection
-- to another request the moment we commit.

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;

-- No org bound => no rows. Fails closed.
CREATE OR REPLACE FUNCTION app_org_bound() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT app_current_org() IS NOT NULL
$$;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['schools', 'campuses', 'academic_years', 'users',
                             'memberships', 'outbox_events']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I
                USING (app_org_bound() AND organization_id = app_current_org())
                WITH CHECK (app_org_bound() AND organization_id = app_current_org())
        $f$, t);
    END LOOP;
END $$;

-- organizations is the tenant root: the key is the row's own id.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
    USING (app_org_bound() AND id = app_current_org())
    WITH CHECK (app_org_bound() AND id = app_current_org());

-- audit_logs: readable within the tenant, insertable, never mutable.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs
    USING (app_org_bound() AND organization_id = app_current_org())
    WITH CHECK (app_org_bound() AND organization_id = app_current_org());

-- Login is the one operation that must find a user before we know which tenant
-- to bind — the person is typing an email, not choosing an organisation. Rather
-- than weaken the policy on users (which would make "no tenant bound" mean "see
-- everything"), we expose exactly the columns login needs through a SECURITY
-- DEFINER function. It runs as the owner, so RLS does not apply inside it, and
-- it can return at most one row.
--
-- This is the only RLS bypass in the system. Everything after authentication
-- runs tenant-bound.
CREATE OR REPLACE FUNCTION auth_lookup_login(p_email citext)
RETURNS TABLE (
    id              uuid,
    organization_id uuid,
    email           text,
    full_name       text,
    password_hash   text,
    status          text,
    failed_attempts int,
    locked_until    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
    SELECT u.id, u.organization_id, u.email::text, u.full_name, u.password_hash,
           u.status, u.failed_attempts, u.locked_until
    FROM   users u
    WHERE  u.email = p_email
      AND  u.archived_at IS NULL
    LIMIT  1
$$;

REVOKE ALL ON FUNCTION auth_lookup_login(citext) FROM PUBLIC;

-- roles and permissions are the catalogue: system rows are readable by everyone,
-- organization-owned rows only within that organization.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY role_visibility ON roles
    USING (organization_id IS NULL OR organization_id = app_current_org())
    WITH CHECK (organization_id = app_current_org());
