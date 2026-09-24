-- +goose Up
/* Every staff login has a staff record.

   Issue a login on Logins & access made an account and nothing else, so a
   member of staff created that way could sign in, be messaged, and appear
   on no HR screen: Staff 360, payroll, documents and ID cards all read the
   employee record. From this migration on the handler makes both at once,
   this repairs what already exists: one employee row for every account
   that holds a staff role (anything but student or parent) and has none,
   named from the login, on the school's first campus, with the next staff
   code and number in that school's sequence. */
SET LOCAL app.is_platform_admin = 'on';

WITH missing AS (
  SELECT u.id AS user_id, u.institution_id, u.full_name, u.email, u.phone,
         row_number() OVER (PARTITION BY u.institution_id ORDER BY u.full_name, u.id) AS rn
    FROM users u
   WHERE u.institution_id IS NOT NULL
     AND u.status IN ('active', 'invited')
     AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                  WHERE ur.user_id = u.id AND ro.key NOT IN ('student', 'parent'))
     AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id)
), base AS (
  SELECT i.id AS institution_id,
         GREATEST(COALESCE((SELECT max(e.staff_number) FROM employees e WHERE e.institution_id = i.id), 999), 999) AS top,
         (SELECT c.id FROM campuses c WHERE c.institution_id = i.id ORDER BY c.id LIMIT 1) AS campus_id
    FROM institutions i
)
INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
                       first_name, last_name, email, phone, status, staff_number)
SELECT m.institution_id, b.campus_id, m.user_id,
       'EMP' || lpad((b.top + m.rn)::text, 4, '0'),
       split_part(m.full_name, ' ', 1),
       NULLIF(btrim(substr(m.full_name, length(split_part(m.full_name, ' ', 1)) + 1)), ''),
       m.email, m.phone, 'active',
       CASE WHEN b.top + m.rn <= 9999 THEN b.top + m.rn END
  FROM missing m
  JOIN base b ON b.institution_id = m.institution_id
 WHERE b.campus_id IS NOT NULL
ON CONFLICT (institution_id, employee_code) DO NOTHING;

-- +goose Down
-- The records are real once made; nothing to undo.
SELECT 1;
