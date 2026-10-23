-- LMS Admin opens Courses (lms_admin.lms.courses) but every action on it --
-- units, lessons, quizzes, videos, unlocks -- is checked against
-- academics.timetable.read, which the role never held, so each press was
-- refused (owner, 2026-10-08). Granted the way 0064 granted its screens.
-- Forward-only: once applied anywhere this file must not change.

INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'academics.timetable.read' FROM roles WHERE key = 'lms_admin' AND is_system = 1 AND customised_at IS NULL;
