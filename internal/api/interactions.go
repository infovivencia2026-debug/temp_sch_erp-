package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The interaction log: everything that passed between two people.

   A message from a teacher to a parent, a remark a teacher wrote about a
   child, a counsellor's reply, a fee a clerk took from a family, a note the
   office put on a student: each is recorded in its own table for its own
   screen. The institution admin's question is not per table. It is "what
   has passed between Mrs Rao and the Gupta family this term", or "show me
   every exchange this teacher has had with any parent". This answers that
   as one list, read-only, with a link to where each thing lives.

   One UNION over the sources, each row shaped the same: when, what kind,
   who (from), whom (to), which child it was about, a one-line summary, how
   many files travelled with it. The "to" side of a remark or a payment is
   the child's family: the guardian accounts linked to the student, named
   as such rather than left blank. Filters: either person, a kind, a window
   of days, a search on the text. Read under audit.read like the other
   oversight screens. */

type interactionRow struct {
	At          string  `json:"at"`
	Kind        string  `json:"kind"`
	FromID      *string `json:"from_id,omitempty"`
	FromName    string  `json:"from_name"`
	ToID        *string `json:"to_id,omitempty"`
	ToName      string  `json:"to_name"`
	StudentName *string `json:"student_name,omitempty"`
	Summary     string  `json:"summary"`
	Files       int     `json:"files"`
	Link        string  `json:"link,omitempty"`
	RefID       string  `json:"ref_id"`
}

