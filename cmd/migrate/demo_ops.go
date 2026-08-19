package main

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

/*
Demo data for everything the first seeder left empty.

seedDemoData built the spine — students, enrolments, timetable, attendance,
invoices, payments — and stopped there. So a school opened the product and
found the register full and the exam screen, the library, the bus list and the
staff register all blank, which reads as "nothing works" rather than "nothing
seeded". A screen with no rows cannot demonstrate anything, and it cannot be
told apart from a broken one.

Everything here is idempotent: each block asks whether its table already has
rows for this institution and returns early if it does. Re-running tops up a
school that was seeded before these existed without duplicating what is there.
*/
func seedDemoOperations(ctx context.Context, db *database.DB) error {
	return db.AsPlatform(ctx, func(tx pgx.Tx) error {
		var inst, campus, year uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM institutions ORDER BY created_at LIMIT 1`).Scan(&inst); err != nil {
			return fmt.Errorf("no institution: %w", err)
		}
		if err := tx.QueryRow(ctx,
			`SELECT id FROM campuses WHERE institution_id = $1 ORDER BY created_at LIMIT 1`,
			inst).Scan(&campus); err != nil {
			return fmt.Errorf("no campus: %w", err)
		}
		if err := tx.QueryRow(ctx, `
			SELECT id FROM academic_years WHERE institution_id = $1
			 ORDER BY is_current DESC, starts_on DESC LIMIT 1`, inst).Scan(&year); err != nil {
			return fmt.Errorf("no academic year: %w", err)
		}

		for _, step := range []struct {
			name string
			fn   func(context.Context, pgx.Tx, uuid.UUID, uuid.UUID, uuid.UUID) (int, error)
		}{
			{"exams and marks", seedExams},
			{"staff attendance", seedStaffAttendance},
			{"library", seedLibrary},
			{"transport", seedTransport},
			{"fee structure", seedFeeStructure},
			{"attendance corrections", seedCorrections},
			{"admissions pipeline", seedPipeline},
			{"hostel", seedHostel},
			{"infirmary", seedInfirmary},
			{"stores", seedStores},
		} {
			n, err := step.fn(ctx, tx, inst, campus, year)
			if err != nil {
				return fmt.Errorf("%s: %w", step.name, err)
			}
			slog.Info("demo", "step", step.name, "rows", n)
		}
		return nil
	})
}

// seedExams creates a term exam with a paper per class-subject and marks for
// every enrolled student, so the gradebook and report cards have something to
// show.
func seedExams(ctx context.Context, tx pgx.Tx, inst, campus, year uuid.UUID) (int, error) {
	/* Guard on marks, not on papers.

	   The first version asked whether exam_subjects had rows and skipped if so.
	   This school had 20 papers and one mark: the exam existed, the gradebook
	   was empty, and the check reported everything present. What a gradebook
	   needs is marks, so that is what to count. */
	var marks, papers int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM marks WHERE institution_id = $1`, inst).Scan(&marks); err != nil {
		return 0, err
	}
	if marks > 50 {
		return 0, nil
	}
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM exam_subjects WHERE institution_id = $1`, inst).Scan(&papers); err != nil {
		return 0, err
	}

	if papers == 0 {
		if err := seedExamPapers(ctx, tx, inst, campus, year); err != nil {
			return 0, err
		}
	}

	// Marks for every paper that has none, whoever created it.
	tag, err := tx.Exec(ctx, `
		INSERT INTO marks (institution_id, exam_subject_id, student_id, marks_obtained,
		                   is_absent, entered_at)
		SELECT $1, es.id, e.student_id,
		       18 + (abs(hashtext(es.id::text || e.student_id::text)) % 33),
		       false, now()
		  FROM exam_subjects es
		  JOIN class_subjects cs ON cs.id = es.class_subject_id
		  JOIN sections sec      ON sec.class_id = cs.class_id
		  JOIN enrollments e     ON e.section_id = sec.id AND e.status = 'active'
		 WHERE es.institution_id = $1
		   AND NOT EXISTS (
		       SELECT 1 FROM marks m
		        WHERE m.exam_subject_id = es.id AND m.student_id = e.student_id)
		ON CONFLICT DO NOTHING`, inst)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// seedExamPapers creates a term exam with one paper per class-subject.
func seedExamPapers(ctx context.Context, tx pgx.Tx, inst, campus, year uuid.UUID) error {
	var scale uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO grading_scales (institution_id, name, is_default)
		VALUES ($1, 'CBSE Scholastic', true)
		ON CONFLICT DO NOTHING
		RETURNING id`, inst).Scan(&scale); err != nil {
		// Already present: reuse it rather than failing the whole seed.
		if err := tx.QueryRow(ctx,
			`SELECT id FROM grading_scales WHERE institution_id = $1 LIMIT 1`,
			inst).Scan(&scale); err != nil {
			return err
		}
	}

	var exam uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO exams (institution_id, campus_id, academic_year_id, name, kind,
		                   weightage, starts_on, ends_on, grading_scale_id, is_published)
		VALUES ($1,$2,$3,'Unit Test I','unit_test',20,
		        CURRENT_DATE - 21, CURRENT_DATE - 14, $4, false)
		RETURNING id`, inst, campus, year, scale).Scan(&exam); err != nil {
		return err
	}

	// One paper per class-subject, sat over the exam week. row_number() is
	// bigint and date arithmetic wants integer.
	if _, err := tx.Exec(ctx, `
		INSERT INTO exam_subjects (institution_id, exam_id, class_subject_id, exam_date,
		                           starts_at, duration_minutes, max_marks, pass_marks)
		SELECT $1, $2, cs.id,
		       CURRENT_DATE - 21 + ((row_number() OVER (ORDER BY cs.id)) % 7)::int,
		       '09:30', 90, 50, 17
		  FROM class_subjects cs WHERE cs.institution_id = $1`, inst, exam); err != nil {
		return err
	}
	return nil
}

// seedStaffAttendance marks the last three weeks for every employee, with a
// scattering of absences so the HR register and the "teachers absent" probe
// have something real to count.
func seedStaffAttendance(ctx context.Context, tx pgx.Tx, inst, campus, _ uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM staff_attendance WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 5 {
		return 0, nil
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO staff_attendance (institution_id, campus_id, user_id, on_date, status, source)
		SELECT $1, $2, e.user_id, d::date,
		       CASE
		         -- Sundays are a week off, not an absence.
		         WHEN extract(dow from d) = 0 THEN 'week_off'
		         WHEN abs(hashtext(e.user_id::text || d::text)) % 23 = 0 THEN 'absent'
		         WHEN abs(hashtext(e.user_id::text || d::text)) % 17 = 0 THEN 'late'
		         ELSE 'present'
		       END,
		       'manual'
		  FROM employees e
		  CROSS JOIN generate_series(CURRENT_DATE - 20, CURRENT_DATE, INTERVAL '1 day') d
		 WHERE e.institution_id = $1 AND e.user_id IS NOT NULL
		ON CONFLICT DO NOTHING`, inst, campus)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// seedLibrary stocks a catalogue, gives each title copies, and puts some on
