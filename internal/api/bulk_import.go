package api

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Setting a school up from the spreadsheets it already has.

   Students could be imported from a CSV; classes, sections and staff could
   not. A school with ten classes, thirty sections and forty teachers had to
   type all eighty into a form one at a time, on the day they were trying to
   decide whether the product was any good. Every one of those lists already
   exists in the school office as a spreadsheet.

   The shape is the students importer's, because it is the right one and a
   second convention would be worse than a longer file:

     Dry run by default. The clerk uploads, sees exactly which rows are wrong
     and why, fixes them in Excel, uploads again. Nothing is written until
     ?commit=true, so a bad file costs nothing.

     Problems are reported per row with the row number and the offending data,
     not as a single "import failed". A message that does not say which of 300
     rows is wrong is a message that sends somebody back to the beginning.

     Every column is matched by header name, case- and space-insensitively,
     because the sheet came out of somebody else's software and its headers
     will not be ours.

   One transaction per import, so a file that fails halfway leaves nothing
   behind. Half a class list is worse than none: nobody can tell which half. */

/* Every lookup below names the institution explicitly.

   Relying on row level security alone was wrong in a way that only shows up
   at the worst moment: RLS is bypassed for a platform administrator, and an
   operator acting inside a school is exactly such a session. A lookup written
   as "the class called Grade 6" then means "the first Grade 6 on the
   installation", and an import run that way writes one school's rows against
   another school's sections. Eighty-four rows on this installation were in
   that state before this was fixed.

   The tenant predicate is therefore in the SQL as well as in the policy. RLS
   is the guarantee for ordinary sessions; this is the guarantee for the ones
   that outrank it. */

// importSpec is one entity's worth of importer.
type importSpec struct {
	// Perm is the permission the equivalent single-row form requires. Checked
	// per entity rather than on the route, because one route serves them all
	// and the loosest of them would otherwise become the price of admission:
	// importing staff must need what creating a staff member needs, not what
	// creating a class needs.
	Perm string
	// Columns, in the order the template writes them. The first is the one a
	// blank row is detected by.
	Columns []string
	// Required names the columns a row cannot be built without.
	Required []string
	Sample   []string
	// Check validates one row without touching the database, during the dry
	// run. Without it a value the writer will reject — a level that is not a
	// number — is reported as valid, the clerk fixes the rows they were told
	// about, uploads again, and the commit fails on a row the check had
	// already seen and passed. A dry run that misses errors is worse than no
	// dry run, because it is trusted.
	Check func(row map[string]string) error
	/* Verify checks what only the database can answer, during the dry run.

	   Check runs before any connection is open, so it can catch "level must
	   be a number" and cannot catch "there is no subject called SCI". That
	   second kind was reported at commit time, after the screen had already
	   said the file was ready — which is the failure the comment on Check
	   warns about, in the one place Check could not reach.

	   Read-only by contract. It runs in the same transaction the commit would
	   use, and on a dry run that transaction writes nothing. */
	Verify func(ctx *importCtx, row map[string]string) error
	// Write inserts one row. It is called inside the import transaction, with
	// the header-keyed values of that row.
	Write func(ctx *importCtx, row map[string]string) error
}

// createdRow is one record an import brought into existence, as opposed to one
// it edited. Only these are removed when an import is undone.
type createdRow struct {
	entity string
	id     uuid.UUID
}

type importCtx struct {
	r    *http.Request
	tx   pgx.Tx
	inst uuid.UUID
	// campus and year are resolved once for the whole file rather than per
	// row: three hundred rows should not mean three hundred lookups of a
	// value that cannot change during the import.
	campus uuid.UUID
	year   *uuid.UUID
	// classes maps a lowercased class name to its id, so a sections file can
	// say "Grade 6" where the database wants a uuid. Filled lazily.
	classes map[string]uuid.UUID
	// sections is keyed "class/section" and teachers by email, both
	// lowercased. Three hundred rows should not mean three hundred lookups
	// of values that cannot change during one import.
	sections map[string]uuid.UUID
	teachers map[string]uuid.UUID
	/* What this import created.

	   Every writer here upserts, so a second upload of a corrected sheet
	   edits rows that existed before it — and undoing that upload must not
	   delete a class the school created by hand in March. */
	created []createdRow
	server  *Server
}

