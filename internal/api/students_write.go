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

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
)

/* Student records: create, edit, the 360 view, and bulk import.

   Bulk import matters more than it looks. Every school arrives with a
   spreadsheet of several hundred children, and an ERP that can only add them
   one at a time is an ERP nobody finishes onboarding. */

type studentWriteRequest struct {
	AdmissionNo  string `json:"admission_no,omitempty"`
	FirstName    string `json:"first_name"`
	MiddleName   string `json:"middle_name,omitempty"`
	LastName     string `json:"last_name,omitempty"`
	DateOfBirth  string `json:"date_of_birth,omitempty"`
	Gender       string `json:"gender,omitempty"`
	BloodGroup   string `json:"blood_group,omitempty"`
	Medium       string `json:"medium,omitempty"`
	MotherTongue string `json:"mother_tongue,omitempty"`
	Religion     string `json:"religion,omitempty"`
	AddressLine1 string `json:"address_line1,omitempty"`
	City         string `json:"city,omitempty"`
	State        string `json:"state,omitempty"`
	Pincode      string `json:"pincode,omitempty"`
	APAARID      string `json:"apaar_id,omitempty"`
	ChildInfoID  string `json:"child_info_id,omitempty"`
	PriorSchool  string `json:"prior_school,omitempty"`
	IsRTE        bool   `json:"is_rte"`
	IsCWSN       bool   `json:"is_cwsn"`
	// Placement and guardian are accepted alongside the student so one form
	// produces a complete, contactable, enrolled child.
	SectionID string `json:"section_id,omitempty"`
	// AllowOverflow admits into a section that is already at capacity. A
	// deliberate act, not a default: see the check in placement below.
	AllowOverflow    bool   `json:"allow_overflow,omitempty"`
	AcademicYearID   string `json:"academic_year_id,omitempty"`
	RollNo           int    `json:"roll_no,omitempty"`
	GuardianName     string `json:"guardian_name,omitempty"`
	GuardianPhone    string `json:"guardian_phone,omitempty"`
	GuardianEmail    string `json:"guardian_email,omitempty"`
	GuardianRelation string `json:"guardian_relation,omitempty"`
}

var validGenders = map[string]bool{"male": true, "female": true, "other": true}

// checkVocabulary validates the fields a school is allowed to extend.
//
// Kept out of validate() because that method has neither the request nor the
// server, and the answer now depends on both: the medium a school teaches in
// is theirs to add, and a hardcoded map refusing "Kannada" is the product
// telling a school it does not exist.
func (s *Server) checkVocabulary(r *http.Request, req *studentWriteRequest) error {
	for _, f := range []struct{ kind, value string }{
		{"medium", strings.ToLower(strings.TrimSpace(req.Medium))},
		{"blood_group", strings.TrimSpace(req.BloodGroup)},
		{"mother_tongue", strings.TrimSpace(req.MotherTongue)},
		{"religion", strings.TrimSpace(req.Religion)},
	} {
		ok, err := s.allowsValue(r, f.kind, f.value)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("that is not one of your " + kindLabels[f.kind] +
				". Add it to the list first, then choose it")
		}
	}
	return nil
}

/* validMediums was here. It listed five media of instruction and refused
   everything else, which is why a school teaching in Kannada could not record
   the fact. Media are now part of the vocabulary a school extends for itself —
   see checkVocabulary above and internal/api/custom_options.go — so the list
   is gone rather than left dead for somebody to wire back in. */

// errSectionFull is a refusal the caller can act on: waitlist the child,
// choose another section, or re-send with allow_overflow.
var errSectionFull = errors.New("section is full")

func (req *studentWriteRequest) validate() error {
	if strings.TrimSpace(req.FirstName) == "" {
		return errors.New("first_name is required")
	}
	if req.Gender != "" && !validGenders[req.Gender] {
		return errors.New("gender must be male, female or other")
	}
	if req.DateOfBirth != "" {
		if _, err := time.Parse(time.DateOnly, req.DateOfBirth); err != nil {
			return errors.New("date_of_birth must be YYYY-MM-DD")
		}
	}
	if req.APAARID != "" && len(req.APAARID) != 12 {
		return errors.New("apaar_id must be 12 digits")
	}
	if req.Pincode != "" && len(req.Pincode) != 6 {
		return errors.New("pincode must be 6 digits")
	}
	return nil
}

