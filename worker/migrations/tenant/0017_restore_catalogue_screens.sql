-- 0017_restore_catalogue_screens (tenant: every school database).
-- Eight finished screens whose catalogue keys had been dropped come back as
-- 'advanced' features (off the sidebar, found by search): the principal's
-- report builder, department reports, performance analytics, department
-- academics, 360 appraisals, instruction hours and purchase orders, and the
-- accountant's automated fee reminders. A catalogue key is also the grant
-- that shows the screen, so existing schools need the key and the grant.
-- A school that customised the role keeps its customisation.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.analysis.custom_report_builder', 'institution_admin', 'Build your own report: pick the data, the columns and the filters, preview it, save it, share it with colleagues and export it.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.analysis.department_reports', 'institution_admin', 'Attendance, workload, results and a summary for each department side by side.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.analysis.performance_analytics', 'institution_admin', 'Subject pass rates, the term-on-term trend, the spread of marks and the students at risk.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.department.department_academics', 'institution_admin', 'Each department''s subjects, sections and teachers, and how far its syllabus has got.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.evaluation.appraisals', 'institution_admin', 'Run a 360-degree review cycle: peers, students and the principal answer the same questions, and each teacher''s results are released once enough people have answered to keep them anonymous.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.statutory_returns.instruction_hours', 'institution_admin', 'Days taught and hours delivered against the minimum the board requires, while there is still term left to make them up.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.stores.purchase_order_workflow', 'institution_admin', 'Raise a purchase requisition, approve it within the spending limits, issue the purchase order, record the goods received and match the supplier''s invoice against both before it is paid.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('finance.student_dues.automated_fee_reminders', 'finance', 'Plans that remind parents of unpaid fees by WhatsApp, SMS or email on a schedule, with a dry run showing who would be sent what and the reason a plan is not sending.');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.analysis.custom_report_builder' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.analysis.department_reports' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.analysis.performance_analytics' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.department.department_academics' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.evaluation.appraisals' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.statutory_returns.instruction_hours' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.stores.purchase_order_workflow' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'finance.student_dues.automated_fee_reminders' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
