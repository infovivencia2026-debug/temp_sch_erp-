-- +goose Up
-- +goose StatementBegin

/* One notice, every school.

   A vendor taking the installation down for twenty minutes on Sunday has no
   way to say so. The choices today are writing to each school's principal by
   hand — ten now, and unworkable at fifty — or saying nothing and letting the
   schools find out by failing to sign in. Neither is a way to run a service
   that other people's Monday mornings depend on.

   Deliberately not a circular. A circular belongs to one school, is composed
   by that school's own staff, and reaches parents; this is the vendor talking
   to every school at once about the software itself, and the two must not be
   able to be mistaken for each other in anybody's list.

   Rows rather than a config value, because a notice has a life: raised at one
   time, shown between two others, taken down by somebody who is named. A
   school that signs in on Sunday needs to know why the site is slow; the same
   school on Tuesday must not still be told. */
CREATE TABLE IF NOT EXISTS platform_broadcasts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    severity    text NOT NULL DEFAULT 'info',
    title       text NOT NULL,
    body        text NOT NULL DEFAULT '',
    -- NULL means "from now". Both bounds so a notice can be written on Friday
    -- for Sunday and nobody has to remember to publish it.
    starts_at   timestamptz NOT NULL DEFAULT now(),
    ends_at     timestamptz,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    retired_at  timestamptz,
    CONSTRAINT platform_broadcasts_severity_check
        CHECK (severity = ANY (ARRAY['info','warning','critical'])),
    -- A window that ends before it starts shows to nobody, silently, which is
    -- the worst outcome for a maintenance notice.
    CONSTRAINT platform_broadcasts_window_check
        CHECK (ends_at IS NULL OR ends_at > starts_at)
);

/* No institution_id, so no tenant policy: this table belongs to the platform
   and every school reads the same rows. Row level security is left off
   deliberately rather than by omission — there is no tenant column to filter
   on, and forcing it would make the notice invisible to the schools it is
   written for. Writing is gated at the endpoint, on the vendor's own
   permission. */

CREATE INDEX IF NOT EXISTS platform_broadcasts_live_idx
    ON platform_broadcasts (starts_at DESC)
 WHERE retired_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS platform_broadcasts;
-- +goose StatementEnd
