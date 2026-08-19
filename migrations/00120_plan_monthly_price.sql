-- +goose Up
-- A monthly price, so the pricing page can offer the choice it shows.
--
-- plans held one figure per plan and the page called it "per year". The new
-- pricing page offers monthly and yearly, and a toggle that switches between
-- one real price and one invented at render time is a toggle that eventually
-- bills somebody the invented one. So the second price is a column.
--
-- Nullable on purpose. A plan with no monthly price is yearly-only, and the
-- page says so rather than dividing the annual figure by twelve and implying
-- a commitment nobody agreed to sell.
--
-- The seeded figures are the vendor's own, from the pricing design: ₹5,000,
-- ₹10,000 and ₹20,000 a month. Twelve of each comes to more than the annual
-- price, which is the point of an annual price — the saving is computed from
-- these two columns and shown per plan, rather than printed as one rounded
-- claim across three plans it is only true for one of.
--
-- Numbered at 120, clear of the range the parallel branch is consuming.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_monthly_paise bigint;

ALTER TABLE plans
    ADD CONSTRAINT plans_monthly_price_sane
    CHECK (price_monthly_paise IS NULL OR price_monthly_paise > 0);

UPDATE plans SET price_monthly_paise = 500000   WHERE code = 'starter'  AND price_monthly_paise IS NULL;
UPDATE plans SET price_monthly_paise = 1000000  WHERE code = 'standard' AND price_monthly_paise IS NULL;
UPDATE plans SET price_monthly_paise = 2000000  WHERE code = 'complete' AND price_monthly_paise IS NULL;

-- The period a school actually chose. Without it the order records an amount
-- and no way to say what it bought: ₹10,000 is a month of Standard and also a
-- ninth of a year of it, and a refund six weeks later cannot tell which.
ALTER TABLE signup_orders
    ADD COLUMN IF NOT EXISTS billing_period text NOT NULL DEFAULT 'yearly';

ALTER TABLE signup_orders
    ADD CONSTRAINT signup_orders_billing_period_check
    CHECK (billing_period IN ('monthly', 'yearly'));

-- +goose Down
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_monthly_price_sane;
ALTER TABLE plans DROP COLUMN IF EXISTS price_monthly_paise;
ALTER TABLE signup_orders DROP CONSTRAINT IF EXISTS signup_orders_billing_period_check;
ALTER TABLE signup_orders DROP COLUMN IF EXISTS billing_period;
