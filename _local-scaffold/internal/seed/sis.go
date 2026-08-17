package seed

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
)

// Names are drawn from common Telugu and North Indian given names and surnames,
// combined arbitrarily. They are invented; any resemblance to a real family is
// coincidental. Realistic data matters here — a list of "Student One, Student
// Two" hides the column-width, sorting and search problems that real names cause.
var (
	boyNames    = []string{"Aarav", "Vihaan", "Rohan", "Karthik", "Siddharth", "Nikhil", "Pranav", "Arjun", "Teja", "Manish", "Rishi", "Vamsi", "Harsha", "Sai", "Aditya", "Kiran", "Naveen", "Chaitanya", "Varun", "Rahul"}
	girlNames   = []string{"Ananya", "Divya", "Sneha", "Keerthi", "Meghana", "Sruthi", "Bhavana", "Pooja", "Lavanya", "Harini", "Swathi", "Nandini", "Aishwarya", "Ramya", "Deepika", "Sahithi", "Vaishnavi", "Tejaswini", "Anusha", "Madhuri"}
	surnames    = []string{"Reddy", "Rao", "Naidu", "Sharma", "Verma", "Chowdary", "Prasad", "Krishnan", "Iyer", "Gupta", "Patel", "Menon", "Nair", "Kumar", "Bhat", "Joshi", "Desai", "Malhotra"}
	fatherFirst = []string{"Ramesh", "Suresh", "Venkat", "Prakash", "Mohan", "Srinivas", "Anil", "Rajesh", "Ganesh", "Dinesh"}
	motherFirst = []string{"Padma", "Lakshmi", "Sunitha", "Radha", "Geetha", "Kavitha", "Shobha", "Usha", "Vani", "Sarala"}
	bloodGroups = []string{"A+", "B+", "O+", "AB+", "A-", "O-"}
)

// grade definitions for a full K-12 school. Levels are negative for pre-primary
// so that Class 1 can be level 1 and promotion is simply level + 1.
var gradeSpecs = []struct {
	name  string
	level int
	stage string
}{
	{"Nursery", -3, "pre_primary"},
	{"LKG", -2, "pre_primary"},
	{"UKG", -1, "pre_primary"},
	{"Class 1", 1, "primary"},
	{"Class 2", 2, "primary"},
	{"Class 3", 3, "primary"},
	{"Class 4", 4, "primary"},
	{"Class 5", 5, "primary"},
	{"Class 6", 6, "middle"},
	{"Class 7", 7, "middle"},
	{"Class 8", 8, "middle"},
	{"Class 9", 9, "secondary"},
	{"Class 10", 10, "secondary"},
}

var subjectSpecs = []struct {
	name, code, kind string
}{
	{"English", "ENG", "language"},
	{"Telugu", "TEL", "language"},
	{"Hindi", "HIN", "language"},
	{"Mathematics", "MAT", "core"},
	{"Science", "SCI", "core"},
	{"Social Studies", "SOC", "core"},
	{"Computer Science", "CSC", "elective"},
	{"Physical Education", "PED", "co_scholastic"},
}

