-- +goose Up
-- Repair sync_payment_allocated.
--
-- The 00001 baseline was generated from a pg_dump whose cleaning pass dropped
-- every line beginning with "SET " in order to remove pg_dump's session
-- preamble. That also deleted
--
--     SET allocated_paise = COALESCE(
--
-- from the middle of this function body. Because the baseline runs with
-- check_function_bodies = false (it has to: pg_dump emits functions before the
-- tables they reference), the malformed body was accepted at CREATE time and
-- only failed when a row was actually inserted into payment_allocations —
-- 42601, syntax error, on every attempt to record a payment against an invoice.
--
-- The generator is fixed to be dollar-quote aware, so a database built from
-- 00001 today already has the correct body and this migration is a no-op
-- replacement. It exists for the environments migrated before that fix.
--
-- Body below is byte-identical to production at erp.187-127-178-100.sslip.io.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.sync_payment_allocated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target uuid := COALESCE(NEW.payment_id, OLD.payment_id);
BEGIN
    UPDATE payments p
       SET allocated_paise = COALESCE(
           (SELECT sum(amount_paise) FROM payment_allocations WHERE payment_id = target), 0)
     WHERE p.id = target;
    RETURN NULL;
END $$;
-- +goose StatementEnd

-- Reconcile any rows written while the trigger was broken. Nothing could have
-- been inserted through it (the insert itself errored), but a deployment that
-- disabled the trigger to get data in would leave allocated_paise stale.
UPDATE payments p
   SET allocated_paise = COALESCE(
       (SELECT sum(a.amount_paise) FROM payment_allocations a WHERE a.payment_id = p.id), 0)
 WHERE p.allocated_paise IS DISTINCT FROM COALESCE(
       (SELECT sum(a.amount_paise) FROM payment_allocations a WHERE a.payment_id = p.id), 0);

-- +goose Down
-- +goose StatementBegin
-- Deliberately not restoring the broken body; down-migrating to a function that
-- raises a syntax error at runtime would be worse than leaving this in place.
SELECT 1;
-- +goose StatementEnd
