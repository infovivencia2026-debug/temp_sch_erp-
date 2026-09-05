-- The job queue moves from Redis into this database, and cron gets a memory.
--
-- Two subjects, one file, because the second exists only because of the first:
--
--   1. River's schema  -- river_job and its neighbours, the tables the queue
--                         library (github.com/riverqueue/river) keeps jobs in.
--   2. cron_runs       -- one row per schedule entry saying when it last ran,
--                         which is what lets the scheduler be a request rather
--                         than a process. See internal/queue/cron.go.
--
-- WHY RIVER'S SCHEMA IS HERE AND NOT APPLIED BY RIVER'S OWN TOOL
--
-- River ships a migrator (rivermigrate) with seven numbered steps on its
-- "main" line. Running it beside goose would mean two migration systems, two
-- version tables and two places a deploy can half-finish; running it from
-- cmd/migrate would mean goose's `status` lying about what the schema holds.
-- So this file is the seven steps collapsed into their final state, as River
-- v0.47.0 would leave them, written once as ordinary goose SQL. The
-- river_migration rows are inserted so River's tooling (`river migrate-get`,
-- `river validate`) reads the schema as being at version 7 rather than
-- unmanaged; River's client itself does not check them.
--
-- When River publishes an eighth step, it becomes the next goose migration
-- here, copied from riverdriver/riverpgxv5/migration/main/008_*.up.sql with
-- the /* TEMPLATE: schema */ markers removed, and its row added to
-- river_migration. That is the whole procedure; it is documented in README.
--
-- GRANTS
--
-- 00042 set default privileges so app_user can use tables created after it,
-- whichever role creates them. Sequences are not covered by that default, and
-- River's two bigserial tables need theirs, so the sequences are granted
-- explicitly. Functions and types are executable and usable by PUBLIC by
-- default, which River's one function and one enum rely on.
--
-- No RLS on any of this. A job's tenant is inside its payload and the worker
-- re-establishes it before touching a tenant's rows; river_job itself is
-- infrastructure, read by nobody but the queue and the ops screens, which are
-- platform-scoped already. FORCE ROW LEVEL SECURITY applies only to tables
-- with a policy, so these are unaffected by it.

-- +goose Up

-- ============================================================ 1. River

CREATE TYPE river_job_state AS ENUM (
    'available',
    'cancelled',
    'completed',
    'discarded',
    'pending',
    'retryable',
    'running',
    'scheduled'
);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION river_job_state_in_bitmask(bitmask BIT(8), state river_job_state)
RETURNS boolean
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE state
        WHEN 'available' THEN get_bit(bitmask, 7)
        WHEN 'cancelled' THEN get_bit(bitmask, 6)
        WHEN 'completed' THEN get_bit(bitmask, 5)
        WHEN 'discarded' THEN get_bit(bitmask, 4)
        WHEN 'pending'   THEN get_bit(bitmask, 3)
        WHEN 'retryable' THEN get_bit(bitmask, 2)
        WHEN 'running'   THEN get_bit(bitmask, 1)
        WHEN 'scheduled' THEN get_bit(bitmask, 0)
        ELSE 0
    END = 1;
$$;
-- +goose StatementEnd

CREATE TABLE river_job (
    id            bigserial PRIMARY KEY,
    -- state near the top for operator convenience: SELECT * shows it first.
    state         river_job_state NOT NULL DEFAULT 'available',
    attempt       smallint NOT NULL DEFAULT 0,
    max_attempts  smallint NOT NULL DEFAULT 25,
    attempted_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    finalized_at  timestamptz,
    scheduled_at  timestamptz NOT NULL DEFAULT now(),
    priority      smallint NOT NULL DEFAULT 1,
    args          jsonb NOT NULL,
    attempted_by  text[],
    errors        jsonb[],
    kind          text NOT NULL,
    metadata      jsonb NOT NULL DEFAULT '{}',
    queue         text NOT NULL DEFAULT 'default',
    tags          varchar(255)[] NOT NULL DEFAULT '{}',
    unique_key    bytea,
    unique_states BIT(8),

    CONSTRAINT finalized_or_finalized_at_null CHECK (
        (finalized_at IS NULL AND state NOT IN ('cancelled', 'completed', 'discarded')) OR
        (finalized_at IS NOT NULL AND state IN ('cancelled', 'completed', 'discarded'))
    ),
    CONSTRAINT max_attempts_is_positive CHECK (max_attempts > 0),
    CONSTRAINT priority_in_range CHECK (priority >= 1 AND priority <= 4),
    CONSTRAINT queue_length CHECK (char_length(queue) > 0 AND char_length(queue) < 128),
    CONSTRAINT kind_length CHECK (char_length(kind) > 0 AND char_length(kind) < 128)
);

