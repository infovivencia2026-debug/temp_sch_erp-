package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/school-erp/erp/internal/httpx"
)

/* The school's own identity, and its campuses.

   Everything downstream assumes these exist and nothing could create them.
   ensureCampus quietly inserted a campus called "Main Campus" so that the
   first academic year had somewhere to hang, and the institution row came
   from whoever ran the tenant bootstrap — so a real school's name, board,
   district and UDISE code were unreachable through the product.

   That is not a cosmetic gap. The UDISE+ export, every report card header and
   every fee receipt print the institution and campus; a school that cannot
   correct "Main Campus" cannot issue a valid receipt. */

type institutionProfile struct {
	Name           string  `json:"name"`
	ShortName      string  `json:"short_name"`
	UDISECode      *string `json:"udise_code,omitempty"`
	Board          *string `json:"affiliation_board,omitempty"`
	AffiliationNo  *string `json:"affiliation_no,omitempty"`
	State          *string `json:"state,omitempty"`
	District       *string `json:"district,omitempty"`
	Mandal         *string `json:"mandal,omitempty"`
	VillageOrWard  *string `json:"village_or_ward,omitempty"`
	SchoolCategory *string `json:"school_category,omitempty"`
	ManagementType *string `json:"management_type,omitempty"`
	ChildInfoCode  *string `json:"child_info_code,omitempty"`
	MidDayMeal     bool    `json:"mid_day_meal"`
	Timezone       string  `json:"timezone"`
}

/* Setup is a school's screen, and a platform operator is not in one.

   super_admin holds no institution_id, so tenantScope resolves to nothing and
   every one of these queries matched zero rows — surfacing as "no rows in
   result set" and a 500 on the first screen a platform operator would open.
   The wizard is registered under super_admin.* keys precisely because they are
   the ones who set a school up, so this was reachable in one click.

   The honest answer is not an empty form: it is that the request is missing
   the school it applies to. */

func requireInstitution(w http.ResponseWriter, r *http.Request) bool {
	id := httpx.IdentityFrom(r.Context())
	if id != nil && id.InstitutionID != uuid.Nil {
		return true
	}
	httpx.BadRequest(w, r,
		"this screen belongs to a school. Sign in against one, or pick a school first - "+
			"a platform operator's account is not attached to any.")
	return false
}

