-- +goose Up
-- The lists a school is allowed to disagree with.
--
-- Every dropdown in setup was a Go slice: seven affiliation boards, five
-- school categories, four management types, five media of instruction. They
-- are good defaults for a Telangana school and wrong for some school
-- somewhere, and `oneOf` rejected anything not on the list -- so a school
-- affiliated to a board nobody had thought of could not record the fact at
-- all. The product's answer to "we are not on your list" was "then you cannot
-- say what you are".
--
-- This is the escape hatch. The built-in lists stay, because a school that
-- starts from an empty dropdown has been handed work rather than a product;
-- a school adds to them when the defaults do not fit.
--
-- Numbered at 80 deliberately, well clear of the 41-54 range being consumed on
-- the parallel branch. Two collisions have already cost a deploy each: goose
-- keys on the numeric prefix alone, so two files sharing one refuse to load,
-- and the loser is silently skipped where its number was already recorded.

CREATE TABLE custom_options (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Which dropdown this belongs to. Not a foreign key to anything: the
    -- vocabulary of kinds lives in Go beside the built-in lists it extends,
    -- and a check constraint here would mean a migration every time a screen
    -- gains a customisable field.
    kind            text        NOT NULL,

    -- What gets stored on the record, and what a human reads. Kept separate
    -- because value ends up in exports and returns where a renamed label must
    -- not silently change the data underneath it.
    value           text        NOT NULL,
    label           text        NOT NULL,

    sequence        integer     NOT NULL DEFAULT 0,
    -- Retired rather than deleted once anything references it. A school that
    -- stops using a board still has students admitted under it, and their
    -- records must keep rendering a label rather than a bare code.
    active          boolean     NOT NULL DEFAULT true,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT custom_options_kind_not_blank  CHECK (btrim(kind) <> ''),
    CONSTRAINT custom_options_value_not_blank CHECK (btrim(value) <> ''),
    CONSTRAINT custom_options_label_not_blank CHECK (btrim(label) <> '')
);

-- One value per kind per school. Case-insensitive, because "CBSE" and "cbse"
-- entered by two clerks a week apart are one board, and a dropdown offering
-- both is how a school's own data stops being groupable.
CREATE UNIQUE INDEX custom_options_unique
    ON custom_options (institution_id, kind, lower(value));

CREATE INDEX custom_options_by_kind
    ON custom_options (institution_id, kind, sequence)
    WHERE active;

ALTER TABLE custom_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_options FORCE  ROW LEVEL SECURITY;

CREATE POLICY custom_options_tenant ON custom_options
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE TRIGGER custom_options_touch
    BEFORE UPDATE ON custom_options
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- +goose Down
DROP TABLE IF EXISTS custom_options;