// loan — including a few overdue, which is the state the screen exists to show.
func seedLibrary(ctx context.Context, tx pgx.Tx, inst, campus, _ uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM library_titles WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}

	titles := [][4]string{
		{"NCERT Mathematics Class VIII", "NCERT", "978-81-7450-647-3", "Textbook"},
		{"NCERT Science Class VIII", "NCERT", "978-81-7450-648-0", "Textbook"},
		{"Wings of Fire", "A P J Abdul Kalam", "978-81-7371-146-6", "Biography"},
		{"Malgudi Days", "R K Narayan", "978-01-4018-543-1", "Fiction"},
		{"The Discovery of India", "Jawaharlal Nehru", "978-01-9562-359-8", "History"},
		{"Panchatantra", "Vishnu Sharma", "978-81-7011-952-1", "Folklore"},
		{"A Brief History of Time", "Stephen Hawking", "978-05-5317-698-8", "Science"},
		{"Train to Pakistan", "Khushwant Singh", "978-01-4302-826-8", "Fiction"},
	}
	n := 0
	for i, t := range titles {
		var titleID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO library_titles (institution_id, campus_id, title, author, isbn,
			                            category, language, price_paise)
			VALUES ($1,$2,$3,$4,$5,$6,'English',$7)
			RETURNING id`,
			inst, campus, t[0], t[1], t[2], t[3], int64(15000+i*5000)).Scan(&titleID); err != nil {
			return n, err
		}
		for c := 1; c <= 4; c++ {
			if _, err := tx.Exec(ctx, `
				INSERT INTO library_copies (institution_id, title_id, accession_no, barcode, rack, status)
				VALUES ($1,$2,$3,$4,$5,'available')`,
				inst, titleID,
				fmt.Sprintf("ACC-%04d", i*4+c),
				fmt.Sprintf("BC%06d", i*4+c),
				fmt.Sprintf("R%d", 1+i%3)); err != nil {
				return n, err
			}
			n++
		}
	}

	// Put a fifth of the stock out, a third of that overdue.
	if _, err := tx.Exec(ctx, `
		WITH picked AS (
		  SELECT c.id, s.id AS student_id,
		         row_number() OVER (ORDER BY c.accession_no) AS rn
		    FROM library_copies c
		    JOIN LATERAL (
		        SELECT st.id FROM students st
		         WHERE st.institution_id = $1
		         ORDER BY hashtext(st.id::text || c.id::text) LIMIT 1
		    ) s ON true
		   WHERE c.institution_id = $1 AND c.status = 'available'
		)
		INSERT INTO library_loans (institution_id, copy_id, student_id, issued_on, due_on)
		SELECT $1, p.id, p.student_id,
		       CURRENT_DATE - (10 + p.rn % 20)::int,
		       CURRENT_DATE - (10 + p.rn % 20)::int + 14
		  FROM picked p WHERE p.rn % 5 = 0`, inst); err != nil {
		return n, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE library_copies SET status = 'issued'
		 WHERE institution_id = $1
		   AND id IN (SELECT copy_id FROM library_loans
		               WHERE institution_id = $1 AND returned_on IS NULL)`, inst); err != nil {
		return n, err
	}
	return n, nil
}

