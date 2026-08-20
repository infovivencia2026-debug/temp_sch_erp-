package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/rbac"
)

// seedDemoUsers creates one signed-in-able account per catalog role and wires
// up the assignments each role's data scope depends on.
//
// Without the wiring the accounts are useless for testing: a HOD with no
// department, a teacher with no sections and a guardian with no children all
// resolve to an empty scope, which is correct behaviour but proves nothing.
// This gives every role something real to see.
func seedDemoUsers(ctx context.Context, db *database.DB, pepper, password, institution string) error {
	hasher := auth.NewHasher(pepper)
	hash, err := hasher.Hash(password)
	if err != nil {
		return err
	}

	return db.AsPlatform(ctx, func(tx pgx.Tx) error {
		instID, err := pickInstitution(ctx, tx, institution)
		if err != nil {
			return err
		}

		var campusID uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM campuses WHERE institution_id = $1 ORDER BY created_at LIMIT 1`,
			instID).Scan(&campusID); err != nil {
			// Every scoped table needs a campus, so make one rather than fail.
			if err := tx.QueryRow(ctx, `
				INSERT INTO campuses (institution_id, name, code)
				VALUES ($1,'Main Campus','MAIN') RETURNING id`, instID).Scan(&campusID); err != nil {
				return fmt.Errorf("create campus: %w", err)
			}
		}

		/* Namespaced when a school is named, bare when one is not.

		   Usernames are unique within a school and not across them, and
		   signing in insists on exactly one match — so seeding a second
		   school's demo users produced a "faculty" in each and neither could
		   sign in. Every demo account on the installation broke the moment a
		   second set existed, with a 401 that looks like a wrong password.

		   The bare names are kept for the default run so an installation that
		   already has demo accounts keeps them: the upsert is keyed on the
		   email, and changing the pattern unconditionally would orphan every
		   existing demo account and create a parallel set beside it. */
		prefix := ""
		domain := "vivencia.test"
		if strings.TrimSpace(institution) != "" {
			prefix = "demo."
			domain = "demo.test"
		}

		for _, role := range catalog.Roles {
			email := role.Key + "@" + domain
			// The role key doubles as the username, so the demo signs in as
			// "student" rather than "student@vivencia.test". Nobody
			// demonstrating this software should have to type a domain.
			username := prefix + role.Key

			// Platform roles carry institution_id NULL, which is what makes
			// app_is_platform_admin apply to them. Taken from rbac rather than
			// listed again here: seller_admin was added and this branch still
			// named only super_admin, so the demo seller was created inside a
			// school and could not sign in to their own console.
			var owner any = instID
			if rbac.PlatformRoles[role.Key] {
				owner = nil
			}

			var userID uuid.UUID
			if owner == nil {
				if err := tx.QueryRow(ctx, `
					INSERT INTO users (institution_id, email, username, full_name,
					                   password_hash, status)
					VALUES (NULL,$1::citext,$2::citext,$3,$4,'active')
					ON CONFLICT (email) WHERE institution_id IS NULL
					DO UPDATE SET password_hash = EXCLUDED.password_hash,
					              username = EXCLUDED.username, status='active'
					RETURNING id`, email, username, "Demo "+role.Name, hash).Scan(&userID); err != nil {
					return fmt.Errorf("upsert %s: %w", email, err)
				}
			} else {
				if err := tx.QueryRow(ctx, `
					INSERT INTO users (institution_id, email, username, full_name,
					                   password_hash, status)
					VALUES ($1,$2::citext,$3::citext,$4,$5,'active')
					ON CONFLICT (institution_id, email) WHERE email IS NOT NULL
					DO UPDATE SET password_hash = EXCLUDED.password_hash,
					              username = EXCLUDED.username, status='active'
					RETURNING id`, instID, email, username, "Demo "+role.Name, hash).Scan(&userID); err != nil {
					return fmt.Errorf("upsert %s: %w", email, err)
				}
			}

			var roleID uuid.UUID
			if err := tx.QueryRow(ctx, `
				SELECT id FROM roles
				 WHERE key = $1
				   AND COALESCE(institution_id,'00000000-0000-0000-0000-000000000000'::uuid)
				     = COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`,
				role.Key, owner).Scan(&roleID); err != nil {
				return fmt.Errorf("role %s missing — run seed first: %w", role.Key, err)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO user_roles (institution_id, user_id, role_id)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, owner, userID, roleID); err != nil {
				return fmt.Errorf("assign %s: %w", role.Key, err)
			}

			if err := wireScope(ctx, tx, role.Key, instID, campusID, userID); err != nil {
				return fmt.Errorf("wire %s: %w", role.Key, err)
			}
			slog.Info("demo user", "role", role.Key, "email", email)
		}
		return nil
	})
}

/* Which school the demo is being built in.

   Every seeder here took "the oldest institution", which is fine on a fresh
   installation with one school and destructive on one with nine: the wiring
   below reassigns the first two sections' class teacher, and pointed at a
   school that is actually running, it takes those sections away from the
   people who teach them.

   An empty name keeps the old behaviour so existing invocations are
   unchanged. A name matches exactly, and a uuid matches by id, because the
   nine schools on this installation include two called SGHS.
*/
func pickInstitution(ctx context.Context, tx pgx.Tx, want string) (uuid.UUID, error) {
	want = strings.TrimSpace(want)
	var id uuid.UUID
	if want == "" {
		err := tx.QueryRow(ctx,
			`SELECT id FROM institutions ORDER BY created_at LIMIT 1`).Scan(&id)
		if err != nil {
			return id, fmt.Errorf("no institution: %w", err)
		}
		return id, nil
	}
	if parsed, err := uuid.Parse(want); err == nil {
		if err := tx.QueryRow(ctx,
			`SELECT id FROM institutions WHERE id = $1`, parsed).Scan(&id); err != nil {
			return id, fmt.Errorf("no institution with id %s: %w", want, err)
		}
		return id, nil
	}
	rows, err := tx.Query(ctx, `SELECT id FROM institutions WHERE name = $1`, want)
	if err != nil {
		return id, err
	}
	defer rows.Close()
	var found []uuid.UUID
	for rows.Next() {
		var one uuid.UUID
		if err := rows.Scan(&one); err != nil {
			return id, err
		}
		found = append(found, one)
	}
	if err := rows.Err(); err != nil {
		return id, err
	}
	switch len(found) {
	case 0:
		return id, fmt.Errorf("no institution named %q", want)
	case 1:
		return found[0], nil
	default:
		// Refusing beats picking one: seeding demo data into the wrong school
		// of two with the same name is not something anybody notices quickly.
		return id, fmt.Errorf("%d institutions are named %q — pass the uuid instead",
			len(found), want)
	}
}

// staffRoles are the roles held by people the school employs. Each needs an
// employees row: leave, the staff register and payroll all key off it, and a
// teacher without one simply cannot apply for a day off.
var staffRoles = map[string]bool{
	"institution_admin": true, "hod": true, "faculty": true, "finance": true,
	"admissions": true, "hr": true, "operations": true,
}

// wireScope gives the scope-narrowed roles something inside their boundary.
func wireScope(ctx context.Context, tx pgx.Tx, roleKey string, inst, campus, userID uuid.UUID) error {
	if staffRoles[roleKey] {
		code := strings.ToUpper(roleKey) + "-DEMO"
		if _, err := tx.Exec(ctx, `
			INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
			                       first_name, last_name, status)
			VALUES ($1,$2,$3,$4,'Demo',$5,'active')
			ON CONFLICT (institution_id, employee_code)
			DO UPDATE SET user_id = EXCLUDED.user_id`,
			inst, campus, userID, code, roleKey); err != nil {
			return err
		}
	}

	switch roleKey {
	case "hod":
		// Head the first department, creating one if the tenant has none.
		var deptID uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM departments WHERE institution_id = $1 ORDER BY name LIMIT 1`, inst).Scan(&deptID)
		if err != nil {
			if err := tx.QueryRow(ctx, `
				INSERT INTO departments (institution_id, campus_id, name)
				VALUES ($1,$2,'Science') RETURNING id`, inst, campus).Scan(&deptID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE departments SET head_user_id = $2 WHERE id = $1`, deptID, userID); err != nil {
			return err
		}

		/* Put the teaching staff in the department they head.

		   Nothing ever set employees.department_id, so the HOD's entire
		   workspace answered zero — no faculty, no sections, no students —
		   while the queries behind it were correct. A head of department
		   logging in to a screen of noughts concludes the module is broken,
		   and they are not wrong to.

		   The head themselves is included: a HOD in an Indian school teaches. */
		_, err = tx.Exec(ctx, `
			UPDATE employees SET department_id = $2
			 WHERE institution_id = $1
			   AND department_id IS NULL
			   AND user_id IN (
			     SELECT ur.user_id FROM user_roles ur
			       JOIN roles r ON r.id = ur.role_id
			      WHERE r.key IN ('faculty','hod'))`, inst, deptID)
		return err

	case "faculty":
		// Class-teacher of two sections, so ScopeAssignedClasses is non-empty
		// even with no timetable loaded. Released first and ordered by a unique
		// key: "ORDER BY name LIMIT 2" over eight sections named A/B is
		// non-deterministic, so re-runs kept adding sections instead of
		// replacing them.
		if _, err := tx.Exec(ctx,
			`UPDATE sections SET class_teacher_id = NULL WHERE class_teacher_id = $1`,
			userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE sections SET class_teacher_id = $2
			 WHERE id IN (
			   SELECT s.id FROM sections s JOIN classes c ON c.id = s.class_id
			    WHERE s.institution_id = $1
			    ORDER BY c.level, s.name LIMIT 2)`, inst, userID); err != nil {
			return err
		}

		/* Give them lessons to teach, not just a register to mark.

		   Being class teacher put sections in their scope but left them off the
		   timetable, so "Today's classes" — the first screen a teacher opens —
		   was empty every day, while the accountant, who happened to be picked
		   up by an earlier assignment pass, had a full teaching week. A demo
		   where the teacher has nothing to teach is not a demo of a school. */
		if _, err := tx.Exec(ctx, `
			INSERT INTO section_subject_teachers (institution_id, section_id,
			                                      class_subject_id, teacher_user_id)
			SELECT $1, sec.id, cs.id, $2
			  FROM sections sec
			  JOIN class_subjects cs ON cs.class_id = sec.class_id
			 WHERE sec.class_teacher_id = $2
			ON CONFLICT (section_id, class_subject_id)
			DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
			inst, userID); err != nil {
			return err
		}

		// Release this teacher's slots first, then take one lesson per period so
		// the timetable_teacher_slot index is respected: two sections share a
		// period grid, and nobody teaches both at nine o'clock on Monday.
		if _, err := tx.Exec(ctx,
			`UPDATE timetable_entries SET teacher_user_id = NULL
			  WHERE teacher_user_id = $1`, userID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			WITH pick AS (
			  SELECT DISTINCT ON (te.weekday, te.period_id) te.id
			    FROM timetable_entries te
			    JOIN sections sec ON sec.id = te.section_id
			   WHERE sec.class_teacher_id = $1
			     AND te.teacher_user_id IS NULL
			   ORDER BY te.weekday, te.period_id, te.section_id
			)
			UPDATE timetable_entries SET teacher_user_id = $1
			 WHERE id IN (SELECT id FROM pick)`, userID)
		return err

	case "student":
		// Attach to a student that has no user yet — but only if this account is
		// not already attached to one. students.user_id is unique, so a second
		// run would otherwise fail with a duplicate key.
		_, err := tx.Exec(ctx, `
			UPDATE students SET user_id = $2
			 WHERE id = (SELECT id FROM students
			              WHERE institution_id = $1 AND user_id IS NULL
			              ORDER BY admission_no LIMIT 1)
			   AND NOT EXISTS (SELECT 1 FROM students WHERE user_id = $2)`, inst, userID)
		return err

	case "parent":
		// Become the guardian of the first two students, so the child switcher
		// has something to switch between. Idempotent: clear this account's
		// existing links first, since guardians.user_id is not unique and a
		// re-run would otherwise keep accumulating children.
		if _, err := tx.Exec(ctx,
			`UPDATE guardians SET user_id = NULL WHERE user_id = $1`, userID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE guardians SET user_id = $2
			 WHERE id IN (
			   SELECT sg.guardian_id FROM student_guardians sg
			     JOIN students st ON st.id = sg.student_id
			    WHERE st.institution_id = $1
			    ORDER BY st.admission_no LIMIT 2)`, inst, userID)
		return err

	case "operations", "finance", "admissions", "hr", "institution_admin":
		// Institution-wide roles need an employee row so HR views and workload
		// queries have something to join to.
		// Whole key, not a fixed-length prefix: "hr" is only two characters.
		code := strings.ToUpper(roleKey) + "-DEMO"
		_, err := tx.Exec(ctx, `
			INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
			                       first_name, last_name, status)
			VALUES ($1,$2,$3,$4,'Demo',$5,'active')
			ON CONFLICT (institution_id, employee_code) DO UPDATE SET user_id = EXCLUDED.user_id`,
			inst, campus, userID, code, roleKey)
		return err
	}
	return nil
}

// seedDemoData creates a small but internally consistent school: one academic
// year, four classes with two sections each, subjects, periods, students with
// guardians and enrolments, a timetable, a month of attendance, and invoices.
//
// It exists so the scope-narrowed roles have something to resolve to. A demo
// where every teacher has no sections and every guardian has no children
// exercises none of the interesting code.
func seedDemoData(ctx context.Context, db *database.DB, institution string) error {
	return db.AsPlatform(ctx, func(tx pgx.Tx) error {
		var inst, campus uuid.UUID
		var perr error
		if inst, perr = pickInstitution(ctx, tx, institution); perr != nil {
			return perr
		}
		/* Reuse whatever campus the school already has.

		   This upserted on the code 'MAIN', so a school that renamed its
		   campus through the product — which is the first thing the setup
		   wizard invites them to do — got a *second* campus on the next seed.
		   The duplicate then doubled the period list, because periods hang off
		   a campus, and the timetable seeded twice as many slots as there are
		   hours in a school day.

		   A campus is identified by being the institution's, not by its code. */
		err := tx.QueryRow(ctx,
			`SELECT id FROM campuses WHERE institution_id = $1
			  ORDER BY created_at LIMIT 1`, inst).Scan(&campus)
		if errors.Is(err, pgx.ErrNoRows) {
			err = tx.QueryRow(ctx, `
				INSERT INTO campuses (institution_id, name, code)
				VALUES ($1,'Main Campus','MAIN') RETURNING id`, inst).Scan(&campus)
		}
		if err != nil {
			return fmt.Errorf("campus: %w", err)
		}

		// Sequential statements, not one big WITH: a data-modifying CTE's rows
		// are not visible to sibling CTEs in the same statement, so inserting
		// classes and then selecting them in the same query yields nothing.
		steps := []struct {
			name string
			sql  string
			args []any
		}{
			{"academic year", `
				INSERT INTO academic_years (institution_id, campus_id, name, starts_on, ends_on, is_current)
				VALUES ($1,$2,'2026-27', DATE '2026-04-01', DATE '2027-03-31', true)
				ON CONFLICT DO NOTHING`, []any{inst, campus}},

			{"classes", `
				INSERT INTO classes (institution_id, campus_id, name, level)
				SELECT $1,$2,'Grade '||g, g FROM generate_series(6,9) g
				ON CONFLICT DO NOTHING`, []any{inst, campus}},

			{"subjects", `
				INSERT INTO subjects (institution_id, campus_id, name, code, is_scholastic)
				VALUES ($1,$2,'Mathematics','MATH',true),
				       ($1,$2,'Science','SCI',true),
				       ($1,$2,'English','ENG',true),
				       ($1,$2,'Social Studies','SST',true),
				       ($1,$2,'Physical Education','PE',false)
				ON CONFLICT DO NOTHING`, []any{inst, campus}},

			{"periods", `
				INSERT INTO periods (institution_id, campus_id, name, sequence, starts_at, ends_at, is_break)
				VALUES ($1,$2,'P1',1,'08:00','08:45',false),
				       ($1,$2,'P2',2,'08:45','09:30',false),
				       ($1,$2,'Break',3,'09:30','09:50',true),
				       ($1,$2,'P3',4,'09:50','10:35',false),
				       ($1,$2,'P4',5,'10:35','11:20',false),
				       ($1,$2,'P5',6,'11:20','12:05',false)
				ON CONFLICT DO NOTHING`, []any{inst, campus}},

			{"sections", `
				INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id, name, capacity, room)
				SELECT $1,$2,c.id,
				       (SELECT id FROM academic_years WHERE institution_id=$1 ORDER BY starts_on DESC LIMIT 1),
				       v.s, 40, 'R'||c.level||v.s
				  FROM classes c CROSS JOIN (VALUES ('A'),('B')) v(s)
				 WHERE c.institution_id = $1
				ON CONFLICT DO NOTHING`, []any{inst, campus}},
		}
		for _, st := range steps {
			if _, err := tx.Exec(ctx, st.sql, st.args...); err != nil {
				return fmt.Errorf("%s: %w", st.name, err)
			}
		}

		// class_subjects: every class offers every subject.
		if _, err := tx.Exec(ctx, `
			INSERT INTO class_subjects (institution_id, class_id, subject_id)
			SELECT $1, c.id, s.id FROM classes c CROSS JOIN subjects s
			 WHERE c.institution_id = $1 AND s.institution_id = $1
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("class_subjects: %w", err)
		}

		// Students: 12 per section, deterministic names so re-runs are stable.
		if _, err := tx.Exec(ctx, `
			WITH sec AS (
			  SELECT s.id, row_number() OVER (ORDER BY c.level, s.name) AS sn
			    FROM sections s JOIN classes c ON c.id = s.class_id
			   WHERE s.institution_id = $1
			)
			INSERT INTO students (institution_id, campus_id, admission_no, first_name, last_name,
			                      date_of_birth, gender, admission_date, status)
			SELECT $1, $2,
			       'ADM' || lpad(((sec.sn - 1) * 12 + n)::text, 4, '0'),
			       (ARRAY['Aarav','Diya','Kabir','Isha','Vivaan','Anaya','Reyansh','Myra',
			              'Arjun','Sara','Vihaan','Kiara'])[n],
			       (ARRAY['Sharma','Iyer','Khan','Reddy','Nair','Patel','Bose','Gupta',
			              'Menon','Rao','Das','Joshi'])[n],
			       DATE '2012-01-01' + (((sec.sn * 12 + n) % 900)::int),
			       CASE WHEN n % 2 = 0 THEN 'female' ELSE 'male' END,
			       DATE '2026-04-05', 'active'
			  FROM sec CROSS JOIN generate_series(1,12) n
			ON CONFLICT (institution_id, admission_no) DO NOTHING`, inst, campus); err != nil {
			return fmt.Errorf("students: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			WITH sec AS (
			  SELECT s.id, s.class_id, row_number() OVER (ORDER BY c.level, s.name) AS sn
			    FROM sections s JOIN classes c ON c.id = s.class_id
			   WHERE s.institution_id = $1
			)
			INSERT INTO enrollments (institution_id, student_id, academic_year_id, class_id,
			                         section_id, roll_no, status)
			SELECT $1, st.id,
			       (SELECT id FROM academic_years WHERE institution_id=$1 ORDER BY starts_on DESC LIMIT 1),
			       sec.class_id, sec.id,
			       ((substring(st.admission_no from 4)::int - 1) % 12) + 1,
			       'active'
			  FROM students st
			  JOIN sec ON sec.sn = ((substring(st.admission_no from 4)::int - 1) / 12) + 1
			 WHERE st.institution_id = $1
			   -- Only the seeder's own ADM#### rows. Students admitted through
			   -- the real workflow carry a generated number like 2026-27/00005,
			   -- and parsing a digit offset out of that fails.
			   AND st.admission_no ~ '^ADM[0-9]+$' 
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("enrollments: %w", err)
		}

		// Clear the residue of the name-join before re-linking.
		//
		// The insert below is correct now and ON CONFLICT DO NOTHING, which
		// means it adds the right rows but never removes the wrong ones. A
		// database seeded before the fix keeps its fan-out for ever: the demo
		// guardian still answered for eight unrelated children, and the test
		// that catches it stayed red against an otherwise-fixed seeder.
		//
		// Five is the cut. Siblings are real and a guardian with two or three
		// children is ordinary; five in one demo cohort of a hundred is only
		// ever the old bug.
		if tag, err := tx.Exec(ctx, `
			DELETE FROM student_guardians sg
			 WHERE sg.institution_id = $1
			   AND sg.guardian_id IN (
			     SELECT guardian_id FROM student_guardians
			      WHERE institution_id = $1
			      GROUP BY guardian_id HAVING count(*) >= 5)`, inst); err != nil {
			return fmt.Errorf("clear fanned-out guardians: %w", err)
		} else if tag.RowsAffected() > 0 {
			slog.Info("removed guardian links left by the old name-join",
				"rows", tag.RowsAffected())
		}

		// Guardians are keyed to their student by the student's admission number,
		// which is unique. Joining on the display name looked equivalent and was
		// not: only twelve distinct first names exist across the cohort, so every
		// guardian matched eight unrelated children.
		if _, err := tx.Exec(ctx, `
			INSERT INTO guardians (institution_id, full_name, relation, phone, email)
			SELECT $1,
			       'Guardian of ' || st.first_name || ' ' || st.admission_no,
			       'father',
			       '9' || lpad((('x'||substr(md5(st.admission_no),1,8))::bit(32)::bigint % 1000000000)::text, 9, '0'),
			       lower(st.admission_no) || '.parent@example.test'
			  FROM students st WHERE st.institution_id = $1
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("guardians: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
			SELECT st.id, g.id, $1, true
			  FROM students st
			  JOIN guardians g
			    ON g.email = (lower(st.admission_no) || '.parent@example.test')::citext
			 WHERE st.institution_id = $1
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("student_guardians: %w", err)
		}

		/* A timetable for the sections that actually have children in them.

		   The recovered production dump carried a grid for one section that
		   nobody is enrolled in, so once the timetable was scoped to the
		   caller — as it must be, or "My timetable" shows another class's day —
		   every teacher, student and parent saw an empty week while the
		   principal saw a full one. The data was the problem, not the scope.

		   Subjects rotate through the week by position so a class does not sit
		   the same lesson every day. Both unique indexes are left to arbitrate:
		   one section cannot hold two lessons in a period, and one teacher
		   cannot be in two rooms at once. A collision simply yields a free
		   period, which is what a real timetable has. */
		if _, err := tx.Exec(ctx, `
			WITH slots AS (
			    SELECT sec.id AS section_id, sec.class_id, d.weekday, p.id AS period_id,
			           row_number() OVER (PARTITION BY sec.id
			                              ORDER BY d.weekday, p.sequence) AS n
			      FROM sections sec
			      JOIN classes cl ON cl.id = sec.class_id
			      JOIN periods p  ON p.campus_id = cl.campus_id AND NOT p.is_break
			      CROSS JOIN generate_series(1,5) AS d(weekday)
			     WHERE sec.institution_id = $1
			       AND EXISTS (SELECT 1 FROM enrollments e
			                    WHERE e.section_id = sec.id AND e.status = 'active')
			), subject_pool AS (
			    SELECT cs.id, cs.class_id,
			           row_number() OVER (PARTITION BY cs.class_id ORDER BY cs.id) - 1 AS idx,
			           count(*)    OVER (PARTITION BY cs.class_id) AS total
			      FROM class_subjects cs
			)
			INSERT INTO timetable_entries (institution_id, academic_year_id, section_id,
			                               class_subject_id, period_id, weekday,
			                               teacher_user_id)
			SELECT $1, (SELECT id FROM academic_years WHERE is_current LIMIT 1),
			       s.section_id, sp.id, s.period_id, s.weekday,
			       (SELECT t.teacher_user_id FROM section_subject_teachers t
			         WHERE t.section_id = s.section_id AND t.class_subject_id = sp.id)
			  FROM slots s
			  JOIN subject_pool sp
			    ON sp.class_id = s.class_id AND sp.idx = (s.n - 1) % sp.total
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("timetable: %w", err)
		}

		/* Fill the holes the teacher-clash left, without a teacher.

		   One teacher covers many class-subjects in this dataset, and the
		   teacher-slot index rightly refuses to put them in two rooms at nine
		   o'clock on Monday. The first pass therefore drops those lessons
		   entirely, which left Grade 6-A with seven periods in a week. A lesson
		   with no teacher named yet is what a school actually has in August;
		   a blank Tuesday is not. */
		if _, err := tx.Exec(ctx, `
			WITH slots AS (
			    SELECT sec.id AS section_id, sec.class_id, d.weekday, p.id AS period_id,
			           row_number() OVER (PARTITION BY sec.id
			                              ORDER BY d.weekday, p.sequence) AS n
			      FROM sections sec
			      JOIN classes cl ON cl.id = sec.class_id
			      JOIN periods p  ON p.campus_id = cl.campus_id AND NOT p.is_break
			      CROSS JOIN generate_series(1,5) AS d(weekday)
			     WHERE sec.institution_id = $1
			       AND EXISTS (SELECT 1 FROM enrollments e
			                    WHERE e.section_id = sec.id AND e.status = 'active')
			), subject_pool AS (
			    SELECT cs.id, cs.class_id,
			           row_number() OVER (PARTITION BY cs.class_id ORDER BY cs.id) - 1 AS idx,
			           count(*)    OVER (PARTITION BY cs.class_id) AS total
			      FROM class_subjects cs
			)
			INSERT INTO timetable_entries (institution_id, academic_year_id, section_id,
			                               class_subject_id, period_id, weekday)
			SELECT $1, (SELECT id FROM academic_years WHERE is_current LIMIT 1),
			       s.section_id, sp.id, s.period_id, s.weekday
			  FROM slots s
			  JOIN subject_pool sp
			    ON sp.class_id = s.class_id AND sp.idx = (s.n - 1) % sp.total
			 WHERE NOT EXISTS (SELECT 1 FROM timetable_entries te
			                    WHERE te.section_id = s.section_id
			                      AND te.weekday = s.weekday
			                      AND te.period_id = s.period_id)
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("timetable gaps: %w", err)
		}

		// A month of attendance, weekdays only, ~92% present.
		if _, err := tx.Exec(ctx, `
			INSERT INTO student_attendance (institution_id, student_id, section_id, on_date, status)
			SELECT $1, e.student_id, e.section_id, d::date,
			       CASE WHEN random() < 0.92 THEN 'present'
			            WHEN random() < 0.6  THEN 'absent'
			            ELSE 'late' END
			  FROM enrollments e
			  CROSS JOIN generate_series(CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day') d
			 WHERE e.institution_id = $1
			   AND extract(isodow FROM d) < 6
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("attendance: %w", err)
		}

		// Fee heads, one invoice per student, and payments for ~70% of them.
		if _, err := tx.Exec(ctx, `
			INSERT INTO fee_heads (institution_id, name, code, is_recurring)
			VALUES ($1,'Tuition','TUI',true), ($1,'Transport','TRN',true),
			       ($1,'Lab','LAB',false), ($1,'Sports','SPT',false)
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("fee_heads: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
			                      invoice_no, issued_on, due_on, gross_paise, status)
			SELECT $1, $2, st.id,
			       (SELECT id FROM academic_years WHERE institution_id=$1 ORDER BY starts_on DESC LIMIT 1),
			       'INV-' || st.admission_no,
			       CURRENT_DATE - 20,
			       CURRENT_DATE - 20 + 14,
			       4500000, 'unpaid'
			  FROM students st WHERE st.institution_id = $1
			ON CONFLICT DO NOTHING`, inst, campus); err != nil {
			return fmt.Errorf("invoices: %w", err)
		}

		// Payments allocate against the invoice, which fires sync_invoice_paid
		// and moves the invoice to paid/partial automatically.
		if _, err := tx.Exec(ctx, `
			WITH pay AS (
			  INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
			                        amount_paise, mode, paid_on, status)
			  SELECT $1, $2, i.student_id, 'RCPT-' || i.invoice_no,
			         CASE WHEN random() < 0.75 THEN i.gross_paise ELSE i.gross_paise / 2 END,
			         (ARRAY['cash','upi','card','netbanking'])[1 + floor(random()*4)::int],
			         CURRENT_DATE - floor(random()*15)::int, 'success'
			    FROM invoices i
			   WHERE i.institution_id = $1 AND random() < 0.7
			  ON CONFLICT DO NOTHING
			  RETURNING id, student_id, amount_paise
			)
			INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
			SELECT $1, p.id, i.id, p.amount_paise
			  FROM pay p JOIN invoices i ON i.student_id = p.student_id
			ON CONFLICT DO NOTHING`, inst, campus); err != nil {
			return fmt.Errorf("payments: %w", err)
		}

		// Spread subject teaching across the staff who have logins, so
		// workload, timetable generation and teacher scope all have real data.
		if _, err := tx.Exec(ctx, `
			INSERT INTO section_subject_teachers (institution_id, section_id,
			                                      class_subject_id, teacher_user_id)
			SELECT $1, sec.id, cs.id, u.id
			  FROM sections sec
			  JOIN class_subjects cs ON cs.class_id = sec.class_id
			  JOIN LATERAL (
			      SELECT e.user_id AS id,
			             row_number() OVER (ORDER BY e.employee_code) AS rn,
			             count(*) OVER () AS total
			        FROM employees e
			       WHERE e.institution_id = $1 AND e.user_id IS NOT NULL
			  ) u ON u.rn = 1 + (abs(hashtext(sec.id::text || cs.id::text)) % u.total)
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return fmt.Errorf("subject teachers: %w", err)
		}

		slog.Info("demo data seeded")
		return nil
	})
}
