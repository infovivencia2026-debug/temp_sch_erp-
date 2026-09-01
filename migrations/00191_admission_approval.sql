-- +goose Up

-- Every new joining is the principal's to approve, not the desk's.
--
-- The admissions desk could enrol a child alone: offer, accept, and the child
-- was on the roll with a seat, an invoice and a login. That is right for a
-- school where the desk is trusted with the whole decision, and wrong for the
-- ones that are not -- and this school has asked for the second.
--
-- The distinction that matters is between OFFERING a place and the child
-- actually joining. Offering stays with the desk: it is a conversation, it is
-- reversible, and it commits nothing. Joining takes a seat that another child
-- cannot have, raises a bill, and issues a family a login. That is the act a
-- head wants to see the details of before it happens.
--
-- WHY A COLUMN AND NOT A NEW TABLE
--
-- The queue is "applications awaiting approval", and applications already have
-- a status ladder, a decision, a decider and a decided_at. A separate approval
-- table would be a second place to look for the same fact, and the day the two
-- disagree the child is either enrolled twice or not at all.
--
-- Off by default. A school that has always let its desk admit is not
-- interrupted by an upgrade, and turns this on when it wants it.

ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS enrolment_approved_by uuid
        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS enrolment_approved_at timestamptz,
    -- What the principal wrote when they approved or sent it back. The reason
    -- a joining was refused is the thing the desk has to tell the family.
    ADD COLUMN IF NOT EXISTS enrolment_note text;

COMMENT ON COLUMN applications.enrolment_approved_at IS
    'When the principal approved this child actually joining, as distinct from '
    'the offer. Null means not yet approved; the setting admissions.approval '
    'in module_settings decides whether that blocks enrolment.';

-- The switch, per school, in the table that already holds this kind of
-- one-line answer for other modules.
-- +goose StatementBegin
DO $$
DECLARE inst uuid;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT id FROM institutions LOOP
        INSERT INTO module_settings (institution_id, module, enabled, config)
        VALUES (inst, 'admissions', true,
                jsonb_build_object('enrolment_needs_approval', 'false'))
        ON CONFLICT (institution_id, module)
        -- Merged, not replaced: admissions settings are not only ours, and a
        -- school that has already answered this question keeps its answer.
        DO UPDATE SET config = module_settings.config
                             || jsonb_build_object('enrolment_needs_approval',
                                  COALESCE(module_settings.config->>'enrolment_needs_approval',
                                           'false'));
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE applications
    DROP COLUMN IF EXISTS enrolment_approved_by,
    DROP COLUMN IF EXISTS enrolment_approved_at,
    DROP COLUMN IF EXISTS enrolment_note;
