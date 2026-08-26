-- +goose Up

/* Document verification, which had a table and no verdict.
 *
 * application_documents has existed since the first migration — application,
 * doc type, file, is_required, verified_by, verified_at — and no Go code has
 * ever read or written it. The clerk checking a birth certificate against the
 * form had nowhere to say so.
 *
 * verified_at alone cannot carry the answer. A document has four states a
 * school actually distinguishes: not brought in yet, brought in and waiting to
 * be checked, checked and accepted, checked and refused. A timestamp collapses
 * the last three into "not verified", so the office cannot tell a parent who
 * has produced nothing from one whose transfer certificate is illegible.
 */
ALTER TABLE application_documents
    ADD COLUMN IF NOT EXISTS status     text NOT NULL DEFAULT 'pending',
    -- Why it was refused. The whole value of a rejection is the sentence that
    -- tells the parent what to bring back.
    ADD COLUMN IF NOT EXISTS note       text,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'application_documents_status') THEN
        ALTER TABLE application_documents
            ADD CONSTRAINT application_documents_status
                CHECK (status IN ('pending','received','verified','rejected')) NOT VALID;
        ALTER TABLE application_documents
            VALIDATE CONSTRAINT application_documents_status;
    END IF;

    /* Verified means somebody verified it. The two columns were already there
       and nothing enforced that they agreed, so a row could claim a verdict
       with no verifier and no date. */
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'application_documents_verdict_evidenced') THEN
        ALTER TABLE application_documents
            ADD CONSTRAINT application_documents_verdict_evidenced
                CHECK (status <> 'verified' OR verified_at IS NOT NULL) NOT VALID;
        ALTER TABLE application_documents
            VALIDATE CONSTRAINT application_documents_verdict_evidenced;
    END IF;

    /* A rejection without a reason is the thing that sends a parent back to
       the counter to ask what was wrong with it. */
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'application_documents_rejection_reasoned') THEN
        ALTER TABLE application_documents
            ADD CONSTRAINT application_documents_rejection_reasoned
                CHECK (status <> 'rejected' OR btrim(coalesce(note,'')) <> '') NOT VALID;
        ALTER TABLE application_documents
            VALIDATE CONSTRAINT application_documents_rejection_reasoned;
    END IF;
END $$;
-- +goose StatementEnd

/* One row per document type per application. Without this two clerks working
 * the same queue produce two "Birth certificate" rows against one child, and
 * the checklist stops being a checklist. */
CREATE UNIQUE INDEX IF NOT EXISTS application_documents_one_per_type
    ON application_documents (application_id, lower(doc_type));

/* The queue the screen opens on: what is outstanding, oldest first. */
CREATE INDEX IF NOT EXISTS application_documents_outstanding
    ON application_documents (institution_id, application_id)
 WHERE status IN ('pending', 'received');

-- +goose Down
DROP INDEX IF EXISTS application_documents_outstanding;
DROP INDEX IF EXISTS application_documents_one_per_type;
ALTER TABLE application_documents
    DROP CONSTRAINT IF EXISTS application_documents_rejection_reasoned,
    DROP CONSTRAINT IF EXISTS application_documents_verdict_evidenced,
    DROP CONSTRAINT IF EXISTS application_documents_status;
ALTER TABLE application_documents
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS note,
    DROP COLUMN IF EXISTS status;
