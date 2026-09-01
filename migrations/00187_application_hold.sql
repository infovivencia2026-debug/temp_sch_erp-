-- +goose Up

-- An application held while something is settled.
--
-- The pipeline had waitlisted, which is about SEATS: there is no place, the
-- applicant is ranked, and a place may come free. It carries waitlist_rank for
-- exactly that reason.
--
-- What it did not have is the other kind of waiting, which is the commoner
-- one. A seat is available and the child is not admitted yet because something
-- is unresolved: the fee has not been agreed, a concession is with the
-- principal, a document has not arrived, the family is deciding. Offices did
-- that by leaving the application in whatever state it was in and remembering,
-- or by marking it waitlisted, which then ranked a child against a queue they
-- were never in and made the seat count wrong.
--
-- So: on_hold, with a reason. It is a live state -- the application stays in
-- the working queue, because a hold nobody sees is a child nobody admits.
--
-- The reason is the point. "On hold" alone is the note somebody leaves for
-- themselves and cannot read back in November; the whole cost of a hold is
-- that the person who set it is not the person who finds it.

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;

ALTER TABLE applications
    ADD CONSTRAINT applications_status_check CHECK (status = ANY (ARRAY[
        'draft', 'submitted', 'under_review', 'documents_pending',
        'test_scheduled', 'interviewed', 'offered', 'accepted',
        'rejected', 'withdrawn', 'waitlisted', 'on_hold']));

ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS hold_reason text,
    ADD COLUMN IF NOT EXISTS held_at timestamptz,
    ADD COLUMN IF NOT EXISTS held_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN applications.hold_reason IS
    'Why this application is not proceeding. Distinct from waitlisted, which '
    'is about seats: a hold means the seat is there and something else is not '
    'settled: a fee, a concession decision, a missing document.';

-- +goose Down

-- The constraint goes back; the columns stay. Dropping them would lose the
-- reasons on every application currently held, and a Down that destroys
-- somebody's notes is worse than one that leaves three unused columns.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications
    ADD CONSTRAINT applications_status_check CHECK (status = ANY (ARRAY[
        'draft', 'submitted', 'under_review', 'documents_pending',
        'test_scheduled', 'interviewed', 'offered', 'accepted',
        'rejected', 'withdrawn', 'waitlisted']));
