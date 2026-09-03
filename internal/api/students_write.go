package api

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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
	AddressLine2 string `json:"address_line2,omitempty"`
	/* NOT a guardian row, deliberately. A guardian gets a login, fee reminders
	   and absence alerts; the neighbour who holds a spare key should get none
	   of that, and modelling them as a guardian to store a phone number would
	   put them on all of it. */
	PermanentAddress  string `json:"permanent_address,omitempty"`
	EmergencyName     string `json:"emergency_contact_name,omitempty"`
	EmergencyPhone    string `json:"emergency_contact_phone,omitempty"`
	EmergencyRelation string `json:"emergency_contact_relation,omitempty"`
	/* The statutory fields the form could not reach.

	   All four have been columns since the baseline and nothing ever wrote
	   them, so a school filing an RTE or a scholarship return had the category
	   nowhere on the child's record and kept it in a spreadsheet beside the
	   ERP — which is the thing an ERP exists to stop.

	   AADHAAR IS FOUR DIGITS, DELIBERATELY. The column is aadhaar_last4 with a
	   CHECK of exactly four, and that is the right design: a school needs to
	   match a child against a government list, which the last four does, and
	   holding the whole number makes the school's database worth stealing. */
	// Optional everywhere. A school with no house system never sees this, and
	// a child with no house is not an incomplete record.
	HouseID      string `json:"house_id,omitempty"`
	Category     string `json:"category,omitempty"`
	Nationality  string `json:"nationality,omitempty"`
	AadhaarLast4 string `json:"aadhaar_last4,omitempty"`
	City         string `json:"city,omitempty"`
	State        string `json:"state,omitempty"`
	Pincode      string `json:"pincode,omitempty"`
	APAARID      string `json:"apaar_id,omitempty"`
	ChildInfoID  string `json:"child_info_id,omitempty"`
	PriorSchool  string `json:"prior_school,omitempty"`
	/* THE DAY THE CHILD ACTUALLY JOINED.

	   This was CURRENT_DATE with nothing able to set it, so a school importing
	   the roll it has kept for fifteen years got a file in which every child
	   joined on the morning of the import. Length of service is not a detail:
	   it decides seniority, it prints on a transfer certificate, and it is the
	   difference between a child continuing from past years and a new joiner,
	   which is the distinction the school is importing the file to preserve. */
	AdmissionDate string `json:"admission_date,omitempty"`
	/* Where they were before this year, for a child who did not start here.

	   A roll imported mid-life has no history: the child appears in this
	   year's section having existed nowhere previously, so "which class was
	   she in last year" -- asked on every transfer certificate and every
	   promotion -- has no answer. One prior placement is enough to make the
	   record continuous; a school with more can import the file once per
	   year. */
	PreviousClass string `json:"previous_class,omitempty"`
	PreviousYear  string `json:"previous_year,omitempty"`
	IsRTE         bool   `json:"is_rte"`
	IsCWSN        bool   `json:"is_cwsn"`
	/* Whatever else this school keeps about a child.

	   Schools differ in ways no fixed column list survives: a bus stop name, a
	   sibling's admission number, a scholarship reference, the parent's
	   employer. custom_fields has been on the table since the baseline with
	   nothing writing to it, so the answer to "can we record X" was no. Now it
	   is yes, without a migration per school. */
	CustomFields map[string]string `json:"custom_fields,omitempty"`
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
	/* THE OTHER PARENT.

	   A school's roll has the father and the mother side by side, with two
	   names, two mobile numbers and often two email addresses. We stored one,
	   so importing a real file silently threw the mother away -- and she is
	   frequently the number that answers, the one on the gate pass, and the
	   only contact when the father works away.

	   A second guardian, not a replacement: both are linked to the child, the
	   first is primary, and either can be reached. */
	Guardian2Name     string `json:"guardian2_name,omitempty"`
	Guardian2Phone    string `json:"guardian2_phone,omitempty"`
	Guardian2Email    string `json:"guardian2_email,omitempty"`
	Guardian2Relation string `json:"guardian2_relation,omitempty"`
	/* AND WHOEVER ACTUALLY HAS THE CHILD.

	   A school's roll carries the father and the mother, and separately a
	   guardian -- a grandmother, an uncle, an elder brother -- for the
	   children who do not live with either parent. That is not a spare
	   contact. It is the person the school rings when a child is ill, and
	   collapsing it into "the mother" loses the fact that there is no mother
	   to ring.

	   All three are kept, all three can be reached, and the first one present
	   is the primary. */
	Guardian3Name     string `json:"guardian3_name,omitempty"`
	Guardian3Phone    string `json:"guardian3_phone,omitempty"`
	Guardian3Email    string `json:"guardian3_email,omitempty"`
	Guardian3Relation string `json:"guardian3_relation,omitempty"`

	/* A CONCESSION THE CHILD ALREADY HAS.

	   A school moving its roll across has families paying a reduced fee that
	   was agreed years ago -- a staff ward, a sibling, an RTE seat. Importing
	   the child without it bills the family in full on the first run, and the
	   only remedy after that is a credit note per family.

	   Imported as approved rather than as a request, because it is not one: a
	   request is a thing somebody is asking for, and this is a fact the school
	   is stating about a fee it has been charging for years. The reason
	   records that it came from the import, so nobody later reads it as a
	   decision this system made. */
	ConcessionKind     string `json:"concession_kind,omitempty"`
	ConcessionPercent  string `json:"concession_percent,omitempty"`
	ConcessionAmount   string `json:"concession_amount,omitempty"`
	ConcessionReason   string `json:"concession_reason,omitempty"`
	GuardianOccupation string `json:"guardian_occupation,omitempty"`
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