func (s *Server) listInteractions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	parse := func(k string) (any, bool) {
		raw := strings.TrimSpace(q.Get(k))
		if raw == "" {
			return nil, true
		}
		u, err := uuid.Parse(raw)
		if err != nil {
			return nil, false
		}
		return u, true
	}
	a, okA := parse("a")
	b, okB := parse("b")
	if !okA || !okB {
		httpx.BadRequest(w, r, "a and b must be user ids")
		return
	}
	kind := strings.TrimSpace(q.Get("kind"))
	days := clampInt(q.Get("days"), 30, 1, 730)
	limit := clampInt(q.Get("limit"), 300, 1, 2000)
	search := strings.TrimSpace(q.Get("q"))

	items, err := collect(s, r, `
		WITH fam AS (
		  -- The guardian accounts behind a student, as one "to" side.
		  SELECT sg.student_id,
		         string_agg(g.full_name, ', ' ORDER BY sg.is_primary DESC, g.full_name) AS names,
		         (array_agg(g.user_id ORDER BY sg.is_primary DESC))[1] AS user_id
		    FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
		   GROUP BY sg.student_id
		),
		src AS (
		  SELECT m.sent_at AS at, 'staff_message' AS kind,
		         m.sender_user_id AS from_id, su.full_name AS from_name,
		         CASE WHEN m.sender_user_id = m.party_a THEN m.party_b ELSE m.party_a END AS to_id,
		         ou.full_name AS to_name,
		         NULL::text AS student_name, m.body AS summary,
		         jsonb_array_length(m.attachments) AS files,
		         '/go/messages?box=staff' AS link, m.id::text AS ref
		    FROM staff_messages m
		    JOIN users su ON su.id = m.sender_user_id
		    JOIN users ou ON ou.id = CASE WHEN m.sender_user_id = m.party_a THEN m.party_b ELSE m.party_a END
		  UNION ALL
		  SELECT m.sent_at, 'parent_message',
		         m.sender_user_id, su.full_name,
		         CASE WHEN m.sender_user_id = m.parent_user_id THEN m.teacher_user_id ELSE m.parent_user_id END,
		         ou.full_name, st.full_name, m.body, jsonb_array_length(m.attachments),
		         '/go/messages?box=parents', m.id::text
		    FROM parent_teacher_messages m
		    JOIN users su ON su.id = m.sender_user_id
		    JOIN users ou ON ou.id = CASE WHEN m.sender_user_id = m.parent_user_id THEN m.teacher_user_id ELSE m.parent_user_id END
		    LEFT JOIN students st ON st.id = m.student_id
		  UNION ALL
		  SELECT m.created_at, 'counselor_message',
		         m.sender_id, COALESCE(su.full_name, 'Unknown'),
		         fam.user_id, COALESCE(fam.names, 'the family'),
		         st.full_name, COALESCE(t.subject, '') || ': ' || m.body, jsonb_array_length(m.attachments),
		         '/go/counselor_channel', m.id::text
		    FROM counselor_messages m
		    JOIN counselor_threads t ON t.id = m.thread_id
		    LEFT JOIN users su ON su.id = m.sender_id
		    LEFT JOIN students st ON st.id = t.student_id
		    LEFT JOIN fam ON fam.student_id = t.student_id
		  UNION ALL
		  SELECT rm.created_at, 'remark',
		         rm.recorded_by, COALESCE(ru.full_name, 'Unknown'),
		         fam.user_id, COALESCE(fam.names, 'the family'),
		         st.full_name, rm.kind || ': ' || rm.body, 0,
		         '/go/remarks', rm.id::text
		    FROM student_remarks rm
		    LEFT JOIN users ru ON ru.id = rm.recorded_by
		    LEFT JOIN students st ON st.id = rm.student_id
		    LEFT JOIN fam ON fam.student_id = rm.student_id
		   WHERE rm.visible_to_family
		  UNION ALL
		  SELECT p.paid_on::timestamptz, 'payment',
		         p.collected_by, COALESCE(cu.full_name, 'Office'),
		         fam.user_id, COALESCE(fam.names, 'the family'),
		         st.full_name,
		         'Receipt ' || COALESCE(p.receipt_no, '') || ' · ₹' || to_char(p.amount_paise / 100.0, 'FM999999990.00') || ' by ' || COALESCE(p.mode, ''), 0,
		         '/go/fee_counter', p.id::text
		    FROM payments p
		    LEFT JOIN users cu ON cu.id = p.collected_by
		    LEFT JOIN students st ON st.id = p.student_id
		    LEFT JOIN fam ON fam.student_id = p.student_id
		   WHERE p.status <> 'void'
		)
		SELECT to_char(src.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', src.kind,
		       src.from_id::text, src.from_name, src.to_id::text, src.to_name,
		       src.student_name, left(src.summary, 300), src.files, src.link, src.ref
		  FROM src
		 WHERE src.at > now() - ($1 || ' days')::interval
		   AND ($2::uuid IS NULL OR src.from_id = $2 OR src.to_id = $2)
		   AND ($3::uuid IS NULL OR src.from_id = $3 OR src.to_id = $3)
		   AND ($4::text = '' OR src.kind = $4)
		   AND ($5::text = '' OR src.summary ILIKE '%' || $5 || '%' OR src.from_name ILIKE '%' || $5 || '%'
		        OR src.to_name ILIKE '%' || $5 || '%' OR src.student_name ILIKE '%' || $5 || '%')
		 ORDER BY src.at DESC
		 LIMIT $6`,
		[]any{strconv.Itoa(days), a, b, kind, search, limit},
		func(rows pgx.Rows) (interactionRow, error) {
			var v interactionRow
			return v, rows.Scan(&v.At, &v.Kind, &v.FromID, &v.FromName, &v.ToID, &v.ToName,
				&v.StudentName, &v.Summary, &v.Files, &v.Link, &v.RefID)
		})
	_ = id
	respond(w, r, items, err)
}

// listInteractionPeople answers the person pickers: staff, guardians and
// students with a login, by name.
func (s *Server) listInteractionPeople(w http.ResponseWriter, r *http.Request) {
	search := strings.TrimSpace(r.URL.Query().Get("q"))
	type person struct {
		ID   string `json:"id"`
		Name string `json:"full_name"`
		Side string `json:"side"`
	}
	items, err := collect(s, r, `
		SELECT u.id::text, u.full_name,
		       CASE WHEN EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id) THEN 'staff'
		            WHEN EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id) THEN 'guardian'
		            WHEN EXISTS (SELECT 1 FROM students st WHERE st.user_id = u.id) THEN 'student'
		            ELSE 'staff' END
		  FROM users u
		 WHERE u.status = 'active'
		   AND ($1::text = '' OR u.full_name ILIKE '%' || $1 || '%')
		 ORDER BY u.full_name
		 LIMIT 30`, []any{search},
		func(rows pgx.Rows) (person, error) {
			var v person
			return v, rows.Scan(&v.ID, &v.Name, &v.Side)
		})
	respond(w, r, items, err)
}
