-- +goose Up
-- +goose StatementBegin

/* A lead you can actually work, not an inbox you can only read.

   purchase_enquiries has existed since 00013 with a five-stage status —
   new, contacted, demo_booked, won, lost — and a CHECK constraint enforcing
   it. The public buy form inserts rows (internal/api/buy.go:215) and
   GET /seller/enquiries lists them. Nothing in the entire repo ever runs
   UPDATE purchase_enquiries, and no screen in web/src requests that endpoint.

   So every lead this product has ever received is still 'new'. The stages
   were designed, constrained and never reachable; the sales pipeline is a
   list nobody can open and nobody can advance.

   This adds the four columns a person working leads needs, and the one table
   the work itself lives in. It does not touch the stages: five is the right
   number and they are already correct.
*/

-- WHO IS CHASING IT. A lead owned by everybody is chased by nobody, and the
-- first question in any pipeline review is whose name is against the row.
ALTER TABLE purchase_enquiries ADD COLUMN IF NOT EXISTS owner_user_id uuid
    REFERENCES users(id) ON DELETE SET NULL;

-- WHEN NEXT. The single most useful column in a CRM: it turns a list of
-- leads into a list of today's work. Deliberately a date, not a timestamp —
-- nobody schedules a school call to the minute.
ALTER TABLE purchase_enquiries ADD COLUMN IF NOT EXISTS next_follow_up date;

-- WHY IT WAS LOST, in the words of whoever lost it. Free text rather than a
-- coded set, because the reasons a Telangana school does not buy are not
-- knowable in advance and a taxonomy invented now would be wrong. It can be
-- grouped later, once there are enough of them to see the shape.
ALTER TABLE purchase_enquiries ADD COLUMN IF NOT EXISTS lost_reason text;

-- WHAT IT IS WORTH. Filled from the plan and the student count when a lead is
-- qualified, so the pipeline can be read in rupees rather than in row counts —
-- ten leads worth nothing and one worth a district are not the same pipeline.
-- Integer paise, like every other money column in this schema.
ALTER TABLE purchase_enquiries ADD COLUMN IF NOT EXISTS value_paise bigint
    CHECK (value_paise IS NULL OR value_paise >= 0);

-- The two questions a pipeline screen asks constantly.
CREATE INDEX IF NOT EXISTS purchase_enquiries_stage
    ON purchase_enquiries (status, next_follow_up NULLS LAST);
CREATE INDEX IF NOT EXISTS purchase_enquiries_owner
    ON purchase_enquiries (owner_user_id) WHERE owner_user_id IS NOT NULL;

/* THE WORK ITSELF.

   A CRM is not the status column, it is the record of what was said and when.
   Without it the pipeline answers "where is this lead" and never "what
   happened last time we rang them", which is the thing the next call needs.

   Stage changes are written here too, by the handler, so one query returns
   the whole history of a lead in order rather than the notes and the status
   changes being two lists somebody has to interleave by eye. */
CREATE TABLE IF NOT EXISTS purchase_enquiry_notes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enquiry_id   uuid NOT NULL REFERENCES purchase_enquiries(id) ON DELETE CASCADE,
    -- 'note' is somebody typing; 'stage' is the handler recording a move;
    -- 'call', 'email', 'meeting' are what was actually done.
    kind         text NOT NULL DEFAULT 'note'
                 CHECK (kind IN ('note','stage','call','email','meeting')),
    body         text NOT NULL,
    author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_enquiry_notes_enquiry
    ON purchase_enquiry_notes (enquiry_id, created_at DESC);

/* NO ROW LEVEL SECURITY ON EITHER TABLE, and that is deliberate rather than
   forgotten.

   Every RLS policy in this schema keys off institution_id, because every other
   table belongs to a school. A sales lead belongs to the vendor and has no
   institution until it converts — purchase_enquiries has carried no
   institution_id since 00013 for exactly that reason, and the handlers reach
   it through database.AsPlatform. Adding a policy here would need a column
   that cannot be filled. The boundary is the permission on the router
   (platform.tenants.write, held by no school role) and it is stated here so
   the next person auditing RLS coverage does not read the absence as an
   oversight. */

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS purchase_enquiry_notes;
DROP INDEX IF EXISTS purchase_enquiries_owner;
DROP INDEX IF EXISTS purchase_enquiries_stage;
ALTER TABLE purchase_enquiries DROP COLUMN IF EXISTS value_paise;
ALTER TABLE purchase_enquiries DROP COLUMN IF EXISTS lost_reason;
ALTER TABLE purchase_enquiries DROP COLUMN IF EXISTS next_follow_up;
ALTER TABLE purchase_enquiries DROP COLUMN IF EXISTS owner_user_id;
-- +goose StatementEnd