func (c *importCtx) classID(name string) (uuid.UUID, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if id, ok := c.classes[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err := c.tx.QueryRow(c.r.Context(),
		`SELECT id FROM classes WHERE institution_id = $1 AND lower(name) = $2`,
		c.inst, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("no class called %q — create the classes first", name)
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.classes[key] = id
	return id, nil
}

/*
noteCreated remembers a row so the import can be taken back out.

	Called only where the insert actually inserted. Postgres answers that with
	xmax = 0 on the returned row — zero means no transaction has updated it, so
	the INSERT branch was taken — and, where the writer says DO NOTHING, by
	returning no row at all on a conflict. Both are exact, where counting rows
	before and after is not.
*/
func (c *importCtx) noteCreated(entity string, id uuid.UUID, inserted bool) {
	if inserted {
		c.created = append(c.created, createdRow{entity: entity, id: id})
	}
}

var importSpecs = map[string]importSpec{
	"classes": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"name", "level", "stream"},
		Required: []string{"name", "level"},
		Sample:   []string{"Grade 6", "6", ""},
		Check: func(row map[string]string) error {
			if n, err := strconv.Atoi(strings.TrimSpace(row["level"])); err != nil || n <= 0 {
				return errors.New("level must be a whole number above zero — it is what orders the classes")
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			level, _ := strconv.Atoi(strings.TrimSpace(row["level"]))
			/* RETURNING with DO NOTHING yields no row on a conflict, which is
			   exactly the signal wanted: a row came back means this INSERT
			   created the class, and ErrNoRows means it was already there. */
			var id uuid.UUID
			err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO classes (institution_id, campus_id, name, level, stream)
				VALUES ($1,$2,$3,$4,NULLIF($5,''))
				ON CONFLICT DO NOTHING
				RETURNING id`,
				c.inst, c.campus, strings.TrimSpace(row["name"]), level,
				strings.TrimSpace(row["stream"])).Scan(&id)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			c.noteCreated("classes", id, err == nil)
			return err
		},
	},
	"sections": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"class", "name", "capacity", "room"},
		Required: []string{"class", "name"},
		Sample:   []string{"Grade 6", "A", "40", ""},
		Check: func(row map[string]string) error {
			if v := strings.TrimSpace(row["capacity"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n <= 0 {
					return errors.New("capacity must be a whole number above zero")
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			classID, err := c.classID(row["class"])
			if err != nil {
				return err
			}
			capacity := 40
			if v := strings.TrimSpace(row["capacity"]); v != "" {
				if n, err := strconv.Atoi(v); err == nil && n > 0 {
					capacity = n
				} else {
					return errors.New("capacity must be a whole number above zero")
				}
			}
			// Mirrors createSection exactly, campus and conflict target
			// included. Writing a shorter INSERT here was how the importer
			// came to omit campus_id, which the column forbids — an importer
			// that diverges from the form it replaces will diverge again.
			var id uuid.UUID
			var inserted bool
			err = c.tx.QueryRow(c.r.Context(), `
				INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id,
				                      name, capacity, room)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))
				ON CONFLICT (class_id, academic_year_id, name)
				DO UPDATE SET capacity = EXCLUDED.capacity, room = EXCLUDED.room
				RETURNING id, (xmax = 0)`,
				c.inst, c.campus, classID, c.year, strings.TrimSpace(row["name"]), capacity,
				strings.TrimSpace(row["room"])).Scan(&id, &inserted)
			c.noteCreated("sections", id, inserted)
			return err
		},
	},
	/* Subjects. Code is what the report card prints and what the upsert keys
	   on, so a second upload of a corrected sheet edits rather than doubles. */
	"subjects": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"name", "code", "is_scholastic"},
		Required: []string{"name", "code"},
		Sample:   []string{"Mathematics", "MATH", "Y"},
		Check: func(row map[string]string) error {
			if strings.TrimSpace(row["code"]) == "" {
				return errors.New("code is what the report card prints; it cannot be blank")
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			// Blank means scholastic: most subjects are, and a school that
			// leaves the column off should get the common case.
			scholastic := !isNo(row["is_scholastic"])
			var id uuid.UUID
			var inserted bool
			err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO subjects (institution_id, campus_id, name, code, is_scholastic)
				VALUES ($1,$2,$3,upper($4),$5)
				ON CONFLICT (institution_id, campus_id, code)
				DO UPDATE SET name = EXCLUDED.name, is_scholastic = EXCLUDED.is_scholastic
				RETURNING id, (xmax = 0)`,
				c.inst, c.campus, strings.TrimSpace(row["name"]),
				strings.TrimSpace(row["code"]), scholastic).Scan(&id, &inserted)
			c.noteCreated("subjects", id, inserted)
			return err
		},
	},
	/* The school day. sequence orders the grid, so it is required and has to
	   be a number -- a period list sorted by name puts P10 before P2. */
	"periods": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"sequence", "name", "starts_at", "ends_at", "is_break"},
		Required: []string{"sequence", "name"},
		Sample:   []string{"1", "P1", "09:00", "09:45", "N"},
		Check: func(row map[string]string) error {
			if n, err := strconv.Atoi(strings.TrimSpace(row["sequence"])); err != nil || n <= 0 {
				return errors.New("sequence must be a whole number above zero — it is what orders the day")
			}
			for _, k := range []string{"starts_at", "ends_at"} {
				if v := strings.TrimSpace(row[k]); v != "" {
					if _, err := time.Parse("15:04", v); err != nil {
						return errors.New(k + " must be a 24-hour time such as 09:45")
					}
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			seq, _ := strconv.Atoi(strings.TrimSpace(row["sequence"]))
			var id uuid.UUID
			var inserted bool
			err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO periods (institution_id, campus_id, name, sequence,
				                     starts_at, ends_at, is_break)
				VALUES ($1,$2,$3,$4,NULLIF($5,'')::time,NULLIF($6,'')::time,$7)
				ON CONFLICT (institution_id, campus_id, sequence)
				DO UPDATE SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at,
				              ends_at = EXCLUDED.ends_at, is_break = EXCLUDED.is_break
				RETURNING id, (xmax = 0)`,
				c.inst, c.campus, strings.TrimSpace(row["name"]), seq,
				strings.TrimSpace(row["starts_at"]), strings.TrimSpace(row["ends_at"]),
				isYes(row["is_break"])).Scan(&id, &inserted)
			c.noteCreated("periods", id, inserted)
			return err
		},
	},
	/* Fee heads. Not fee amounts -- those are per class and belong to the
	   structure, which is a different sheet and a different decision. */
	"fee_heads": {
		Perm:     rbac.FeesWrite,
		Columns:  []string{"name", "code", "is_recurring"},
		Required: []string{"name", "code"},
		Sample:   []string{"Tuition", "TUI", "Y"},
		Write: func(c *importCtx, row map[string]string) error {
			recurring := !isNo(row["is_recurring"])
			var id uuid.UUID
			var inserted bool
			err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO fee_heads (institution_id, name, code, is_recurring,
				                       is_taxable, gst_rate_bp)
				VALUES ($1,$2,upper($3),$4,false,0)
				ON CONFLICT (institution_id, code)
				DO UPDATE SET name = EXCLUDED.name, is_recurring = EXCLUDED.is_recurring
				RETURNING id, (xmax = 0)`,
				c.inst, strings.TrimSpace(row["name"]), strings.TrimSpace(row["code"]),
				recurring).Scan(&id, &inserted)
			c.noteCreated("fee_heads", id, inserted)
			return err
		},
	},
	/* What each class pays, a year at a time.

	   Fees are re-set every year and the form takes one class at a time, so a
	   school of ten grades and six heads types sixty amounts to change a
	   number that moved with inflation. The sheet is the thing the office
	   already has: a grid of classes down the side and heads across the top,
	   flattened to one row per class per head.

	   The instalment count divides the annual amount rather than being typed
	   per term, because a school says "45,000 a year, three terms", not
	   "15,000, 15,000, 15,000" -- and the remainder of a division that does
	   not come out evenly goes on the first instalment, where a parent
	   expects the odd rupee.
	*/
	"fee_structures": {
		Perm:     rbac.FeesWrite,
		Columns:  []string{"structure", "class", "fee_head", "annual_amount", "instalments"},
		Required: []string{"structure", "fee_head", "annual_amount"},
		Sample:   []string{"2026-2027", "Grade 6", "Tuition Fee", "45000", "3"},
		Check: func(row map[string]string) error {
			if _, err := strconv.ParseFloat(strings.TrimSpace(row["annual_amount"]), 64); err != nil {
				return errors.New("annual_amount must be a number, in rupees")
			}
			if v := strings.TrimSpace(row["instalments"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n < 1 || n > 12 {
					return errors.New("instalments must be a whole number between 1 and 12")
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			name := strings.TrimSpace(row["structure"])

			// A blank class is the structure every class pays, which is how a
			// school with one fee for the whole school writes it.
			var classID *uuid.UUID
			if v := strings.TrimSpace(row["class"]); v != "" {
				id, err := c.classID(v)
				if err != nil {
					return err
				}
				classID = &id
			}

			// The head by code or by name. The office writes "Tuition Fee".
			want := strings.TrimSpace(row["fee_head"])
			var headID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT id FROM fee_heads
				 WHERE institution_id = $1
				   AND (upper(code) = upper($2) OR lower(name) = lower($2))`,
				c.inst, want).Scan(&headID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("no fee head called %q -- add the fee heads first", want)
				}
				return err
			}

			if c.year == nil {
				return errors.New("create an academic year before loading fee structures")
			}

			/* One structure per name and class, reused across the rows of the
			   sheet. Without this every row would make its own structure and a
			   class would end up with six of them, one per head. */
			var structID uuid.UUID
			var inserted bool
			if err := c.tx.QueryRow(c.r.Context(), `
				WITH found AS (
				    SELECT id FROM fee_structures
				     WHERE institution_id = $1 AND name = $3
				       AND class_id IS NOT DISTINCT FROM $4::uuid
				), made AS (
				    INSERT INTO fee_structures (institution_id, campus_id, academic_year_id,
				                                class_id, name, applies_to, is_active)
				    SELECT $1, $2, $5, $4::uuid, $3, 'all', true
				     WHERE NOT EXISTS (SELECT 1 FROM found)
				    RETURNING id
				)
				SELECT id, true FROM made
				UNION ALL SELECT id, false FROM found
				LIMIT 1`,
				c.inst, c.campus, name, classID, *c.year).Scan(&structID, &inserted); err != nil {
				return err
			}
			c.noteCreated("fee_structures", structID, inserted)

			rupees, _ := strconv.ParseFloat(strings.TrimSpace(row["annual_amount"]), 64)
			total := int64(rupees*100 + 0.5)
			terms := 1
			if v := strings.TrimSpace(row["instalments"]); v != "" {
				terms, _ = strconv.Atoi(v)
			}
			if terms < 1 {
				terms = 1
			}
			each := total / int64(terms)
			first := each + total - each*int64(terms) // the odd rupee, up front

			for n := 1; n <= terms; n++ {
				amount := each
				if n == 1 {
					amount = first
				}
				if _, err := c.tx.Exec(c.r.Context(), `
					INSERT INTO fee_structure_items (institution_id, fee_structure_id,
					                                 fee_head_id, instalment_no, amount_paise)
					VALUES ($1,$2,$3,$4,$5)
					ON CONFLICT (fee_structure_id, fee_head_id, instalment_no)
					DO UPDATE SET amount_paise = EXCLUDED.amount_paise`,
					c.inst, structID, headID, n, amount); err != nil {
					return err
				}
			}
			return nil
		},
	},
	/* Which subjects a class studies, and -- in the same row -- who teaches
	   them. The two were separate steps, so a school listed the subject on
	   step seven and came back on step nine to say who takes it, reading the
	   same sheet twice. A class list from a school already has both columns
	   next to each other. */
	"class_subjects": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"class", "subject_code", "max_marks", "periods_per_week", "teacher_email"},
		Required: []string{"class", "subject_code"},
		Sample:   []string{"Grade 6", "MATH", "100", "6", "priya.rao@jsm.test"},
		Check: func(row map[string]string) error {
			if v := strings.TrimSpace(row["max_marks"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n <= 0 {
					return errors.New("max_marks must be a whole number above zero")
				}
			}
			if v := strings.TrimSpace(row["periods_per_week"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n < 0 || n > 40 {
					return errors.New("periods_per_week must be a whole number, 0 to 40")
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			classID, err := c.classID(row["class"])
			if err != nil {
				return err
			}
			/* The code or the name, because a school writes both.

			   The column is called subject_code and the sheet the office
			   actually keeps says "General Science". Insisting on the code
			   rejected files whose every row named a subject that plainly
			   exists. The staff importer had already learned this; these two
			   had not. */
			want := strings.TrimSpace(row["subject_code"])
			var subjectID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT id FROM subjects
				 WHERE institution_id = $1
				   AND (upper(code) = upper($2) OR lower(name) = lower($2))`,
				c.inst, want).Scan(&subjectID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("no subject called %q — add the subjects first", want)
				}
				return err
			}
			maxMarks := 100
			if v := strings.TrimSpace(row["max_marks"]); v != "" {
				maxMarks, _ = strconv.Atoi(v)
			}

			/* How many periods a week the subject wants.
			
			   The timetable solver reads this and nothing else wrote it, so
			   every school reached "Generate a draft" and was told no subject
			   has a weekly requirement yet — with no screen that could set
			   one. The sheet a school keeps has this column; it just had
			   nowhere to go. Left alone when the column is absent, so a file
			   without it still loads and the value already stored survives a
			   re-upload. */
			var perWeek *int
			if v := strings.TrimSpace(row["periods_per_week"]); v != "" {
				if n, err := strconv.Atoi(v); err == nil && n > 0 {
					perWeek = &n
				}
			}

			var csID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO class_subjects (institution_id, class_id, subject_id,
				                            max_marks, periods_per_week)
				VALUES ($1,$2,$3,$4,COALESCE($5, 0))
				ON CONFLICT (class_id, subject_id)
				DO UPDATE SET max_marks = EXCLUDED.max_marks,
				              periods_per_week = COALESCE($5, class_subjects.periods_per_week)
				RETURNING id`,
				c.inst, classID, subjectID, maxMarks, perWeek).Scan(&csID); err != nil {
				return err
			}

			// The teacher column is optional, and naming one attaches them to
			// every section of that class -- which is what "who teaches Grade 6
			// maths" means in a school with two sections and one maths teacher.
			email := strings.TrimSpace(row["teacher_email"])
			if email == "" {
				return nil
			}
			var teacher uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT id FROM users WHERE institution_id = $1 AND email = $2::citext`,
				c.inst, email).Scan(&teacher); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("no member of staff with the email %q — import the staff first", email)
				}
				return err
			}
			_, err = c.tx.Exec(c.r.Context(), `
				INSERT INTO section_subject_teachers (institution_id, section_id,
				                                      class_subject_id, teacher_user_id)
				SELECT $1, sec.id, $2, $3 FROM sections sec WHERE sec.class_id = $4
				ON CONFLICT (section_id, class_subject_id)
				DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
				c.inst, csID, teacher, classID)
			return err
		},
	},
	/* Who runs which room, and who teaches what in it.

	   Two facts a school keeps on one sheet and the product made them enter
	   in two places: the class teacher and the room for a section, and the
	   teacher against each subject in that section. Both are here, and every
	   column but the class and the section is optional — a school with only
	   class teachers fills three columns and leaves the rest blank, and a
	   school listing subject teachers repeats the class and section down the
	   rows the way a spreadsheet does.

	   Nothing is required to appear together. A row with a class teacher and
	   no subject sets the class teacher. A row with a subject and no class
	   teacher sets the subject teacher. A row with both does both.
	*/
	"allocations": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"class", "section", "room", "class_teacher_email", "subject_code", "teacher_email"},
		Required: []string{"class", "section"},
		Sample:   []string{"Grade 6", "A", "6A", "priya.rao@jsm.test", "MATH", "anand.k@jsm.test"},
		Write: func(c *importCtx, row map[string]string) error {
			sectionID, err := c.sectionIDFor(row["class"], row["section"])
			if err != nil {
				return err
			}

			if room := strings.TrimSpace(row["room"]); room != "" {
				if _, err := c.tx.Exec(c.r.Context(),
					`UPDATE sections SET room = $2 WHERE id = $1`, sectionID, room); err != nil {
					return err
				}
			}

			if email := strings.TrimSpace(row["class_teacher_email"]); email != "" {
				teacher, err := c.teacherByEmail(email)
				if err != nil {
					return err
				}
				if _, err := c.tx.Exec(c.r.Context(),
					`UPDATE sections SET class_teacher_id = $2 WHERE id = $1`,
					sectionID, teacher); err != nil {
					return err
				}
			}

			code := strings.TrimSpace(row["subject_code"])
			email := strings.TrimSpace(row["teacher_email"])
			if code == "" || email == "" {
				// A row that only names the class teacher is complete. Treating
				// a blank subject as an error would mean two files for what a
				// school keeps as one.
				return nil
			}
			teacher, err := c.teacherByEmail(email)
			if err != nil {
				return err
			}
			var csID, subjectID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				SELECT cs.id, cs.subject_id
				  FROM class_subjects cs
				  JOIN subjects sub ON sub.id = cs.subject_id
				  JOIN sections sec ON sec.class_id = cs.class_id
				 WHERE sec.id = $1 AND cs.institution_id = $3
				   AND (upper(sub.code) = upper($2) OR lower(sub.name) = lower($2))`,
				sectionID, code, c.inst).Scan(&csID, &subjectID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("%s does not study %q — map the subject to the class first",
						row["class"], code)
				}
				return err
			}
			if _, err := c.tx.Exec(c.r.Context(), `
				INSERT INTO section_subject_teachers (institution_id, section_id,
				                                      class_subject_id, teacher_user_id)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (section_id, class_subject_id)
				DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
				c.inst, sectionID, csID, teacher); err != nil {
				return err
			}
			// Assigning somebody to teach a subject is also a statement that
			// they teach it, which is what the dropdowns read.
			_, err = c.tx.Exec(c.r.Context(), `
				INSERT INTO teacher_subjects (institution_id, user_id, subject_id)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, c.inst, teacher, subjectID)
			return err
		},
	},
	"staff": {
		Perm: rbac.EmployeesWrite,
		Columns: []string{"employee_code", "first_name", "last_name", "email", "phone",
			"designation", "role", "joined_on", "subjects"},
		Required: []string{"employee_code", "first_name"},
		Sample: []string{"T-014", "Priya", "Rao", "priya@school.in", "9876543210",
			"Teacher", "faculty", "2026-06-01", "MATH; SCI"},
		Check: func(row map[string]string) error {
			if v := strings.TrimSpace(row["joined_on"]); v != "" {
				if _, err := time.Parse(time.DateOnly, v); err != nil {
					return errors.New("joined_on must be a date written as YYYY-MM-DD")
				}
			}
			return nil
		},
		Verify: func(c *importCtx, row map[string]string) error {
			// Named before the upload rather than after it: a subject that
			// does not exist is the commonest thing wrong with a staff sheet,
			// because a school writes "Science" where the list says "General
			// Science".
			for _, want := range splitSubjects(row["subjects"]) {
				var exists bool
				if err := c.tx.QueryRow(c.r.Context(), `
					SELECT EXISTS (SELECT 1 FROM subjects
					                WHERE institution_id = $2
					                  AND (upper(code) = upper($1) OR lower(name) = lower($1)))`,
					want, c.inst).Scan(&exists); err != nil {
					return err
				}
				if !exists {
					return fmt.Errorf("no subject called %q — check the Subjects step for the exact name", want)
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			req := employeeRequest{
				EmployeeCode: strings.TrimSpace(row["employee_code"]),
				FirstName:    strings.TrimSpace(row["first_name"]),
				LastName:     strings.TrimSpace(row["last_name"]),
				Email:        strings.TrimSpace(row["email"]),
				Phone:        strings.TrimSpace(row["phone"]),
				JoinedOn:     strings.TrimSpace(row["joined_on"]),
				RoleKey:      strings.ToLower(strings.TrimSpace(row["role"])),
			}
			// A login is minted only where there is an address to send it to.
			// A teacher with no email is still a teacher; inventing a username
			// for them creates an account nobody will ever sign in to.
			req.CreateLogin = req.Email != "" && req.RoleKey != ""
			empID, userID, created, err := appointEmployee(c.r.Context(), c.tx, c.inst, c.campus, req)
			if err != nil {
				return err
			}
			// Only staff this file brought onto the roll. The upsert matches on
			// employee_code, so a corrected re-upload edits people who were
			// already appointed and undoing it must not remove them.
			if parsed, perr := uuid.Parse(empID); perr == nil {
				c.noteCreated("staff", parsed, created)
			}

			/* What they teach, where the sheet says.

			   A school knows who its maths teachers are and had nowhere to
			   put that, so the subject-teacher dropdown offered every member
			   of staff for every subject and the Telugu row listed the
			   accountant.

			   Separated by semicolons or commas, matched on the subject code
			   or its name, because a school writes "MATH; SCI" in one column
			   and should not have to learn which of the two we wanted. An
			   unknown subject fails the row by name rather than being
			   skipped: silently dropping half of "MATH; PHYSICS" leaves
			   somebody believing a fact that is not recorded. */
			// userID is empty for a member of staff imported without an email:
			// they have a personnel record and no account, so there is no user
			// to attach a subject to. Their subjects go in when they are given
			// a login.
			list := strings.TrimSpace(row["subjects"])
			if list == "" || strings.TrimSpace(userID) == "" {
				return nil
			}
			for _, want := range splitSubjects(list) {
				var subjectID uuid.UUID
				if err := c.tx.QueryRow(c.r.Context(), `
					SELECT id FROM subjects
					 WHERE upper(code) = upper($1) OR lower(name) = lower($1)
					 LIMIT 1`, want).Scan(&subjectID); err != nil {
					if errors.Is(err, pgx.ErrNoRows) {
						return fmt.Errorf("no subject called %q — add the subjects first", want)
					}
					return err
				}
				if _, err := c.tx.Exec(c.r.Context(), `
					INSERT INTO teacher_subjects (institution_id, user_id, subject_id)
					VALUES ($1,$2::uuid,$3) ON CONFLICT DO NOTHING`,
					c.inst, userID, subjectID); err != nil {
					return err
				}
			}
			return nil
		},
	},
}

// getBulkTemplate hands back a CSV with the headers and one filled example
// row, because an empty template is a puzzle about what the columns mean.
func (s *Server) getBulkTemplate(w http.ResponseWriter, r *http.Request) {
	entity := chiURLParam(r, "entity")
	spec, ok := importSpecs[entity]
	if !ok {
		httpx.BadRequest(w, r, "nothing can be imported as "+entity)
		return
	}
	if !httpx.IdentityFrom(r.Context()).Can(spec.Perm) {
		httpx.Error(w, r, http.StatusForbidden, "forbidden", "you cannot import "+entity)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+entity+`-template.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(spec.Columns)
	if len(spec.Sample) == len(spec.Columns) {
		_ = cw.Write(spec.Sample)
	}
	cw.Flush()
}

// bulkImport validates a CSV and, on commit, writes it.
func (s *Server) bulkImport(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	entity := chiURLParam(r, "entity")
	spec, ok := importSpecs[entity]
	if !ok {
		httpx.BadRequest(w, r, "nothing can be imported as "+entity)
		return
	}
	if !id.Can(spec.Perm) {
		httpx.Error(w, r, http.StatusForbidden, "forbidden", "you cannot import "+entity)
		return
	}
	commit := r.URL.Query().Get("commit") == "true"

	// 8 MB is a few thousand rows. Past that it is a data migration, which is
	// somebody sitting down with the database rather than a drag and drop.
	// Read once and parse from memory, because the file is wanted twice: to
	// import it, and to keep it against the history so somebody can open the
	// upload later and see what was actually in it.
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if err != nil {
		httpx.BadRequest(w, r, "could not read the file — is it larger than 8 MB?")
		return
	}

	reader := csv.NewReader(bytes.NewReader(raw))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1 // ragged rows are reported per row, not fatal

	head, err := reader.Read()
	if err != nil {
		httpx.BadRequest(w, r, "that file has no header row")
		return
	}
	index := map[string]int{}
	for i, h := range head {
		index[normaliseHeader(h)] = i
	}
	for _, need := range spec.Required {
		if _, ok := index[need]; !ok {
			httpx.BadRequest(w, r,
				"the file needs a column called "+need+". Download the template if the headers do not match.")
			return
		}
	}

	type parsed struct {
		row  int
		data map[string]string
	}
	var rows []parsed
	out := importResult{DryRun: !commit, Problems: []importRow{}}

	for n := 2; ; n++ {
		rec, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			out.Total++
			out.Rejected++
			out.Problems = append(out.Problems, importRow{Row: n, Problem: "could not read this row: " + err.Error()})
			continue
		}
		data := map[string]string{}
		for col, i := range index {
			if i < len(rec) {
				data[col] = strings.TrimSpace(rec[i])
			}
		}
		// A trailing blank line is not a rejected row. Spreadsheets add them
		// and a report that calls them errors teaches people to ignore it.
		if allBlank(data) {
			continue
		}
		out.Total++

		missing := ""
		for _, need := range spec.Required {
			if data[need] == "" {
				missing = need
				break
			}
		}
		if missing != "" {
			out.Rejected++
			out.Problems = append(out.Problems, importRow{Row: n, Data: data, Problem: missing + " is required"})
			continue
		}
		if spec.Check != nil {
			if err := spec.Check(data); err != nil {
				out.Rejected++
				out.Problems = append(out.Problems, importRow{Row: n, Data: data, Problem: err.Error()})
				continue
			}
		}
		out.Valid++
		rows = append(rows, parsed{row: n, data: data})
	}

	/* The database-dependent checks, before the screen says "ready".

	   Runs on a dry run and on a commit alike: on a commit it is the same
	   answer a moment earlier, and the cost of asking twice is a few selects
	   against rows already in cache. */
	if spec.Verify != nil && len(rows) > 0 {
		verr := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			campus, err := ensureCampus(r, tx, id.InstitutionID)
			if err != nil {
				return err
			}
			ctx := &importCtx{r: r, tx: tx, inst: id.InstitutionID, campus: campus,
				classes: map[string]uuid.UUID{}, server: s}
			for _, p := range rows {
				if err := spec.Verify(ctx, p.data); err != nil {
					out.Valid--
					out.Rejected++
					out.Problems = append(out.Problems,
						importRow{Row: p.row, Data: p.data, Problem: err.Error()})
				}
			}
			return nil
		})
		if verr != nil {
			httpx.Internal(w, r, verr)
			return
		}
		if out.Rejected > 0 {
			// Rebuilt so the rows that failed verification are not written on
			// a commit that got this far.
			kept := rows[:0]
			bad := map[int]bool{}
			for _, p := range out.Problems {
				bad[p.Row] = true
			}
			for _, p := range rows {
				if !bad[p.row] {
					kept = append(kept, p)
				}
			}
			rows = kept
		}
	}

	/* A bad row is a bad row, not a bad file.

	   This used to refuse the whole upload if any row failed, on the reasoning
	   that a partial import leaves the office reconciling what went in against
	   what did not. That reasoning holds for two schools and fails for the
	   rest: a sixty-row roll with one child whose section was typed "6A"
	   instead of "6-A" cannot be loaded at all, and the office has no way to
	   get the other fifty-nine in while somebody works out which. It also
	   makes the product the obstacle at exactly the moment a school is trying
	   to start using it.

	   So the good rows land and the rest are named, with the row number and
	   the reason. Nothing is silent: the count of what was skipped is returned
	   beside the count of what was written, and re-uploading the corrected
	   sheet updates rather than duplicates, because every importer upserts. */
	if !commit || len(rows) == 0 {
		httpx.JSON(w, http.StatusOK, out)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		ctx := &importCtx{r: r, tx: tx, inst: id.InstitutionID, campus: campus,
			classes: map[string]uuid.UUID{}, server: s}

		var year uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).
			Scan(&year); err == nil {
			ctx.year = &year
		}

		/* Each row inside its own savepoint.

		   One row's failure used to abort the transaction, and with it every
		   row that had already succeeded. A savepoint per row means a row that
		   cannot be written is rolled back on its own and the file carries on
		   — which is the difference between "we could not load your sheet" and
		   "we loaded your sheet apart from row 14, which says this". */
		for _, p := range rows {
			sp, berr := tx.Begin(r.Context())
			if berr != nil {
				return berr
			}
			outer, madeSoFar := ctx.tx, len(ctx.created)
			ctx.tx = sp
			werr := spec.Write(ctx, p.data)
			ctx.tx = outer
			if werr != nil {
				_ = sp.Rollback(r.Context())
				// Anything the failed row claimed to have created went back
				// with it, so the undo record must not still name those rows.
				ctx.created = ctx.created[:madeSoFar]
				out.Imported = out.Imported
				out.Rejected++
				out.Problems = append(out.Problems,
					importRow{Row: p.row, Data: p.data, Problem: werr.Error()})
				continue
			}
			if cerr := sp.Commit(r.Context()); cerr != nil {
				return cerr
			}
			out.Imported++
		}

		/* The record of what was loaded, written in the same transaction as
		   the rows themselves.

		   Outside it, a failed import could still leave a log entry claiming
		   success -- which is worse than no log, because somebody would then
		   not re-import a file that never landed. */
		return recordImportRunFull(r, tx, id.InstitutionID, entity,
			r.URL.Query().Get("filename"), out.Total, out.Imported, out.Rejected,
			ctx.created, string(raw))
	})
	if err != nil {
		out.Imported = 0
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// normaliseHeader makes "Employee Code", "employee_code" and "EMPLOYEE CODE"
// the same column, because the sheet came from somebody else's software.
func normaliseHeader(h string) string {
	// The byte order mark Excel writes is not whitespace, so TrimSpace
	// leaves it on the first column and that column stops matching its
	// own name.
	h = strings.TrimPrefix(h, "\ufeff")
	h = strings.ToLower(strings.TrimSpace(h))
	h = strings.ReplaceAll(h, " ", "_")
	h = strings.ReplaceAll(h, "-", "_")
	return strings.Trim(h, "_")
}

func allBlank(data map[string]string) bool {
	for _, v := range data {
		if v != "" {
			return false
		}
	}
	return true
}

// --- what was loaded, and by whom ----------------------------------------

// recordImportRun logs one committed import. Dry runs are deliberately not
// recorded: nothing happened, and a log full of things that did not happen is
// a log people stop reading.
func recordImportRun(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	entity, filename string, read, imported, rejected int) error {

	return recordImportRunWith(r, tx, inst, entity, filename, read, imported, rejected, nil)
}

// recordImportRunWith also remembers which records the import created, which
// is the whole of what makes undoing it possible.
func recordImportRunWith(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	entity, filename string, read, imported, rejected int, created []createdRow) error {
	return recordImportRunFull(r, tx, inst, entity, filename, read, imported, rejected, created, "")
}

// maxKeptImportBytes is how much of an uploaded file is kept for later
// reading. A class list is a few hundred kilobytes; a data migration is not
// something to hold a copy of in a text column, and half a file kept is worse
// than none because it reads as the whole one.
const maxKeptImportBytes = 1 << 20

// recordImportRunFull also keeps the file, so somebody can open the history
// later and see what was actually uploaded rather than only how many rows it
// had.
func recordImportRunFull(r *http.Request, tx pgx.Tx, inst uuid.UUID,
	entity, filename string, read, imported, rejected int,
	created []createdRow, content string) error {

	kept := content
	omitted := false
	if len(kept) > maxKeptImportBytes {
		kept, omitted = "", true
	}

	var runID uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO import_runs (institution_id, entity, filename,
		                         rows_read, rows_imported, rows_rejected, imported_by,
		                         content, content_omitted)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,NULLIF($8,''),$9)
		RETURNING id`,
		inst, entity, strings.TrimSpace(filename), read, imported, rejected,
		httpx.IdentityFrom(r.Context()).UserID, kept, omitted).Scan(&runID); err != nil {
		return err
	}
	for _, c := range created {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO import_run_rows (run_id, institution_id, entity, record_id)
			VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
			runID, inst, c.entity, c.id); err != nil {
			return err
		}
	}
	return nil
}

