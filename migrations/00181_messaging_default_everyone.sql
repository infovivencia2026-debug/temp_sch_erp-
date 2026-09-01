-- +goose Up

-- Messages were being held back by default, and silently.
--
-- messaging_recipient_policy.mode defaulted to 'allowlist', and so did the
-- code path taken when a school had no policy row at all. The reasoning was
-- sound in the abstract: a half-configured school should not mail six hundred
-- parents by accident.
--
-- In practice it was the wrong default, because the failure it produces is
-- indistinguishable from a broken mail server. Every message logs as
-- suppressed, nobody is told, and the school spends days diagnosing SMTP that
-- was working perfectly the whole time. On this deployment: 190 suppressed
-- against 93 sent, an enquiry acknowledgement that reached nobody, and a
-- correctly configured Gmail relay blamed for all of it.
--
-- A school that wants a pilot still sets mode = 'allowlist' and gets exactly
-- the old behaviour, with the allowlist rows it already has. The difference is
-- that holding messages back becomes something a school chooses rather than
-- something it has to discover it was doing.
--
-- Existing rows are moved too, deliberately. Leaving them would mean the two
-- schools already on this deployment keep the behaviour this migration exists
-- to remove, and the allowlist entries are kept rather than deleted so
-- switching back is one UPDATE and loses nothing.

ALTER TABLE messaging_recipient_policy ALTER COLUMN mode SET DEFAULT 'everyone';

UPDATE messaging_recipient_policy
   SET mode = 'everyone',
       note = COALESCE(NULLIF(btrim(note), '') || ' | ', '')
              || 'Allowlist lifted by migration 181; entries kept.',
       updated_at = now()
 WHERE mode = 'allowlist';

-- +goose Down

ALTER TABLE messaging_recipient_policy ALTER COLUMN mode SET DEFAULT 'allowlist';
