-- Whoever is actually a section's class teacher gets the Class Teacher role
-- (Yajur, 2026-10-16: "why does a subject teacher have attendance... let me
-- remove that... after class teacher is selected their role gets class
-- teacher features"). Faculty's own menu no longer carries attendance,
-- Class 360, report cards or student leave requests -- those now need the
-- Class Teacher role too, which permissions already union across (see
-- worker/src/identity.ts), the same menu widening rather than a second one.
-- Without this, the moment that trim ships every section's own class
-- teacher, already holding only "Faculty", would lose them on the spot.
-- Idempotent and forward-only: a role already held is skipped by the unique
-- index on (user_id, role_id, campus_id); run again safely, including for a
-- class teacher added after this migration (the app's own role-assignment
-- screen is what keeps them covered from here).
INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, campus_id, created_at)
SELECT lower(hex(randomblob(16))), s.institution_id, s.class_teacher_id, r.id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM sections s
  JOIN roles r ON r.institution_id = s.institution_id AND r.key = 'class_teacher'
 WHERE s.class_teacher_id IS NOT NULL;