type importRunRow struct {
	ID       string  `json:"id"`
	Entity   string  `json:"entity"`
	Filename *string `json:"filename,omitempty"`
	RowsRead int     `json:"rows_read"`
	Imported int     `json:"rows_imported"`
	Rejected int     `json:"rows_rejected"`
	By       *string `json:"imported_by,omitempty"`
	At       string  `json:"created_at"`
	UndoneAt *string `json:"undone_at,omitempty"`
	// Created counts what this upload brought into existence rather than
	// edited, which is the only part an undo can remove.
	Created int `json:"created_rows"`
}

/*
listImportRuns answers "has somebody already loaded this?"

	The question a school office asks when three people share the work and the
	second one is holding the same spreadsheet as the first. Every importer
	reported a count on screen and forgot it on refresh, so the honest answer
	was to go and look at the rows and guess.

	Newest first, and not narrowed by who did it: the point is to see the other
	person's upload, not your own.
*/
func (s *Server) listImportRuns(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	items, err := collect(s, r, `
		SELECT ir.id::text, ir.entity, ir.filename, ir.rows_read, ir.rows_imported,
		       ir.rows_rejected, u.full_name,
		       to_char(ir.created_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
		       to_char(ir.undone_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
		       (SELECT count(*) FROM import_run_rows w WHERE w.run_id = ir.id)::int
		  FROM import_runs ir
		  LEFT JOIN users u ON u.id = ir.imported_by
		 WHERE ($1::text IS NULL OR ir.entity = $1)
		 ORDER BY ir.created_at DESC
		 LIMIT 50`,
		[]any{nullString(r.URL.Query().Get("entity"))},
		func(rows pgx.Rows) (importRunRow, error) {
			var v importRunRow
			return v, rows.Scan(&v.ID, &v.Entity, &v.Filename, &v.RowsRead, &v.Imported,
				&v.Rejected, &v.By, &v.At, &v.UndoneAt, &v.Created)
		})
	respond(w, r, items, err)
}