/*
nil for "the caller said nothing about extra fields", which the SQL turns

	into an empty object on insert and, on update, merges as a no-op. Sending
	'{}' instead would read identically on insert and be indistinguishable from
	it on update — which is fine only because the merge is `||`; if this were
	ever an assignment it would silently erase the school's fields on every
	save from a screen that does not edit them.
*/
func customFieldsJSON(m map[string]string) any {
	if len(m) == 0 {
		return nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return string(b)
}

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
	if req.Category != "" && !validCategories[req.Category] {
		return errors.New("category must be general, obc, sc, st, ews or other")
	}
	/* Refused here rather than left to the CHECK constraint, which would come
	   back as a 500 and a constraint name. The rule is the same either way;
	   only one of them is readable by the person typing. */
	if req.AadhaarLast4 != "" {
		if len(req.AadhaarLast4) != 4 {
			return errors.New("record only the LAST FOUR digits of the Aadhaar number")
		}
		for _, c := range req.AadhaarLast4 {
			if c < '0' || c > '9' {
				return errors.New("the Aadhaar last four must be digits")
			}
		}
	}
	// A field name that is blank or enormous is a mistake, not a school's
	// vocabulary, and both make an unreadable record.
	if len(req.CustomFields) > 40 {
		return errors.New("that is more extra fields than one child's record should carry")
	}
	for k, v := range req.CustomFields {
		if strings.TrimSpace(k) == "" {
			return errors.New("an extra field needs a name")
		}
		if len(k) > 60 || len(v) > 500 {
			return errors.New("keep an extra field's name under 60 characters and its value under 500")
		}
	}
	return nil
}

