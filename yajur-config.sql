-- Yajur only: Subject Teacher (role key 'faculty') opens with exactly the
-- owner's 14 screens. Run against YAJUR'S TENANT DATABASE only. Not a
-- migration; not applied to any other school. Idempotent.
--
-- How screens map to grants: a menu entry is a catalogue feature key
-- (faculty.<section>.<feature>) held in role_permissions; the API behind it
-- is gated by capability keys (academics.marks.write, ...), also rows in
-- role_permissions. A school admin can switch any removed screen back on in
-- Logins & access -> Roles -> Faculty -> Features.
--
-- Kept screens (feature key -> screen):
--   faculty.marks_report_cards.marks_entry      1  Marks entry
--   faculty.timetable.my_timetable              2  Weekly timetable
--   faculty.home.todays_classes                 3  Today's classes + notifications
--   faculty.communication.remarks               4  Remarks
--   faculty.communication.messages              5  Messages (staff only, see below)
--   faculty.my_profile.profile                  6  Profile (read-only, see below)
--   faculty.communication.class_status          7  Status
--   faculty.teaching.homework_classwork         8  Homework
--   faculty.teaching.assignments_submissions    8  Assignments / projects
--   faculty.my_classes.student_progress         9  Student progress
--   faculty.my_classes.behaviour                10 Behaviour
--   faculty.my_profile.leave_self_service       11 Leaves
--   faculty.my_profile.my_pay                   12 My pay
--   faculty.my_profile.my_tasks                 13 My tasks
--   faculty.exams.question_papers               14 Question papers
-- Also kept, but the menu hides them unless the person also holds the Class
-- Teacher role (web Shell.tsx CLASS_TEACHER_ONLY), so a class teacher keeps
-- attendance etc.: faculty.attendance.*, faculty.my_classes.class_360,
-- faculty.my_classes.student_details, faculty.marks_report_cards.report_cards,
-- faculty.my_profile.student_leave_requests, faculty.academics.subject_overview.
--
-- Capabilities kept: status.post, students.read, academics.read,
-- academics.timetable.read, academics.exams.read, academics.marks.write,
-- academics.homework.write, welfare.discipline.write, self.profile.read.
-- Removed: comms.announcements.write (parent threads, notices and broadcasts
-- to parents are refused by the server without it) and self.profile.write
-- (profile becomes read-only; PUT /api/v1/profile refused).

DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE key = 'faculty')
   AND permission_key NOT IN (
     'status.post', 'students.read', 'academics.read', 'academics.timetable.read', 'academics.exams.read',
     'academics.marks.write', 'academics.homework.write', 'welfare.discipline.write', 'self.profile.read',
     'faculty.marks_report_cards.marks_entry', 'faculty.timetable.my_timetable', 'faculty.home.todays_classes',
     'faculty.communication.remarks', 'faculty.communication.messages', 'faculty.my_profile.profile',
     'faculty.communication.class_status', 'faculty.teaching.homework_classwork',
     'faculty.teaching.assignments_submissions', 'faculty.my_classes.student_progress',
     'faculty.my_classes.behaviour', 'faculty.my_profile.leave_self_service', 'faculty.my_profile.my_pay',
     'faculty.my_profile.my_tasks', 'faculty.exams.question_papers',
     'faculty.attendance.take_attendance', 'faculty.attendance.take_attendance_school',
     'faculty.attendance.attendance_correction', 'faculty.attendance.absentee_followup',
     'faculty.attendance.student_absentees', 'faculty.attendance.offline_attendance_diary_capture',
     'faculty.my_classes.class_360', 'faculty.my_classes.student_details',
     'faculty.marks_report_cards.report_cards', 'faculty.my_profile.student_leave_requests',
     'faculty.academics.subject_overview');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT r.id, k.value FROM roles r, json_each('["status.post","students.read","academics.read","academics.timetable.read","academics.exams.read","academics.marks.write","academics.homework.write","welfare.discipline.write","self.profile.read","faculty.marks_report_cards.marks_entry","faculty.timetable.my_timetable","faculty.home.todays_classes","faculty.communication.remarks","faculty.communication.messages","faculty.my_profile.profile","faculty.communication.class_status","faculty.teaching.homework_classwork","faculty.teaching.assignments_submissions","faculty.my_classes.student_progress","faculty.my_classes.behaviour","faculty.my_profile.leave_self_service","faculty.my_profile.my_pay","faculty.my_profile.my_tasks","faculty.exams.question_papers"]') k
 WHERE k.value IN (SELECT key FROM permissions) AND r.key = 'faculty';

-- Class teacher remarks and PTM notes leave the Faculty role but stay with
-- Yajur's class teachers, through the Class Teacher role they also hold.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT r.id, k.value FROM roles r, json_each('["faculty.communication.class_teacher_remarks","faculty.communication.ptm_notes_action_items"]') k
 WHERE k.value IN (SELECT key FROM permissions) AND r.key = 'class_teacher';
