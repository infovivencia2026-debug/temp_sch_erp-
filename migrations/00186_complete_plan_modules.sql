-- +goose Up

-- The most expensive plan granted the fewest modules.
--
-- plans.modules for 'complete' was an empty array. Entitlement reads it as
-- "this school bought no sellable module", so every section behind one --
-- Students, Academics, Attendance, Fees, Communication, Exams, HR, Transport,
-- Library -- was dropped from the catalogue before any permission was even
-- consulted.
--
-- What that looks like to a school is not an error message. It is a principal
-- signing in to a sidebar holding Dashboard, School setup and Approvals, on
-- the top tier, with every permission the product defines. The screens exist,
-- the grants exist, and the menu is empty; the row on the dashboard saying
-- "1 certificate request to issue" had nowhere to send anybody because the
-- feature it points at was not in that principal's catalogue at all.
--
-- 'starter' and 'standard' list their modules deliberately and are left
-- alone. Only the plan whose whole promise is "everything" is corrected, and
-- it is corrected to the canonical list in internal/entitlement (All), so the
-- two cannot drift apart quietly again.
--
-- Written as a targeted UPDATE rather than "empty means everything" in the
-- code. An empty list must go on meaning nothing: a plan that legitimately
-- sells no module would otherwise silently sell all of them, which is the
-- same bug pointed the other way and worth more money.

UPDATE plans
   SET modules = ARRAY[
        'students', 'academics', 'attendance', 'fees', 'communication',
        'exams', 'hr', 'transport', 'library', 'hostel', 'inventory'
   ]
 WHERE code = 'complete'
   AND (modules IS NULL OR cardinality(modules) = 0);

-- +goose Down

-- Deliberately empty. Putting the empty array back would re-break every school
-- on the plan, and the state it restores was never one anybody chose.
SELECT 1;
