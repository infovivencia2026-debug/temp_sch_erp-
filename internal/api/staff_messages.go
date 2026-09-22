package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/live"
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
	// Files sent with it; see attachments.go.
	Attachments []attachment `json:"attachments"`
	// Cursor is this message's own send time at full precision: the value to
	// pass as `before` to fetch the page above it.
	Cursor string `json:"cursor"`
	// What this message answers, quoted as it read when it was quoted.
	ReplyToID   *string `json:"reply_to_id,omitempty"`
	ReplyBody   *string `json:"reply_body,omitempty"`
	ReplySender *string `json:"reply_sender,omitempty"`
	Edited      bool    `json:"edited"`
	Deleted     bool    `json:"deleted"`
	ReadAt      *string `json:"read_at,omitempty"`
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
		  /* Everybody on the staff, not everybody on the payroll.

		     Built from employees, so a principal with no employees row was
		     absent from the address book of every teacher in the school, the
		     account that runs a school is created with the school, before
		     there is a payroll to put anybody on. Searching "ram" returned
		     "Nobody matches", about the person who runs the place, and any
		     conversation already had with them was unreachable because the
		     only way in is through this list.

		     So: users holding a staff role, with the employee row kept for the
		     designation and the active check where there is one. */
		  FROM users u
		  LEFT JOIN employees e ON e.user_id = u.id
		  LEFT JOIN designations d ON d.id = e.designation_id
		 WHERE u.id <> $1
		   AND (e.id IS NULL OR e.status = 'active')
		   AND EXISTS (SELECT 1 FROM user_roles ur
		                 JOIN roles ro ON ro.id = ur.role_id
		                WHERE ur.user_id = u.id
		                  AND ro.key NOT IN ('student','parent'))
		 /* Conversations first, then the rest of the address book.

		    Unread, then whoever was spoken to most recently, then everybody
		    else alphabetically. Sorting the whole list by name put a thread
		    you had just written in among ten colleagues you had never
		    written to, distinguishable only by a line of preview text, so
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

	/* A WINDOW, NOT THE WHOLE CONVERSATION.

	   This selected every message ever exchanged with that colleague, on every
	   open. A thread that runs a year is a few hundred rows and a second of
	   waiting on a school corridor's connection, and it grows for as long as
	   the two of them keep talking. The newest page comes back by default and
	   `before` walks backwards through the rest, so opening is the same cost
	   in March as it was in June.

	   Rows are read newest-first for the LIMIT and turned back into reading
	   order before they are sent, because a page of the OLDEST fifty is not
	   what anybody opening a chat wants. */
	const pageSize = 40
	before := strings.TrimSpace(r.URL.Query().Get("before"))

	var items []staffMessageRow
	var more bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, qerr := tx.Query(r.Context(), `
			SELECT m.id::text,
			       CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END,
			       to_char(m.sent_at, 'YYYY-MM-DD"T"HH24:MI'),
			       m.sender_user_id = $1, u.full_name,
			       CASE WHEN m.deleted_at IS NULL THEN m.attachments ELSE NULL END,
			       to_char(m.sent_at, 'YYYY-MM-DD"T"HH24:MI:SS.US'),
			       m.reply_to_id::text,
			       (SELECT left(q.body, 120) FROM staff_messages q WHERE q.id = m.reply_to_id),
			       (SELECT qu.full_name FROM staff_messages q JOIN users qu ON qu.id = q.sender_user_id
			         WHERE q.id = m.reply_to_id),
			       m.edited_at IS NOT NULL, m.deleted_at IS NOT NULL,
			       to_char(m.read_at, 'YYYY-MM-DD"T"HH24:MI')
			  FROM staff_messages m
			  JOIN users u ON u.id = m.sender_user_id
			 WHERE m.party_a = least($1, $2::uuid) AND m.party_b = greatest($1, $2::uuid)
			   AND ($3 = '' OR m.sent_at < $3::timestamptz)
			 ORDER BY m.sent_at DESC
			 LIMIT $4`, id.UserID, other, before, pageSize+1)
		if qerr != nil {
			return qerr
		}
		items = []staffMessageRow{}
		for rows.Next() {
			var v staffMessageRow
			var raw []byte
			if err := rows.Scan(&v.ID, &v.Body, &v.SentAt, &v.Mine, &v.Sender, &raw, &v.Cursor,
				&v.ReplyToID, &v.ReplyBody, &v.ReplySender, &v.Edited, &v.Deleted, &v.ReadAt); err != nil {
				rows.Close()
				return err
			}
			v.Attachments = scanAttachments(raw)
			items = append(items, v)
		}
		rows.Close()
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(items) > pageSize {
		more = true
		items = items[:pageSize]
	}
	// Back into reading order: oldest of this page first.
	for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
		items[i], items[j] = items[j], items[i]
	}
	var cursor string
	if len(items) > 0 {
		cursor = items[0].Cursor
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "has_more": more, "cursor": cursor,
	})
	return
}