// getInstitution returns the school's own record — the header on every
// document the system prints.
func (s *Server) getInstitution(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var p institutionProfile
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT name, short_name, udise_code, affiliation_board, affiliation_no,
			       state, district, mandal, village_or_ward, school_category,
			       management_type, child_info_code, mid_day_meal, timezone
			  FROM institutions WHERE id = $1`, id.InstitutionID).
			Scan(&p.Name, &p.ShortName, &p.UDISECode, &p.Board, &p.AffiliationNo,
				&p.State, &p.District, &p.Mandal, &p.VillageOrWard, &p.SchoolCategory,
				&p.ManagementType, &p.ChildInfoCode, &p.MidDayMeal, &p.Timezone)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

type institutionUpdate struct {
	Name           string `json:"name"`
	ShortName      string `json:"short_name,omitempty"`
	UDISECode      string `json:"udise_code,omitempty"`
	Board          string `json:"affiliation_board,omitempty"`
	AffiliationNo  string `json:"affiliation_no,omitempty"`
	State          string `json:"state,omitempty"`
	District       string `json:"district,omitempty"`
	Mandal         string `json:"mandal,omitempty"`
	VillageOrWard  string `json:"village_or_ward,omitempty"`
	SchoolCategory string `json:"school_category,omitempty"`
	ManagementType string `json:"management_type,omitempty"`
	ChildInfoCode  string `json:"child_info_code,omitempty"`
	MidDayMeal     bool   `json:"mid_day_meal"`
}

var errBadUDISE = errors.New("udise code must be 11 digits")

/* The enumerations the institutions table enforces with check constraints.

   They are published rather than hard-coded in the client for two reasons: a
   check-constraint violation surfaces as an opaque 500, and an admin typing
   "Private Unaided" has no way to discover the column wants private_unaided.
   The label is what a Telangana school calls it; the value is what UDISE+
   and the constraint want. */

type option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

/*
A list of names as options, where the stored value IS the name.

	Most vocabularies here carry a short code and a longer label, because the
	code is what other tables reference. A state and a district do not: nothing
	joins on them, they are what a school types on a government return, and
	inventing "TG" for Telangana would mean every report had to translate it
	back. So value and label are the same string, and this exists so that saying
	so takes one line rather than thirty-three.
*/
func optionsOf(names ...string) []option {
	out := make([]option, 0, len(names))
	for _, n := range names {
		out = append(out, option{Value: n, Label: n})
	}
	return out
}

var managementTypes = []option{
	{"government", "Government"},
	{"aided", "Aided"},
	{"private_unaided", "Private unaided"},
	{"model_school", "Model school"},
	{"gurukul", "Gurukul / residential"},
	{"kgbv", "KGBV"},
	{"central", "Central government (KV, JNV)"},
}

var schoolCategories = []option{
	{"primary", "Primary (I–V)"},
	{"upper_primary", "Upper primary (I–VIII)"},
	{"high_school", "High school (I–X)"},
	{"higher_secondary", "Higher secondary (I–XII)"},
	{"composite", "Composite"},
}

/* Every board a school here is likely to be affiliated to.

   It was seven: two Telangana boards, CBSE, CISCE, the two international ones,
   and "Other state board" for everybody else — which is the product telling
   most of India's schools that their board is an exception, and which loses
   the only fact this field could carry. A report grouping by board then has
   one enormous bucket labelled Other.

   Derived from boardPresets rather than written twice. The list a school picks
   from and the list the product knows something about must be the same list,
   or the day they drift is the day a board offers a preset it cannot apply. */
var affiliationBoards = boardOptions()

func boardOptions() []option {
	out := make([]option, 0, len(boardPresets))
	for _, b := range boardPresets {
		out = append(out, option{b.Value, b.Label})
	}
	return out
}

/*
The states and union territories, so the field is a list rather than a box.

	"State" was a free-text input with a placeholder reading "Telangana", which
	is a hint rather than a choice: every school typed it, and typed it
	differently. "Telangana", "TELANGANA", "Telengana" and "TS" are four values
	for one state, and every report that groups by state then shows four rows.

	All thirty-six, because a product sold in Telangana is still installed by a
	chain with a branch in Andhra Pradesh, and refusing the second one to keep
	the list short is a worse trade than a longer list.
*/
var indianStates = []string{
	"Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
	"Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
	"Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
	"Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
	"Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
	"Andaman and Nicobar Islands", "Chandigarh",
	"Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir",
	"Ladakh", "Lakshadweep", "Puducherry",
}

// telanganaDistricts is offered as a suggestion list, not a constraint: a
// school in another state must still be able to type its own district.
var telanganaDistricts = []string{
	"Adilabad", "Bhadradri Kothagudem", "Hanumakonda", "Hyderabad", "Jagtial",
	"Jangaon", "Jayashankar Bhupalpally", "Jogulamba Gadwal", "Kamareddy",
	"Karimnagar", "Khammam", "Komaram Bheem Asifabad", "Mahabubabad",
	"Mahabubnagar", "Mancherial", "Medak", "Medchal-Malkajgiri", "Mulugu",
	"Nagarkurnool", "Nalgonda", "Narayanpet", "Nirmal", "Nizamabad",
	"Peddapalli", "Rajanna Sircilla", "Rangareddy", "Sangareddy", "Siddipet",
	"Suryapet", "Vikarabad", "Wanaparthy", "Warangal", "Yadadri Bhuvanagiri",
}

// getInstitutionOptions feeds the setup form's dropdowns.
func (s *Server) getInstitutionOptions(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{
		"management_types":    managementTypes,
		"school_categories":   schoolCategories,
		"affiliation_boards":  affiliationBoards,
		"telangana_districts": telanganaDistricts,
		"states":              indianStates,
	})
}

// oneOf validates against a published enumeration and names the alternatives
// in the error, so a bad value is self-correcting rather than a 500.
func oneOf(field, v string, opts []option) error {
	if v == "" {
		return nil
	}
	allowed := make([]string, 0, len(opts))
	for _, o := range opts {
		if o.Value == v {
			return nil
		}
		allowed = append(allowed, o.Value)
	}
	return errors.New(field + " must be one of: " + strings.Join(allowed, ", "))
}

// updateInstitution edits the school profile.
//
// short_name is derived when left blank rather than rejected: it exists to fit
// on a receipt, and asking an admin to invent one on their first screen is a
// question the system can answer itself.
func (s *Server) updateInstitution(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req institutionUpdate
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "the school's name is required")
		return
	}
	req.UDISECode = strings.TrimSpace(req.UDISECode)
	// UDISE+ codes are exactly 11 digits. A wrong one is worse than a blank:
	// it is carried into the state return and rejected there, months later.
	if req.UDISECode != "" && !isDigits(req.UDISECode, 11) {
		httpx.BadRequest(w, r, errBadUDISE.Error())
		return
	}
	// Validated against the built-in list *and* the school's own additions.
	// oneOf alone made these lists the vendor's opinion of what schools exist:
	// a school affiliated to a board nobody had thought of could not record
	// the fact, and picked the nearest wrong option instead — which is worse
	// than a blank, because it reads as a fact and lands in the state return.
	for _, f := range []struct{ kind, value string }{
		{"management_type", req.ManagementType},
		{"school_category", req.SchoolCategory},
		{"affiliation_board", strings.TrimSpace(req.Board)},
	} {
		ok, err := s.allowsValue(r, f.kind, f.value)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if !ok {
			httpx.BadRequest(w, r,
				"that is not one of your "+kindLabels[f.kind]+". Add it to the list first, then choose it")
			return
		}
	}
	short := strings.TrimSpace(req.ShortName)
	if short == "" {
		short = deriveShortName(req.Name)
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE institutions
			   SET name = $2, short_name = $3, udise_code = $4,
			       affiliation_board = $5, affiliation_no = $6,
			       state = $7, district = $8, mandal = $9, village_or_ward = $10,
			       school_category = $11, management_type = $12,
			       child_info_code = $13, mid_day_meal = $14, updated_at = now()
			 WHERE id = $1`,
			id.InstitutionID, req.Name, short, nullString(req.UDISECode),
			nullString(req.Board), nullString(req.AffiliationNo),
			nullString(req.State), nullString(req.District), nullString(req.Mandal),
			nullString(req.VillageOrWard), nullString(req.SchoolCategory),
			nullString(req.ManagementType), nullString(req.ChildInfoCode),
			req.MidDayMeal)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"name": req.Name, "short_name": short})
}

