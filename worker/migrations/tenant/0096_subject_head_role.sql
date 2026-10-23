-- SUBJECT HEAD (owner, 2026-10-19): the head of one subject across every
-- grade, given as a role of its own so it works for a teacher or a HOD alike
-- and in any school. Academics -> Subject overview -> Subject heads gives the
-- role with the headship and takes it away when the person heads nothing.
-- Forward-only: once applied anywhere this file must not change.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES
  ('academics.subject_head', 'academics', 'Head a subject: its teachers, classes, timetable, approvals and meetings'),
  ('faculty.academics.subject_overview', 'faculty', 'For each subject''s head: every teacher of that subject from Grade 1 up, their classes, marks and syllabus, the subject''s timetable, notices and meetings.');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT id, 'faculty.academics.subject_overview' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;

INSERT INTO roles (id, institution_id, key, name, is_system, is_default, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       i.id, 'subject_head', 'Subject Head', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM institutions i
 WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.institution_id = i.id AND r.key = 'subject_head');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN ('academics.subject_head', 'academics.read', 'academics.timetable.read',
       'academics.homework.write', 'academics.exams.read', 'comms.announcements.write', 'self.profile.read', 'self.profile.write')
 WHERE r.key = 'subject_head';

-- Today's heads get the role.
INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, campus_id, created_at)
SELECT lower(hex(randomblob(16))), h.institution_id, h.head_user_id, r.id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM subject_heads h JOIN roles r ON r.institution_id = h.institution_id AND r.key = 'subject_head'
 GROUP BY h.head_user_id, r.id;

-- What a subject head is given, chosen per school (Subject heads tab). Every part on unless a school turns it off.
CREATE TABLE IF NOT EXISTS subject_head_members (
  subject_id TEXT NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL,
  -- 'add': under this head though they do not teach the subject; 'remove': teaches it but not under this head.
  mode TEXT NOT NULL CHECK (mode IN ('add','remove')),
  PRIMARY KEY (subject_id, user_id)
);
