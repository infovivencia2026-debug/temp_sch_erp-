-- 0118_orphan_screens_menu (tenant: every school database).
-- Built screens that no menu reached get catalogue entries (owner, 2026-10-27).
-- Navigation keys only: each role already holds the API permissions the screen calls.
-- Brings every existing school database up to what a new school is provisioned with.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.examinations.exams_monitoring', 'exam_controller', 'Every paper that has been sat, with how many of the class roll have marks entered. See who has not entered marks yet, approve a paper once it is complete, and publish the results.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.board_exams.ssc_registration', 'exam_controller', 'The Class 10 nominal roll for the state board: who is entered, what they are entered for, amendments, and what the board has said about each candidate.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.board_exams.intermediate_registration', 'exam_controller', 'The Class 11 and 12 nominal roll for the intermediate board, first year and second year: who is entered, amendments, and the board''s response for each candidate.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.board_exams.board_loc_filing', 'exam_controller', 'The List of Candidates for the board: validate it, see which candidates the board would refuse and why, export it and record the filing.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.board_exams.board_results', 'exam_controller', 'Import the board''s result file and reconcile it against the school''s own candidates: who the board has that the school does not, and who is missing from the file. Publish once matched.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.board_exams.baseline_analysis', 'exam_controller', 'Each class''s latest results against its own earlier baseline exam, in percentage points, with the basis printed on the page.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hod.academics.course_outcomes', 'hod', 'Programme and course outcomes for the department''s subjects, which papers measure each outcome, and whether the class attained it, computed from marks.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('finance.fees.fee_regulatory_filing', 'finance', 'Compile the fee structure filed with the fee regulatory committee, attach the supporting documents, submit it and record the committee''s decision, so the school charges only what was approved.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('admissions.front_desk.alumni', 'admissions', 'Former students: their profiles, events and attendance, and contributions, with the leavers who have no alumni profile yet. Contactable is consent: an alumnus who asked to be left alone drops out of every mailing.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.examinations.exams_monitoring' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.board_exams.ssc_registration' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.board_exams.intermediate_registration' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.board_exams.board_loc_filing' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.board_exams.board_results' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.board_exams.baseline_analysis' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hod.academics.course_outcomes' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'finance.fees.fee_regulatory_filing' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'admissions.front_desk.alumni' FROM roles WHERE key = 'admissions' AND is_system = 1 AND customised_at IS NULL;
