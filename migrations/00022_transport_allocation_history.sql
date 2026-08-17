-- +goose Up
-- Let a child change bus stop mid-year.
--
-- transport_allocations carries valid_from and valid_to, which say plainly
-- that an allocation is a period rather than a fact. It also carried a unique
-- constraint on (student_id, academic_year_id), which says a child may have
-- exactly one for the whole year. Both cannot be true, and the constraint won:
-- a family that moved house in October could not be re-allocated at all.
--
-- The dated columns are the intent worth keeping. A closed allocation has to
-- survive because the transport fee already raised against the old stop must
-- stay explicable when somebody asks in March.

ALTER TABLE transport_allocations
    DROP CONSTRAINT IF EXISTS transport_allocations_student_id_academic_year_id_key;

-- One *current* allocation per child. Two open allocations would mean two
-- buses expecting the same child, which is the failure the original
-- constraint was reaching for.
CREATE UNIQUE INDEX transport_allocations_one_current
    ON transport_allocations (student_id)
 WHERE valid_to IS NULL;

CREATE INDEX transport_allocations_route
    ON transport_allocations (route_id, valid_to);

-- +goose Down
DROP INDEX IF EXISTS transport_allocations_route;
DROP INDEX IF EXISTS transport_allocations_one_current;
ALTER TABLE transport_allocations
    ADD CONSTRAINT transport_allocations_student_id_academic_year_id_key
    UNIQUE (student_id, academic_year_id);
