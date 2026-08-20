package api

import (
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
	// Write inserts one row. It is called inside the import transaction, with
	// the header-keyed values of that row.
	Write func(ctx *importCtx, row map[string]string) error
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
	server   *Server
}

func (c *importCtx) classID(name string) (uuid.UUID, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if id, ok := c.classes[key]; ok {
		return id, nil
	}
	var id uuid.UUID
	err := c.tx.QueryRow(c.r.Context(),
		`SELECT id FROM classes WHERE lower(name) = $1`, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("no class called %q — create the classes first", name)
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.classes[key] = id
	return id, nil
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
			_, err := c.tx.Exec(c.r.Context(), `
				INSERT INTO classes (institution_id, campus_id, name, level, stream)
				VALUES ($1,$2,$3,$4,NULLIF($5,''))
				ON CONFLICT DO NOTHING`,
				c.inst, c.campus, strings.TrimSpace(row["name"]), level, strings.TrimSpace(row["stream"]))
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
			_, err = c.tx.Exec(c.r.Context(), `
				INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id,
				                      name, capacity, room)
				VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))
				ON CONFLICT (class_id, academic_year_id, name)
				DO UPDATE SET capacity = EXCLUDED.capacity, room = EXCLUDED.room`,
				c.inst, c.campus, classID, c.year, strings.TrimSpace(row["name"]), capacity,
				strings.TrimSpace(row["room"]))
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
			_, err := c.tx.Exec(c.r.Context(), `
				INSERT INTO subjects (institution_id, campus_id, name, code, is_scholastic)
				VALUES ($1,$2,$3,upper($4),$5)
				ON CONFLICT (institution_id, campus_id, code)
				DO UPDATE SET name = EXCLUDED.name, is_scholastic = EXCLUDED.is_scholastic`,
				c.inst, c.campus, strings.TrimSpace(row["name"]),
				strings.TrimSpace(row["code"]), scholastic)
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
			_, err := c.tx.Exec(c.r.Context(), `
				INSERT INTO periods (institution_id, campus_id, name, sequence,
				                     starts_at, ends_at, is_break)
				VALUES ($1,$2,$3,$4,NULLIF($5,'')::time,NULLIF($6,'')::time,$7)
				ON CONFLICT (institution_id, campus_id, sequence)
				DO UPDATE SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at,
				              ends_at = EXCLUDED.ends_at, is_break = EXCLUDED.is_break`,
				c.inst, c.campus, strings.TrimSpace(row["name"]), seq,
				strings.TrimSpace(row["starts_at"]), strings.TrimSpace(row["ends_at"]),
				isYes(row["is_break"]))
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
			_, err := c.tx.Exec(c.r.Context(), `
				INSERT INTO fee_heads (institution_id, name, code, is_recurring,
				                       is_taxable, gst_rate_bp)
				VALUES ($1,$2,upper($3),$4,false,0)
				ON CONFLICT (institution_id, code)
				DO UPDATE SET name = EXCLUDED.name, is_recurring = EXCLUDED.is_recurring`,
				c.inst, strings.TrimSpace(row["name"]), strings.TrimSpace(row["code"]),
				recurring)
			return err
		},
	},
	/* Which subjects a class studies, and -- in the same row -- who teaches
	   them. The two were separate steps, so a school listed the subject on
	   step seven and came back on step nine to say who takes it, reading the
	   same sheet twice. A class list from a school already has both columns
	   next to each other. */
	"class_subjects": {
		Perm:     rbac.AcademicsWrite,
		Columns:  []string{"class", "subject_code", "max_marks", "teacher_email"},
		Required: []string{"class", "subject_code"},
		Sample:   []string{"Grade 6", "MATH", "100", "priya.rao@jsm.test"},
		Check: func(row map[string]string) error {
			if v := strings.TrimSpace(row["max_marks"]); v != "" {
				if n, err := strconv.Atoi(v); err != nil || n <= 0 {
					return errors.New("max_marks must be a whole number above zero")
				}
			}
			return nil
		},
		Write: func(c *importCtx, row map[string]string) error {
			classID, err := c.classID(row["class"])
			if err != nil {
				return err
			}
			code := strings.ToUpper(strings.TrimSpace(row["subject_code"]))
			var subjectID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(),
				`SELECT id FROM subjects WHERE upper(code) = $1`, code).Scan(&subjectID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("no subject with code %q — add the subjects first", code)
				}
				return err
			}
			maxMarks := 100
			if v := strings.TrimSpace(row["max_marks"]); v != "" {
				maxMarks, _ = strconv.Atoi(v)
			}
			var csID uuid.UUID
			if err := c.tx.QueryRow(c.r.Context(), `
				INSERT INTO class_subjects (institution_id, class_id, subject_id, max_marks)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (class_id, subject_id)
				DO UPDATE SET max_marks = EXCLUDED.max_marks
				RETURNING id`, c.inst, classID, subjectID, maxMarks).Scan(&csID); err != nil {
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
				`SELECT id FROM users WHERE email = $1::citext`, email).Scan(&teacher); err != nil {
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
				 WHERE sec.id = $1
				   AND (upper(sub.code) = upper($2) OR lower(sub.name) = lower($2))`,
				sectionID, code).Scan(&csID, &subjectID); err != nil {
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
			_, userID, err := appointEmployee(c.r.Context(), c.tx, c.inst, c.campus, req)
			if err != nil {
				return err
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
			for _, raw := range strings.FieldsFunc(list, func(r rune) bool {
				return r == ';' || r == ',' || r == '|'
			}) {
				want := strings.TrimSpace(raw)
				if want == "" {
					continue
				}
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
	body := http.MaxBytesReader(w, r.Body, 8<<20)
	defer body.Close()

	reader := csv.NewReader(body)
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

	if !commit || out.Rejected > 0 || len(rows) == 0 {
		// Refusing to write a file with any bad row is deliberate: a partial
		// import leaves the office reconciling what went in against what did
		// not, which is more work than fixing the sheet.
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

		for _, p := range rows {
			if err := spec.Write(ctx, p.data); err != nil {
				return fmt.Errorf("row %d: %w", p.row, err)
			}
			out.Imported++
		}

		/* The record of what was loaded, written in the same transaction as
		   the rows themselves.

		   Outside it, a failed import could still leave a log entry claiming
		   success -- which is worse than no log, because somebody would then
		   not re-import a file that never landed. */
		return recordImportRun(r, tx, id.InstitutionID, entity,
			r.URL.Query().Get("filename"), out.Total, out.Imported, out.Rejected)
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

	_, err := tx.Exec(r.Context(), `
		INSERT INTO import_runs (institution_id, entity, filename,
		                         rows_read, rows_imported, rows_rejected, imported_by)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7)`,
		inst, entity, strings.TrimSpace(filename), read, imported, rejected,
		httpx.IdentityFrom(r.Context()).UserID)
	return err
}

type importRunRow struct {
	Entity   string  `json:"entity"`
	Filename *string `json:"filename,omitempty"`
	RowsRead int     `json:"rows_read"`
	Imported int     `json:"rows_imported"`
	Rejected int     `json:"rows_rejected"`
	By       *string `json:"imported_by,omitempty"`
	At       string  `json:"created_at"`
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
		SELECT ir.entity, ir.filename, ir.rows_read, ir.rows_imported,
		       ir.rows_rejected, u.full_name,
		       to_char(ir.created_at, 'YYYY-MM-DD"T"HH24:MI:SS')
		  FROM import_runs ir
		  LEFT JOIN users u ON u.id = ir.imported_by
		 WHERE ($1::text IS NULL OR ir.entity = $1)
		 ORDER BY ir.created_at DESC
		 LIMIT 50`,
		[]any{nullString(r.URL.Query().Get("entity"))},
		func(rows pgx.Rows) (importRunRow, error) {
			var v importRunRow
			return v, rows.Scan(&v.Entity, &v.Filename, &v.RowsRead, &v.Imported,
				&v.Rejected, &v.By, &v.At)
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
		`SELECT id FROM sections WHERE class_id = $1 AND lower(name) = $2 LIMIT 1`,
		classID, strings.ToLower(strings.TrimSpace(sectionName))).Scan(&id)
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
		`SELECT id FROM users WHERE email = $1::citext`, key).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("no member of staff with the email %q — import the staff first", email)
	}
	if err != nil {
		return uuid.Nil, err
	}
	c.teachers[key] = id
	return id, nil
}
