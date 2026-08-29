-- +goose Up

/* A report card goes to the principal before it goes to a family.
 *
 * Generating one published it in the same call: the class teacher pressed a
 * button and every parent in the section could read it. That is not how any
 * school in the country works — a head signs the results off before they leave
 * the building, because a wrong mark reaching a family cannot be recalled, and
 * because the principal's remark is written after reading them.
 *
 * Four states, and the fourth is the only one a family sees:
 *
 *   draft      generated, the class teacher is still working
 *   submitted  sent up, waiting on the principal
 *   returned   sent back with a reason; the class teacher fixes and resubmits
 *   published  approved and released to the child and their guardians
 *
 * There is no separate "approved but not released" state. A head who approves
 * a set has decided the family may see it, and holding an approved card back
 * would be a fifth state whose only content is "somebody has not pressed the
 * other button yet" — which is what the queue already shows.
 */
ALTER TABLE report_cards
    ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS decided_at   timestamptz,
    ADD COLUMN IF NOT EXISTS decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Why it went back. A card returned with no reason is one the class
    -- teacher has to come and ask about, which is the errand the workflow
    -- exists to save.
    ADD COLUMN IF NOT EXISTS return_note  text;

/* Everything already published stays published.
 *
 * A school mid-term with results already out must not have them withdrawn by a
 * deploy: the parents have read them. */
UPDATE report_cards SET status = 'published' WHERE is_published AND status = 'draft';

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_cards_status') THEN
        ALTER TABLE report_cards
            ADD CONSTRAINT report_cards_status
                CHECK (status IN ('draft','submitted','returned','published')) NOT VALID;
        ALTER TABLE report_cards VALIDATE CONSTRAINT report_cards_status;
    END IF;

    /* is_published and status cannot disagree.
     *
     * Two columns describing the same fact drift the first time one code path
     * updates one of them, and the half that drifts is the half a family reads.
     * The constraint makes them one fact with two spellings. */
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'report_cards_published_matches_status') THEN
        ALTER TABLE report_cards
            ADD CONSTRAINT report_cards_published_matches_status
                CHECK (is_published = (status = 'published')) NOT VALID;
        ALTER TABLE report_cards VALIDATE CONSTRAINT report_cards_published_matches_status;
    END IF;

    /* Sent back means somebody said why. */
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'report_cards_return_reasoned') THEN
        ALTER TABLE report_cards
            ADD CONSTRAINT report_cards_return_reasoned
                CHECK (status <> 'returned' OR btrim(coalesce(return_note,'')) <> '') NOT VALID;
        ALTER TABLE report_cards VALIDATE CONSTRAINT report_cards_return_reasoned;
    END IF;
END $$;
-- +goose StatementEnd

/* The principal's queue: what is waiting, oldest first. Partial, because the
 * published rows accumulate for ever and are never what this asks for. */
CREATE INDEX IF NOT EXISTS report_cards_awaiting_approval
    ON report_cards (institution_id, submitted_at)
 WHERE status = 'submitted';

-- +goose Down
DROP INDEX IF EXISTS report_cards_awaiting_approval;
ALTER TABLE report_cards
    DROP CONSTRAINT IF EXISTS report_cards_return_reasoned,
    DROP CONSTRAINT IF EXISTS report_cards_published_matches_status,
    DROP CONSTRAINT IF EXISTS report_cards_status;
ALTER TABLE report_cards
    DROP COLUMN IF EXISTS return_note,
    DROP COLUMN IF EXISTS decided_by,
    DROP COLUMN IF EXISTS decided_at,
    DROP COLUMN IF EXISTS submitted_by,
    DROP COLUMN IF EXISTS submitted_at,
    DROP COLUMN IF EXISTS status;
