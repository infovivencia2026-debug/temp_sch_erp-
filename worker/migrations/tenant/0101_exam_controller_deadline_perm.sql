-- The Examination Controller role never held academics.exams.approve
-- (rbac.go's exam_controller grant listed ExamsRead/ExamsWrite but not
-- ExamsApprove) so the question-paper-deadline routes, which gate on that
-- permission the same way question-paper approval does, 403'd for the one
-- role meant to use them (owner, 2026-10-19: "there is a ROLE EXAMINATION
-- COUNCELLAR... for that person that feature should be there"). Fixed in
-- rbac.go and worker/src/routes/admin/static_data.ts's SYSTEM_ROLES (hand
-- maintained there, not generated); this grants it to any school that
-- already installed the role before that change, the same as 0095 did for
-- faculty's trim.
-- Forward-only: once applied anywhere this file must not change.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT id, 'academics.exams.approve' FROM roles
 WHERE key = 'exam_controller' AND customised_at IS NULL;
