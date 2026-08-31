-- +goose Up

/* THE FAMILY IS LET IN AT THE ENQUIRY, NOT AT THE ADMISSION.
 *
 * A login was issued when a child was enrolled, which is weeks or months after
 * the parent first walked in. Everything between those two moments -- did the
 * application arrive, are the documents accepted, is there a test, was a seat
 * offered -- was answerable only by ringing the office, so the office spent the
 * admissions season answering the phone.
 *
 * The enquiry is the first moment a real person gives the school a real contact
 * and the earliest one at which a login can be issued at all. So it is issued
 * there, against the enquiry itself: there is no student yet, and there may
 * never be one.
 *
 * Two columns rather than a new table. The account is one fact about the
 * enquiry -- who was given a way in to watch it -- and a join table for a
 * relationship that is one-to-one would be a table that never has a second row.
 *
 * guardian_id is what carries the login forward. Enrolment reuses this guardian
 * rather than creating a second one, so the parent who has been signing in
 * since the enquiry keeps the same password on the day the child is admitted --
 * a family issued a second credential is a family with one that silently
 * stopped working.
 *
 * ON DELETE SET NULL, both: an enquiry outlives the account, and purging a user
 * must not take the enquiry -- the funnel's history is the school's record of
 * its own season, not the account's.
 */
ALTER TABLE enquiries
    ADD COLUMN IF NOT EXISTS user_id     uuid REFERENCES users(id)     ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS guardian_id uuid REFERENCES guardians(id) ON DELETE SET NULL;

/* The portal reads by user on every page load, and the funnel is the one table
 * that grows without bound across a season. Partial, because the overwhelming
 * majority of historical enquiries carry no account and indexing them is paying
 * for rows no query asks for. */
CREATE INDEX IF NOT EXISTS enquiries_user_idx
    ON enquiries (user_id) WHERE user_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS enquiries_user_idx;
ALTER TABLE enquiries
    DROP COLUMN IF EXISTS user_id,
    DROP COLUMN IF EXISTS guardian_id;