// markStaffThreadRead is the tick the other person sees, and it is set when
// their message has actually been on screen — not merely when the thread was
// opened, which marked an unread message read while its sender was still
// typing the next one and nobody had looked at anything.
func (s *Server) markStaffThreadRead(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	other, err := uuid.Parse(r.URL.Query().Get("with"))
	if err != nil {
		httpx.BadRequest(w, r, "with must be the uuid of a colleague")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, uerr := tx.Exec(r.Context(), `
			UPDATE staff_messages SET read_at = now()
			 WHERE party_a = least($1, $2::uuid) AND party_b = greatest($1, $2::uuid)
			   AND sender_user_id = $2 AND read_at IS NULL`, id.UserID, other)
		return uerr
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

type sendStaffMessageRequest struct {
	To          string       `json:"to"`
	Body        string       `json:"body"`
	Attachments []attachment `json:"attachments,omitempty"`
	// ReplyTo quotes the message this one answers. Optional; a thread about
	// one child runs a year and "about which day?" is its commonest question.
	ReplyTo string `json:"reply_to_id,omitempty"`
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
	files, okFiles := s.attachmentsFor(w, r, req.Attachments)
	if !okFiles {
		return
	}
	if strings.TrimSpace(req.Body) == "" && len(files) == 0 {
		httpx.BadRequest(w, r, "an empty message says nothing")
		return
	}
	if other == id.UserID {
		httpx.BadRequest(w, r, "you cannot message yourself")
		return
	}

	var newID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Staff of this school, and nobody else. Checked here rather than
		   trusted from the address book, because the address book is a
		   convenience and this is the control.

		   AN EMPLOYEE ROW IS NOT WHAT MAKES SOMEBODY STAFF.

		   It asked whether the recipient had an active employees row, and a
		   principal often has none — the account that runs the school is
		   created with the school, before there is a payroll to put anybody on.
		   So a teacher could be written to by their head and could not reply:
		   "that person is not a member of staff at this school", about the
		   person who runs it.

		   Holding a staff role is the real test. A guardian or a pupil holds
		   none of them, which is the line this check exists to draw; an
		   employee row is a payroll fact that usually coincides with it. */
		var ok bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM employees e
			                WHERE e.user_id = $1 AND e.status = 'active')
			    OR EXISTS (SELECT 1 FROM user_roles ur
			                 JOIN roles ro ON ro.id = ur.role_id
			                WHERE ur.user_id = $1
			                  AND ro.key NOT IN ('student','parent'))`,
			other).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return errNotColleague
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO staff_messages (institution_id, party_a, party_b,
			                            sender_user_id, body, attachments, reply_to_id)
			VALUES ($1, least($2, $3::uuid), greatest($2, $3::uuid), $2, $4, $5,
			        NULLIF($6, '')::uuid)
			RETURNING id`,
			id.InstitutionID, id.UserID, other, strings.TrimSpace(req.Body),
			attachmentsJSON(files), strings.TrimSpace(req.ReplyTo)).
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

		if err := notify(r, tx, id.InstitutionID, other, nil, "staff_message",
			"Message from "+from, body,
			/* With the sender on the end of it.

			   The link opened the Messages screen and left the reader to find
			   the name in a list of eleven colleagues — which is the same
			   search the notification had just done for them. It carries who
			   wrote, and the screen opens that conversation. */
			"/go/communication/messages?with="+id.UserID.String(),
			"staff_message", &newID); err != nil {
			return err
		}
		// And now, not in thirty seconds: the colleague's open screen refetches
		// this thread and their bell, and the sender's own list reorders.
		s.publishLive(r.Context(), tx, live.Event{
			Institution: id.InstitutionID, Users: []uuid.UUID{other, id.UserID},
			Type: "message", Scope: "staff", From: id.UserID,
			Keys: map[string]string{"peer": id.UserID.String(), "to": other.String(), "from_name": from},
		})
		return nil
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
