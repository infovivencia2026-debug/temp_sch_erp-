-- +goose Up
-- Every school that already existed keeps everything it already had.
--
-- The subscription gate that lands with this migration refuses tenant work for
-- a school with no active subscription. That is the intended behaviour for a
-- school that never bought anything -- and it would have been catastrophic for
-- the schools already on the system, which predate billing entirely and have
-- no subscription row at all. Switching the gate on without this migration
-- would lock out every existing customer, including the demo tenant every
-- login is tested against, and it would look like an outage rather than a
-- policy.
--
-- So: anyone already here is grandfathered onto the top plan, active, renewing
-- in a year. Not the cheapest plan -- taking modules away from a school that
-- has been using them is a worse first impression of billing than giving them
-- away. The seller can downgrade any of these deliberately from the console;
-- what they must not do is have it happen by omission.
-- institutions and subscriptions both use FORCE ROW LEVEL SECURITY, which
-- applies to the table owner too -- and migrations run as the owner. Without
-- this the SELECT below sees no institutions at all, the INSERT matches zero
-- rows, and goose reports a successful migration that did nothing. That is
-- exactly what happened on the first deploy of this file: every existing
-- school stayed unsubscribed and was locked out by the gate it was meant to
-- protect them from.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO subscriptions (institution_id, plan_code, status, started_on,
                           renews_on, licensed_students, notes)
SELECT i.id,
       -- The plan with no module restrictions, falling back to whatever the
       -- most expensive plan is if 'complete' was ever renamed.
       COALESCE(
           (SELECT code FROM plans WHERE code = 'complete'),
           (SELECT code FROM plans ORDER BY price_paise DESC LIMIT 1)
       ),
       'active',
       CURRENT_DATE,
       CURRENT_DATE + interval '1 year',
       NULL,
       'Grandfathered: predates subscription enforcement.'
  FROM institutions i
 WHERE NOT EXISTS (
           SELECT 1 FROM subscriptions s
            WHERE s.institution_id = i.id AND s.status <> 'cancelled')
   -- A platform-only installation with no plans seeded would insert a NULL
   -- plan_code and fail the foreign key; skip rather than break the deploy.
   AND EXISTS (SELECT 1 FROM plans);

-- module_settings is left alone on purpose. The top plan carries an empty
-- modules array, which the entitlement resolver reads as "everything", so
-- these schools need no rows to see every module. Writing eleven rows each
-- would only create a second source of truth to drift from the plan.

-- +goose Down
DELETE FROM subscriptions
 WHERE notes = 'Grandfathered: predates subscription enforcement.';