// seedTransport puts buses on routes with stops, and allocates a third of the
// school to them — the proportion an Indian day school actually buses.
func seedTransport(ctx context.Context, tx pgx.Tx, inst, campus, year uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM vehicles WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}

	routes := []struct {
		reg, model, route string
		km                float64
		stops             []string
	}{
		{"TS07UB1234", "Tata Starbus 32", "Route 01 — Kompally", 12.5,
			[]string{"Kompally X Roads", "Suchitra Circle", "Jeedimetla", "Petbasheerabad"}},
		{"TS07UB5678", "Ashok Leyland 40", "Route 02 — Secunderabad", 18.2,
			[]string{"Paradise Circle", "Tarnaka", "Alwal", "Bowenpally"}},
		{"TS07UB9012", "Tata Starbus 32", "Route 03 — Medchal", 22.0,
			[]string{"Medchal Bus Stand", "Shamirpet", "Gundlapochampally", "Bahadurpally"}},
	}

	n := 0
	for _, r := range routes {
		var vehID, routeID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO vehicles (institution_id, campus_id, registration_no, model, capacity,
			                      insurance_expiry, fitness_expiry, permit_expiry, puc_expiry, status)
			VALUES ($1,$2,$3,$4,40,
			        CURRENT_DATE + 120, CURRENT_DATE + 200, CURRENT_DATE + 300, CURRENT_DATE + 45,
			        'active')
			RETURNING id`, inst, campus, r.reg, r.model).Scan(&vehID); err != nil {
			return n, err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO routes (institution_id, campus_id, name, code, vehicle_id, distance_km, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,true)
			RETURNING id`, inst, campus, r.route,
			fmt.Sprintf("R%02d", n+1), vehID, r.km).Scan(&routeID); err != nil {
			return n, err
		}
		for i, stop := range r.stops {
			if _, err := tx.Exec(ctx, `
				-- $4 is both the sequence column and an interval multiplier, so
				-- it needs an explicit type or Postgres deduces two.
				INSERT INTO route_stops (institution_id, route_id, name, sequence,
				                         pickup_time, drop_time, fare_paise)
				VALUES ($1,$2,$3,$4::int,
				        ('07:00'::time + ($4::int * INTERVAL '8 min')),
				        ('15:30'::time + ($4::int * INTERVAL '8 min')), $5)`,
				inst, routeID, stop, i+1, int64(90000+i*10000)); err != nil {
				return n, err
			}
		}
		n++
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO transport_allocations (institution_id, student_id, academic_year_id,
		                                   route_id, pickup_stop_id, drop_stop_id, valid_from)
		SELECT $1, st.id, $2, rs.route_id, rs.id, rs.id, CURRENT_DATE - 60
		  FROM students st
		  JOIN LATERAL (
		      SELECT s.id, s.route_id FROM route_stops s
		       WHERE s.institution_id = $1
		       ORDER BY hashtext(s.id::text || st.id::text) LIMIT 1
		  ) rs ON true
		 WHERE st.institution_id = $1
		   AND abs(hashtext(st.id::text)) % 3 = 0
		ON CONFLICT DO NOTHING`, inst, year); err != nil {
		return n, err
	}
	return n, nil
}

// seedFeeStructure gives the demand-generation screen something to raise
// against: one structure per class, with three instalments of real heads.
func seedFeeStructure(ctx context.Context, tx pgx.Tx, inst, campus, year uuid.UUID) (int, error) {
	/* Guard on structures, not items. One structure with items already existed,
	   which meant the demand-generation screen offered a single line where a
	   school has one per class. Skipping only once every class has one lets a
	   part-seeded school top up without duplicating. */
	var structures, classes int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM fee_structures WHERE institution_id = $1`, inst).Scan(&structures); err != nil {
		return 0, err
	}
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM classes WHERE institution_id = $1`, inst).Scan(&classes); err != nil {
		return 0, err
	}
	if classes == 0 || structures >= classes {
		return 0, nil
	}

	// The heads the first seeder created, plus any the school added.
	rows, err := tx.Query(ctx,
		`SELECT id, name FROM fee_heads WHERE institution_id = $1 ORDER BY name`, inst)
	if err != nil {
		return 0, err
	}
	type head struct {
		id   uuid.UUID
		name string
	}
	var heads []head
	for rows.Next() {
		var h head
		if err := rows.Scan(&h.id, &h.name); err != nil {
			rows.Close()
			return 0, err
		}
		heads = append(heads, h)
	}
	rows.Close()
	if len(heads) == 0 {
		return 0, nil
	}

	rowsC, err := tx.Query(ctx, `
		SELECT c.id, c.name FROM classes c
		 WHERE c.institution_id = $1
		   AND NOT EXISTS (SELECT 1 FROM fee_structures fs
		                    WHERE fs.institution_id = $1 AND fs.class_id = c.id)
		 ORDER BY c.level`, inst)
	if err != nil {
		return 0, err
	}
	type klass struct {
		id   uuid.UUID
		name string
	}
	var ks []klass
	for rowsC.Next() {
		var k klass
		if err := rowsC.Scan(&k.id, &k.name); err != nil {
			rowsC.Close()
			return 0, err
		}
		ks = append(ks, k)
	}
	rowsC.Close()

	n := 0
	for i, k := range ks {
		var sid uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO fee_structures (institution_id, campus_id, academic_year_id, class_id,
			                            name, applies_to, is_active)
			-- applies_to is the student category, not the class: the class is
			-- already class_id. Allowed values are all/rte/hosteller/
			-- day_scholar/transport.
			VALUES ($1,$2,$3,$4,$5,'all',true)
			RETURNING id`, inst, campus, year, k.id,
			fmt.Sprintf("%s — Annual fees", k.name)).Scan(&sid); err != nil {
			return n, err
		}
		// Three instalments across the year, tuition rising a little by class.
		for inst_no := 1; inst_no <= 3; inst_no++ {
			for hi, h := range heads {
				amount := int64(450000 + i*25000 + hi*30000)
				if _, err := tx.Exec(ctx, `
					INSERT INTO fee_structure_items (institution_id, fee_structure_id, fee_head_id,
					                                 instalment_no, amount_paise, due_on)
					VALUES ($1,$2,$3,$4,$5, CURRENT_DATE + ($4 * 90) - 60)`,
					inst, sid, h.id, inst_no, amount); err != nil {
					return n, err
				}
				n++
			}
		}
	}
	return n, nil
}