// upsertStudent writes one student, their placement and their guardian.
// Shared by the single-student form and the bulk importer so both apply
// exactly the same rules.
func upsertStudent(r *http.Request, tx pgx.Tx, instID uuid.UUID, req studentWriteRequest) (string, string, error) {
	campus, err := ensureCampus(r, tx, instID)
	if err != nil {
		return "", "", err
	}

	admissionNo := strings.TrimSpace(req.AdmissionNo)
	if admissionNo == "" {
		if admissionNo, err = fees.NextNumber(r.Context(), tx, instID, "admission"); err != nil {
			return "", "", err
		}
	}

	var studentID string
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO students (institution_id, campus_id, admission_no, first_name, middle_name,
		                      last_name, date_of_birth, gender, blood_group, medium,
		                      mother_tongue, religion, address_line1, city, state, pincode,
		                      apaar_id, child_info_id, prior_school, is_rte, is_cwsn,
		                      admission_date, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,
		        $17,$18,$19,$20,$21, CURRENT_DATE,'active')
		ON CONFLICT (institution_id, admission_no) DO UPDATE SET
		    first_name = EXCLUDED.first_name, middle_name = EXCLUDED.middle_name,
		    last_name = EXCLUDED.last_name, date_of_birth = EXCLUDED.date_of_birth,
		    gender = EXCLUDED.gender, blood_group = EXCLUDED.blood_group,
		    medium = EXCLUDED.medium, mother_tongue = EXCLUDED.mother_tongue,
		    religion = EXCLUDED.religion, address_line1 = EXCLUDED.address_line1,
		    city = EXCLUDED.city, state = EXCLUDED.state, pincode = EXCLUDED.pincode,
		    apaar_id = COALESCE(EXCLUDED.apaar_id, students.apaar_id),
		    child_info_id = COALESCE(EXCLUDED.child_info_id, students.child_info_id),
		    prior_school = EXCLUDED.prior_school, is_rte = EXCLUDED.is_rte,
		    is_cwsn = EXCLUDED.is_cwsn, updated_at = now()
		RETURNING id::text`,
		instID, campus, admissionNo, req.FirstName, nullString(req.MiddleName),
		nullString(req.LastName), nullString(req.DateOfBirth), nullString(req.Gender),
		nullString(req.BloodGroup), nullString(strings.ToLower(req.Medium)),
		nullString(req.MotherTongue), nullString(req.Religion), nullString(req.AddressLine1),
		nullString(req.City), nullString(req.State), nullString(req.Pincode),
		nullString(req.APAARID), nullString(req.ChildInfoID), nullString(req.PriorSchool),
		req.IsRTE, req.IsCWSN).Scan(&studentID); err != nil {
		return "", "", err
	}

	// Placement.
	if req.SectionID != "" {
		yearID := req.AcademicYearID
		if yearID == "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id::text FROM academic_years
				 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&yearID); err != nil {
				return "", "", errNoAcademicYear
			}
		}
		/* Refuse to over-fill a section unless told to.

		   The admissions funnel already refuses this — offering a seat in a
		   full class answers "no seats remain, waitlist the applicant" — but
		   the walk-in path wrote the enrolment without looking, so the same
		   school could be at 41 of 40 through one door and blocked at the
		   other. Two doors into the same room have to agree.

		   Overridable, because a school does sometimes take the forty-first
		   child and the system should record that rather than prevent it. What
		   it must not do is let it happen silently. */
		if !req.AllowOverflow {
			var name string
			var capacity, taken int
			err := tx.QueryRow(r.Context(), `
				SELECT c.name || '-' || s.name, s.capacity,
				       (SELECT count(*) FROM enrollments e
				         WHERE e.section_id = s.id AND e.status = 'active')::int
				  FROM sections s JOIN classes c ON c.id = s.class_id
				 WHERE s.id = $1::uuid`, req.SectionID).Scan(&name, &capacity, &taken)
			if err != nil {
				return "", "", err
			}
			if capacity > 0 && taken >= capacity {
				return "", "", fmt.Errorf("%w: %s is full at %d of %d",
					errSectionFull, name, taken, capacity)
			}
		}

		var rollNo any
		if req.RollNo > 0 {
			rollNo = req.RollNo
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO enrollments (institution_id, student_id, academic_year_id,
			                         class_id, section_id, roll_no, status)
			SELECT $1, $2::uuid, $3::uuid, s.class_id, s.id, $5, 'active'
			  FROM sections s WHERE s.id = $4::uuid
			ON CONFLICT (student_id, academic_year_id)
			DO UPDATE SET section_id = EXCLUDED.section_id,
			              class_id   = EXCLUDED.class_id,
			              roll_no    = COALESCE(EXCLUDED.roll_no, enrollments.roll_no),
			              status     = 'active'`,
			instID, studentID, yearID, req.SectionID, rollNo); err != nil {
			return "", "", err
		}
	}

	// Guardian. Reused across siblings via the phone+name key.
	if req.GuardianName != "" && req.GuardianPhone != "" {
		relation := req.GuardianRelation
		if relation == "" {
			relation = "father"
		}
		var guardianID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO guardians (institution_id, full_name, relation, phone, email)
			VALUES ($1,$2,$3,$4,$5::citext)
			ON CONFLICT (institution_id, phone, full_name)
			DO UPDATE SET relation = EXCLUDED.relation,
			              email = COALESCE(EXCLUDED.email, guardians.email)
			RETURNING id::text`,
			instID, req.GuardianName, relation, req.GuardianPhone,
			nullString(req.GuardianEmail)).Scan(&guardianID); err != nil {
			return "", "", err
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
			VALUES ($1::uuid,$2::uuid,$3,true) ON CONFLICT DO NOTHING`,
			studentID, guardianID, instID); err != nil {
			return "", "", err
		}
	}

	return studentID, admissionNo, nil
}