UPDATE roles SET customised_at = COALESCE(customised_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE key = 'class_teacher';

-- Marked customised so a later role reinstall or reset does not put the
-- removed screens back.
UPDATE roles SET customised_at = COALESCE(customised_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE key = 'faculty';

-- ---------------------------------------------------------------------------
-- Class Teacher defaults (owner, 2026-10-19). Additive only: nothing is taken
-- away from any role, and an admin can still switch on any other screen in
-- Logins & access -> Roles -> Class Teacher -> Features. A class teacher also
-- holds Faculty, so they keep all 14 subject-teacher screens above as well.
--
--   Take attendance, with every class and section in the picker
--     (academics.attendance.write.any + read.all; Take attendance (school))
--   Report cards: generate                      academics.reportcards.generate
--   Marks: subjects they teach and every subject of their own class
--     (server rule in worker/src/routes/exams.ts, classTeacherOf)
--   Classroom communication to the class's parents  comms.announcements.write
--   Remarks, anecdotal records, class teacher remark for the report card
--   Student leave requests, homework, assignments, CCE assessments
--   Messages: staff to staff only (module teacher_parent_messages off below)
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT r.id, k.value FROM roles r, json_each('["comms.announcements.write","academics.attendance.read","academics.attendance.read.all","academics.attendance.write","academics.attendance.write.any","academics.reportcards.generate","academics.marks.write","academics.homework.write","academics.class360.view","welfare.discipline.write","students.read","academics.read","academics.timetable.read","academics.exams.read","status.post","self.profile.read","faculty.attendance.take_attendance","faculty.attendance.take_attendance_school","faculty.attendance.attendance_correction","faculty.attendance.absentee_followup","faculty.attendance.student_absentees","faculty.attendance.offline_attendance_diary_capture","faculty.my_classes.my_classes","faculty.my_classes.class_360","faculty.my_classes.student_details","faculty.my_classes.student_progress","faculty.my_classes.behaviour","faculty.marks_report_cards.marks_entry","faculty.marks_report_cards.report_cards","faculty.assessment_schemes.cce_formative_assessment_entry","faculty.assessment_schemes.cce_summative_assessment_entry","faculty.communication.classroom_communication","faculty.communication.remarks","faculty.communication.anecdotal_records","faculty.communication.class_teacher_remarks","faculty.communication.ptm_notes_action_items","faculty.communication.messages","faculty.communication.class_status","faculty.my_profile.student_leave_requests","faculty.teaching.homework_classwork","faculty.teaching.assignments_submissions","faculty.home.todays_classes","faculty.timetable.my_timetable"]') k
 WHERE k.value IN (SELECT key FROM permissions) AND r.key = 'class_teacher';
UPDATE roles SET customised_at = COALESCE(customised_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE key = 'class_teacher';

-- Messages for teachers are staff to staff; families are reached through
-- Classroom communication. Bus staff keep their parent messages. Switch back
-- on in Settings -> Communication -> Teachers message parents directly.
INSERT INTO module_settings (institution_id, module, enabled)
SELECT id, 'teacher_parent_messages', 0 FROM institutions WHERE 1 LIMIT 1
ON CONFLICT (institution_id, module) DO UPDATE SET enabled = 0;

-- ---------------------------------------------------------------------------
-- Trim to the owner's lists exactly (owner, 2026-10-19: "I see more").
-- Grants only: every screen stays in the system and an admin can switch it
-- back on in Logins & access -> Roles.
-- Class Teacher: the class-teacher list plus the 14 subject-teacher screens.
-- Kept capabilities: attendance (any section), report cards, marks,
-- homework, class notices to parents, students.write, class360.view (it
-- gates Student leave requests). Dropped: self.profile.write (profile is
-- read-only) and academics.attendance.read.all (Absentee follow-up is the
-- office's).
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE key = 'class_teacher')
   AND permission_key NOT IN (
     'status.post', 'students.read', 'students.write', 'academics.read', 'academics.timetable.read',
     'academics.exams.read', 'academics.marks.write', 'academics.homework.write', 'welfare.discipline.write',
     'self.profile.read', 'academics.attendance.read', 'academics.attendance.write', 'academics.attendance.write.any',
     'academics.reportcards.generate', 'academics.class360.view', 'comms.announcements.write',
     'faculty.attendance.take_attendance', 'faculty.attendance.take_attendance_school',
     'faculty.marks_report_cards.marks_entry', 'faculty.marks_report_cards.report_cards',
     'faculty.communication.classroom_communication', 'faculty.communication.remarks',
     'faculty.communication.anecdotal_records', 'faculty.communication.class_teacher_remarks',
     'faculty.communication.messages', 'faculty.communication.class_status',
     'faculty.my_profile.student_leave_requests', 'faculty.teaching.homework_classwork',
     'faculty.teaching.assignments_submissions', 'faculty.assessment_schemes.cce_formative_assessment_entry',
     'faculty.assessment_schemes.cce_summative_assessment_entry', 'faculty.timetable.my_timetable',
     'faculty.home.todays_classes', 'faculty.my_classes.student_progress', 'faculty.my_classes.behaviour',
     'faculty.my_profile.leave_self_service', 'faculty.my_profile.my_pay', 'faculty.my_profile.my_tasks',
     'faculty.my_profile.profile', 'faculty.exams.question_papers');
-- Faculty: drop the class-teacher extras nobody asked for (a class teacher
-- holds Faculty too, so these showed up in their menu).
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE key = 'faculty')
   AND permission_key IN ('faculty.attendance.absentee_followup', 'faculty.attendance.attendance_correction',
     'faculty.attendance.offline_attendance_diary_capture', 'faculty.attendance.student_absentees',
     'faculty.my_classes.student_details', 'faculty.my_classes.class_360');

-- Class teacher works on her own class only (owner, 2026-10-19: "show only
-- her class students which is class teacher of"): no any-section reach, so
-- attendance, marks, report cards, class notices and leave cover the
-- section(s) she is class teacher of.
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE key = 'class_teacher')
   AND permission_key IN ('academics.attendance.write.any', 'faculty.attendance.take_attendance_school');
