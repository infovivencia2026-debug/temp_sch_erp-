-- +goose Up
-- Which pack may send on its own vendor account.
--
-- Two ways for a school's SMS and WhatsApp to leave the building, and they are
-- commercially opposite. On the lower packs the school sends through the
-- seller's account and buys credits to do it: the seller carries the vendor
-- relationship, the DLT registration and the bill, and the meter added in 212
-- is what makes that safe. On the top pack the school links its OWN vendor
-- account, pays that vendor directly, and the seller is not in the middle of
-- it at all.
--
-- A COLUMN RATHER THAN A MODULE. The obvious place to put this was
-- plans.modules, which already gates what a pack includes — and it would have
-- been wrong. Every value in that array is a catalogue section a school can
-- open; the array is read to build menus and to decide which screens exist.
-- A value that is not a section would appear as a module nobody can navigate
-- to, in the pricing page's own list, and every reader of that array would
-- have to learn the exception. This is a capability, not a module.
--
-- Default false, so a plan nobody has thought about does not quietly get the
-- expensive thing.

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS custom_integration boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN plans.custom_integration IS
    'The school may link its own SMS/WhatsApp vendor account instead of sending on the seller''s and buying credits.';

-- The top pack, by its sequence rather than by its code.
--
-- `complete` is what it is called today. Naming it here would silently do
-- nothing the day somebody renames the pack or adds a fourth above it, and a
-- migration that silently does nothing is the kind that is found a year later.
UPDATE plans
   SET custom_integration = true
 WHERE sequence = (SELECT max(sequence) FROM plans WHERE retired_at IS NULL);

-- +goose Down
ALTER TABLE plans DROP COLUMN IF EXISTS custom_integration;