// createStudent admits one child directly, outside the admissions funnel —
// which is how a school onboards its existing roll.
func (s *Server) createStudent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req studentWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if err := req.validate(); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if err := s.checkVocabulary(r, &req); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	var studentID, admissionNo string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		studentID, admissionNo, err = upsertStudent(r, tx, id.InstitutionID, req)
		return err
	})
	if errors.Is(err, errNoAcademicYear) {
		httpx.BadRequest(w, r, "create an academic year before enrolling students")
		return
	}
	// 409, matching the offer path: the request is well-formed and the school
	// simply has no room, which the office resolves by choosing another
	// section or re-sending with allow_overflow.
	if errors.Is(err, errSectionFull) {
		httpx.Error(w, r, http.StatusConflict, "no_seats",
			err.Error()+". Choose another section, or re-send with allow_overflow to admit anyway.")
		return
	}
	if err != nil {
		if strings.Contains(err.Error(), "students_apaar_id") {
			httpx.Error(w, r, http.StatusConflict, "apaar_already_used",
				"that APAAR ID is already assigned to another student")
			return
		}
		/* Two children cannot share a roll number in one section.

		   This surfaced as a 500 — "something went wrong" — on the admissions
		   clerk's screen, twice in a row on the same afternoon, on a form they
		   had filled in correctly apart from one number. The database was
		   right to refuse it; the product was wrong to present a rule of the
		   school's own as a fault of the software. It is the clerk's to fix,
		   so it is said in words they can act on. */
		if strings.Contains(err.Error(), "enrollments_roll_no_unique") {
			httpx.Error(w, r, http.StatusConflict, "roll_no_taken",
				"another child in that section already has this roll number. Use a different one, or leave it blank and it will be left unset.")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": studentID, "admission_no": admissionNo,
	})
}

// updateStudent edits an existing record. Scope-checked: a teacher may not
// rewrite a child outside their sections.
func (s *Server) updateStudent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req studentWriteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if err := req.validate(); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if err := s.checkVocabulary(r, &req); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var existing string
		if err := tx.QueryRow(r.Context(),
			`SELECT st.admission_no FROM students st WHERE st.id = $1 AND `+pred,
			append([]any{sid}, args...)...).Scan(&existing); err != nil {
			return err
		}
		req.AdmissionNo = existing // never renumber on edit
		_, _, err := upsertStudent(r, tx, id.InstitutionID, req)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": sid.String(), "updated": true})
}

// --- bulk import -------------------------------------------------------------

type importRow struct {
	Row     int               `json:"row"`
	Data    map[string]string `json:"data"`
	Problem string            `json:"problem,omitempty"`
}

