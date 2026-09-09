-- +goose Up
-- The three tenant tables that opted out of row level security.
--
-- Every other table carrying an institution_id -- 400-odd of them -- has RLS
-- enabled AND forced, so the tenant boundary is enforced by Postgres and the
-- WHERE clause in Go is a second opinion rather than the only one. These three
-- had the column, had SELECT/INSERT/UPDATE/DELETE granted to app_user, and had
-- no policy at all. Nothing but a correct WHERE clause stood between one
-- school and another school's commercial standing.
--
-- Nothing found a leak: every cross-institution read of these tables today
-- runs under AsPlatform, and every tenant read of `subscriptions` runs inside
-- InTenant asking for its own institution. That is precisely why this is worth
-- doing now and cheap to do -- the code already behaves as though the policy
-- were there, so turning it on changes no answer and removes the possibility
-- that the next query written here forgets.
--
-- 00040's comment said "institutions and subscriptions both use FORCE ROW
-- LEVEL SECURITY". Only institutions ever did. The comment is true from here.
--
-- FORCE as well as ENABLE, like every other tenant table: without it the owner
-- -- which is who migrations and the seller console connect as -- bypasses the
-- policy silently, and a policy the owner bypasses is a policy nobody tests.
-- app_is_platform_admin() is the deliberate way through, and AsPlatform sets it.

-- signup_orders and platform_events both carry a NULL institution_id for rows
-- that predate a school existing (a signup that has not provisioned) or that
-- belong to the platform rather than to any one school (a vendor-level event).
-- Those rows are reachable by platform staff through the second arm of the
-- policy and by nobody else, which is what they were always meant to be.
ALTER TABLE subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions   FORCE  ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant ON subscriptions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE signup_orders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_orders   FORCE  ROW LEVEL SECURITY;
CREATE POLICY signup_orders_tenant ON signup_orders
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE platform_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY platform_events_tenant ON platform_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- The foreign keys on the tables that grow with the school, with no index
-- behind them. 940 of the 1,543 foreign keys in this schema have no covering
-- index, which is mostly harmless -- a lookup table with forty rows does not
-- care. These are the ones on tables that grow per student, per invoice and
-- per term, where the parent DELETE and the join both end up sequential.
--
-- invoices.academic_year_id is the one that matters most: "this year's
-- invoices" is the shape of nearly every finance screen, and it was reading
-- the whole table to answer it.
CREATE INDEX IF NOT EXISTS invoices_academic_year  ON invoices      (academic_year_id);
CREATE INDEX IF NOT EXISTS invoices_campus         ON invoices      (campus_id);
CREATE INDEX IF NOT EXISTS invoice_lines_fee_head  ON invoice_lines (fee_head_id);
CREATE INDEX IF NOT EXISTS payments_campus         ON payments      (campus_id);
CREATE INDEX IF NOT EXISTS payments_collected_by   ON payments      (collected_by);
CREATE INDEX IF NOT EXISTS payments_reconciled_by  ON payments      (reconciled_by);
CREATE INDEX IF NOT EXISTS students_campus         ON students      (campus_id);
CREATE INDEX IF NOT EXISTS students_house          ON students      (house_id);
CREATE INDEX IF NOT EXISTS students_photo_file     ON students      (photo_file_id);
CREATE INDEX IF NOT EXISTS marks_entered_by        ON marks         (entered_by);
CREATE INDEX IF NOT EXISTS marks_approved_by       ON marks         (approved_by);

-- +goose Down
DROP INDEX IF EXISTS marks_approved_by;
DROP INDEX IF EXISTS marks_entered_by;
DROP INDEX IF EXISTS students_photo_file;
DROP INDEX IF EXISTS students_house;
DROP INDEX IF EXISTS students_campus;
DROP INDEX IF EXISTS payments_reconciled_by;
DROP INDEX IF EXISTS payments_collected_by;
DROP INDEX IF EXISTS payments_campus;
DROP INDEX IF EXISTS invoice_lines_fee_head;
DROP INDEX IF EXISTS invoices_campus;
DROP INDEX IF EXISTS invoices_academic_year;
DROP POLICY IF EXISTS platform_events_tenant ON platform_events;
ALTER TABLE platform_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_events DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signup_orders_tenant ON signup_orders;
ALTER TABLE signup_orders NO FORCE ROW LEVEL SECURITY;
ALTER TABLE signup_orders DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_tenant ON subscriptions;
ALTER TABLE subscriptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;