// isUniqueViolation distinguishes "you already have one of those" from a real
// failure, so a duplicate code can be reported as a correctable mistake rather
// than as an internal error the admin can do nothing about.
func isUniqueViolation(err error) bool {
	var pge *pgconn.PgError
	return errors.As(err, &pge) && pge.Code == "23505"
}

/*
uniqueViolationOn reports a 23505 raised by one named index.

	A table with two unique indexes needs the caller to tell them apart: users
	has one on (institution_id, email) and another on (institution_id, phone),
	and "you already have one of those" is a different sentence for each. Named
	rather than positional, because the constraint name is what Postgres
	actually reports and matching on anything else drifts the first time an
	index is renamed.
*/
func uniqueViolationOn(err error, constraint string) bool {
	var pge *pgconn.PgError
	return errors.As(err, &pge) && pge.Code == "23505" &&
		pge.ConstraintName == constraint
}

func isDigits(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// deriveShortName takes the initials of a long school name, which is what a
// receipt has room for: "Vivencia High School, Kompally" -> "VHSK".
func deriveShortName(name string) string {
	var b strings.Builder
	for _, word := range strings.FieldsFunc(name, func(r rune) bool {
		return r == ' ' || r == ',' || r == '-' || r == '.'
	}) {
		if b.Len() >= 6 {
			break
		}
		b.WriteRune([]rune(strings.ToUpper(word))[0])
	}
	if b.Len() == 0 {
		return "SCHOOL"
	}
	return b.String()
}

// --- campuses ---------------------------------------------------------------

type campusRow struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Code     string  `json:"code"`
	City     *string `json:"city,omitempty"`
	State    *string `json:"state,omitempty"`
	Pincode  *string `json:"pincode,omitempty"`
	Phone    *string `json:"phone,omitempty"`
	Status   string  `json:"status"`
	Students int     `json:"students"`
}

