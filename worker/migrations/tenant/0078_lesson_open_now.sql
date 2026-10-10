-- A lesson can be unlocked now (owner, 2026-10-10: "unlock this now, or wait
-- till the other videos are completed"). 1 = open to the class straight away,
-- whatever is before it and whether or not its day has opened; 0 = the usual
-- one-by-one rule. Additive; every existing lesson keeps the usual rule.
-- Forward-only: once applied anywhere this file must not change.
ALTER TABLE lms_lessons ADD COLUMN open_now INTEGER NOT NULL DEFAULT 0;
