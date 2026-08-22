package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Did the circular reach them?

   A principal could publish a notice and then had no way on earth to find out
   what happened to it. The published list was not clickable, there was no
   recipient list, no delivery state, no read receipt — only an aggregate
   "awaiting acknowledgement: 2". So the one question a person asks after
   sending something to six hundred families had no answer anywhere in the
   product, and the honest conclusion a tester drew was that delivery was
   unverified and probably broken. It was not broken. It was invisible, which
   for the person relying on it is the same thing.

   Three facts per circular, because they are three different states people
   confuse:

     delivered     the notice is on their portal and in their bell
     acknowledged  they pressed the button saying they had read it
     unreachable   there is nobody to deliver to, because that child's family
                   has never been issued a login

   The third is the one that explains a small number, and it is the one no
   aggregate was ever going to surface. A school reading "12 reached" out of
   sixty children assumes the targeting is wrong; told that forty-nine families
   have no login, they know exactly what to go and do.
*/

type circularPerson struct {
	Name string `json:"name"`
	// Who they are to the school — a guardian of somebody, a student, or staff.
	Role    string  `json:"role"`
	Student *string `json:"student,omitempty"`
	AckedAt *string `json:"acked_at,omitempty"`
}

type circularDelivery struct {
	Title        string           `json:"title"`
	Audience     string           `json:"audience_role"`
	PublishedAt  string           `json:"published_at"`
	Delivered    int              `json:"delivered"`
	Acknowledged int              `json:"acknowledged"`
	Unreachable  int              `json:"unreachable_children"`
	People       []circularPerson `json:"people"`
}

// getCircularDelivery answers "who got this, and who said they read it".
func (s *Server) getCircularDelivery(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	annID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}

	out := circularDelivery{People: []circularPerson{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var sections []string
		err := tx.QueryRow(r.Context(), `
			SELECT a.title, a.audience_role,
			       to_char(a.publish_at, 'YYYY-MM-DD HH24:MI'),
			       COALESCE(array_agg(s.section_id::text) FILTER (WHERE s.section_id IS NOT NULL),
			                '{}')
			  FROM announcements a
			  LEFT JOIN announcement_sections s ON s.announcement_id = a.id
			 WHERE a.id = $1
			 GROUP BY a.id, a.title, a.audience_role, a.publish_at`, annID).
			Scan(&out.Title, &out.Audience, &out.PublishedAt, &sections)
		if err == pgx.ErrNoRows {
			httpx.NotFound(w, r)
			return errStopped
		}
		if err != nil {
			return err
		}

		// nil rather than an empty array: the recipient query reads a NULL
		// section list as "the whole school", and an empty array as "no
		// sections", which would reach nobody.
		var secArg any
		if len(sections) > 0 {
			secArg = uuidArray(sections)
		}

		/* The same query that decided who to send it to.

		   Deliberately reused rather than rewritten: a delivery report built
		   from a second, similar query is a report that can disagree with what
		   actually happened, and the disagreement will always be discovered at
		   the worst moment. */
		rows, err := tx.Query(r.Context(), `
			WITH recipients AS (`+circularRecipients+`)
			SELECT COALESCE(u.full_name, u.email::text, 'unnamed'),
			       CASE WHEN g.id IS NOT NULL THEN 'guardian'
			            WHEN st.id IS NOT NULL THEN 'student'
			            ELSE 'staff' END,
			       COALESCE(concat_ws(' ', ward.first_name, ward.last_name),
			                concat_ws(' ', st.first_name, st.last_name)),
			       to_char(ack.acked_at, 'YYYY-MM-DD HH24:MI')
			  FROM recipients rcp
			  JOIN users u ON u.id = rcp.user_id
			  LEFT JOIN guardians g ON g.user_id = u.id
			  LEFT JOIN students  st ON st.user_id = u.id
			  LEFT JOIN LATERAL (
			      SELECT s2.first_name, s2.last_name
			        FROM student_guardians sg2
			        JOIN students s2 ON s2.id = sg2.student_id
			       WHERE sg2.guardian_id = g.id
			       ORDER BY s2.first_name LIMIT 1
			  ) ward ON true
			  LEFT JOIN announcement_acks ack
			         ON ack.announcement_id = $3 AND ack.user_id = u.id
			 ORDER BY (ack.acked_at IS NULL) DESC, 1`,
			secArg, out.Audience, annID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var p circularPerson
			if err := rows.Scan(&p.Name, &p.Role, &p.Student, &p.AckedAt); err != nil {
				return err
			}
			if p.AckedAt != nil {
				out.Acknowledged++
			}
			out.People = append(out.People, p)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		out.Delivered = len(out.People)

		if out.Audience == "staff" {
			return nil
		}
		return tx.QueryRow(r.Context(), `
			SELECT count(*)::int
			  FROM students st
			  LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
			 WHERE st.status = 'active'
			   AND ($1::uuid[] IS NULL OR e.section_id = ANY($1))
			   AND st.user_id IS NULL
			   AND NOT EXISTS (
			         SELECT 1 FROM student_guardians sg
			           JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
			          WHERE sg.student_id = st.id)`, secArg).Scan(&out.Unreachable)
	})
	if err == errStopped {
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