func (s *Server) listCampuses(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	items, err := collect(s, r, `
		SELECT c.id::text, c.name, c.code, c.city, c.state, c.pincode, c.phone, c.status,
		       (SELECT count(*) FROM students st
		         WHERE st.campus_id = c.id AND st.status = 'active')::int
		  FROM campuses c ORDER BY c.created_at`, nil,
		func(rows pgx.Rows) (campusRow, error) {
			var v campusRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Code, &v.City, &v.State,
				&v.Pincode, &v.Phone, &v.Status, &v.Students)
		})
	respond(w, r, items, err)
}

type campusRequest struct {
	Name     string `json:"name"`
	Code     string `json:"code,omitempty"`
	Address1 string `json:"address_line1,omitempty"`
	Address2 string `json:"address_line2,omitempty"`
	City     string `json:"city,omitempty"`
	State    string `json:"state,omitempty"`
	Pincode  string `json:"pincode,omitempty"`
	Phone    string `json:"phone,omitempty"`
	Email    string `json:"email,omitempty"`
}

func (s *Server) createCampus(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req campusRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "the campus needs a name")
		return
	}
	if strings.TrimSpace(req.Code) == "" {
		req.Code = deriveShortName(req.Name)
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO campuses (institution_id, name, code, address_line1, address_line2,
			                      city, state, pincode, phone, email)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, req.Name, strings.ToUpper(req.Code),
			nullString(req.Address1), nullString(req.Address2), nullString(req.City),
			nullString(req.State), nullString(req.Pincode), nullString(req.Phone),
			nullString(req.Email)).Scan(&newID)
	})
	if isUniqueViolation(err) {
		httpx.BadRequest(w, r, "a campus with that code already exists")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "name": req.Name})
}

