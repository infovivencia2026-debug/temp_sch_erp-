package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
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
}

// listTeacherParentThreads is the teacher's inbox of family conversations.
func (s *Server) listTeacherParentThreads(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items, err := collect(s, r, `
		SELECT DISTINCT ON (m.student_id, m.parent_user_id)
		       m.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name),
		       COALESCE(c.name, '') || COALESCE('-' || sec.name, ''),
		       m.parent_user_id::text, pu.full_name,
		       m.body, to_char(m.sent_at,'YYYY-MM-DD"T"HH24:MI'),
		       (SELECT count(*)::int FROM parent_teacher_messages un
		         WHERE un.student_id = m.student_id
		           AND un.parent_user_id = m.parent_user_id
		           AND un.teacher_user_id = m.teacher_user_id
		           AND un.sender_user_id <> $1 AND un.read_at IS NULL)
		  FROM parent_teacher_messages m
		  JOIN users pu ON pu.id = m.parent_user_id
		  JOIN students st ON st.id = m.student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE m.teacher_user_id = $1
		 ORDER BY m.student_id, m.parent_user_id, m.sent_at DESC
		 LIMIT 200`, []any{id.UserID},
		func(rows pgx.Rows) (teacherThreadRow, error) {
			var v teacherThreadRow
			return v, rows.Scan(&v.StudentID, &v.StudentName, &v.ClassName,
				&v.ParentID, &v.ParentName, &v.LastMessage, &v.LastAt, &v.Unread)
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

	/* Only a thread this teacher is an end of.

	   Not "may this teacher write to this family" — that is a different and
	   stricter question, asked by teacherMayWrite when they reply. A teacher
	   who has since stopped taking the class must still be able to read what
	   was said to them, or a handover loses the conversation. */
	items, err := collect(s, r, `
		SELECT m.id::text, m.body,
		       to_char(m.sent_at,'YYYY-MM-DD"T"HH24:MI'), u.full_name,
		       m.sender_user_id = $3,
		       to_char(m.read_at,'YYYY-MM-DD"T"HH24:MI')
		  FROM parent_teacher_messages m
		  JOIN users u ON u.id = m.sender_user_id
		 WHERE m.student_id = $1 AND m.parent_user_id = $2
		   AND m.teacher_user_id = $3
		 ORDER BY m.sent_at
		 LIMIT 500`, []any{sid, parentID, id.UserID},
		func(rows pgx.Rows) (portalMessageRow, error) {
			var v portalMessageRow
			return v, rows.Scan(&v.ID, &v.Body, &v.SentAt, &v.Sender, &v.Mine, &v.ReadAt)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, uerr := tx.Exec(r.Context(), `
			UPDATE parent_teacher_messages
			   SET read_at = now()
			 WHERE student_id = $1 AND parent_user_id = $2 AND teacher_user_id = $3
			   AND sender_user_id <> $3 AND read_at IS NULL`, sid, parentID, id.UserID)
		return uerr
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