// seedCorrections raises a few amendments so the corrections queue is not an
// empty screen. Marked pending: the queue exists to be worked.
func seedCorrections(ctx context.Context, tx pgx.Tx, inst, _, _ uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM attendance_corrections WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO attendance_corrections (institution_id, attendance_id, requested_by,
		                                    from_status, to_status, reason, status)
		SELECT $1, sa.id,
		       (SELECT e.user_id FROM employees e
		         WHERE e.institution_id = $1 AND e.user_id IS NOT NULL LIMIT 1),
		       sa.status, 'present',
		       'Marked absent in error — child was in the lab period.',
		       'pending'
		  FROM student_attendance sa
		 WHERE sa.institution_id = $1 AND sa.status = 'absent'
		   AND sa.on_date > CURRENT_DATE - 14
		   -- requested_by is NOT NULL and the subselect above is the only
		   -- source for it. A demo tenant with no employees yet -- which is
		   -- every fresh one, because demo-data seeds none -- made that
		   -- subselect NULL and took the whole seeding transaction down with
		   -- it, so nothing after this point ran either. An absent
		   -- corrections queue is a missing demo screen; a failed seed is a
		   -- broken install.
		   AND EXISTS (SELECT 1 FROM employees e
		                WHERE e.institution_id = $1 AND e.user_id IS NOT NULL)
		 ORDER BY sa.on_date DESC
		 LIMIT 6`, inst)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// seedPipeline spreads applications across the admission statuses, so the
// pipeline reads as a funnel rather than a list of one state.
func seedPipeline(ctx context.Context, tx pgx.Tx, inst, campus, _ uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM applications WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 8 {
		return 0, nil
	}

	names := [][2]string{
		{"Riya", "Patel"}, {"Akhil", "Rao"}, {"Sai Krishna", "Reddy"},
		{"Meghana", "Iyer"}, {"Arjun", "Nair"}, {"Ananya", "Sharma"},
		{"Vihaan", "Gupta"}, {"Diya", "Menon"}, {"Kabir", "Singh"},
		{"Aarohi", "Desai"}, {"Ishaan", "Kulkarni"}, {"Tara", "Bose"},
	}
	statuses := []string{
		"submitted", "under_review", "documents_pending", "test_scheduled",
		"interviewed", "offered", "accepted", "waitlisted", "rejected",
		"submitted", "documents_pending", "offered",
	}

	n := 0
	for i, nm := range names {
		if _, err := tx.Exec(ctx, `
			INSERT INTO applications (institution_id, campus_id, application_no,
			                          first_name, last_name, date_of_birth, gender,
			                          class_sought, parent_name, parent_phone, status,
			                          created_at)
			SELECT $1, $2, $3, $4, $5,
			       CURRENT_DATE - INTERVAL '11 years' - ($6::int * INTERVAL '37 days'),
			       CASE WHEN $6::int % 2 = 0 THEN 'female' ELSE 'male' END,
			       (SELECT id FROM classes WHERE institution_id = $1 ORDER BY level LIMIT 1),
			       $7, $8, $9, now() - ($6::int * INTERVAL '3 days')
			 WHERE NOT EXISTS (
			   SELECT 1 FROM applications WHERE institution_id = $1 AND application_no = $3)`,
			inst, campus, fmt.Sprintf("APP-2026-%03d", i+1),
			nm[0], nm[1], i,
			nm[0]+"'s parent", fmt.Sprintf("98%08d", 45000000+i*11111),
			statuses[i]); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

/*
seedHostel builds a residential block with rooms and boarders.

	The hostel tables shipped with the schema and were never seeded, so the
	occupancy screen queried three empty tables and rendered nothing. A warden
	looking at a blank room list cannot tell "no data" from "broken".

	One block of each gender, three floors, four rooms a floor. A third of the
	beds filled, which is roughly what a day school with a small boarding wing
	actually runs at.
*/
func seedHostel(ctx context.Context, tx pgx.Tx, inst, campus, _ uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM hostel_rooms WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}

	n := 0
	for _, b := range []struct{ name, gender string }{
		{"Nalanda Block", "male"},
		{"Gargi Block", "female"},
	} {
		var blockID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO hostel_blocks (institution_id, campus_id, name, gender)
			VALUES ($1,$2,$3,$4) RETURNING id`, inst, campus, b.name, b.gender).Scan(&blockID); err != nil {
			return n, err
		}
		for floor := 1; floor <= 3; floor++ {
			for room := 1; room <= 4; room++ {
				if _, err := tx.Exec(ctx, `
					INSERT INTO hostel_rooms (institution_id, block_id, room_no, floor, beds)
					VALUES ($1,$2,$3,$4,4)`,
					inst, blockID, fmt.Sprintf("%d%02d", floor, room), floor); err != nil {
					return n, err
				}
				n++
			}
		}
	}

	// Boarders, matched to a block of their own gender. bed_no is per room, so
	// it is derived from the row's position rather than a global counter.
	if _, err := tx.Exec(ctx, `
		WITH candidates AS (
		  SELECT st.id, st.gender,
		         row_number() OVER (PARTITION BY st.gender ORDER BY st.admission_no) AS rn
		    FROM students st
		   WHERE st.institution_id = $1
		     AND abs(hashtext(st.id::text)) % 3 = 0
		),
		slots AS (
		  SELECT hr.id AS room_id, hb.gender, bed.n AS bed_no,
		         row_number() OVER (PARTITION BY hb.gender ORDER BY hr.room_no, bed.n) AS rn
		    FROM hostel_rooms hr
		    JOIN hostel_blocks hb ON hb.id = hr.block_id
		    CROSS JOIN generate_series(1, hr.beds) AS bed(n)
		   WHERE hr.institution_id = $1
		)
		INSERT INTO hostel_allocations (institution_id, room_id, student_id, bed_no, allocated_on)
		SELECT $1, s.room_id, c.id, s.bed_no, CURRENT_DATE - 60
		  FROM candidates c
		  JOIN slots s ON s.gender = c.gender AND s.rn = c.rn`, inst); err != nil {
		return n, err
	}
	return n, nil
}

