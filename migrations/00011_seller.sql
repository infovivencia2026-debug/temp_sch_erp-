-- +goose Up
-- The commercial side of the installation, and the first morning after a sale.
--
-- plans, subscriptions and support_tickets already existed: the original
-- product designed the seller's side and then never populated or exposed it,
-- so all three tables were empty and no screen read them. This migration does
-- not recreate that schema. It fills the two gaps that stopped it working —
-- a price list to sell from, and a record of who has met the software before.

-- A starter ladder so a fresh installation has something to sell. Prices in
-- paise, like every other amount here: ₹40,000, ₹90,000, ₹1,80,000 a year.
--
-- The module lists are what the plan *includes*. An empty list means every
-- module, so the top plan does not have to be edited each time one is added —
-- the trap a hard-coded "all modules" array walks into a year later.
INSERT INTO plans (code, name, price_paise, max_students, max_campuses, modules, sequence)
VALUES
  ('starter', 'Starter', 4000000, 300, 1,
   ARRAY['students','academics','attendance','fees','communication'], 1),
  ('standard', 'Standard', 9000000, 1200, 3,
   ARRAY['students','academics','attendance','fees','communication','exams',
         'hr','transport','library'], 2),
  ('complete', 'Complete', 18000000, NULL, NULL,
   ARRAY[]::text[], 3)
ON CONFLICT (code) DO UPDATE
   SET name = EXCLUDED.name,
       price_paise = EXCLUDED.price_paise,
       max_students = EXCLUDED.max_students,
       max_campuses = EXCLUDED.max_campuses,
       modules = EXCLUDED.modules,
       sequence = EXCLUDED.sequence;

/* Has this person met the software before?

   The cycle a sale actually follows: the school buys, the vendor provisions
   the tenant and hands credentials to the principal, and the principal signs
   in — alone, to an empty system, with no idea what to do next. That morning
   decides whether the rollout happens. Industry surveys put ERP implementation
   failure at 60-70%, and almost none of it is the software.

   Per user rather than per school, because the principal, the clerk and the
   head of department each meet the system for the first time on a different
   day. NULL means they have not been shown round yet. */
ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_completed_at timestamptz;

COMMENT ON COLUMN users.tour_completed_at IS
    'When this user finished the first-run tour. NULL means they have not seen it.';

-- Renewals and overdue accounts are looked up by date across every tenant,
-- which is the one query the seller console runs on every page load.
CREATE INDEX IF NOT EXISTS subscriptions_renews_on
    ON subscriptions (renews_on)
 WHERE status IN ('trial', 'active', 'past_due');

-- +goose Down
DROP INDEX IF EXISTS subscriptions_renews_on;
ALTER TABLE users DROP COLUMN IF EXISTS tour_completed_at;
DELETE FROM plans WHERE code IN ('starter', 'standard', 'complete');
