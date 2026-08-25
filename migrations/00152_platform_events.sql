-- +goose Up
-- +goose StatementBegin

/* What the platform did, and what went wrong doing it.

   Instance Health says plainly that error rates are not measured — the lines
   go to slog and nowhere a screen can read them. That honesty is right and it
   leaves a vendor with no way to answer the question they are actually asked:
   "we tried to sign up on Tuesday and something failed, what happened?"

   Deliberately narrow. Not a log of every request — that is a metrics store,
   it is a different piece of infrastructure, and pretending a table is one is
   how a database becomes a landfill. This records the handful of platform
   operations a vendor has to be able to account for afterwards: provisioning
   a school, and the failures of same. One row per attempt, kept.

   Failures are the point. A successful provision announces itself — the
   school is in the directory. A failed one leaves nothing at all, which is
   why the same school gets provisioned three times by three people who each
   thought it had not worked. */
CREATE TABLE IF NOT EXISTS platform_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL,
    ok          boolean NOT NULL,
    -- The school this was about, when there is one. A provision that failed
    -- before the row existed has no id to point at, only the name attempted.
    institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL,
    subject     text NOT NULL DEFAULT '',
    detail      text NOT NULL DEFAULT '',
    actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    at          timestamptz NOT NULL DEFAULT now()
);

/* No institution_id policy: this table belongs to the platform, and half its
   rows are about a school that does not exist because creating it is what
   failed. Reading is gated at the endpoint, on the vendor's own permission. */

CREATE INDEX IF NOT EXISTS platform_events_recent_idx ON platform_events (at DESC);
CREATE INDEX IF NOT EXISTS platform_events_failures_idx ON platform_events (at DESC) WHERE NOT ok;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS platform_events;
-- +goose StatementEnd
