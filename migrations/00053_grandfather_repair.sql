-- +goose Up
-- Repairs the grandfathering that 00040 silently did not do.
--
-- 00040 ran as the table owner, and institutions carries FORCE ROW LEVEL
-- SECURITY, which applies to the owner as well. Its SELECT therefore matched
-- no rows, its INSERT wrote nothing, and goose recorded a clean success. The
-- first school to notice was the demo tenant, which was locked out of its own
-- data by the subscription gate the same deploy introduced.
--
-- 00040 has been corrected for installations that have not run it yet. This
-- file exists for the ones that have, because an applied migration never runs
-- again no matter how it is edited afterwards.
--
-- Renumbered from 00041, which collided with 00041_teaching.sql developed in
-- parallel on another branch. Goose keys on the numeric prefix alone, so two
-- files sharing one refuse to load at all -- and on the one installation where
-- this had already run as 41, its recorded row would have made goose skip the
-- teaching migration for ever. That row is cleared as part of the same deploy.
--
-- Idempotent: on a database where 00040 worked, this matches nothing, and it
-- is safe to run a second time under its new number.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO subscriptions (institution_id, plan_code, status, started_on,
                           renews_on, licensed_students, notes)
SELECT i.id,
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
   AND EXISTS (SELECT 1 FROM plans);

-- +goose Down
-- Deliberately empty. 00040's Down already removes these rows by note, and
-- removing them twice would delete subscriptions this file did not create.
SELECT 1;
