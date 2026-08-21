-- +goose Up
-- The check that made WhatsApp impossible.
--
-- 00101 constrained wa_template_name with '^[a-z0-9_]{1,512}$', copying Meta's
-- documented limit of 512 characters. Postgres's regex engine caps a bounded
-- repetition at 255, and rejects anything larger — not when the constraint is
-- written, but every time a row is checked against it:
--
--     ERROR: invalid regular expression: invalid repetition count(s)
--
-- So every insert into message_templates failed, in every school, from the day
-- that migration ran. Nobody noticed because the failure surfaced as a 500 on
-- a settings screen that is visited once, and the consequence appeared
-- somewhere else entirely: WhatsApp refusing each message with "no approved
-- template is mapped", which reads like configuration nobody had done rather
-- than configuration nobody could do.
--
-- The shape and the length are now two checks. A pattern says which characters
-- are allowed and length() says how many, which is what was meant and what the
-- regex could not express.

ALTER TABLE message_templates
    DROP CONSTRAINT IF EXISTS message_templates_wa_name_shape;

ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_wa_name_shape
    CHECK (
        wa_template_name IS NULL
        OR (wa_template_name ~ '^[a-z0-9_]+$' AND length(wa_template_name) <= 512)
    );

-- The language check is the same idea and is within the cap, so it stands:
-- '^[a-z]{2,3}(_[A-Z]{2})?$' is legal and means what it says.

-- +goose Down
ALTER TABLE message_templates
    DROP CONSTRAINT IF EXISTS message_templates_wa_name_shape;

-- Restoring the broken form deliberately: a down migration that leaves a
-- different constraint behind is not a down migration. Anything saved while it
-- was fixed stays, because the check is not revalidated on existing rows.
ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_wa_name_shape
    CHECK ((wa_template_name IS NULL) OR (wa_template_name ~ '^[a-z0-9_]{1,512}$'))
    NOT VALID;
