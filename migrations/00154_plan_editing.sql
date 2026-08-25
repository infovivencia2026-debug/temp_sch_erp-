-- +goose Up
-- +goose StatementBegin

/* What a school agreed to pay, kept on the school.

   A subscription stored a plan code and no price, so every school's revenue was
   read live from plans.price_paise. That is fine while a plan is a fixed thing
   and wrong the moment a vendor can edit one: raising the price of "Pro" for
   next year's customers would silently re-price every school already on it,
   including a contract signed eleven months ago. The vendor would see MRR jump
   and no school would have agreed to a rupee of it.

   So the price travels with the subscription. Editing a plan changes what the
   next school pays and nothing about the ones already signed — which is what
   "for the next purchase" means, and is also how anybody would expect a
   price list to behave.

   Backfilled from the plan each school is currently on, because that is what
   they are being billed today and there is no better record of it. */
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS agreed_price_paise bigint;

UPDATE subscriptions s
   SET agreed_price_paise = p.price_paise
  FROM plans p
 WHERE p.code = s.plan_code
   AND s.agreed_price_paise IS NULL;

COMMENT ON COLUMN subscriptions.agreed_price_paise IS
    'What this school agreed to pay, fixed at signing. NULL falls back to the plan''s current price.';

/* A plan that is no longer sold, but is still being paid.

   Deleting a plan somebody is on would orphan their subscription; leaving it on
   the list means a vendor offers last year's pricing by accident. Retiring is
   the third answer: gone from what can be sold, still readable by the schools
   on it. */
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS retired_at timestamptz;

/* Limits, at the two levels a vendor actually negotiates them.

   A plan says what a tier includes; a subscription says what this school was
   promised. Students already worked that way — plans.max_students is the tier's
   cap and subscriptions.licensed_students overrides it for one school — and
   storage had neither: no tier carried a storage cap and no school could be
   given a different one, so "School A gets 50GB while Basic allows 10" could
   not be expressed at all.

   NULL means "no limit of its own": a plan with no cap is unlimited, and a
   subscription with no override takes the plan's. Two nullable columns rather
   than a settings blob, because a limit that has to be parsed out of JSON is a
   limit no query will ever enforce. */
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS max_storage_gb integer;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS storage_gb integer;

COMMENT ON COLUMN plans.max_storage_gb IS
    'Storage the tier includes, in GB. NULL is unlimited.';
COMMENT ON COLUMN subscriptions.storage_gb IS
    'Storage promised to this school, overriding the plan. NULL takes the plan''s.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE subscriptions DROP COLUMN IF EXISTS agreed_price_paise;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS storage_gb;
ALTER TABLE plans DROP COLUMN IF EXISTS retired_at;
ALTER TABLE plans DROP COLUMN IF EXISTS max_storage_gb;
-- +goose StatementEnd
