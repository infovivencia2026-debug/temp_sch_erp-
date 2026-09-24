package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The teacher's half of the conversation.

   A parent writes to a teacher through the portal, the row lands in
   parent_teacher_messages, and a notification is raised. Then nothing: the
   teacher's "Messages" is staff-to-staff DM, and "Communication" is what the
   teacher sends out — remarks, notices, PTM notes. Neither reads this table,
   so the message arrived at a room with no door.

   The reply was never the missing part. POST /portal/messages already has a
   branch for a teacher answering, and the thread view already accepts a
   teacher as one of the two ends. What it did not have was a way to find out
   there was a thread at all: the list is keyed on parent_user_id, and the
   ownership guard in front of it turns a teacher away before the branch that
   would have served them. So the feature was reachable only by somebody who
   already knew the ids of a conversation they had never been shown.

   These two endpoints are the same data read from the other side, kept here
   rather than bolted onto the portal handler with a third mode — that handler
   is already answering "which child" and "which teacher", and a caller who is
   neither a guardian nor asking about their own children does not belong in
   its guard. */

type teacherThreadRow struct {
	StudentID   string `json:"student_id"`
	StudentName string `json:"student_name"`
	ClassName   string `json:"class_name"`
	ParentID    string `json:"parent_user_id"`
	ParentName  string `json:"parent_name"`
	LastMessage string `json:"last_message"`
	LastAt      string `json:"last_at"`
	Unread      int    `json:"unread"`
	/* The child's face, on the school's side of the conversation.

	   A teacher answering eight families reads "Nikhil Gupta" and has to
	   remember which of the four Nikhils that is. The photograph the office
	   already holds settles it before the name is read. Absent for a child
	   with no photograph on file, which the screen draws as initials. */
	StudentPhoto *string `json:"student_photo,omitempty"`

	// Whose conversation this is. Sent only to a reader seeing somebody
	// else's threads; a teacher's own inbox has one teacher in it.
	TeacherID   *string `json:"teacher_user_id,omitempty"`
	TeacherName *string `json:"teacher_name,omitempty"`
}

