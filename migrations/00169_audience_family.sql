-- +goose Up

/* A rule may address the whole household.
 *
 * The audience vocabulary was guardians, student, staff, or role:<key>. A fee
 * reminder wants both halves of a family: in a boarding school, and anywhere
 * the child carries the money to the office, the child is the one who has to
 * act on it — and a guardian-only reminder reaches the parent with the app and
 * nobody else.
 *
 * 'family' resolves in internal/api/messaging.go by composing the two
 * audiences that already exist rather than by a third query, so what it means
 * cannot drift from what 'guardians' and 'student' mean.
 *
 * WHY A MIGRATION AND NOT A LOOSER CHECK
 *
 * The constraint is a closed list on purpose: an audience nothing implements
 * is a rule that silently sends to nobody, and the failure looks like a
 * gateway problem rather than a typo. Adding the one value the code now
 * understands keeps that property.
 */
ALTER TABLE message_trigger_rules
    DROP CONSTRAINT IF EXISTS message_trigger_rules_audience;

ALTER TABLE message_trigger_rules
    ADD CONSTRAINT message_trigger_rules_audience
        CHECK (audience ~ '^(guardians|student|family|staff|role:[a-z_]+)$');

-- +goose Down
ALTER TABLE message_trigger_rules
    DROP CONSTRAINT IF EXISTS message_trigger_rules_audience;

/* Anything already addressed to the household falls back to the guardians,
 * which is what it was before and is still a real audience — rather than
 * leaving rows the restored constraint would refuse. */
UPDATE message_trigger_rules SET audience = 'guardians' WHERE audience = 'family';

ALTER TABLE message_trigger_rules
    ADD CONSTRAINT message_trigger_rules_audience
        CHECK (audience ~ '^(guardians|student|staff|role:[a-z_]+)$');