// seedSIS builds the academic structure and a population of students for the
// primary school, then wires up a class teacher and two parent accounts so the
// scope rules can be exercised by hand.
func seedSIS(ctx context.Context, tx database.Tx, orgID, schoolID, yearID uuid.UUID,
	classTeacherUserID uuid.UUID, passwordHash string) error {

	// --- houses -------------------------------------------------------------
	houses := map[string]uuid.UUID{}
	for _, h := range []struct{ name, colour string }{
		{"Ganga", "#1D6FB8"}, {"Yamuna", "#2E9E63"},
		{"Krishna", "#C4472B"}, {"Godavari", "#B58A1B"},
	} {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO houses (organization_id, school_id, name, colour)
			VALUES ($1, $2, $3, $4) RETURNING id`,
			orgID, schoolID, h.name, h.colour).Scan(&id); err != nil {
			return fmt.Errorf("house %s: %w", h.name, err)
		}
		houses[h.name] = id
	}

	// --- subjects -----------------------------------------------------------
	for _, s := range subjectSpecs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO subjects (organization_id, school_id, name, code, kind)
			VALUES ($1, $2, $3, $4, $5)`,
			orgID, schoolID, s.name, s.code, s.kind); err != nil {
			return fmt.Errorf("subject %s: %w", s.code, err)
		}
	}

	// --- grades and sections ------------------------------------------------
	type sectionRef struct {
		id      uuid.UUID
		gradeID uuid.UUID
		label   string
	}
	var sections []sectionRef

	for _, g := range gradeSpecs {
		var gradeID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO grades (organization_id, school_id, name, level, stage)
			VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			orgID, schoolID, g.name, g.level, g.stage).Scan(&gradeID); err != nil {
			return fmt.Errorf("grade %s: %w", g.name, err)
		}

		// Two sections for the main school years, one for pre-primary — which is
		// roughly how an Indian school of this size is actually shaped.
		names := []string{"A", "B"}
		if g.level < 1 {
			names = []string{"A"}
		}
		for _, name := range names {
			var sectionID uuid.UUID
			// A real cap, so the capacity rule is exercised rather than theoretical.
			capacity := 40
			if err := tx.QueryRow(ctx, `
				INSERT INTO sections (organization_id, school_id, grade_id,
				                      academic_year_id, name, capacity)
				VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
				orgID, schoolID, gradeID, yearID, name, capacity).Scan(&sectionID); err != nil {
				return fmt.Errorf("section %s %s: %w", g.name, name, err)
			}
			sections = append(sections, sectionRef{id: sectionID, gradeID: gradeID, label: g.name + " " + name})
		}
	}

	// --- the class teacher's allocation -------------------------------------
	// Anitha is class teacher of Class 6A. This single row is what will limit her
	// to that section's students — no separate permission grant is involved.
	var class6A sectionRef
	for _, s := range sections {
		if s.label == "Class 6 A" {
			class6A = s
			break
		}
	}
	if class6A.id == uuid.Nil {
		return fmt.Errorf("seed: Class 6 A was not created")
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO section_teachers (organization_id, school_id, section_id, user_id, kind)
		VALUES ($1, $2, $3, $4, 'class_teacher')`,
		orgID, schoolID, class6A.id, classTeacherUserID); err != nil {
		return fmt.Errorf("assign class teacher: %w", err)
	}

	// --- students, guardians and enrollments --------------------------------
	// Deterministic pseudo-randomness: the same seed produces the same school
	// every time, so a bug found today is reproducible tomorrow.
	rnd := newDeterministicSource(20260601)
	admissionSeq := 1
	currentYear := time.Now().Year()

	for _, section := range sections {
		// 18 to 27 children per section: enough that lists paginate and sort
		// meaningfully, comfortably under the cap of 40.
		count := 18 + rnd.intn(10)

		for i := 0; i < count; i++ {
			isGirl := rnd.intn(2) == 0
			var first string
			if isGirl {
				first = girlNames[rnd.intn(len(girlNames))]
			} else {
				first = boyNames[rnd.intn(len(boyNames))]
			}
			surname := surnames[rnd.intn(len(surnames))]
			gender := "male"
			if isGirl {
				gender = "female"
			}

			// Age appropriate to the class: a Class 6 child is about 11.
			var level int
			if err := tx.QueryRow(ctx, `SELECT level FROM grades WHERE id = $1`, section.gradeID).
				Scan(&level); err != nil {
				return err
			}
			birthYear := currentYear - (level + 5)
			dob := time.Date(birthYear, time.Month(1+rnd.intn(12)), 1+rnd.intn(28), 0, 0, 0, 0, time.UTC)

			admissionNumber := fmt.Sprintf("VN%d%04d", currentYear%100, admissionSeq)
			admissionSeq++

			houseNames := []string{"Ganga", "Yamuna", "Krishna", "Godavari"}
			houseID := houses[houseNames[rnd.intn(len(houseNames))]]

			var studentID uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO students (organization_id, school_id, admission_number,
				                      first_name, last_name, date_of_birth, gender,
				                      blood_group, mother_tongue, house_id, admission_date,
				                      address)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Telugu', $9, $10,
				        jsonb_build_object('line1', $11::text, 'city', 'Hyderabad',
				                           'district', 'Hyderabad', 'state', 'Telangana',
				                           'pin', '500034'))
				RETURNING id`,
				orgID, schoolID, admissionNumber, first, surname, dob, gender,
				bloodGroups[rnd.intn(len(bloodGroups))], houseID,
				time.Date(currentYear, 6, 1, 0, 0, 0, 0, time.UTC),
				fmt.Sprintf("%d-%d, Sector %d", 1+rnd.intn(99), 1+rnd.intn(40), 1+rnd.intn(12)),
			).Scan(&studentID); err != nil {
				return fmt.Errorf("student %s: %w", admissionNumber, err)
			}

			if _, err := tx.Exec(ctx, `
				INSERT INTO enrollments (organization_id, school_id, student_id,
				                         academic_year_id, grade_id, section_id, roll_number)
				VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				orgID, schoolID, studentID, yearID, section.gradeID, section.id, i+1); err != nil {
				return fmt.Errorf("enrol %s: %w", admissionNumber, err)
			}

			if _, err := tx.Exec(ctx, `
				INSERT INTO student_lifecycle_events
					(organization_id, student_id, kind, to_state, effective_on)
				VALUES ($1, $2, 'enrolled',
				        jsonb_build_object('section', $3::text), $4)`,
				orgID, studentID, section.label,
				time.Date(currentYear, 6, 1, 0, 0, 0, 0, time.UTC)); err != nil {
				return fmt.Errorf("lifecycle %s: %w", admissionNumber, err)
			}

			// Father and mother, both contactable, father pays the fees. The
			// mother is the primary contact for half the families — schools
			// really are split roughly this way.
			father := fatherFirst[rnd.intn(len(fatherFirst))] + " " + surname
			mother := motherFirst[rnd.intn(len(motherFirst))] + " " + surname
			motherIsPrimary := rnd.intn(2) == 0

			for _, g := range []struct {
				name, relation string
				primary, pays  bool
			}{
				{father, "father", !motherIsPrimary, true},
				{mother, "mother", motherIsPrimary, false},
			} {
				var guardianID uuid.UUID
				if err := tx.QueryRow(ctx, `
					INSERT INTO guardians (organization_id, school_id, full_name, phone, occupation)
					VALUES ($1, $2, $3, $4, $5) RETURNING id`,
					orgID, schoolID, g.name,
					fmt.Sprintf("+919%09d", rnd.intn(1000000000)),
					pickOccupation(rnd, g.relation)).Scan(&guardianID); err != nil {
					return fmt.Errorf("guardian %s: %w", g.name, err)
				}
				if _, err := tx.Exec(ctx, `
					INSERT INTO student_guardians (student_id, guardian_id, organization_id,
					                               relation, is_primary, is_emergency_contact,
					                               financial_responsibility)
					VALUES ($1, $2, $3, $4, $5, true, $6)`,
					studentID, guardianID, orgID, g.relation, g.primary, g.pays); err != nil {
					return fmt.Errorf("link guardian %s: %w", g.name, err)
				}
			}
		}
	}

	// --- a parent login, with two children in different classes -------------
	// This is the case that breaks naive implementations: one account, two
	// children, in two different sections, taught by different teachers.
	return seedParentAccount(ctx, tx, orgID, schoolID, passwordHash)
}