/*
May this reader open threads belonging to that teacher?

	The counterpart of the narrowing on the list, factored out so the two cannot
	drift: a rule that decides which threads are listed and a different rule
	deciding which may be opened is how a screen shows you a row you are then
	refused.

	A head of department is checked against the departments they head; anybody
	holding the right with no department — the principal — reads the school.
*/
func (s *Server) mayReadTeachersThreads(r *http.Request, teacher uuid.UUID) (bool, error) {
	res, err := s.resolveScope(r)
	if err != nil {
		return false, err
	}
	if len(res.DepartmentIDs) == 0 {
		return true, nil
	}
	id := httpx.IdentityFrom(r.Context())
	var ok bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			  SELECT 1 FROM employees emp
			   WHERE emp.user_id = $1 AND emp.department_id = ANY($2))`,
			teacher, res.DepartmentIDs).Scan(&ok)
	})
	return ok, err
}

// listTeacherParentThreads is the teacher's inbox of family conversations, and
// the head's view of their teachers'.
func (s *Server) listTeacherParentThreads(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	/* Whose threads may this person read?

	   Their own, always. Everybody's, on comms.messages.read.all — narrowed to
	   the departments they head, because a head of department answers for their
	   own subject and not for the school's whole postbag. A principal heads no
	   department, so the narrowing does not apply and they see all of it. */
	whose, args := "m.teacher_user_id = $1", []any{id.UserID}
	if id.Can(rbac.MessagesReadAll) {
		res, err := s.resolveScope(r)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if len(res.DepartmentIDs) > 0 {
			args = append(args, res.DepartmentIDs)
			whose = `m.teacher_user_id IN (
			           SELECT emp.user_id FROM employees emp
			            WHERE emp.department_id = ANY($2) AND emp.user_id IS NOT NULL)`
		} else {
			whose = "TRUE"
		}
	}

	items, err := collect(s, r, `
		SELECT DISTINCT ON (m.student_id, m.parent_user_id, m.teacher_user_id)
		       m.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       COALESCE(c.name, '') || COALESCE('-' || sec.name, ''),
		       m.parent_user_id::text, pu.full_name,
		       m.body, to_char(m.sent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       m.teacher_user_id::text, tu.full_name,
		       st.photo_file_id::text,
		       (SELECT count(*)::int FROM parent_teacher_messages un
		         WHERE un.student_id = m.student_id
		           AND un.parent_user_id = m.parent_user_id
		           AND un.teacher_user_id = m.teacher_user_id
		           AND un.sender_user_id <> $1 AND un.read_at IS NULL)
		  FROM parent_teacher_messages m
		  JOIN users pu ON pu.id = m.parent_user_id
		  LEFT JOIN users tu ON tu.id = m.teacher_user_id
		  JOIN students st ON st.id = m.student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE `+whose+`
		 ORDER BY m.student_id, m.parent_user_id, m.teacher_user_id, m.sent_at DESC
		 LIMIT 200`, args,
		func(rows pgx.Rows) (teacherThreadRow, error) {
			var v teacherThreadRow
			return v, rows.Scan(&v.StudentID, &v.StudentName, &v.ClassName,
				&v.ParentID, &v.ParentName, &v.LastMessage, &v.LastAt,
				&v.TeacherID, &v.TeacherName, &v.StudentPhoto, &v.Unread)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// listTeacherParentMessages is one conversation, and marks it read.
func (s *Server) listTeacherParentMessages(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	sid, err := uuid.Parse(strings.TrimSpace(q.Get("student_id")))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	parentID, err := uuid.Parse(strings.TrimSpace(q.Get("parent_user_id")))
	if err != nil {
		httpx.BadRequest(w, r, "parent_user_id must be a uuid")
		return
	}

	/* Whose end of the thread is being read.

	   A teacher reads their own, always: the id comes from the session and the
	   client cannot move it. A head reading their teachers' correspondence
	   names the teacher, and that is honoured only on
	   comms.messages.read.all — so the parameter can pick a thread out of the
	   set the reader is already entitled to and can never widen it.

	   Narrowed the same way the list is: a head of department is checked
	   against their own departments, a principal has none and reads the school.
	   Without the check, naming any teacher's id would have handed the whole
	   staffroom's post to whoever guessed a uuid. */
	teacher := id.UserID
	if asked := strings.TrimSpace(q.Get("teacher_user_id")); asked != "" &&
		id.Can(rbac.MessagesReadAll) {
		other, perr := uuid.Parse(asked)
		if perr != nil {
			httpx.BadRequest(w, r, "teacher_user_id must be a uuid")
			return
		}
		ok, cerr := s.mayReadTeachersThreads(r, other)
		if cerr != nil {
			httpx.Internal(w, r, cerr)
			return
		}
		if !ok {
			// The same answer as a thread that does not exist: a head probing
			// for another department's teachers learns nothing either way.
			httpx.NotFound(w, r)
			return
		}
		teacher = other
	}

	/* Not "may this teacher write to this family" — that is a different and
	   stricter question, asked by teacherMayWrite when they reply. A teacher
	   who has since stopped taking the class must still be able to read what
	   was said to them, or a handover loses the conversation. */
	/* A window, newest first, then turned back into reading order. Loading a
	   year of conversation on every open is a second of waiting that grows
	   every term; `before` walks back through the rest a page at a time. */
	items, err := collect(s, r, `
		SELECT m.id::text,
		       CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END,
		       to_char(m.sent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', u.full_name,
		       m.sender_user_id = $4,
		       CASE WHEN m.sender_user_id = m.parent_user_id THEN 'parent'
		            WHEN m.sender_user_id = m.teacher_user_id THEN 'teacher'
		            ELSE COALESCE((SELECT r.name FROM user_roles ur
		                             JOIN roles r ON r.id = ur.role_id
		                            WHERE ur.user_id = m.sender_user_id AND r.key <> 'parent'
		                            ORDER BY r.name LIMIT 1), 'school') END,
		       to_char(m.read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       CASE WHEN m.deleted_at IS NULL THEN m.attachments ELSE NULL END,
		       to_char(m.sent_at,'YYYY-MM-DD"T"HH24:MI:SS.US'),
		       m.reply_to_id::text,
		       (SELECT left(q.body, 120) FROM parent_teacher_messages q WHERE q.id = m.reply_to_id),
		       (SELECT qu.full_name FROM parent_teacher_messages q
		          JOIN users qu ON qu.id = q.sender_user_id WHERE q.id = m.reply_to_id),
		       m.edited_at IS NOT NULL, m.deleted_at IS NOT NULL
		  FROM parent_teacher_messages m
		  JOIN users u ON u.id = m.sender_user_id
		 WHERE m.student_id = $1 AND m.parent_user_id = $2
		   AND m.teacher_user_id = $3
		   AND ($5 = '' OR m.sent_at < $5::timestamptz)
		 ORDER BY m.sent_at DESC
		 LIMIT 41`, []any{sid, parentID, teacher, id.UserID,
		strings.TrimSpace(r.URL.Query().Get("before"))},
		func(rows pgx.Rows) (portalMessageRow, error) {
			var v portalMessageRow
			var raw []byte
			err := rows.Scan(&v.ID, &v.Body, &v.SentAt, &v.Sender, &v.Mine,
				&v.SenderSide, &v.ReadAt, &raw, &v.Cursor,
				&v.ReplyToID, &v.ReplyBody, &v.ReplySender, &v.Edited, &v.Deleted)
			v.Attachments = scanAttachments(raw)
			return v, err
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Marking read moved to its own call (chat_ops.go): a tick set the moment
	   the thread was fetched said "seen" while the recipient was still walking
	   to the staff room. The screen now says so when the bubble is on screen. */
	more := len(items) > 40
	if more {
		items = items[:40]
	}
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
}
