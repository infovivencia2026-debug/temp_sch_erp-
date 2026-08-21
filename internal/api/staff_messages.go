package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A principal talking to their own staff.

   The product had three messaging channels and none of them was this one. A
   parent can write to their child's teacher, a counsellor has a private
   thread, a class has a homework forum — and a principal wanting to ask one
   head of department about Thursday had nowhere to do it. The catalogue entry
   that claimed otherwise opened the circular composer, which broadcasts to the
   whole school: a reasonable answer to "tell everybody" and the wrong tool
   entirely for "ask one person".

   Bounded to the school's own staff. Not because a principal cannot be trusted
   with a wider address book, but because an unbounded one is a list of every
   parent and child in the school, and picking a name out of nine hundred is
   not a feature.

   The thread key is the pair of people, held in a fixed order. A conversation
   between two people is one conversation, and storing it as "from A to B" plus
   "from B to A" gives each of them half of it.
*/

type staffThreadRow struct {
	UserID   string  `json:"user_id"`
	FullName string  `json:"full_name"`
	Role     *string `json:"designation,omitempty"`
	Unread   int     `json:"unread"`
	Last     *string `json:"last_message,omitempty"`
	LastAt   *string `json:"last_at,omitempty"`
}

type staffMessageRow struct {
	ID     string `json:"id"`
	Body   string `json:"body"`
	SentAt string `json:"sent_at"`
	Mine   bool   `json:"mine"`
	Sender string `json:"sender_name"`
}

/*
listStaffThreads is the address book with the conversations folded into it.

	Every colleague appears, whether or not there is a thread yet, because the
	first message to somebody is the common case and a screen that lists only
	existing conversations cannot start one. The ones with unread messages
	sort first; after that it is alphabetical, which is how somebody looks for
	a name they already know.
*/
func (s *Server) listStaffThreads(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	items, err := collect(s, r, `
		SELECT u.id::text, u.full_name, d.name,
		       (SELECT count(*)::int FROM staff_messages m
		         WHERE m.sender_user_id = u.id
		           AND (m.party_a = $1 OR m.party_b = $1)
		           AND (m.party_a = u.id OR m.party_b = u.id)
		           AND m.read_at IS NULL),
		       (SELECT left(m.body, 90) FROM staff_messages m
		         WHERE (m.party_a = least($1, u.id) AND m.party_b = greatest($1, u.id))
		         ORDER BY m.sent_at DESC LIMIT 1),
		       (SELECT to_char(m.sent_at, 'YYYY-MM-DD"T"HH24:MI') FROM staff_messages m
		         WHERE (m.party_a = least($1, u.id) AND m.party_b = greatest($1, u.id))
		         ORDER BY m.sent_at DESC LIMIT 1)
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN designations d ON d.id = e.designation_id
		 WHERE e.status = 'active' AND u.id <> $1
		 /* Conversations first, then the rest of the address book.

		    Unread, then whoever was spoken to most recently, then everybody
		    else alphabetically. Sorting the whole list by name put a thread
		    you had just written in among ten colleagues you had never
		    written to, distinguishable only by a line of preview text — so
		    the screen read as though nothing had been sent. A message you
		    sent is history, and history belongs at the top. */
		 ORDER BY 4 DESC, 6 DESC NULLS LAST, u.full_name`,
		[]any{id.UserID},
		func(rows pgx.Rows) (staffThreadRow, error) {
			var v staffThreadRow
			return v, rows.Scan(&v.UserID, &v.FullName, &v.Role, &v.Unread, &v.Last, &v.LastAt)
		})
	respond(w, r, items, err)
}

