package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type student struct {
	ID string `json:"id"`
	/* This app's own permanent identifier, alongside the school's.

	   admission_no is whatever the school writes — a format that differs at
	   every school, is sometimes text, and is occasionally reissued when a
	   child leaves. person_code is ours, never changes, and is what an import
	   can be re-run against without creating a second copy of a child. */
	PersonCode  *string `json:"person_code,omitempty"`
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
	Items  []T `json:"items"`
	/* Absent, not zero, when nobody counted.

	   count(*) over the filtered set is the one part of this envelope that
	   cannot scale: at a million rows it walks every matching row to answer a
	   question the reader asked once, and it would do it again on every page.
	   So it is computed on the FIRST page only (no cursor), which is the page
	   whose header prints "345 students on the roll", and omitted from every
	   page after it. `with_total=1` asks for it anyway, `with_total=0`
	   declines it even on the first page. A caller that sees no `total` must
	   keep the one it already has, not read a zero. */
	Total  *int `json:"total,omitempty"`
	Limit  int  `json:"limit"`
	Offset int  `json:"offset"`
	/* Derived by fetching limit+1 rows and trimming, never from the total --
	   which is why it stays honest on the pages that carry no total. */
	HasMore bool `json:"has_more"`
	/* Feed this back as `cursor` to get the next page. Empty on the last one:
	   an empty next_cursor is the end of the list, and the only end. */
	NextCursor string `json:"next_cursor,omitempty"`
}

/* listCursor is where one page of students stopped.

   Keyset, not offset. OFFSET 999950 makes Postgres produce and discard 999950
   rows before it can return ten, so the last page of a big roll costs the
   whole roll; a WHERE on the sort key costs an index seek wherever the reader
   is. The trade is that you can only go forward from a row you have seen,
   which is exactly what a list that loads as you scroll does.

   The sort key is the endpoint's own ORDER BY, admission_no, plus the row id
   as a tiebreak. The tiebreak is what makes the ordering TOTAL, which is the
   one thing keyset paging cannot do without: where two rows compare equal on
   the sort key, a boundary landing between them either repeats them or skips
   them, and which of the two you get is up to the plan.

   This said admission numbers "are NOT unique in practice -- they get
   reissued when a child leaves, and imports duplicate them". Not in this
   schema: students has carried UNIQUE (institution_id, admission_no) since
   00001, and admission_no is NOT NULL, so within one school the sort key is
   already total and the id changes no answer today. It stays because it costs
   nothing, because it is what keeps this correct if the constraint is ever
   relaxed for the reissue case the old note described, and because the cursor
   comparison below is written against a total order and would have to be
   rewritten, not just extended, to drop it.

   Filter carries a fingerprint of the query the cursor was cut from. A cursor
   is only meaningful against the same WHERE clause: paste one from a Class 6
   listing into an unfiltered one and the keyset would silently start the walk
   part-way down a different set. Mismatched fingerprints are ignored -- the
   caller gets the first page, which is a complete answer to the question they
   asked, rather than an error about a token they never typed. */
type listCursor struct {
	Adm    string `json:"a"`
	ID     string `json:"i"`
	Filter string `json:"f"`
}

func encodeCursor(c listCursor) string {
	b, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor returns the cursor only if it parses AND was cut from the same
// filter. Anything else -- truncated, re-encoded, from another screen -- reads
// as "no cursor", i.e. start at the beginning.
func decodeCursor(raw, filter string) *listCursor {
	if raw == "" {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil
	}
	var c listCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return nil
	}
	if c.ID == "" || c.Filter != filter {
		return nil
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return nil
	}
	return &c
}

// filterFingerprint names the row set a cursor belongs to: every parameter
// that reaches the WHERE clause, plus the caller's own visibility scope, so a
// cursor cannot carry a teacher's page into an admin's list either.
func filterFingerprint(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return base64.RawURLEncoding.EncodeToString(sum[:9])
}

/* listStudents pages by KEYSET, and `limit` is a page size rather than a cap.

   The old comment on this handler said the fix, if a tenant ever outgrew the
   count, was a cursor and not a bigger LIMIT cap -- and then the cap went 200,
   then 500, because callers kept being handed a complete-looking answer to a
   question they had not asked. Both numbers were wrong in the same way: they
   made the size of ONE RESPONSE stand in for how much of the school a reader
   could reach, so a roll of 345 read as 200 and a roll of 4,000 would read as
   500.

   THE LIMIT NOW BOUNDS ONE RESPONSE AND NOTHING ELSE. Default 50, maximum
   200. Every row is reachable at any roll size by following next_cursor; the
   client asks for the next page when the reader moves, so the cost of a
   million-row list is one page at a time rather than one enormous answer.

   Three ways in, and they coexist on purpose:

     cursor=...   the keyset walk. What new callers use.
     offset=N     the legacy path, still exact, still supported. It is
                  O(offset) in the database, so it belongs to the callers that
                  already exist and not to new ones.
     neither      the first page.

   `total` is on the first page only -- see the page envelope. */