var validCategories = map[string]bool{
	"general": true, "obc": true, "sc": true, "st": true, "ews": true, "other": true,
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
		                      address_line2, category, nationality, aadhaar_last4,
		                      custom_fields, house_id, permanent_address,
		                      emergency_contact_name, emergency_contact_phone,
		                      emergency_contact_relation, admission_date, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,
		        $17,$18,$19,$20,$21,$22,$23,
		        COALESCE($24,'Indian'),$25,
		        COALESCE($26::jsonb,'{}'::jsonb), $27::uuid,
		        $28,$29,$30,$31, COALESCE($32::date, CURRENT_DATE),'active')
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
		    is_cwsn = EXCLUDED.is_cwsn,
		    address_line2 = EXCLUDED.address_line2,
		    category = EXCLUDED.category,
		    nationality = EXCLUDED.nationality,
		    aadhaar_last4 = EXCLUDED.aadhaar_last4,
		    /* MERGED, NOT REPLACED. The importer sends the two columns its CSV
		       carried; the form sends what its user edited. Assigning would
		       make whichever ran last delete the other's fields. */
		    custom_fields = students.custom_fields || EXCLUDED.custom_fields,
		    house_id = EXCLUDED.house_id,
		    permanent_address = EXCLUDED.permanent_address,
		    emergency_contact_name = EXCLUDED.emergency_contact_name,
		    emergency_contact_phone = EXCLUDED.emergency_contact_phone,
		    emergency_contact_relation = EXCLUDED.emergency_contact_relation,
		    -- COALESCE: a re-upload whose sheet has no admission_date column
		    -- must not reset a date somebody already got right.
		    admission_date = COALESCE(EXCLUDED.admission_date, students.admission_date),
		    updated_at = now()
		RETURNING id::text`,
		instID, campus, admissionNo, req.FirstName, nullString(req.MiddleName),
		nullString(req.LastName), nullString(req.DateOfBirth), nullString(req.Gender),
		nullString(req.BloodGroup), nullString(strings.ToLower(req.Medium)),
		nullString(req.MotherTongue), nullString(req.Religion), nullString(req.AddressLine1),
		nullString(req.City), nullString(req.State), nullString(req.Pincode),
		nullString(req.APAARID), nullString(req.ChildInfoID), nullString(req.PriorSchool),
		req.IsRTE, req.IsCWSN,
		nullString(req.AddressLine2), nullString(req.Category),
		nullString(req.Nationality), nullString(req.AadhaarLast4),
		customFieldsJSON(req.CustomFields),
		nullString(req.HouseID), nullString(req.PermanentAddress),
		nullString(req.EmergencyName), nullString(req.EmergencyPhone),
		nullString(req.EmergencyRelation),
		nullString(req.AdmissionDate)).Scan(&studentID); err != nil {
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

	/* LAST YEAR'S CLASS, where the sheet carries it.

	   Matched on the class name and the year's name as the school writes them,
	   because that is what is in the file: "Grade 5" and "2025-26". A name
	   that matches nothing is skipped rather than failing the row -- the child
	   and this year's placement are the record, and refusing to import a
	   family because a historic year was spelt differently would lose the
	   thing that matters to preserve the thing that does not.

	   Recorded as completed, not active: it is where they were, and an active
	   second enrolment would put the child in two classes at once and count
	   them twice in every roll. */
	if req.PreviousClass != "" && req.PreviousYear != "" {
		/* The year is created if the school has never named it here, exactly
		   as the marks sheet creates it. These two disagreed: marks made the
		   year, this skipped the row, so whether a child's previous class was
		   recorded depended on which file was uploaded first and nothing said
		   so. */
		prevYear, yerr := ensurePastYear(r.Context(), tx, instID, campus, req.PreviousYear)
		if yerr != nil {
			return "", "", yerr
		}
		var prevClass uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT id FROM classes
			 WHERE institution_id = $1 AND lower(name) = lower($2)`,
			instID, req.PreviousClass).Scan(&prevClass)
		if err == nil {
			/* Completed, not active: it is where they were, and an active
			   second enrolment would put the child in two classes at once and
			   count them twice in every roll. */
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO enrollments (institution_id, student_id, academic_year_id,
				                         class_id, status)
				VALUES ($1,$2::uuid,$3,$4,'completed')
				ON CONFLICT (student_id, academic_year_id) DO NOTHING`,
				instID, studentID, prevYear, prevClass); err != nil {
				return "", "", err
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return "", "", err
		}
		// A class the school does not have is skipped rather than fatal: the
		// child and this year's placement are the record, and refusing a
		// family because a historic class was spelt differently would lose
		// what matters to protect what does not.
	}

	/* Both parents, where the sheet has both.

	   Reused across siblings via the phone-and-name key, so two children of
	   one family share the guardian rather than duplicating them -- which is
	   what makes "a sibling already here" answerable later.

	   The first is primary. That is not a judgement about the family; it is
	   which number a single-contact message goes to, and something has to be
	   first. */
	link := func(name, phone, email, relation, fallbackRelation string, primary bool) error {
		if strings.TrimSpace(name) == "" || strings.TrimSpace(phone) == "" {
			return nil
		}
		if relation == "" {
			relation = fallbackRelation
		}
		var guardianID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO guardians (institution_id, full_name, relation, phone, email, occupation)
			VALUES ($1,$2,$3,$4,$5::citext,$6)
			ON CONFLICT (institution_id, phone, full_name)
			DO UPDATE SET relation = EXCLUDED.relation,
			              email = COALESCE(EXCLUDED.email, guardians.email),
			              -- COALESCE, not assign: the importer's CSV rarely
			              -- carries an occupation, and a blank column must not
			              -- erase what the office typed on the child's page.
			              occupation = COALESCE(EXCLUDED.occupation, guardians.occupation)
			RETURNING id::text`,
			instID, strings.TrimSpace(name), relation, strings.TrimSpace(phone),
			nullString(email), nullString(req.GuardianOccupation)).Scan(&guardianID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
			VALUES ($1::uuid,$2::uuid,$3,$4) ON CONFLICT DO NOTHING`,
			studentID, guardianID, instID, primary)
		return err
	}

	if err := link(req.GuardianName, req.GuardianPhone, req.GuardianEmail,
		req.GuardianRelation, "father", true); err != nil {
		return "", "", err
	}
	haveFirst := strings.TrimSpace(req.GuardianName) != "" &&
		strings.TrimSpace(req.GuardianPhone) != ""
	haveSecond := strings.TrimSpace(req.Guardian2Name) != "" &&
		strings.TrimSpace(req.Guardian2Phone) != ""

	if err := link(req.Guardian2Name, req.Guardian2Phone, req.Guardian2Email,
		req.Guardian2Relation, "mother",
		// Primary only when there is no first -- a child whose sheet carries
		// the mother and not the father must still have somebody the school
		// can reach.
		!haveFirst); err != nil {
		return "", "", err
	}
	if err := link(req.Guardian3Name, req.Guardian3Phone, req.Guardian3Email,
		req.Guardian3Relation, "guardian",
		// And the guardian is primary for a child who has neither parent on
		// the sheet, which is exactly the child a guardian column is for.
		!haveFirst && !haveSecond); err != nil {
		return "", "", err
	}

	if err := recordConcession(r, tx, instID, studentID, req); err != nil {
		return "", "", err
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

	/* The clerk's own column choices, where they made any.

	   Replaces the index rather than adding to it: a field deliberately left
	   unmapped must not still be read from a same-named column, because
	   leaving it unmapped is a statement that the file does not carry it. */
	/* A COLUMN WE HAVE NO FIELD FOR IS STILL THE SCHOOL'S DATA.

	   Every school keeps something we did not think of -- a bus stop, a
	   scholarship number, a house, a parent's occupation code. Until now the
	   only answers were to lose that column or to wait for us to add a field
	   to the product, which is a school waiting on a release to import a
	   spreadsheet it already has.

	   Mapped as custom:<the label they want>, the column is imported into the
	   child's own extra fields and appears on their page beside everything
	   else. The label is kept exactly as typed, because "Bus stop" and
	   "bus_stop" are the same word to us and not to the office reading it. */
	customCols := map[string]int{}
	if m := columnMapFrom(r); len(m) > 0 {
		remapped := map[string]int{}
		for ours, theirs := range m {
			if strings.TrimSpace(theirs) == "" {
				continue
			}
			key := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(theirs, "\ufeff")))
			i, ok := col[key]
			if !ok {
				continue
			}
			if label, isCustom := strings.CutPrefix(ours, "custom:"); isCustom {
				if label = strings.TrimSpace(label); label != "" {
					customCols[label] = i
				}
				continue
			}
			remapped[strings.ToLower(strings.TrimSpace(ours))] = i
		}
		col = remapped
	}

	/* AND A COLUMN NOBODY MAPPED AT ALL IS STILL THE SCHOOL'S DATA.

	   Keeping an unknown column required somebody to notice it and map it as
	   custom:Something, which asks the clerk to know in advance which of their
	   own columns this product has a field for. They do not, and the ones they
	   miss are silently dropped — a sheet is uploaded, the import says 812
	   children imported, and the scholarship number that was in column N is
	   gone with no line anywhere saying so.

	   So anything left over is kept, under the school's own header as its
	   label. The cost of being wrong in this direction is a field on a record
	   that nobody reads; the cost of the other is data destroyed on the way
	   in. */
	usedColumns := map[int]bool{}
	for _, i := range col {
		usedColumns[i] = true
	}
	for _, i := range customCols {
		usedColumns[i] = true
	}
	for i, h := range header {
		if usedColumns[i] {
			continue
		}
		label := strings.TrimSpace(strings.TrimPrefix(h, "\ufeff"))
		if label == "" {
			continue
		}
		customCols[label] = i
	}

	/* THE NAME, CHECKED AFTER THE MAPPING RATHER THAN BEFORE IT.

	   This ran against the file's own headers, before any mapping was
	   considered, and refused outright: "the CSV needs a full_name column".
	   A school whose sheet says "Student Name" -- which is what a school's
	   sheet says -- was rejected at the door, and the mapping screen that
	   exists precisely to answer this never got the chance to.

	   It is the one field a record cannot be built without, so it is still
	   required. What changed is where it may come from: any column the person
	   points at it. A file written from our template still works untouched,
	   because its header already is the name.
	*/
	_, hasFull := col["full_name"]
	_, hasFirst := col["first_name"]
	if !hasFull && !hasFirst {
		httpx.BadRequest(w, r,
			"nothing is pointed at the child's name, and a row cannot be built "+
				"without it. Choose which of your columns holds it. Everything "+
				"else is optional.")
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
			AdmissionNo:  get(rec, "admission_no"),
			FirstName:    first,
			MiddleName:   middle,
			LastName:     last,
			DateOfBirth:  normaliseDate(get(rec, "date_of_birth")),
			Gender:       normaliseGender(get(rec, "gender")),
			BloodGroup:   get(rec, "blood_group"),
			Medium:       strings.ToLower(get(rec, "medium")),
			MotherTongue: get(rec, "mother_tongue"),
			AddressLine1: get(rec, "address"),
			City:         get(rec, "city"),
			State:        get(rec, "state"),
			Pincode:      get(rec, "pincode"),
			APAARID:      get(rec, "apaar_id"),
			ChildInfoID:  get(rec, "child_info_id"),
			PriorSchool:  get(rec, "prior_school"),
			/* CATEGORY MEANS TWO DIFFERENT THINGS.

			   Ours is the government one -- general, OBC, SC, ST, EWS -- and
			   it drives the RTE return. A real school's export had "Day
			   Scholar" and "Hosteller" in that column, which is a residence
			   type and an equally reasonable thing to call Category.

			   Read as ours where it is one of ours, kept as the school's own
			   field where it is not. Refusing 399 rows over a word that means
			   something true is the wrong answer to a collision of
			   vocabularies. */
			Category: knownCategory(get(rec, "category")),
			/* A SCHOOL KEEPS THE CLASS AND THE SECTION IN TWO COLUMNS.

			   This wanted them joined -- "Class 6-A" in one cell -- and every
			   export in existence has Class and Section side by side. So a
			   school had to add a column to a sheet it already had, or watch
			   every child arrive with no placement.

			   The joined form still works, because our own template writes it
			   that way. */
			SectionID: sectionLabel(get(rec, "section"), get(rec, "class")),
			CustomFields: withUnmapped(customValues(rec, customCols),
				"Category", get(rec, "category"), knownCategory(get(rec, "category")) == ""),
			// Optional, like every column but the name: a school that keeps
			// none of this imports exactly as well without them.
			AdmissionDate:    normaliseDate(get(rec, "admission_date")),
			PreviousClass:    get(rec, "previous_class"),
			PreviousYear:     get(rec, "previous_year"),
			IsRTE:            isTruthy(get(rec, "is_rte")),
			IsCWSN:           isTruthy(get(rec, "is_cwsn")),
			GuardianName:     get(rec, "guardian_name"),
			GuardianPhone:    get(rec, "guardian_phone"),
			GuardianEmail:    get(rec, "guardian_email"),
			GuardianRelation: strings.ToLower(get(rec, "guardian_relation")),
			// mother_* as well as guardian2_*, because that is what a school's
			// own sheet calls the column.
			Guardian2Name:     firstNonEmpty(get(rec, "guardian2_name"), get(rec, "mother_name")),
			Guardian2Phone:    firstNonEmpty(get(rec, "guardian2_phone"), get(rec, "mother_phone")),
			Guardian2Email:    firstNonEmpty(get(rec, "guardian2_email"), get(rec, "mother_email")),
			Guardian2Relation: strings.ToLower(get(rec, "guardian2_relation")),
			Guardian3Name:     firstNonEmpty(get(rec, "guardian3_name"), get(rec, "guardian_name_3")),
			Guardian3Phone:    firstNonEmpty(get(rec, "guardian3_phone"), get(rec, "guardian_phone_3")),
			Guardian3Email:    firstNonEmpty(get(rec, "guardian3_email"), get(rec, "guardian_email_3")),
			Guardian3Relation: strings.ToLower(get(rec, "guardian3_relation")),
			ConcessionKind:    get(rec, "concession"),
			ConcessionPercent: get(rec, "concession_percent"),
			ConcessionAmount:  get(rec, "concession_amount"),
			ConcessionReason:  get(rec, "concession_reason"),
			// Carries a human label such as "Class 6-A" at this point; resolved
			// to a section id below, once, rather than per row.
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

	/* Resolve "Class 6-A" style placement once, not per row -- and on the dry
	   run as well as the commit.

	   Loaded only when committing, so the dry run could not tell a school that
	   a section did not exist. It reported every row valid and the commit then
	   handed the label "Class 1-A" to Postgres as a uuid, which came back as
	   "invalid input syntax for type uuid" and stopped the whole file on row
	   three. The clerk is told the file is ready and then shown a SQLSTATE. */
	sectionByLabel := map[string]string{}
	if len(good) > 0 {
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

	/* A placement naming a section the school does not have.

	   Checked here, before anything is written, and reported against its own
	   row like any other bad value -- rather than being passed on as a uuid it
	   plainly is not. One child in the wrong class does not stop the file. */
	kept := good[:0]
	for _, g := range good {
		label := strings.TrimSpace(g.req.SectionID)
		if label == "" {
			kept = append(kept, g)
			continue
		}
		if _, ok := sectionByLabel[strings.ToLower(label)]; ok {
			kept = append(kept, g)
			continue
		}
		out.Valid--
		out.Rejected++
		out.Problems = append(out.Problems, importRow{
			Row: g.row,
			Problem: fmt.Sprintf("no class and section called %q. "+
				"Create the classes and sections first, and write them as the "+
				"school does \u2014 Class 6 and A", label),
		})
	}
	good = kept

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
		/* The shapes an export from another school system writes.

		   A real file arrived with "9-Dec-22" in every date column and
		   "01 Jan 2024" in the staff sheet. Neither parsed, so every row was
		   rejected for a date the school can read perfectly well. A two-digit
		   year is unambiguous here: nobody enrolls a child born in 1922. */
		"2-Jan-06", "02-Jan-06", "2-Jan-2006", "02-Jan-2006",
		"2 Jan 2006", "02 Jan 2006", "2 January 2006",
		"Jan 2, 2006", "2-Jan-2006",
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

/*
normaliseGender accepts what a register actually says.

	A file arrived with Boy and Girl in every row, which is how an Indian
	school writes it, and every row was rejected for a gender that "must be
	male, female or other". The school was not wrong.
*/

/*
knownCategory keeps the government category and lets anything else through as
a school's own word.

	Returned empty rather than refused, with the original preserved as an
	extra field by the caller. A column that means one thing to a return and
	another to a school is not a mistake by either of them.
*/
/*
withUnmapped keeps a value the record has no field for, under the school's own
label, instead of dropping it.

	A word we do not recognise in a column we do is still the school's data.
	Dropping it silently is how an import reports success and loses something.
*/
func withUnmapped(fields map[string]string, label, value string, keep bool) map[string]string {
	if !keep || strings.TrimSpace(value) == "" {
		return fields
	}
	if fields == nil {
		fields = map[string]string{}
	}
	fields[label] = strings.TrimSpace(value)
	return fields
}

func knownCategory(v string) string {
	c := strings.ToLower(strings.TrimSpace(v))
	if validCategories[c] {
		return c
	}
	return ""
}

/*
recordConcession carries across a reduction the family already has.

	Written as approved, and deliberately. A concession raised in this product
	is a request, decided by somebody with the authority to give money away --
	and that control matters. But a school importing its roll is not asking for
	anything: it is stating what it has been charging this family for years,
	and holding those pending would bill every one of them in full on the first
	run while somebody approved a hundred rows of history.

	The reason says where it came from, so nobody reading the discount book
	later mistakes it for a decision made here.

	Nothing is written when the sheet names no concession, which is almost
	every child.
*/
func recordConcession(r *http.Request, tx pgx.Tx, instID uuid.UUID,
	studentID string, req studentWriteRequest) error {

	kind := strings.ToLower(strings.TrimSpace(req.ConcessionKind))
	if kind == "" || blankConcession[kind] {
		return nil
	}
	if !concessionKindAllowed(kind) {
		return fmt.Errorf("concession must be one of %s",
			strings.Join(concessionKinds, ", "))
	}

	percent := strings.TrimSpace(req.ConcessionPercent)
	amount := strings.TrimSpace(strings.ReplaceAll(req.ConcessionAmount, ",", ""))
	if percent == "" && amount == "" {
		return errors.New("a concession needs a percentage or an amount")
	}

	var amountPaise *int64
	if amount != "" {
		f, err := strconv.ParseFloat(amount, 64)
		if err != nil || f < 0 {
			return errors.New("concession_amount must be a number of rupees")
		}
		v := int64(math.Round(f * 100))
		amountPaise = &v
	}
	if percent != "" {
		if f, err := strconv.ParseFloat(percent, 64); err != nil || f <= 0 || f > 100 {
			return errors.New("concession_percent must be between 1 and 100")
		}
	}

	reason := strings.TrimSpace(req.ConcessionReason)
	if reason == "" {
		reason = "Carried across when the school's roll was imported"
	} else {
		reason += " (carried across at import)"
	}

	var yearID any
	var y uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).
		Scan(&y); err == nil {
		yearID = y
	}

	_, err := tx.Exec(r.Context(), `
		INSERT INTO fee_concessions (institution_id, student_id, academic_year_id,
		        kind, percent, amount_paise, reason, status, approved_at)
		VALUES ($1,$2::uuid,$3,$4,NULLIF($5,'')::numeric,$6,$7,'approved',now())`,
		instID, studentID, yearID, kind, percent, amountPaise, reason)
	return err
}

// blankConcession is a school writing "there isn't one" in the column.
var blankConcession = map[string]bool{
	"no": true, "none": true, "nil": true, "na": true, "n/a": true,
	"-": true, "--": true, "full fee": true, "regular": true,
}

func normaliseGender(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "m", "male", "boy", "b":
		return "male"
	case "f", "female", "girl", "g":
		return "female"
	case "":
		return ""
	default:
		// Anything else is handed on and refused by name, rather than guessed
		// at -- a school with its own word should be told we did not know it.
		return strings.ToLower(strings.TrimSpace(v))
	}
}

/*
sectionLabel builds the placement from whichever columns the file carries.

	Ours writes one cell, "Class 6-A". Every export from another system writes
	two, Class and Section. Both are the same fact and both are read here, so
	nobody has to add a column to a sheet they already have.
*/
func sectionLabel(section, class string) string {
	sec := strings.TrimSpace(section)
	cls := strings.TrimSpace(class)
	if sec == "" {
		return ""
	}
	// Already joined, or there is no class column to join it to.
	if cls == "" || strings.Contains(sec, "-") {
		return sec
	}
	return cls + "-" + sec
}

func isTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "y", "yes", "true", "1":
		return true
	}
	return false
}

// getImportTemplate returns the CSV header a school should fill in.

// customValues reads the columns a clerk chose to keep as extra fields.
//
// A blank cell is left out rather than stored as an empty string: an extra
// field that exists on every child and says nothing on most of them is a
// column of dashes on the record, which is worse than not having it at all.
func customValues(rec []string, cols map[string]int) map[string]string {
	if len(cols) == 0 {
		return nil
	}
	out := map[string]string{}
	for label, i := range cols {
		if i < len(rec) {
			if v := strings.TrimSpace(rec[i]); v != "" {
				out[label] = v
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// studentImportFields is the list the mapping screen asks about, in the order
// a school reads them. Only the name is required -- every other column is
// optional by design, so a sheet with six columns imports as well as one with
// eighteen.
func studentImportFields() []map[string]any {
	f := func(name, example string, required bool) map[string]any {
		return map[string]any{"name": name, "example": example, "required": required}
	}
	return []map[string]any{
		f("full_name", "Meera Menon", true),
		f("admission_no", "ADM0001", false),
		f("date_of_birth", "14/06/2013", false),
		f("gender", "female", false),
		f("blood_group", "B+", false),
		f("medium", "english", false),
		f("mother_tongue", "Malayalam", false),
		f("section", "Class 6-A", false),
		f("roll_no", "1", false),
		f("address", "12 Green Park", false),
		f("city", "Hyderabad", false),
		f("state", "Telangana", false),
		f("pincode", "500001", false),
		f("prior_school", "St Teresa's", false),
		f("admission_date", "12/06/2021", false),
		f("previous_class", "Grade 5", false),
		f("previous_year", "2025-26", false),
		f("guardian_name", "Suresh Menon", false),
		f("guardian_relation", "father", false),
		f("guardian_phone", "9845012345", false),
		f("guardian_email", "suresh@example.com", false),
	}
}

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
		// The three that make an existing roll import as a history rather
		// than as a room full of children who all arrived this morning.
		"admission_date", "previous_class", "previous_year",
		"guardian_name", "guardian_relation", "guardian_phone", "guardian_email",
	}, ",")+"\n")
	_, _ = io.WriteString(w,
		"Meera Menon,ADM0001,14/06/2013,female,B+,english,Malayalam,Class 6-A,1,"+
			"12 Green Park,Hyderabad,Telangana,500001,St Teresa's,"+
			"12/06/2021,Grade 5,2025-26,"+
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
			category, nationality, aadhaar4                        *string
			addr1, addr2, state, pincode                           *string
			permAddr, emgName, emgPhone, emgRel                    *string
			customFields                                           []byte
			houseID, houseName, houseColor                         *string
			exitDate, exitReason                                   *string
			heightCM, weightKG, bmi, measuredOn                    *string
			allergies                                              *string
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
			       st.photo_file_id::text,
			       st.category, st.nationality, st.aadhaar_last4,
			       st.address_line1, st.address_line2, st.state, st.pincode,
			       st.permanent_address, st.emergency_contact_name,
			       st.emergency_contact_phone, st.emergency_contact_relation,
			       st.custom_fields, st.house_id::text, h.name, h.color,
			       to_char(st.exit_date,'YYYY-MM-DD'), st.exit_reason,
			       /* The last time a nurse measured them. Read from the
			          infirmary's checkups rather than copied onto the child:
			          height and weight are a reading on a date, and a pair of
			          columns on students would be a number with no date that
			          nobody would ever update. */
			       hc.height_cm::text, hc.weight_kg::text, hc.bmi::text,
			       to_char(hc.on_date,'YYYY-MM-DD'),
			       sh.allergies
			  FROM students st
			  LEFT JOIN houses h ON h.id = st.house_id
			  LEFT JOIN LATERAL (
			      SELECT height_cm, weight_kg, bmi, on_date FROM health_checkups
			       WHERE student_id = st.id AND height_cm IS NOT NULL
			       ORDER BY on_date DESC LIMIT 1
			  ) hc ON true
			  LEFT JOIN student_health sh ON sh.student_id = st.id
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
				&photoFileID,
				&category, &nationality, &aadhaar4,
				&addr1, &addr2, &state, &pincode,
				&permAddr, &emgName, &emgPhone, &emgRel,
				&customFields, &houseID, &houseName, &houseColor,
				&exitDate, &exitReason,
				&heightCM, &weightKG, &bmi, &measuredOn, &allergies); err != nil {
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
		out["category"] = category
		out["nationality"] = nationality
		out["aadhaar_last4"] = aadhaar4
		out["address_line1"] = addr1
		out["address_line2"] = addr2
		out["state"] = state
		out["pincode"] = pincode
		out["permanent_address"] = permAddr
		out["emergency_contact_name"] = emgName
		out["emergency_contact_phone"] = emgPhone
		out["emergency_contact_relation"] = emgRel
		out["house_id"] = houseID
		out["house_name"] = houseName
		out["house_color"] = houseColor
		out["exit_date"] = exitDate
		out["exit_reason"] = exitReason
		out["height_cm"] = heightCM
		out["weight_kg"] = weightKG
		out["bmi"] = bmi
		out["measured_on"] = measuredOn
		out["allergies"] = allergies
		if len(customFields) > 0 {
			var cf map[string]string
			if json.Unmarshal(customFields, &cf) == nil && len(cf) > 0 {
				out["custom_fields"] = cf
			}
		}
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
			/* The id, which the row has never carried.

			   "Give a login" posts to /guardians/{id}/login and the client had
			   no id to put in it, so every attempt answered "invalid guardian
			   id" — on the one screen the product tells an office to use for
			   exactly that. */
			SELECT g.id::text, g.full_name, g.relation, COALESCE(g.phone,''),
			       COALESCE(g.email::text,''), sg.is_primary,
			       COALESCE(g.occupation,''), g.photo_file_id::text
			  FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = '`+sid.String()+`'::uuid
			 ORDER BY sg.is_primary DESC`,
			func(rows pgx.Rows) error {
				var gid, name, rel, ph, em, occ string
				var primary bool
				var photo *string
				if err := rows.Scan(&gid, &name, &rel, &ph, &em, &primary,
					&occ, &photo); err != nil {
					return err
				}
				guardians = append(guardians, map[string]any{
					"id": gid, "full_name": name, "relation": rel, "phone": ph,
					"email": em, "is_primary": primary, "occupation": occ,
					"photo_file_id": photo})
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