func pickOccupation(rnd *deterministicSource, relation string) string {
	jobs := []string{"Software Engineer", "Teacher", "Bank Officer", "Doctor",
		"Shop Owner", "Civil Servant", "Farmer", "Accountant", "Homemaker", "Driver"}
	if relation == "mother" && rnd.intn(3) == 0 {
		return "Homemaker"
	}
	return jobs[rnd.intn(len(jobs))]
}

// seedParentAccount takes two existing students from different sections and
// gives their father a login, so the "one parent, several children" path is
// exercised from the very first run.
func seedParentAccount(ctx context.Context, tx database.Tx, orgID, schoolID uuid.UUID, passwordHash string) error {
	var parentUserID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO users (organization_id, email, full_name, password_hash)
		VALUES ($1, 'ramesh.chowdary@example.test', 'Ramesh Chowdary', $2)
		RETURNING id`, orgID, passwordHash).Scan(&parentUserID); err != nil {
		return fmt.Errorf("create parent user: %w", err)
	}

	var parentRoleID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM roles WHERE key = 'parent' AND organization_id IS NULL`).
		Scan(&parentRoleID); err != nil {
		return fmt.Errorf("find parent role: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO memberships (user_id, organization_id, school_id, role_id)
		VALUES ($1, $2, $3, $4)`, parentUserID, orgID, schoolID, parentRoleID); err != nil {
		return fmt.Errorf("parent membership: %w", err)
	}

	// One guardian record carrying the login, linked to two children who are in
	// different sections.
	var guardianID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO guardians (organization_id, school_id, full_name, phone, email,
		                       occupation, user_id)
		VALUES ($1, $2, 'Ramesh Chowdary', '+919876543210',
		        'ramesh.chowdary@example.test', 'Software Engineer', $3)
		RETURNING id`, orgID, schoolID, parentUserID).Scan(&guardianID); err != nil {
		return fmt.Errorf("create parent guardian: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (e.section_id) s.id
		FROM   students s
		JOIN   enrollments e ON e.student_id = s.id AND e.status = 'active'
		JOIN   sections sec  ON sec.id = e.section_id
		JOIN   grades g      ON g.id = sec.grade_id
		WHERE  g.name IN ('Class 6', 'Class 9') AND sec.name = 'A'
		ORDER  BY e.section_id, s.first_name
		LIMIT  2`)
	if err != nil {
		return fmt.Errorf("find children for parent: %w", err)
	}
	var childIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		childIDs = append(childIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(childIDs) < 2 {
		return fmt.Errorf("seed: expected two children for the parent account, found %d", len(childIDs))
	}

	for i, childID := range childIDs {
		// Replace whichever father was generated for these two children, so the
		// parent account is the real link rather than a third guardian.
		if _, err := tx.Exec(ctx, `
			UPDATE student_guardians SET status = 'revoked'
			WHERE  student_id = $1 AND relation = 'father'`, childID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO student_guardians (student_id, guardian_id, organization_id,
			                               relation, is_primary, is_emergency_contact,
			                               financial_responsibility)
			VALUES ($1, $2, $3, 'father', $4, true, true)`,
			childID, guardianID, orgID, i == 0); err != nil {
			return fmt.Errorf("link parent to child: %w", err)
		}
	}
	return nil
}

// deterministicSource is a tiny linear congruential generator. math/rand would
// do, but seeding it explicitly here makes it obvious that the seed data is
// meant to be reproducible rather than merely arbitrary.
type deterministicSource struct{ state uint64 }

func newDeterministicSource(seed uint64) *deterministicSource {
	return &deterministicSource{state: seed}
}

func (d *deterministicSource) intn(n int) int {
	d.state = d.state*6364136223846793005 + 1442695040888963407
	return int((d.state >> 33) % uint64(n))
}