func (s *Server) listStudents(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	// A page size, not a data cap. 200 is what one response may carry; what
	// the caller can reach is the whole list, by following next_cursor.
	limit := clampInt(q.Get("limit"), 50, 1, 200)
	offset := clampInt(q.Get("offset"), 0, 0, 1_000_000)
	search := strings.TrimSpace(q.Get("q"))
	status := q.Get("status")
	newThisYear := q.Get("new_this_year") == "1"

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

	scopePred, scopeArgs := res.StudentPredicate("st", 9) // $1..$6 filter, $7/$8 keyset

	fp := filterFingerprint(status, search, uuidText(sectionID), uuidText(classID),
		uuidText(yearID), strconv.FormatBool(newThisYear), scopePred,
		fmt.Sprint(scopeArgs...))
	cur := decodeCursor(q.Get("cursor"), fp)

	/* Counted on the first page only.

	   That is the page whose header says how many children are on the roll;
	   the pages after it are the same roll, further down. `with_total`
	   overrides in either direction for a caller that knows better. */
	withTotal := cur == nil
	switch q.Get("with_total") {
	case "1":
		withTotal = true
	case "0":
		withTotal = false
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
			   AND ($4::uuid IS NULL OR en.class_id = $4)
			   /* The keyset. $7/$8 are the last row the caller saw; NULL means
			      the first page, and the row comparison is what makes the
			      admission-number tiebreak exact rather than nearly right. */
			   AND ($7::text IS NULL OR
			        (st.admission_no, st.id) > ($7::text, $8::uuid))`

		// $1..$6 are the filter, $7/$8 the keyset, and the scope predicate was
		// numbered from $9 above. The count runs the SAME clause with the
		// keyset held NULL, because a total that shrank as you paged would be
		// a different number every page.
		filterArgs := []any{nullString(status), nullString(search), sectionID, classID,
			yearID, newThisYear}
		var curAdm, curID any
		if cur != nil {
			curAdm, curID = cur.Adm, cur.ID
		}
		args := append(append([]any{}, filterArgs...), curAdm, curID)
		args = append(args, scopeArgs...)
		where := from + " AND " + scopePred

		if withTotal {
			countArgs := append(append([]any{}, filterArgs...), nil, nil)
			countArgs = append(countArgs, scopeArgs...)
			var n int
			if err := tx.QueryRow(r.Context(), `SELECT count(*)`+where, countArgs...).Scan(&n); err != nil {
				return err
			}
			out.Total = &n
		}

		/* limit+1, then trim.

		   HasMore has to be a fact about the rows, not arithmetic on a total
		   that most pages no longer carry. One extra row answers it exactly
		   and costs one row. */
		rows, err := tx.Query(r.Context(), `
			SELECT st.id::text, st.person_code, st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.first_name, st.middle_name, st.last_name, st.gender,
			       to_char(st.date_of_birth, 'YYYY-MM-DD'), st.status,
			       to_char(st.admission_date, 'YYYY-MM-DD'),
			       c.name, sec.name, en.roll_no,
			       (SELECT g.phone FROM student_guardians sg
			          JOIN guardians g ON g.id = sg.guardian_id
			         WHERE sg.student_id = st.id
			         ORDER BY sg.is_primary DESC LIMIT 1)`+where+`
			 ORDER BY st.admission_no, st.id
			 LIMIT $`+itoa(len(args)+1)+` OFFSET $`+itoa(len(args)+2),
			append(args, limit+1, cursorOffset(cur, offset))...)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var st student
			if err := rows.Scan(&st.ID, &st.PersonCode, &st.AdmissionNo, &st.FullName,
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

	out.HasMore = len(out.Items) > limit
	if out.HasMore {
		out.Items = out.Items[:limit]
	}
	if len(out.Items) > 0 && out.HasMore {
		last := out.Items[len(out.Items)-1]
		out.NextCursor = encodeCursor(listCursor{Adm: last.AdmissionNo, ID: last.ID, Filter: fp})
	}
	httpx.JSON(w, http.StatusOK, out)
}

/* cursorOffset keeps the legacy offset callers working without letting the
   two schemes collide. A cursor already IS the position, so once one is in
   play the offset is spent and must be zero, or the walk would skip a page
   every step. */
func cursorOffset(cur *listCursor, offset int) int {
	if cur != nil {
		return 0
	}
	return offset
}

func uuidText(u *uuid.UUID) string {
	if u == nil {
		return ""
	}
	return u.String()
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
