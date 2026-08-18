-- +goose Up
-- Make the waiting-list rank actually unique.
--
-- The index added in 00026 keyed on (admission_session_id, class_sought,
-- waitlist_rank). Both of the first two are nullable, and in Postgres a NULL
-- is distinct from every other NULL — so as soon as an application had no
-- admission session, which is every application in a school that has not set
-- one up, two children could be ranked third and the index enforced nothing.
--
-- The same trap this codebase has hit before, and the same fix: coalesce the
-- nullable parts of the key to a sentinel so absence compares equal to
-- absence.

DROP INDEX IF EXISTS applications_waitlist_rank;

CREATE UNIQUE INDEX applications_waitlist_rank
    ON applications (
        COALESCE(admission_session_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(class_sought, '00000000-0000-0000-0000-000000000000'::uuid),
        waitlist_rank)
 WHERE waitlist_rank IS NOT NULL AND status = 'waitlisted';

-- +goose Down
DROP INDEX IF EXISTS applications_waitlist_rank;
CREATE UNIQUE INDEX applications_waitlist_rank
    ON applications (admission_session_id, class_sought, waitlist_rank)
 WHERE waitlist_rank IS NOT NULL AND status = 'waitlisted';