// seedInfirmary gives the clinic a baseline health record per student, which
// is what every other health screen reads from.
func seedInfirmary(ctx context.Context, tx pgx.Tx, inst, _, _ uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM student_health WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO student_health (student_id, institution_id, allergies,
		                            chronic_conditions, doctor_name, doctor_phone)
		SELECT st.id, $1,
		       CASE abs(hashtext(st.id::text)) % 7
		         WHEN 0 THEN 'Peanuts' WHEN 1 THEN 'Dust, pollen'
		         WHEN 2 THEN 'Penicillin' ELSE NULL END,
		       CASE abs(hashtext(st.id::text || 'c')) % 11
		         WHEN 0 THEN 'Asthma' WHEN 1 THEN 'Type 1 diabetes' ELSE NULL END,
		       'Dr S Raghavan', '9848012345'
		  FROM students st WHERE st.institution_id = $1
		ON CONFLICT DO NOTHING`, inst)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// seedStores stocks the store room and records the movements behind the
// balances. on_hand is maintained by a trigger, so the movements are what is
// inserted and the balance follows.
func seedStores(ctx context.Context, tx pgx.Tx, inst, campus, _ uuid.UUID) (int, error) {
	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM inventory_items WHERE institution_id = $1`, inst).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}

	items := []struct {
		code, name, category, unit string
		reorder, received          int
	}{
		{"UNI-SHIRT", "School shirt", "Uniform", "piece", 40, 200},
		{"UNI-TROU", "School trousers", "Uniform", "piece", 40, 180},
		{"UNI-TIE", "School tie", "Uniform", "piece", 25, 90},
		{"STA-NOTE", "Ruled notebook 200pg", "Stationery", "piece", 100, 600},
		{"STA-PEN", "Blue ballpoint pen", "Stationery", "box", 20, 60},
		{"LAB-BEAK", "Glass beaker 250ml", "Laboratory", "piece", 15, 40},
		{"LAB-SLIDE", "Microscope slides", "Laboratory", "box", 10, 25},
		{"SPT-BALL", "Football", "Sports", "piece", 5, 12},
		{"CLN-PHEN", "Phenyl 5L", "Housekeeping", "can", 8, 30},
	}
	n := 0
	for _, it := range items {
		var itemID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO inventory_items (institution_id, campus_id, code, name, category,
			                             unit, reorder_level, on_hand)
			VALUES ($1,$2,$3,$4,$5,$6,$7,0) RETURNING id`,
			inst, campus, it.code, it.name, it.category, it.unit, it.reorder).Scan(&itemID); err != nil {
			return n, err
		}
		// A receipt, then issues that leave two lines below reorder level --
		// which is the state the stock screen exists to flag.
		if _, err := tx.Exec(ctx, `
			INSERT INTO inventory_movements (institution_id, item_id, kind, quantity,
			                                 reference, moved_on)
			VALUES ($1,$2,'receipt',$3,'Opening stock', CURRENT_DATE - 45)`,
			inst, itemID, it.received); err != nil {
			return n, err
		}
		issued := it.received - it.reorder/2
		if issued > 0 {
			if _, err := tx.Exec(ctx, `
				-- issued_to is a uuid reference, not a free-text recipient.
				INSERT INTO inventory_movements (institution_id, item_id, kind, quantity,
				                                 reference, moved_on)
				VALUES ($1,$2,'issue',$3,'Term issue to class teachers', CURRENT_DATE - 10)`,
				inst, itemID, issued); err != nil {
				return n, err
			}
		}
		n++
	}
	return n, nil
}