// updateCampus is what turns the auto-created "Main Campus" into the real
// school building, with the address that prints on a transfer certificate.
func (s *Server) updateCampus(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	cid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid campus id")
		return
	}
	var req campusRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "the campus needs a name")
		return
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE campuses
			   SET name = $2,
			       code = COALESCE(NULLIF($3,''), code),
			       address_line1 = $4, address_line2 = $5, city = $6, state = $7,
			       pincode = $8, phone = $9, email = $10, updated_at = now()
			 WHERE id = $1`,
			cid, req.Name, strings.ToUpper(strings.TrimSpace(req.Code)),
			nullString(req.Address1), nullString(req.Address2), nullString(req.City),
			nullString(req.State), nullString(req.Pincode), nullString(req.Phone),
			nullString(req.Email))
		found = err == nil && tag.RowsAffected() > 0
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cid.String(), "name": req.Name})
}

// --- fee heads (read) -------------------------------------------------------

type feeHeadRow struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Code        string  `json:"code"`
	IsRecurring bool    `json:"is_recurring"`
	HSNSAC      *string `json:"hsn_sac,omitempty"`
	UsedIn      int     `json:"used_in"`
}

// listFeeHeads exists because a fee structure is built out of heads and there
// was no way to see which ones the school had defined.
func (s *Server) listFeeHeads(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	items, err := collect(s, r, `
		SELECT h.id::text, h.name, h.code, h.is_recurring, h.hsn_sac,
		       (SELECT count(*) FROM fee_structure_items i
		         WHERE i.fee_head_id = h.id)::int
		  FROM fee_heads h
		 ORDER BY h.name`, nil,
		func(rows pgx.Rows) (feeHeadRow, error) {
			var v feeHeadRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Code, &v.IsRecurring, &v.HSNSAC, &v.UsedIn)
		})
	respond(w, r, items, err)
}

// --- teacher assignment -----------------------------------------------------

/* Creating a staff login is only half the job.

   A teacher's reach in this system comes entirely from their assignments —
   internal/scope derives the sections they may mark and the students they may
   see from section_subject_teachers and sections.class_teacher_id. A school
   that adds ten teachers and stops has ten accounts that can see nothing, and
   the setup checklist correctly refuses to call that step done.

   assign-teacher already existed for subject teaching. Making someone the
   class teacher of an existing section did not: it could only be passed when
   the section was first created, which is the one moment a school does not
   yet know who will take it. */

type classTeacherRequest struct {
	SectionID     string `json:"section_id"`
	TeacherUserID string `json:"teacher_user_id"`
}

func (s *Server) setClassTeacher(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var req classTeacherRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sec, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	// An empty teacher clears the assignment, which is how a school records
	// that a class teacher has left before the replacement is decided.
	var teacher *uuid.UUID
	if strings.TrimSpace(req.TeacherUserID) != "" {
		t, perr := uuid.Parse(req.TeacherUserID)
		if perr != nil {
			httpx.BadRequest(w, r, "teacher_user_id must be a uuid")
			return
		}
		teacher = &t
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`UPDATE sections SET class_teacher_id = $2 WHERE id = $1`, sec, teacher)
		found = err == nil && tag.RowsAffected() > 0
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"section_id": sec.String()})
}

type classSubjectRow struct {
	ID          string  `json:"id"`
	ClassID     string  `json:"class_id"`
	ClassName   string  `json:"class_name"`
	SubjectID   string  `json:"subject_id"`
	SubjectName string  `json:"subject_name"`
	MaxMarks    *int    `json:"max_marks,omitempty"`
	Teachers    int     `json:"sections_taught"`
	Unassigned  int     `json:"sections_unassigned"`
	AnyTeacher  *string `json:"a_teacher,omitempty"`
}

// listClassSubjects is what the assignment screen is built from, and it
// carries the count of sections still without a teacher — the number that
// tells a head of school where the timetable will fall over in week one.
func (s *Server) listClassSubjects(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	items, err := collect(s, r, `
		SELECT cs.id::text, c.id::text, c.name, sub.id::text, sub.name, cs.max_marks,
		       (SELECT count(*) FROM section_subject_teachers t
		         WHERE t.class_subject_id = cs.id)::int,
		       (SELECT count(*) FROM sections sec
		         WHERE sec.class_id = c.id
		           AND NOT EXISTS (SELECT 1 FROM section_subject_teachers t
		                            WHERE t.class_subject_id = cs.id
		                              AND t.section_id = sec.id))::int,
		       (SELECT u.full_name FROM section_subject_teachers t
		          JOIN users u ON u.id = t.teacher_user_id
		         WHERE t.class_subject_id = cs.id LIMIT 1)
		  FROM class_subjects cs
		  JOIN classes  c   ON c.id = cs.class_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		 WHERE ($1::uuid IS NULL OR cs.class_id = $1)
		 ORDER BY c.level, sub.name`,
		[]any{nullString(r.URL.Query().Get("class_id"))},
		func(rows pgx.Rows) (classSubjectRow, error) {
			var v classSubjectRow
			return v, rows.Scan(&v.ID, &v.ClassID, &v.ClassName, &v.SubjectID,
				&v.SubjectName, &v.MaxMarks, &v.Teachers, &v.Unassigned, &v.AnyTeacher)
		})
	respond(w, r, items, err)
}
