-- +goose Up
-- Every staff role gets the Messages screen.
--
-- staff_messages has never gated on a permission — any account that is not a
-- student or a guardian may write to any other — but only five roles carried
-- a catalog key for the screen, so a librarian, an accountant, the nurse, the
-- warden, HR and transport had no way to ask a class teacher anything. These
-- are the keys that put the door on the menu; the deploy runs `migrate up`
-- and never `seed`, so they are carried here as 00323 and 00332 were.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description)
SELECT k.role_key || '.communication.messages', k.role_key, 'Messages'
  FROM (VALUES ('activity_coord'), ('counsellor'), ('discipline_officer'),
               ('exam_controller'), ('finance'), ('hostel_warden'), ('hr'),
               ('it_admin'), ('librarian'), ('nurse'), ('operations'),
               ('transport_manager')) AS k(role_key)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, r.key || '.communication.messages'
  FROM roles r
 WHERE r.key IN ('activity_coord','counsellor','discipline_officer','exam_controller',
                 'finance','hostel_warden','hr','it_admin','librarian','nurse',
                 'operations','transport_manager')
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';
DELETE FROM role_permissions
 WHERE permission_key LIKE '%.communication.messages'
   AND permission_key NOT LIKE 'institution_admin.%'
   AND permission_key NOT LIKE 'faculty.%'
   AND permission_key NOT LIKE 'hod.%'
   AND permission_key NOT LIKE 'admissions.%'
   AND permission_key NOT LIKE 'front_office.%';