// isYes and isNo read the Y/N, yes/no, true/false and 1/0 that a school's
// spreadsheet actually contains. Kept as two functions rather than one with a
// default, because "blank means yes" is right for a subject being scholastic
// and wrong for a period being a break.
func isYes(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "y", "yes", "true", "1":
		return true
	}
	return false
}

func isNo(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "n", "no", "false", "0":
		return true
	}
	return false
}

// sectionIDFor resolves "Grade 6" + "A" to a section, the same idea as
// classID and cached the same way.
func (c *importCtx) sectionIDFor(className, sectionName string) (uuid.UUID, error) {
	classID, err := c.classID(className)
	if err != nil {
		return uuid.Nil, err
	}
	key := strings.ToLower(strings.TrimSpace(className)) + "/" +
		strings.ToLower(strings.TrimSpace(sectionName))
	if c.sections == nil {
		c.sections = map[string]uuid.UUID{}
	}
	if id, ok := c.sections[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err = c.tx.QueryRow(c.r.Context(),
		`SELECT id FROM sections
		  WHERE institution_id = $1 AND class_id = $2 AND lower(name) = $3
		  LIMIT 1`,
		c.inst, classID, strings.ToLower(strings.TrimSpace(sectionName))).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("%s has no section %q — create the sections first",
			className, sectionName)
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.sections[key] = id
	return id, nil
}

// teacherByEmail turns the address a school writes in a spreadsheet into the
// account behind it, and says which address failed rather than that one did.
func (c *importCtx) teacherByEmail(email string) (uuid.UUID, error) {
	if c.teachers == nil {
		c.teachers = map[string]uuid.UUID{}
	}
	key := strings.ToLower(strings.TrimSpace(email))
	if id, ok := c.teachers[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err := c.tx.QueryRow(c.r.Context(),
		`SELECT id FROM users WHERE institution_id = $1 AND email = $2::citext`,
		c.inst, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("no member of staff with the email %q — import the staff first", email)
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.teachers[key] = id
	return id, nil
}

// splitSubjects reads the "MATH; SCI" a school writes in one column. Semicolon,
// comma or pipe, because a spreadsheet is written by a person and not a parser.
func splitSubjects(v string) []string {
	out := []string{}
	for _, raw := range strings.FieldsFunc(v, func(r rune) bool {
		return r == ';' || r == ',' || r == '|'
	}) {
		if t := strings.TrimSpace(raw); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// --- taking an import back out ---------------------------------------------

// undoableTables maps the entity names recorded against an import run to the
// tables they live in. A fixed list in code rather than trusting the column:
// the entity is written by this package and read back into a DELETE, and a
// table name interpolated from the database is the shape of a very bad day.
var undoableTables = map[string]string{
	"classes":   "classes",
	"sections":  "sections",
	"subjects":  "subjects",
	"periods":   "periods",
	"fee_heads": "fee_heads",
	"students":  "students",
	"staff":     "employees",
	// Undoing a fee structure upload removes the structures it created; the
	// priced lines under them go with the cascade, which is what a school
	// means by "take last year's fees off".
	"fee_structures": "fee_structures",
}

/*
Deleting a student cascades.

	Nearly forty tables reference students with ON DELETE CASCADE — marks,
	attendance, invoices, report cards, discipline records. That is right for a
	school removing a record deliberately and wrong for an undo, which would
	take a term's work with it without saying so.

	So a child is removed only while nothing has happened to them yet. The
	enrolment and the guardian the import itself created are expected and do
	not count; anything else means the school has begun using the record, and
	the row is kept and reported instead.
*/
const studentIsUntouched = `
	SELECT NOT EXISTS (SELECT 1 FROM student_attendance a WHERE a.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM marks m            WHERE m.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM invoices i         WHERE i.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM report_cards rc    WHERE rc.student_id = $1)
	   AND NOT EXISTS (SELECT 1 FROM homework_submissions h WHERE h.student_id = $1)`

/*
permForImportEntity is the right an import of this kind needed.

	importSpecs covers the entities the shared importer handles. Students go in
	through their own endpoint and are not in that map, so looking their
	permission up there returned the empty string — and Can("") is false for
	everybody, including the principal who did the upload. Reading back or
	undoing a student import was refused to the one person certain to be
	allowed.

	Falling back to a deny would repeat that mistake for the next importer
	added outside the map, so an unknown entity resolves to the right that
	governs the records it would touch, and an entity with no answer at all is
	the only one refused.
*/
func permForImportEntity(entity string) string {
	if spec, ok := importSpecs[entity]; ok {
		return spec.Perm
	}
	switch entity {
	case "students":
		return rbac.StudentsWrite
	}
	return ""
}

type undoResult struct {
	Removed int      `json:"removed"`
	Kept    int      `json:"kept"`
	Reasons []string `json:"reasons"`
}

/*
undoImport deletes the records one upload created.

	Only the records it created. Every importer upserts, so a second upload of
	a corrected sheet edits rows that were already there, and undoing it must
	not remove a class the school typed in by hand in March.

	Rows that something else now depends on are kept rather than cascaded. A
	section with children enrolled in it is not an accident of the import any
	more, and deleting it to satisfy an undo would take the enrolments with it.
	The count of what was kept, and why, is returned rather than swallowed —
	an undo that silently does half its job is worse than one that refuses.
*/
func (s *Server) undoImport(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid import id")
		return
	}

	var out undoResult
	out.Reasons = []string{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var entity string
		var undone *time.Time
		if err := tx.QueryRow(r.Context(),
			`SELECT entity, undone_at FROM import_runs WHERE id = $1`, runID).
			Scan(&entity, &undone); err != nil {
			return err
		}
		if undone != nil {
			return errAlreadyUndone
		}
		need := permForImportEntity(entity)
		if need == "" || !id.Can(need) {
			return errNotYours
		}

		rows, err := tx.Query(r.Context(),
			`SELECT entity, record_id FROM import_run_rows WHERE run_id = $1`, runID)
		if err != nil {
			return err
		}
		type target struct {
			entity string
			id     uuid.UUID
		}
		var targets []target
		for rows.Next() {
			var t target
			if err := rows.Scan(&t.entity, &t.id); err != nil {
				rows.Close()
				return err
			}
			targets = append(targets, t)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, t := range targets {
			table, ok := undoableTables[t.entity]
			if !ok {
				out.Kept++
				continue
			}
			/* A member of staff who has started work is not just a row this
			   file created either. Deleting an employee takes their leave,
			   their payroll and their timetable with it, so anybody holding a
			   class or a section is kept. */
			if t.entity == "staff" {
				var busy bool
				if err := tx.QueryRow(r.Context(), `
					SELECT EXISTS (SELECT 1 FROM section_subject_teachers t
					                JOIN employees e ON e.user_id = t.teacher_user_id
					               WHERE e.id = $1)
					    OR EXISTS (SELECT 1 FROM sections s
					                JOIN employees e ON e.user_id = s.class_teacher_id
					               WHERE e.id = $1)`, t.id).Scan(&busy); err != nil {
					return err
				}
				if busy {
					out.Kept++
					if len(out.Reasons) < 5 {
						out.Reasons = append(out.Reasons,
							"a teacher is assigned to a class or subject and was left alone")
					}
					continue
				}
			}

			// A child who has been marked present, examined or invoiced is no
			// longer just a row this file created.
			if t.entity == "students" {
				var untouched bool
				if err := tx.QueryRow(r.Context(), studentIsUntouched, t.id).Scan(&untouched); err != nil {
					return err
				}
				if !untouched {
					out.Kept++
					if len(out.Reasons) < 5 {
						out.Reasons = append(out.Reasons,
							"a child already has attendance, marks or fees recorded and was left alone")
					}
					continue
				}
			}
			// A savepoint per row, so one row held back by a foreign key does
			// not abort the transaction and lose the rest of the undo.
			if _, err := tx.Exec(r.Context(), "SAVEPOINT undo_row"); err != nil {
				return err
			}
			_, derr := tx.Exec(r.Context(),
				"DELETE FROM "+table+" WHERE id = $1", t.id)
			if derr != nil {
				if _, err := tx.Exec(r.Context(), "ROLLBACK TO SAVEPOINT undo_row"); err != nil {
					return err
				}
				out.Kept++
				if len(out.Reasons) < 5 {
					out.Reasons = append(out.Reasons,
						"one "+t.entity+" row is still in use and was left alone")
				}
				continue
			}
			if _, err := tx.Exec(r.Context(), "RELEASE SAVEPOINT undo_row"); err != nil {
				return err
			}
			out.Removed++
		}

		// Marked rather than deleted: "loaded and then undone" is a different
		// fact from "never loaded", and an empty history says the second.
		_, err = tx.Exec(r.Context(),
			`UPDATE import_runs SET undone_at = now(), undone_by = $2 WHERE id = $1`,
			runID, id.UserID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errAlreadyUndone):
		httpx.BadRequest(w, r, "that upload has already been undone")
		return
	case errors.Is(err, errNotYours):
		httpx.Forbidden(w, r, "undoing this kind of import")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

var (
	errAlreadyUndone = errStr("already undone")
	errNotYours      = errStr("not permitted")
)

/*
getImportContent hands back the file one upload was made from.

	The history could say that 4-staff.csv added ten rows and never say which
	ten. That is the question anybody actually has when they open it — usually
	because something looks wrong and they want to compare the sheet against
	what is now in the school.

	Returned as the CSV it was, not as a rendering of it. The screen parses it
	with the same code it uses for a file being dropped, so what is shown here
	and what was shown then are the same table by construction rather than by
	two pieces of code agreeing.
*/
func (s *Server) getImportContent(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	runID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid import id")
		return
	}

	var (
		entity   string
		filename *string
		content  *string
		omitted  bool
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT entity, filename, content, content_omitted
			  FROM import_runs WHERE id = $1`, runID).
			Scan(&entity, &filename, &content, &omitted)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// The same right the import needed. Reading back a staff sheet is reading
	// staff records, whatever route it arrives by.
	need := permForImportEntity(entity)
	if need == "" || !id.Can(need) {
		httpx.Forbidden(w, r, "reading this upload")
		return
	}

	body := ""
	if content != nil {
		body = *content
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"entity":   entity,
		"filename": filename,
		"content":  body,
		// Told apart on purpose: a file too large to keep is not an empty
		// file, and an empty table would say the second.
		"omitted": omitted,
	})
}
