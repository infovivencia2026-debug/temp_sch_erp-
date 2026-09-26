-- 00343_staff_records_for_every_login (tenant D1, data only).
-- One employee row for every active/invited login with a staff role and no
-- employee record: named from the login, on the first campus, next EMP code.
-- Idempotent: a second run finds nobody missing; codes that collide are skipped.
-- Note: as in Go, employees.user_id is set to the login here.
WITH missing AS (
  SELECT u.id AS user_id, u.institution_id, trim(u.full_name) AS full_name, u.email, u.phone,
         row_number() OVER (PARTITION BY u.institution_id ORDER BY u.full_name, u.id) AS rn
    FROM users u
   WHERE u.institution_id IS NOT NULL
     AND u.status IN ('active', 'invited')
     AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                  WHERE ur.user_id = u.id AND ro.key NOT IN ('student', 'parent'))
     AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id)
), base AS (
  SELECT i.id AS institution_id,
         max(COALESCE((SELECT max(e.staff_number) FROM employees e WHERE e.institution_id = i.id), 999), 999) AS top,
         (SELECT c.id FROM campuses c WHERE c.institution_id = i.id ORDER BY c.id LIMIT 1) AS campus_id
    FROM institutions i
)
INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
                       first_name, last_name, email, phone, status, staff_number)
SELECT m.institution_id, b.campus_id, m.user_id,
       'EMP' || CASE WHEN b.top + m.rn < 1000 THEN substr('0000' || (b.top + m.rn), -4) ELSE CAST(b.top + m.rn AS TEXT) END,
       CASE WHEN instr(m.full_name, ' ') > 0 THEN substr(m.full_name, 1, instr(m.full_name, ' ') - 1) ELSE m.full_name END,
       CASE WHEN instr(m.full_name, ' ') > 0 THEN NULLIF(trim(substr(m.full_name, instr(m.full_name, ' ') + 1)), '') END,
       m.email, m.phone, 'active',
       CASE WHEN b.top + m.rn <= 9999 THEN b.top + m.rn END
  FROM missing m
  JOIN base b ON b.institution_id = m.institution_id
 WHERE b.campus_id IS NOT NULL
ON CONFLICT (institution_id, employee_code) DO NOTHING;
