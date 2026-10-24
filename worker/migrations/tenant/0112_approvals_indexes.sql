-- 0109_approvals_indexes (tenant: every school database).
-- The Approvals inbox (GET /api/v1/workflow/approvals) lists pending
-- attendance corrections by status and age, and picks each offered
-- applicant's fee structure by class, active flag and age. The existing
-- indexes lead with institution_id, which D1 queries do not filter on, so
-- both scanned whole tables.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).
-- 0108 is left free: two unmerged branches already use it.

CREATE INDEX IF NOT EXISTS "attendance_corrections_status_created_at_idx" ON "attendance_corrections" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "fee_structures_class_id_is_active_created_at_idx" ON "fee_structures" ("class_id", "is_active", "created_at");