type importResult struct {
	Total    int         `json:"total"`
	Valid    int         `json:"valid"`
	Rejected int         `json:"rejected"`
	Imported int         `json:"imported"`
	DryRun   bool        `json:"dry_run"`
	Problems []importRow `json:"problems"`
}

// importStudents accepts a CSV and either validates it or writes it.
//
// Dry run is the default and the whole point: a clerk uploads the spreadsheet,
// sees exactly which rows are wrong and why, fixes them in Excel, and re-uploads.
// Importing 800 children and discovering afterwards that 40 had bad dates is a
// far worse experience than refusing up front.
//
// The write is one transaction: a partial import leaves a school unable to tell
// which half of the file landed.
func (s *Server) importStudents(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	commit := r.URL.Query().Get("commit") == "true"

	// 8 MB covers a few thousand rows; beyond that the file is a data-migration
	// job, not an upload.
	// Read once and parse from memory: the file is wanted twice, to import it
	// and to keep it against the history so the upload can be opened later and
	// read back the way every other importer's can.
	raw, rerr := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if rerr != nil {
		httpx.BadRequest(w, r, "could not read the file. Is it larger than 8 MB?")
		return
	}

	reader := csv.NewReader(bytes.NewReader(raw))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1 // tolerate ragged rows; report them per row

	header, err := reader.Read()
	if err != nil {
		httpx.BadRequest(w, r, "could not read the CSV header")
		return
	}
	col := map[string]int{}
	for i, h := range header {
		// TrimSpace does not remove a byte order mark, and every CSV that
		// Excel saves begins with one. Without this the first column --
		// whichever it happens to be -- is keyed with the mark still on it
		// and stops matching its own name, so a class list imported from a
		// spreadsheet quietly lost its admission numbers and every child
		// was given a generated one instead.
		col[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))] = i
	}
	/* One column is genuinely required and the rest are not.

	   Every other column is read through get(), which answers "" for a header
	   the file does not have — so a sheet with six columns imports exactly as
	   well as one with eighteen, and a school that keeps no blood groups does
	   not have to invent an empty column to satisfy a template.

	   The name is the exception, because a child with no name is not a record.
	   full_name or first_name will do: schools write one column and the older
	   template wrote three, and both keep working. */
	_, hasFull := col["full_name"]
	_, hasFirst := col["first_name"]
	if !hasFull && !hasFirst {
		httpx.BadRequest(w, r,
			"the CSV needs a full_name column (or first_name). Everything else is optional")
		return
	}

	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	type parsed struct {
		req studentWriteRequest
		row int
	}
	var good []parsed
	out := importResult{DryRun: !commit, Problems: []importRow{}}

	rowNum := 1 // header is row 1
	for {
		rec, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		rowNum++
		if err != nil {
			out.Total++
			out.Rejected++
			out.Problems = append(out.Problems, importRow{
				Row: rowNum, Problem: "malformed row: " + err.Error()})
			continue
		}
		out.Total++

		// full_name wins where the sheet has one; the three-column form is
		// still read, so a file written against the older template imports
		// unchanged.
		first, middle, last := splitName(get(rec, "full_name"))
		if first == "" {
			first = get(rec, "first_name")
			middle = get(rec, "middle_name")
			last = get(rec, "last_name")
		}

		req := studentWriteRequest{
			AdmissionNo:      get(rec, "admission_no"),
			FirstName:        first,
			MiddleName:       middle,
			LastName:         last,
			DateOfBirth:      normaliseDate(get(rec, "date_of_birth")),
			Gender:           strings.ToLower(get(rec, "gender")),
			BloodGroup:       get(rec, "blood_group"),
			Medium:           strings.ToLower(get(rec, "medium")),
			MotherTongue:     get(rec, "mother_tongue"),
			AddressLine1:     get(rec, "address"),
			City:             get(rec, "city"),
			State:            get(rec, "state"),
			Pincode:          get(rec, "pincode"),
			APAARID:          get(rec, "apaar_id"),
			ChildInfoID:      get(rec, "child_info_id"),
			PriorSchool:      get(rec, "prior_school"),
			IsRTE:            isTruthy(get(rec, "is_rte")),
			IsCWSN:           isTruthy(get(rec, "is_cwsn")),
			GuardianName:     get(rec, "guardian_name"),
			GuardianPhone:    get(rec, "guardian_phone"),
			GuardianEmail:    get(rec, "guardian_email"),
			GuardianRelation: strings.ToLower(get(rec, "guardian_relation")),
			// Carries a human label such as "Class 6-A" at this point; resolved
			// to a section id below, once, rather than per row.
			SectionID: get(rec, "section"),
		}
		if v := get(rec, "roll_no"); v != "" {
			req.RollNo, _ = strconv.Atoi(v)
		}

		if err := req.validate(); err != nil {
			out.Rejected++
			out.Problems = append(out.Problems, importRow{
				Row: rowNum, Problem: err.Error(),
				Data: map[string]string{
					"first_name": req.FirstName, "admission_no": req.AdmissionNo,
				}})
			continue
		}
		out.Valid++
		good = append(good, parsed{req: req, row: rowNum})
	}

	// Resolve "Class 6-A" style placement once, not per row.
	sectionByLabel := map[string]string{}
	if commit && len(good) > 0 {
		_ = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT lower(c.name || '-' || s.name), s.id::text
				  FROM sections s JOIN classes c ON c.id = s.class_id`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var label, sid string
				if err := rows.Scan(&label, &sid); err != nil {
					return err
				}
				sectionByLabel[label] = sid
			}
			return rows.Err()
		})
	}

	if !commit {
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	if out.Rejected > 0 {
		httpx.Error(w, r, http.StatusBadRequest, "import_has_errors",
			fmt.Sprintf("%d of %d rows are invalid; fix them and upload again",
				out.Rejected, out.Total))
		return
	}

	// Re-read placement labels from the parsed rows.
	var createdStudents []createdRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		createdStudents = nil
		for i := range good {
			if sid, ok := sectionByLabel[strings.ToLower(good[i].req.SectionID)]; ok {
				good[i].req.SectionID = sid
			}
			sid, _, err := upsertStudent(r, tx, id.InstitutionID, good[i].req)
			if err != nil {
				return fmt.Errorf("row %d: %w", good[i].row, err)
			}
			/* Only the children this file brought into existence.

			   upsertStudent updates on a matching admission number, so a
			   corrected re-upload edits children who were already enrolled —
			   and undoing that upload must not remove them. Asked directly
			   rather than inferred: a row created in this transaction has no
			   enrolment older than it. */
			var fresh bool
			if err := tx.QueryRow(r.Context(),
				`SELECT created_at >= now() - interval '1 minute' FROM students WHERE id = $1`,
				sid).Scan(&fresh); err == nil && fresh {
				if parsed, perr := uuid.Parse(sid); perr == nil {
					createdStudents = append(createdStudents,
						createdRow{entity: "students", id: parsed})
				}
			}
			out.Imported++
		}
		// Written inside the same transaction as the children, so a log entry
		// cannot survive an import that rolled back.
		return recordImportRunFull(r, tx, id.InstitutionID, "students",
			r.URL.Query().Get("filename"), out.Total, out.Imported, out.Rejected,
			createdStudents, string(raw))
	})
	if err != nil {
		out.Imported = 0
		httpx.Error(w, r, http.StatusBadRequest, "import_failed", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// normaliseDate accepts the formats Indian spreadsheets actually contain and
// returns ISO. Excel exports dd/mm/yyyy far more often than yyyy-mm-dd, and
// rejecting those would fail almost every real upload.

/*
splitName turns "Aarav Kumar Sharma" into the three columns students has.

	The table stores first, middle and last because a report card prints them
	separately and a transfer certificate is required to. A school's own
	spreadsheet almost never does: it has one column called Name, and asking an
	office to split six hundred of them by hand before they can import is how a
	migration stops.

	The rule is the ordinary Indian one for a written name — first word is the
	given name, last word is the surname, anything between is the middle. A
	single word is a given name and nothing else, which is correct for the
	children who genuinely have one.
*/
func splitName(full string) (first, middle, last string) {
	parts := strings.Fields(strings.TrimSpace(full))
	switch len(parts) {
	case 0:
		return "", "", ""
	case 1:
		return parts[0], "", ""
	case 2:
		return parts[0], "", parts[1]
	default:
		return parts[0], strings.Join(parts[1:len(parts)-1], " "), parts[len(parts)-1]
	}
}

func normaliseDate(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	for _, layout := range []string{
		time.DateOnly, "02/01/2006", "02-01-2006", "2/1/2006",
		"01/02/2006", "2006/01/02", "02.01.2006",
	} {
		if t, err := time.Parse(layout, v); err == nil {
			// Guard against a US-format misread producing an impossible year.
			if t.Year() > 1900 && t.Year() < 2100 {
				return t.Format(time.DateOnly)
			}
		}
	}
	return v // hand it to validate(), which will reject it with a clear message
}

func isTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "y", "yes", "true", "1":
		return true
	}
	return false
}

// getImportTemplate returns the CSV header a school should fill in.
func (s *Server) getImportTemplate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="students-template.csv"`)
	/* The columns a school actually has, and no more.

	   APAAR, Child Info, RTE and CWSN came off: they are admissions and
	   government-return fields, they are blank in every sheet a school hands
	   over on the first day, and four empty columns at the front of a template
	   read as four things somebody has to go and find out. They are still on
	   the record and still editable on the child's own page.

	   One name column instead of three, because that is what a school's
	   spreadsheet has. The importer splits it and still reads the three-column
	   form, so nothing written against the old template breaks.

	   Every column here except full_name is optional. A file with four of
	   them imports. */
	_, _ = io.WriteString(w, strings.Join([]string{
		"full_name", "admission_no", "date_of_birth", "gender", "blood_group",
		"medium", "mother_tongue", "section", "roll_no",
		"address", "city", "state", "pincode", "prior_school",
		"guardian_name", "guardian_relation", "guardian_phone", "guardian_email",
	}, ",")+"\n")
	_, _ = io.WriteString(w,
		"Meera Menon,ADM0001,14/06/2013,female,B+,english,Malayalam,Class 6-A,1,"+
			"12 Green Park,Hyderabad,Telangana,500001,St Teresa's,"+
			"Suresh Menon,father,9845012345,suresh@example.com\n")
}

