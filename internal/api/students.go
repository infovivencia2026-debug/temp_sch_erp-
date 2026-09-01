package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type student struct {
	ID          string  `json:"id"`
	AdmissionNo string  `json:"admission_no"`
	FullName    string  `json:"full_name"`
	FirstName   string  `json:"first_name"`
	MiddleName  *string `json:"middle_name,omitempty"`
	LastName    *string `json:"last_name,omitempty"`
	Gender      *string `json:"gender,omitempty"`
	DateOfBirth *string `json:"date_of_birth,omitempty"`
	Status      string  `json:"status"`
	AdmissionOn string  `json:"admission_date"`
	ClassName   *string `json:"class_name,omitempty"`
	SectionName *string `json:"section_name,omitempty"`
	RollNo      *int32  `json:"roll_no,omitempty"`
	/* A number to ring, on the roll itself.

	   The office reads this list to find somebody and then had to open the
	   child to get a phone number — which is one page load per call on the
	   afternoon somebody is ringing eleven families. */
	PrimaryPhone *string `json:"primary_phone,omitempty"`
}

type page[T any] struct {
	Items   []T  `json:"items"`
	Total   int  `json:"total"`
	Limit   int  `json:"limit"`
	Offset  int  `json:"offset"`
	HasMore bool `json:"has_more"`
}

