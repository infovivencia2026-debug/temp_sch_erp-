-- +goose Up

--  A refused concession left no trace at all.
--
-- The workflow was there: an accountant grants a waiver, it sits unapproved,
-- a principal decides. Approving stamped approved_by and approved_at.
-- Rejecting ran DELETE.
--
-- So the record of a family that asked for help and was told no did not
-- exist. Three things follow, and a school meets all three:
--
--   the same request comes back next term and nobody can see it was already
--   refused, or why, so it is decided again from nothing;
--
--   a parent who says "we applied and heard nothing" cannot be answered,
--   because there is nothing to look at;
--
--   and a school cannot show an auditor how concessions were decided, which
--   is the one question asked about them — a table containing only the
--   approvals looks like a school that approves everything.
--
-- WHY status AND NOT approved_at ALONE
--
-- approved_at NULL meant "waiting". With refusals kept it would also mean
-- "refused", and the pending queue would fill with decided rows for ever.
-- Three states need three values.
--

ALTER TABLE fee_concessions
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
    -- Why. On a refusal this is what the family is told, and on an approval
    -- it is what the auditor reads.
    ADD COLUMN IF NOT EXISTS decision_note text,
    ADD COLUMN IF NOT EXISTS decided_at timestamptz,
    -- Who asked, as against who decided. approved_by has always held the
    -- decider; the person who raised it was nowhere.
    ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users(id) ON DELETE SET NULL;

--  Existing rows carry their answer forward: anything already approved is
-- approved, and everything else was waiting when this ran. Nothing existing
-- can be 'rejected', because those rows were deleted.
UPDATE fee_concessions
   SET status = CASE WHEN approved_at IS NOT NULL THEN 'approved' ELSE 'pending' END
 WHERE status = 'pending';

ALTER TABLE fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_status_check;
ALTER TABLE fee_concessions
    ADD CONSTRAINT fee_concessions_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'));

--  The fee engine must not start charging differently because refusals are
-- now kept. Everything that reads a concession reads approved_at, which stays
-- NULL on a refusal, so the engine's behaviour is unchanged by this
-- migration — deliberately, and it is worth saying out loud.
CREATE INDEX IF NOT EXISTS fee_concessions_pending
    ON fee_concessions (institution_id) WHERE status = 'pending';

COMMENT ON COLUMN fee_concessions.status IS
    'pending, approved, rejected or withdrawn. A refusal is KEPT: the record '
    'of a family that asked and was told no is the record an auditor asks for.';

-- +goose Down
ALTER TABLE fee_concessions DROP CONSTRAINT IF EXISTS fee_concessions_status_check;
ALTER TABLE fee_concessions
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS decision_note,
    DROP COLUMN IF EXISTS decided_at,
    DROP COLUMN IF EXISTS requested_by;
