-- +goose Up

-- The fee is agreed before the child joins, not after.
--
-- A concession could only be asked for against a STUDENT, and a student does
-- not exist until the application is accepted. So the order the product
-- imposed was: accept the child, bill them, then ask for the waiver that was
-- agreed at the desk a week earlier. By then the invoice exists at full price
-- and the only remedy is a credit note.
--
-- That is backwards from how a school actually admits. The family negotiates
-- the staff-ward or sibling rate as part of deciding whether to come at all.
-- Nobody accepts a place and then finds out what it costs.
--
-- So a concession may now hang off an APPLICATION instead, go through the same
-- approval, and be carried onto the student at acceptance. One table, one
-- workflow, one set of statuses: the alternative was a second concession model
-- on applications, which would have meant two places to approve from and two
-- to read when the numbers disagreed.
--
-- EXACTLY ONE OWNER. A row belongs to an applicant or to a student, never to
-- both and never to neither. Acceptance moves it: application_id stays for the
-- history, student_id is filled in, and every existing query -- the fee engine
-- included -- keeps matching on student_id exactly as it did.

ALTER TABLE fee_concessions
    ALTER COLUMN student_id DROP NOT NULL;

ALTER TABLE fee_concessions
    ADD COLUMN IF NOT EXISTS application_id uuid
        REFERENCES applications(id) ON DELETE CASCADE;

ALTER TABLE fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_has_owner;
ALTER TABLE fee_concessions
    ADD CONSTRAINT fee_concessions_has_owner
        CHECK (student_id IS NOT NULL OR application_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS fee_concessions_by_application
    ON fee_concessions (application_id) WHERE application_id IS NOT NULL;

COMMENT ON COLUMN fee_concessions.application_id IS
    'Set when the waiver was agreed before the child was admitted. Acceptance '
    'fills in student_id and leaves this for the history, so every query that '
    'matches on student_id keeps working unchanged.';

-- The academic year stops being required for the same reason: an applicant is
-- not enrolled in a year yet. Acceptance sets it along with the student.
ALTER TABLE fee_concessions
    ALTER COLUMN academic_year_id DROP NOT NULL;

-- +goose Down

-- The columns stay. Dropping application_id would lose the record of which
-- waivers were agreed before admission, and re-imposing NOT NULL would fail
-- against any row still waiting on an applicant.
ALTER TABLE fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_has_owner;
