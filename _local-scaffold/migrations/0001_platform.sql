-- 0001_platform: tenancy root, identity, RBAC, audit.
-- Phase 1 foundation. Every tenant table carries organization_id and is RLS-protected.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- tenancy ----

CREATE TABLE organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    slug        text        NOT NULL UNIQUE,
    status      text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'closed')),
    settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);

CREATE TABLE schools (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    name            text NOT NULL,
    code            text NOT NULL,
    board           text NOT NULL DEFAULT 'CBSE',
    address         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    timezone        text        NOT NULL DEFAULT 'Asia/Kolkata',
    locale          text        NOT NULL DEFAULT 'en-IN',
    currency        char(3)     NOT NULL DEFAULT 'INR',
    settings        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_by      uuid,
    archived_at     timestamptz,
    CONSTRAINT schools_code_unique UNIQUE (organization_id, code)
);
CREATE INDEX schools_org_idx ON schools (organization_id) WHERE archived_at IS NULL;
CREATE INDEX schools_name_trgm ON schools USING gin (name gin_trgm_ops);

CREATE TABLE campuses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    name            text NOT NULL,
    code            text NOT NULL,
    address         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,
    CONSTRAINT campuses_code_unique UNIQUE (school_id, code)
);
CREATE INDEX campuses_school_idx ON campuses (organization_id, school_id);

CREATE TABLE academic_years (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    name            text NOT NULL,
    start_date      date NOT NULL,
    end_date        date NOT NULL,
    status          text NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'active', 'closed')),
    is_current      boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT academic_years_name_unique UNIQUE (school_id, name),
    CONSTRAINT academic_years_dates CHECK (end_date > start_date)
);
-- Business rule in the schema: exactly one current academic year per school.
CREATE UNIQUE INDEX academic_years_one_current
    ON academic_years (school_id) WHERE is_current;

-- --------------------------------------------------------------- identity ----

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    email               citext,
    phone               text,
    password_hash       text NOT NULL,
    full_name           text NOT NULL,
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'deactivated')),
    failed_attempts     int         NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    mfa_enabled         boolean     NOT NULL DEFAULT false,
    must_change_password boolean    NOT NULL DEFAULT false,
    last_login_at       timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    archived_at         timestamptz,
    CONSTRAINT users_email_unique UNIQUE (organization_id, email),
    CONSTRAINT users_contactable CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX users_phone_idx ON users (organization_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE roles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE, -- NULL = system role
    key             text NOT NULL,
    name            text NOT NULL,
    description     text NOT NULL DEFAULT '',
    is_system       boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_system_key ON roles (key) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX roles_org_key ON roles (organization_id, key) WHERE organization_id IS NOT NULL;

CREATE TABLE permissions (
    key         text PRIMARY KEY,
    domain      text NOT NULL,
    description text NOT NULL DEFAULT '',
    is_restricted boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
    role_id        uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission_key text NOT NULL REFERENCES permissions (key) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_key)
);

-- A user's access is the union of their memberships. Scope narrows a role to a
-- school, a campus, or a set of objects resolved at request time.
CREATE TABLE memberships (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    school_id       uuid REFERENCES schools (id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses (id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
    scope           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    status          text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'revoked')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memberships_campus_needs_school
        CHECK (campus_id IS NULL OR school_id IS NOT NULL)
);
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE status = 'active';
CREATE UNIQUE INDEX memberships_unique
    ON memberships (user_id, organization_id, coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    coalesce(campus_id, '00000000-0000-0000-0000-000000000000'::uuid), role_id)
    WHERE status = 'active';

-- ------------------------------------------------------------------ audit ----
-- Append-only. UPDATE and DELETE are revoked from the application role in 0002.
-- Partitioned by month so retention is a DETACH, not a DELETE.

CREATE TABLE audit_logs (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    organization_id uuid        NOT NULL,
    school_id       uuid,
    actor_user_id   uuid,
    actor_role      text,
    action          text        NOT NULL,
    entity_kind     text        NOT NULL,
    entity_id       uuid,
    before          jsonb,
    after           jsonb,
    reason          text,
    ip              inet,
    user_agent      text,
    request_id      text,
    at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_kind, entity_id, at DESC);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_user_id, at DESC);
CREATE INDEX audit_logs_org_idx    ON audit_logs (organization_id, at DESC);

-- Default partition catches anything the scheduler has not pre-created, so an
-- audit write can never fail for want of a partition.
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

-- ---------------------------------------------------------------- outbox -----
-- Written in the same transaction as the business change; a relay publishes to
-- the queue. This is what makes "payment received -> receipt" survive a crash.

CREATE TABLE outbox_events (
    id              bigserial PRIMARY KEY,
    organization_id uuid        NOT NULL,
    aggregate       text        NOT NULL,
    aggregate_id    uuid,
    event_key       text        NOT NULL,
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    attempts        int         NOT NULL DEFAULT 0,
    last_error      text
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at)
    WHERE published_at IS NULL;
