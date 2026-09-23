-- +goose Up
-- PRIVACY, AS SCHOOL POLICY AND AS A PER-GUARDIAN FACT.
--
-- Two switches on the school (docs: /privacy, screen: Privacy under Staff):
--   alerts_primary_only       marks, fee and absence alerts go to the primary
--                             guardian on record rather than to every linked
--                             adult -- the 2026-09-23 audit found a relation
--                             'other' receiving a child's marks.
--   credentials_by_email_only a new login's password travels by email only;
--                             SMS and WhatsApp carry the "your login is ready"
--                             notice without it, because a password sent to a
--                             number nobody verified is sent to whoever holds
--                             that number now.
-- Both default to the safer setting; a school that wants the old behaviour
-- switches it on knowingly.
ALTER TABLE institutions
    ADD COLUMN IF NOT EXISTS alerts_primary_only       boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS credentials_by_email_only boolean NOT NULL DEFAULT true;

-- A guardian link that can end. student_guardians had no way to say "may not
-- see this child" (custody) and no end date, so a withdrawn child's guardian
-- kept portal access for good. Scope resolution (internal/scope) and every
-- alert audience honour both.
ALTER TABLE student_guardians
    ADD COLUMN IF NOT EXISTS portal_blocked boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS access_until   date;

-- +goose Down
ALTER TABLE student_guardians DROP COLUMN IF EXISTS access_until, DROP COLUMN IF EXISTS portal_blocked;
ALTER TABLE institutions DROP COLUMN IF EXISTS credentials_by_email_only, DROP COLUMN IF EXISTS alerts_primary_only;