// listStudents is keyset-free offset pagination on purpose: the SPA's grid
// needs a total for its pager, and at a few thousand rows per tenant the count
// is cheap. If a tenant ever outgrows that, the fix is a cursor, not a bigger
// LIMIT cap.
func (s *Server) listStudents(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	limit := clampInt(q.Get("limit"), 50, 1, 200)
	offset := clampInt(q.Get("offset"), 0, 0, 1_000_000)
	search := strings.TrimSpace(q.Get("q"))
	status := q.Get("status")

	var (
		sectionID *uuid.UUID
		classID   *uuid.UUID
		yearID    *uuid.UUID
	)
	if v, err := uuid.Parse(q.Get("section_id")); err == nil {
		sectionID = &v
	}
	if v, err := uuid.Parse(q.Get("class_id")); err == nil {
		classID = &v
	}
	if v, err := uuid.Parse(q.Get("academic_year_id")); err == nil {
		yearID = &v
	}

	// Narrow to the students this caller may see. RLS bounds the tenant; it
	// cannot tell a teacher's two sections from the whole school, so without
	// this a faculty account lists every student in the institution.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out := page[student]{Items: []student{}, Limit: limit, Offset: offset}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The enrollment join is LATERAL so a student with no enrollment still
		// appears (newly admitted, not yet placed in a section) instead of
		// silently vanishing from the roster.
		const from = `
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id, e.roll_no
			        FROM enrollments e
			       WHERE e.student_id = st.id
			         AND ($5::uuid IS NULL OR e.academic_year_id = $5)
			       ORDER BY e.enrolled_on DESC
			       LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE ($1::text IS NULL OR st.status = $1)
			   /* Admitted since this academic year began.
			
			      Served here rather than filtered on the client so the tile and
			      the list cannot disagree — which is exactly how the defaulters
			      export came to show 2 rows against a screen showing 61. The
			      expression is the same one studentCounts uses. */
			   AND (NOT $6::bool OR st.admission_date >= COALESCE(
			        (SELECT starts_on FROM academic_years WHERE is_current LIMIT 1),
			        date_trunc('year', CURRENT_DATE)::date))
			   AND ($2::text IS NULL OR
			        st.admission_no ILIKE '%' || $2 || '%' OR
			        concat_ws(' ', st.first_name, st.middle_name, st.last_name) ILIKE '%' || $2 || '%')
			   AND ($3::uuid IS NULL OR en.section_id = $3)
			   AND ($4::uuid IS NULL OR en.class_id = $4)`

		args := []any{nullString(status), nullString(search), sectionID, classID,
			yearID, q.Get("new_this_year") == "1"}
		scopePred, scopeArgs := res.StudentPredicate("st", len(args)+1)
		args = append(args, scopeArgs...)
		where := from + " AND " + scopePred

		if err := tx.QueryRow(r.Context(), `SELECT count(*)`+where, args...).Scan(&out.Total); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.first_name, st.middle_name, st.last_name, st.gender,
			       to_char(st.date_of_birth, 'YYYY-MM-DD'), st.status,
			       to_char(st.admission_date, 'YYYY-MM-DD'),
			       c.name, sec.name, en.roll_no,
			       (SELECT g.phone FROM student_guardians sg
			          JOIN guardians g ON g.id = sg.guardian_id
			         WHERE sg.student_id = st.id
			         ORDER BY sg.is_primary DESC LIMIT 1)`+where+`
			 ORDER BY st.admission_no
			 LIMIT $`+itoa(len(args)+1)+` OFFSET $`+itoa(len(args)+2),
			append(args, limit, offset)...)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var st student
			if err := rows.Scan(&st.ID, &st.AdmissionNo, &st.FullName,
				&st.FirstName, &st.MiddleName, &st.LastName, &st.Gender,
				&st.DateOfBirth, &st.Status, &st.AdmissionOn,
				&st.ClassName, &st.SectionName, &st.RollNo,
				&st.PrimaryPhone); err != nil {
				return err
			}
			out.Items = append(out.Items, st)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.HasMore = out.Offset+len(out.Items) < out.Total
	httpx.JSON(w, http.StatusOK, out)
}

type studentDetail struct {
	student
	BloodGroup  *string    `json:"blood_group,omitempty"`
	Category    *string    `json:"category,omitempty"`
	Religion    *string    `json:"religion,omitempty"`
	Nationality string     `json:"nationality"`
	AddressLine *string    `json:"address_line1,omitempty"`
	City        *string    `json:"city,omitempty"`
	State       *string    `json:"state,omitempty"`
	Pincode     *string    `json:"pincode,omitempty"`
	Guardians   []guardian `json:"guardians"`
}

type guardian struct {
	ID        string  `json:"id"`
	FullName  string  `json:"full_name"`
	Relation  string  `json:"relation"`
	Phone     *string `json:"phone,omitempty"`
	Email     *string `json:"email,omitempty"`
	IsPrimary bool    `json:"is_primary"`
	// Optional, and blank is an ordinary answer — most schools photograph the
	// child and not the parents.
	PhotoFileID *string `json:"photo_file_id,omitempty"`
}

func (s *Server) getStudent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	scopePred, scopeArgs := res.StudentPredicate("st", 2)

	var d studentDetail
	d.Guardians = []guardian{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.first_name, st.middle_name, st.last_name, st.gender,
			       to_char(st.date_of_birth,'YYYY-MM-DD'), st.status,
			       to_char(st.admission_date,'YYYY-MM-DD'),
			       c.name, sec.name, en.roll_no,
			       st.blood_group, st.category, st.religion, st.nationality,
			       st.address_line1, st.city, st.state, st.pincode
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id, e.roll_no FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE st.id = $1 AND `+scopePred,
			append([]any{sid}, scopeArgs...)...).
			Scan(&d.ID, &d.AdmissionNo, &d.FullName, &d.FirstName, &d.MiddleName,
				&d.LastName, &d.Gender, &d.DateOfBirth, &d.Status, &d.AdmissionOn,
				&d.ClassName, &d.SectionName, &d.RollNo,
				&d.BloodGroup, &d.Category, &d.Religion, &d.Nationality,
				&d.AddressLine, &d.City, &d.State, &d.Pincode)
		if err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.full_name, g.relation, g.phone, g.email::text,
			       sg.is_primary, g.photo_file_id::text
			  FROM student_guardians sg
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = $1
			 ORDER BY sg.is_primary DESC, g.full_name`, sid)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var g guardian
			if err := rows.Scan(&g.ID, &g.FullName, &g.Relation, &g.Phone, &g.Email, &g.IsPrimary, &g.PhotoFileID); err != nil {
				return err
			}
			d.Guardians = append(d.Guardians, g)
		}
		return rows.Err()
	})
	if err == pgx.ErrNoRows {
		// RLS makes a cross-tenant id indistinguishable from a missing one,
		// which is the behaviour we want: no existence oracle.
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, d)
}

func clampInt(raw string, def, lo, hi int) int {
	v, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func nullString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// itoa keeps the placeholder arithmetic readable where a query's parameter
// count depends on the caller's scope.
func itoa(n int) string { return strconv.Itoa(n) }

/*
The roll in four numbers.

	Counted here rather than from the rows the list returns. That list is
	filtered by class, capped at a few hundred and narrowed to what the caller
	may see, so counting it would report "12 on the roll" about a section of
	twelve and present it as the school.

	Scoped like everything else: a class teacher's tiles count their own
	sections, because a teacher being shown the whole school's roll on their own
	page is a number that means nothing to them and that they should arguably
	not have.
*/
func (s *Server) studentCounts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 1)

	out := map[string]int{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  count(*) FILTER (WHERE st.status = 'active')::int,
			  -- Every way of being gone, in one number. A school asks "how many
			  -- have left", not "how many are transferred versus withdrawn".
			  count(*) FILTER (WHERE st.status IN
			      ('transferred','withdrawn','graduated','alumni','inactive'))::int,
			  count(*) FILTER (WHERE st.status = 'suspended')::int,
			  /* Admitted since this academic year began. Derived from the
			     year's own start date rather than from January: an Indian
			     school year runs June to April, so a calendar year would count
			     a child admitted last September as new. */
			  count(*) FILTER (
			      WHERE st.status = 'active'
			        AND st.admission_date >= COALESCE(
			            (SELECT starts_on FROM academic_years WHERE is_current LIMIT 1),
			            date_trunc('year', CURRENT_DATE)::date))::int
			  FROM students st WHERE `+pred, args...).
			Scan(pgxInt(out, "active"), pgxInt(out, "left"),
				pgxInt(out, "suspended"), pgxInt(out, "new_this_year"))
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// pgxInt hands Scan somewhere to put a count and files it under its name, so
// the four counts above read as four names rather than four bare variables
// that have to stay in the same order as the SELECT.
func pgxInt(m map[string]int, key string) any {
	m[key] = 0
	return &counterField{m: m, key: key}
}

type counterField struct {
	m   map[string]int
	key string
}

func (c *counterField) Scan(src any) error {
	switch v := src.(type) {
	case int64:
		c.m[c.key] = int(v)
	case int32:
		c.m[c.key] = int(v)
	case int:
		c.m[c.key] = v
	}
	return nil
}