// listStaffMessages returns one conversation, oldest first, and marks the
// other side's messages read.
//
// Marking on read rather than on open of the list: an unread count that clears
// because somebody glanced at the index is a count that stops meaning anything.
func (s *Server) listStaffMessages(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	other, err := uuid.Parse(r.URL.Query().Get("with"))
	if err != nil {
		httpx.BadRequest(w, r, "with must be the uuid of a colleague")
		return
	}

	var items []staffMessageRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, qerr := tx.Query(r.Context(), `
			SELECT m.id::text, m.body,
			       to_char(m.sent_at, 'YYYY-MM-DD"T"HH24:MI'),
			       m.sender_user_id = $1, u.full_name
			  FROM staff_messages m
			  JOIN users u ON u.id = m.sender_user_id
			 WHERE m.party_a = least($1, $2::uuid) AND m.party_b = greatest($1, $2::uuid)
			 ORDER BY m.sent_at`, id.UserID, other)
		if qerr != nil {
			return qerr
		}
		items = []staffMessageRow{}
		for rows.Next() {
			var v staffMessageRow
			if err := rows.Scan(&v.ID, &v.Body, &v.SentAt, &v.Mine, &v.Sender); err != nil {
				rows.Close()
				return err
			}
			items = append(items, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		_, err := tx.Exec(r.Context(), `
			UPDATE staff_messages SET read_at = now()
			 WHERE party_a = least($1, $2::uuid) AND party_b = greatest($1, $2::uuid)
			   AND sender_user_id = $2 AND read_at IS NULL`, id.UserID, other)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type sendStaffMessageRequest struct {
	To   string `json:"to"`
	Body string `json:"body"`
}

// sendStaffMessage writes one message to one colleague.
func (s *Server) sendStaffMessage(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var req sendStaffMessageRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	other, err := uuid.Parse(strings.TrimSpace(req.To))
	if err != nil {
		httpx.BadRequest(w, r, "to must be the uuid of a colleague")
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "an empty message says nothing")
		return
	}
	if other == id.UserID {
		httpx.BadRequest(w, r, "you cannot message yourself")
		return
	}

	var newID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Staff of this school, and nobody else. Checked here rather than
		// trusted from the address book, because the address book is a
		// convenience and this is the control.
		var ok bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM employees e
			                WHERE e.user_id = $1 AND e.status = 'active')`,
			other).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return errNotColleague
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO staff_messages (institution_id, party_a, party_b,
			                            sender_user_id, body)
			VALUES ($1, least($2, $3::uuid), greatest($2, $3::uuid), $2, $4)
			RETURNING id`,
			id.InstitutionID, id.UserID, other, strings.TrimSpace(req.Body)).
			Scan(&newID); err != nil {
			return err
		}

		// Told, rather than left to notice. A message nobody is alerted to is
		// a message read on the day somebody happens to open the screen.
		var from string
		if err := tx.QueryRow(r.Context(),
			`SELECT full_name FROM users WHERE id = $1`, id.UserID).Scan(&from); err != nil {
			return err
		}
		body := strings.TrimSpace(req.Body)
		if len(body) > 240 {
			body = body[:237] + "…"
		}
		/* The link has to open in the reader's own workspace.

		   It was hard-coded to the principal's URL, so a teacher who was sent a
		   message got a notification leading to a page their role cannot open —
		   the one action the notification exists for. The route is
		   /{role}/communication/messages for everybody who has the screen, so
		   the only variable is which role the reader holds. */
		var role string
		if err := tx.QueryRow(r.Context(), `
			SELECT r.key
			  FROM user_roles ur
			  JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = $1
			 ORDER BY CASE r.key
			            WHEN 'institution_admin' THEN 0
			            WHEN 'hod' THEN 1
			            WHEN 'faculty' THEN 2
			            ELSE 3 END
			 LIMIT 1`, other).Scan(&role); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			role = "institution_admin"
		}


		return notify(r, tx, id.InstitutionID, other, nil, "staff_message",
			"Message from "+from, body,
			"/"+role+"/communication/messages",
			"staff_message", &newID)
	})
	switch {
	case errors.Is(err, errNotColleague):
		httpx.BadRequest(w, r, "that person is not a member of staff at this school")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID.String()})
}

var errNotColleague = errStr("not a colleague")