CREATE INDEX river_job_kind ON river_job USING btree (kind);
CREATE INDEX river_job_state_and_finalized_at_index ON river_job USING btree (state, finalized_at) WHERE finalized_at IS NOT NULL;
CREATE INDEX river_job_prioritized_fetching_index ON river_job USING btree (state, queue, priority, scheduled_at, id);
CREATE INDEX river_job_args_index ON river_job USING GIN (args);
CREATE INDEX river_job_metadata_index ON river_job USING GIN (metadata);
CREATE UNIQUE INDEX river_job_unique_idx ON river_job (unique_key)
    WHERE unique_key IS NOT NULL
      AND unique_states IS NOT NULL
      AND river_job_state_in_bitmask(unique_states, state);

-- Leader election for River's maintenance services (the cleaner that
-- enforces retention, the rescuer, the scheduler that releases scheduled
-- jobs). UNLOGGED: it is a lease, and a lease that does not survive a crash
-- is exactly right.
CREATE UNLOGGED TABLE river_leader (
    elected_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    leader_id  text NOT NULL,
    name       text PRIMARY KEY DEFAULT 'default',
    CONSTRAINT name_length CHECK (name = 'default'),
    CONSTRAINT leader_id_length CHECK (char_length(leader_id) > 0 AND char_length(leader_id) < 128)
);

-- Per-queue state; today only whether a queue is paused, which the ops
-- screens read.
CREATE TABLE river_queue (
    name       text PRIMARY KEY NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    paused_at  timestamptz,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- River's notification outbox, for drivers without LISTEN/NOTIFY. Postgres
-- has it, so this stays empty, but the client expects the table.
CREATE TABLE river_notification (
    id         bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    payload    text NOT NULL,
    topic      text NOT NULL,
    CONSTRAINT topic_length CHECK (length(topic) > 0 AND length(topic) < 128)
);
CREATE INDEX river_notification_created_at_idx ON river_notification (created_at);
CREATE INDEX river_notification_topic_id_idx ON river_notification (topic, id);

-- River's own version table, at the version this file reproduces.
CREATE TABLE river_migration (
    line       text NOT NULL,
    version    bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT line_length CHECK (char_length(line) > 0 AND char_length(line) < 128),
    CONSTRAINT version_gte_1 CHECK (version >= 1),
    PRIMARY KEY (line, version)
);
INSERT INTO river_migration (line, version)
SELECT 'main', v FROM generate_series(1, 7) AS v;

-- ============================================================ 2. cron_runs

-- One row per schedule entry: its name, and when a tick last considered it.
-- Per-institution entries are keyed "<name>:<institution uuid>", so a school
-- added tomorrow starts its own rows tomorrow. The tick reads the table,
-- decides what has come due, enqueues it and writes back -- all in one
-- transaction, under an advisory lock, so two callers take turns.
CREATE TABLE cron_runs (
    name        text PRIMARY KEY,
    last_run_at timestamptz NOT NULL,
    CONSTRAINT cron_runs_name_length CHECK (char_length(name) > 0 AND char_length(name) < 200)
);

-- ============================================================ 3. grants

GRANT SELECT, INSERT, UPDATE, DELETE ON
    river_job, river_leader, river_queue, river_notification, river_migration, cron_runs
    TO app_user;
GRANT USAGE, SELECT ON SEQUENCE river_job_id_seq, river_notification_id_seq TO app_user;

-- +goose Down

-- Undoing this drops every queued job. That is the correct meaning of rolling
-- back the queue's schema, and it is stated here so nobody does it thinking
-- the jobs went somewhere.
DROP TABLE IF EXISTS cron_runs;
DROP TABLE IF EXISTS river_migration;
DROP TABLE IF EXISTS river_notification;
DROP TABLE IF EXISTS river_queue;
DROP TABLE IF EXISTS river_leader;
DROP TABLE IF EXISTS river_job;
DROP FUNCTION IF EXISTS river_job_state_in_bitmask(BIT(8), river_job_state);
DROP TYPE IF EXISTS river_job_state;