// --- student 360 --------------------------------------------------------------

// getStudentProfile assembles everything about one child in a single response.
//
// This is the screen a school opens most often — a parent is on the phone, or
// standing at the desk — so it answers the questions that actually get asked:
// who are they, which class, who do we call, are they present, what do they
// owe, how are they doing. Six round trips would make it feel slow at exactly
// the moment it needs to feel instant.
func (s *Server) getStudentProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	out := map[string]any{}
	guardians := []map[string]any{}
	attendance := []map[string]any{}
	results := []map[string]any{}
	ledger := []map[string]any{}
	documents := []map[string]any{}
	enrolments := []map[string]any{}
	transport := []map[string]any{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			admissionNo, fullName, status                          string
			className, sectionName, gender, dob, medium, blood     *string
			motherTongue, apaar, childInfo, phone, city, priorSchl *string
			rollNo                                                 *int32
			isRTE, isCWSN                                          bool
			admissionDate                                          string
			photoFileID                                            *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.status, c.name, sec.name, en.roll_no, st.gender,
			       to_char(st.date_of_birth,'YYYY-MM-DD'), st.medium, st.blood_group,
			       st.mother_tongue, st.apaar_id, st.child_info_id,
			       (SELECT g.phone FROM student_guardians sg
			          JOIN guardians g ON g.id = sg.guardian_id
			         WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1),
			       st.city, st.prior_school, st.is_rte, st.is_cwsn,
			       to_char(st.admission_date,'YYYY-MM-DD'),
			       st.photo_file_id::text
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id, e.roll_no FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE st.id = $1 AND `+pred,
			append([]any{sid}, args...)...).
			Scan(&admissionNo, &fullName, &status, &className, &sectionName, &rollNo,
				&gender, &dob, &medium, &blood, &motherTongue, &apaar, &childInfo,
				&phone, &city, &priorSchl, &isRTE, &isCWSN, &admissionDate,
				&photoFileID); err != nil {
			return err
		}
		out["id"] = sid.String()
		out["admission_no"] = admissionNo
		out["full_name"] = fullName
		out["status"] = status
		out["class_name"] = className
		out["section_name"] = sectionName
		out["roll_no"] = rollNo
		out["gender"] = gender
		out["date_of_birth"] = dob
		out["medium"] = medium
		out["blood_group"] = blood
		out["mother_tongue"] = motherTongue
		out["apaar_id"] = apaar
		out["child_info_id"] = childInfo
		out["primary_phone"] = phone
		out["city"] = city
		out["prior_school"] = priorSchl
		out["is_rte"] = isRTE
		out["is_cwsn"] = isCWSN
		out["admission_date"] = admissionDate
		out["photo_file_id"] = photoFileID

		var present, total int
		var duesPaise, paidPaise int64
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*) FROM student_attendance
			         WHERE student_id=$1 AND status IN ('present','late'))::int,
			       (SELECT count(*) FROM student_attendance WHERE student_id=$1)::int,
			       COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
			                  WHERE student_id=$1 AND status IN ('unpaid','partial','overdue')),0),
			       COALESCE((SELECT sum(amount_paise) FROM payments
			                  WHERE student_id=$1 AND status='success'),0)`,
			sid).Scan(&present, &total, &duesPaise, &paidPaise); err != nil {
			return err
		}
		pct := 0
		if total > 0 {
			pct = present * 100 / total
		}
		out["attendance"] = map[string]any{
			"present": present, "total": total, "percent": pct,
			// Board exam eligibility hinges on 75%, so the flag is computed
			// here rather than left for each screen to re-derive.
			"below_threshold": total > 0 && pct < 75,
		}
		/* Two different measures, and the header must not imply otherwise.
		   outstanding_paise is what this child still owes on unpaid invoices of
		   every academic year; paid_paise is every successful receipt ever
		   taken on the account, across all years and including money not yet
		   applied to any invoice. They do not add up to one year's bill, and
		   the profile labels them so. */
		out["fees"] = map[string]any{"outstanding_paise": duesPaise, "paid_paise": paidPaise}

		if err := scanInto(r.Context(), tx, `
			SELECT g.full_name, g.relation, COALESCE(g.phone,''), COALESCE(g.email::text,''),
			       sg.is_primary
			  FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = '`+sid.String()+`'::uuid
			 ORDER BY sg.is_primary DESC`,
			func(rows pgx.Rows) error {
				var name, rel, ph, em string
				var primary bool
				if err := rows.Scan(&name, &rel, &ph, &em, &primary); err != nil {
					return err
				}
				guardians = append(guardians, map[string]any{
					"full_name": name, "relation": rel, "phone": ph,
					"email": em, "is_primary": primary})
				return nil
			}); err != nil {
			return err
		}

		// Last 30 marked days, newest first — enough for a phone conversation.
		if err := scanInto(r.Context(), tx, `
			SELECT to_char(on_date,'YYYY-MM-DD'), status
			  FROM student_attendance WHERE student_id = '`+sid.String()+`'::uuid
			 ORDER BY on_date DESC LIMIT 30`,
			func(rows pgx.Rows) error {
				var d, st string
				if err := rows.Scan(&d, &st); err != nil {
					return err
				}
				attendance = append(attendance, map[string]any{"date": d, "status": st})
				return nil
			}); err != nil {
			return err
		}

		if err := scanInto(r.Context(), tx, `
			SELECT e.name, COALESCE(rc.percentage::text,''), COALESCE(rc.grade,''),
			       COALESCE(rc.rank_in_section::text,'')
			  FROM report_cards rc
			  LEFT JOIN exams e ON e.academic_year_id = rc.academic_year_id
			 WHERE rc.student_id = '`+sid.String()+`'::uuid AND rc.is_published
			 ORDER BY rc.created_at DESC LIMIT 10`,
			func(rows pgx.Rows) error {
				var exam, pct, grade, rank string
				if err := rows.Scan(&exam, &pct, &grade, &rank); err != nil {
					return err
				}
				results = append(results, map[string]any{
					"exam": exam, "percentage": pct, "grade": grade, "rank": rank})
				return nil
			}); err != nil {
			return err
		}

		if err := scanInto(r.Context(), tx, `
			SELECT to_char(i.issued_on,'YYYY-MM-DD'), i.invoice_no,
			       i.net_paise, i.paid_paise, i.status
			  FROM invoices i WHERE i.student_id = '`+sid.String()+`'::uuid
			 ORDER BY i.issued_on DESC LIMIT 20`,
			func(rows pgx.Rows) error {
				var d, no, st string
				var net, paid int64
				if err := rows.Scan(&d, &no, &net, &paid, &st); err != nil {
					return err
				}
				ledger = append(ledger, map[string]any{
					"date": d, "invoice_no": no, "net_paise": net,
					"paid_paise": paid, "status": st})
				return nil
			}); err != nil {
			return err
		}

		/* Where the child has been, and how they get here.

		   Two tabs on the most-opened record in the product were showing a
		   single line each: the History tab said which class the child is in
		   now — which the header already says — and Transport was not there at
		   all, because there was nothing to put in it.

		   Both were queries nobody had written, not features nobody had built.
		   A promotion writes an enrolments row and closes the last one, and a
		   bus seat is a transport_allocations row; the record just never asked
		   for either. The class teacher asking "has this child been detained
		   before" and the front desk asking "which bus does she take, her
		   mother is at the gate" were both being sent to somebody else's
		   screen to find out. */
		if err := scanInto(r.Context(), tx, `
			SELECT ay.name, c.name, sec.name, e.roll_no,
			       to_char(e.enrolled_on,'YYYY-MM-DD'), e.status
			  FROM enrollments e
			  JOIN academic_years ay ON ay.id = e.academic_year_id
			  JOIN classes c ON c.id = e.class_id
			  JOIN sections sec ON sec.id = e.section_id
			 WHERE e.student_id = '`+sid.String()+`'::uuid
			 ORDER BY e.enrolled_on DESC`,
			func(rows pgx.Rows) error {
				var year, cls, sec, on, st string
				var roll *int
				if err := rows.Scan(&year, &cls, &sec, &roll, &on, &st); err != nil {
					return err
				}
				enrolments = append(enrolments, map[string]any{
					"year": year, "class": cls, "section": sec,
					"roll_no": roll, "from": on, "status": st})
				return nil
			}); err != nil {
			return err
		}

		if err := scanInto(r.Context(), tx, `
			SELECT rt.name, COALESCE(v.registration_no,''), COALESCE(pu.name,''),
			       COALESCE(to_char(pu.pickup_time,'HH24:MI'),''),
			       COALESCE(dr.name,''), COALESCE(to_char(dr.drop_time,'HH24:MI'),''),
			       to_char(ta.valid_from,'YYYY-MM-DD'),
			       COALESCE(to_char(ta.valid_to,'YYYY-MM-DD'),'')
			  FROM transport_allocations ta
			  JOIN routes rt ON rt.id = ta.route_id
			  LEFT JOIN vehicles v ON v.id = rt.vehicle_id
			  LEFT JOIN route_stops pu ON pu.id = ta.pickup_stop_id
			  LEFT JOIN route_stops dr ON dr.id = ta.drop_stop_id
			 WHERE ta.student_id = '`+sid.String()+`'::uuid
			 ORDER BY ta.valid_from DESC`,
			func(rows pgx.Rows) error {
				var route, vehicle, pick, pickAt, drop, dropAt, from, to string
				if err := rows.Scan(&route, &vehicle, &pick, &pickAt,
					&drop, &dropAt, &from, &to); err != nil {
					return err
				}
				transport = append(transport, map[string]any{
					"route": route, "vehicle": vehicle,
					"pickup_stop": pick, "pickup_time": pickAt,
					"drop_stop": drop, "drop_time": dropAt,
					"from": from, "to": to})
				return nil
			}); err != nil {
			return err
		}

		return scanInto(r.Context(), tx, `
			SELECT ic.serial_no, ct.name, to_char(ic.issued_on,'YYYY-MM-DD')
			  FROM issued_certificates ic
			  JOIN certificate_types ct ON ct.id = ic.certificate_type_id
			 WHERE ic.student_id = '`+sid.String()+`'::uuid
			 ORDER BY ic.issued_on DESC`,
			func(rows pgx.Rows) error {
				var serial, kind, on string
				if err := rows.Scan(&serial, &kind, &on); err != nil {
					return err
				}
				documents = append(documents, map[string]any{
					"serial_no": serial, "type": kind, "issued_on": on})
				return nil
			})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out["guardians"] = guardians
	out["recent_attendance"] = attendance
	out["results"] = results
	out["invoices"] = ledger
	out["documents"] = documents
	out["enrolments"] = enrolments
	out["transport"] = transport
	httpx.JSON(w, http.StatusOK, out)
}
