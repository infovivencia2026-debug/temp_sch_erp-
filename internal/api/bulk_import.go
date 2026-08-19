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
	server  *Server
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
	"staff": {
		Perm:     rbac.EmployeesWrite,
		Columns:  []string{"employee_code", "first_name", "last_name", "email", "phone", "designation", "role", "joined_on"},
		Required: []string{"employee_code", "first_name"},
		Sample:   []string{"T-014", "Priya", "Rao", "priya@school.in", "9876543210", "Teacher", "faculty", "2026-06-01"},
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
			_, _, err := appointEmployee(c.r.Context(), c.tx, c.inst, c.campus, req)
			return err
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
		return nil
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
