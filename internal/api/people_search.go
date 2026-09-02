package api

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Searching for a person, rather than for a screen.

	The command palette searched 470 features and no people, so "find Anika
	Goud" — the single most common thing anybody in a school office does — meant
	knowing which screen holds children, opening it, and searching again inside
	it. Worse for a parent: guardians were reachable only through a child, so
	"a mother is at the counter and I have her number" had no answer at all
	unless somebody already knew which child she belonged to.

	Both live here, in one query, because the person at the counter does not
	announce which kind of record they are. A number typed into the box is a
	parent's mobile as often as it is an admission number.

	SCOPE. Gated on students.read, which every desk that deals with families
	holds and no parent does. A guardian is returned with the child they belong
	to, since a parent record with no child attached is not something this
	school has any use for — and it is the child's screen the office actually
	wants to open.
*/
type personHit struct {
	// student | guardian. The client renders a different line and opens a
	// different screen for each.
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Name string `json:"name"`
	// What tells two people of the same name apart, already assembled: a
	// class and an admission number, or a relation and a phone.
	Detail string `json:"detail"`
	// The child to open. Their own id for a student; for a guardian, one of
	// their children — the screen that shows a parent is a child's screen.
	StudentID string `json:"student_id"`
}

func (s *Server) searchPeople(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	/* Two characters, because one letter is the whole school and a scan of it
	   is work the database does for a result nobody reads. Answered as an
	   empty list rather than a 400: the client types into this on every
	   keystroke and an error at "a" is an error on the way to "anika". */
	if len(q) < 2 {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": []personHit{}})
		return
	}

	out := []personHit{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* One statement, so the two halves are ranked against each other
		   rather than concatenated: a query that is exactly an admission
		   number should not sit under three parents whose names merely
		   contain it.

		   Ranked: an exact identifier first, then a name that starts with what
		   was typed, then a name that contains it, then everything else that
		   matched. Children before parents at equal rank, because the child's
		   record is what the office opens either way. */
		rows, qerr := tx.Query(r.Context(), `
			WITH needle AS (SELECT $1::text AS q)
			SELECT * FROM (
				SELECT 'student' AS kind,
				       st.id::text AS id,
				       trim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)) AS name,
				       trim(concat_ws(' · ',
				            NULLIF(concat_ws(' ', c.name, sec.name), ''),
				            st.admission_no,
				            COALESCE(st.person_code, ''),
				            NULLIF(st.status, 'active'))) AS detail,
				       st.id::text AS student_id,
				       CASE
				         WHEN lower(st.admission_no) = lower((SELECT q FROM needle))
				              OR lower(COALESCE(st.person_code,'')) = lower((SELECT q FROM needle)) THEN 0
				         WHEN lower(trim(concat_ws(' ', st.first_name, st.last_name)))
				              LIKE lower((SELECT q FROM needle)) || '%' THEN 1
				         ELSE 3
				       END AS rank
				  FROM students st
				  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
				  LEFT JOIN sections sec ON sec.id = en.section_id
				  LEFT JOIN classes c ON c.id = sec.class_id
				 WHERE trim(concat_ws(' ', st.first_name, st.middle_name, st.last_name))
				         ILIKE '%' || (SELECT q FROM needle) || '%'
				    OR st.admission_no ILIKE '%' || (SELECT q FROM needle) || '%'
				    -- The app's own code, so a person quoting it is found by it.
				    OR COALESCE(st.person_code,'') ILIKE '%' || (SELECT q FROM needle) || '%'

				UNION ALL

				/* ONE ROW PER PARENT, NAMING EVERY CHILD.

				   Joined through student_guardians this listed a mother once
				   per child, so a family with three at the school pushed
				   everything else out of a fifteen-row result and the office
				   still could not see that the three were siblings. A parent
				   is one person and one login; the children are what
				   identifies them, so they belong on the row rather than
				   multiplying it. */
				SELECT 'guardian',
				       g.id::text,
				       g.full_name,
				       trim(concat_ws(' · ',
				            NULLIF(initcap(g.relation), ''),
				            NULLIF(string_agg(trim(concat_ws(' ', st.first_name, st.last_name)),
				                              ', ' ORDER BY st.first_name), ''),
				            NULLIF(COALESCE(g.phone, ''), ''))),
				       -- The child their record opens on: the eldest link, so
				       -- the same parent always lands on the same page.
				       (array_agg(st.id::text ORDER BY st.admission_no))[1],
				       CASE
				         WHEN g.phone = (SELECT q FROM needle) THEN 0
				         WHEN lower(g.full_name) LIKE lower((SELECT q FROM needle)) || '%' THEN 2
				         ELSE 4
				       END
				  FROM guardians g
				  JOIN student_guardians sg ON sg.guardian_id = g.id
				  JOIN students st ON st.id = sg.student_id
				 WHERE g.full_name ILIKE '%' || (SELECT q FROM needle) || '%'
				    OR COALESCE(g.phone,'') ILIKE '%' || (SELECT q FROM needle) || '%'
				    OR COALESCE(g.email::text,'') ILIKE '%' || (SELECT q FROM needle) || '%'
				 GROUP BY g.id, g.full_name, g.relation, g.phone
			) hits
			 ORDER BY rank, name
			 LIMIT 15`, q)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var h personHit
			var rank int
			if err := rows.Scan(&h.Kind, &h.ID, &h.Name, &h.Detail, &h.StudentID, &rank); err != nil {
				return err
			}
			out = append(out, h)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}
