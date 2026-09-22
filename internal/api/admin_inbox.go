package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
All messages: every conversation in the school, on the principal's desk.

	A parent writes to a class teacher, another raises a concern, a teacher
	writes to the office, a circular goes out asking for acknowledgement — four
	tables, four screens, and no way for the person who answers for the school
	to see which of them is going unanswered. This is that view: one list
	across the channels, newest first, with a count of what is still waiting
	for the school's reply.

	"Waiting" is defined per channel, because the channels differ:
	  parent_teacher  the last message in the thread is the parent's
	  concern         open and no update has yet been shown to the family
	  staff           the last message has not been read by the other side
	  circular        asked for acknowledgement and somebody has not yet acked
	  counsellor      counted, never read — a counselling thread is confidential
	                  by design, so this reports that N threads exist and no more

	Contents are the tenant's; RLS bounds every query. The screen is gated on
	comms.messages.read.all, which only the principal's roles carry.
*/

type inboxItem struct {
	Channel string `json:"channel"`
	// Key identifies the thread inside its channel: a ticket id, an
	// announcement id, or "student|parent|teacher" for a parent thread.
	Key      string  `json:"key"`
	Title    string  `json:"title"`
	From     string  `json:"from"`
	About    *string `json:"about"`
	Handler  *string `json:"handler"`
	LastBody string  `json:"last_body"`
	LastAt   string  `json:"last_at"`
	Pending  bool    `json:"pending"`
	Status   *string `json:"status"`
	// Parent-thread coordinates, so the reply endpoint can address it.
	StudentID     *string `json:"student_id,omitempty"`
	ParentUserID  *string `json:"parent_user_id,omitempty"`
	TeacherUserID *string `json:"teacher_user_id,omitempty"`
	// Ack progress for a circular that asked for one.
	Acked *int `json:"acked,omitempty"`
	Asked *int `json:"asked,omitempty"`
}

type inboxCounts struct {
	ParentTeacher int `json:"parent_teacher"`
	Concerns      int `json:"concerns"`
	Staff         int `json:"staff"`
	Circulars     int `json:"circulars"`
	Counsellor    int `json:"counsellor"`
	Total         int `json:"total"`
}

func (s *Server) adminInbox(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	channel := q.Get("channel")
	status := q.Get("status") // pending | answered | all
	if status == "" {
		status = "all"
	}
	search := "%" + strings.ToLower(strings.TrimSpace(q.Get("q"))) + "%"

	items := []inboxItem{}
	var counts inboxCounts
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ctx := r.Context()

		// --- parent ↔ teacher: one row per thread, the latest message on it.
		if channel == "" || channel == "parent_teacher" {
			rows, err := tx.Query(ctx, `
				WITH last AS (
				  SELECT DISTINCT ON (m.student_id, m.parent_user_id, m.teacher_user_id)
				         m.student_id, m.parent_user_id, m.teacher_user_id,
				         m.sender_user_id, m.body, m.sent_at
				    FROM parent_teacher_messages m
				   ORDER BY m.student_id, m.parent_user_id, m.teacher_user_id, m.sent_at DESC
				)
				SELECT l.student_id::text, l.parent_user_id::text, l.teacher_user_id::text,
				       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
				       COALESCE(pu.full_name, ''), COALESCE(tu.full_name, ''),
				       COALESCE(su.full_name, ''), l.body, l.sent_at,
				       l.sender_user_id = l.parent_user_id
				  FROM last l
				  JOIN students st ON st.id = l.student_id
				  LEFT JOIN users pu ON pu.id = l.parent_user_id
				  LEFT JOIN users tu ON tu.id = l.teacher_user_id
				  LEFT JOIN users su ON su.id = l.sender_user_id
				 WHERE ($1 = '%%' OR lower(concat_ws(' ', st.first_name, st.last_name, pu.full_name, tu.full_name, l.body)) LIKE $1)
				 ORDER BY l.sent_at DESC
				 LIMIT 300`, search)
			if err != nil {
				return err
			}
			for rows.Next() {
				var it inboxItem
				var sid, pid, tid, child, parent, teacher, sender string
				var at time.Time
				if err := rows.Scan(&sid, &pid, &tid, &child, &parent, &teacher, &sender,
					&it.LastBody, &at, &it.Pending); err != nil {
					rows.Close()
					return err
				}
				it.Channel = "parent_teacher"
				it.Key = sid + "|" + pid + "|" + tid
				it.Title = parent + " → " + teacher
				it.From = sender
				it.About = &child
				it.Handler = &teacher
				it.LastAt = at.Format(time.RFC3339)
				it.StudentID, it.ParentUserID, it.TeacherUserID = &sid, &pid, &tid
				if it.Pending {
					counts.ParentTeacher++
				}
				items = append(items, it)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		// --- concerns: the ticket, and whether the family has heard back.
		if channel == "" || channel == "concern" {
			rows, err := tx.Query(ctx, `
				SELECT t.id::text, t.subject, t.status, t.category,
				       COALESCE(ru.full_name, ''),
				       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
				       au.full_name,
				       COALESCE((SELECT g.body FROM grievance_updates g
				                  WHERE g.ticket_id = t.id ORDER BY g.created_at DESC LIMIT 1), t.body),
				       COALESCE((SELECT max(g.created_at) FROM grievance_updates g WHERE g.ticket_id = t.id), t.created_at),
				       t.status NOT IN ('resolved','closed')
				         AND NOT EXISTS (SELECT 1 FROM grievance_updates g
				                          WHERE g.ticket_id = t.id AND g.visible_to_parent)
				  FROM support_tickets t
				  LEFT JOIN users ru ON ru.id = t.raised_by
				  LEFT JOIN students st ON st.id = t.student_id
				  LEFT JOIN users au ON au.id = t.assigned_to
				 WHERE ($1 = '%%' OR lower(concat_ws(' ', t.subject, t.body, ru.full_name, st.first_name, st.last_name)) LIKE $1)
				 ORDER BY t.updated_at DESC
				 LIMIT 300`, search)
			if err != nil {
				return err
			}
			for rows.Next() {
				var it inboxItem
				var tid, subject, st, category, from, child string
				var handler *string
				var at time.Time
				if err := rows.Scan(&tid, &subject, &st, &category, &from, &child, &handler,
					&it.LastBody, &at, &it.Pending); err != nil {
					rows.Close()
					return err
				}
				it.Channel = "concern"
				it.Key = tid
				it.Title = subject
				if it.Title == "" {
					it.Title = category
				}
				it.From = from
				if child != "" {
					it.About = &child
				}
				it.Handler = handler
				it.Status = &st
				it.LastAt = at.Format(time.RFC3339)
				if it.Pending {
					counts.Concerns++
				}
				items = append(items, it)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		// --- staff ↔ staff: one row per pair, the latest message.
		if channel == "" || channel == "staff" {
			rows, err := tx.Query(ctx, `
				WITH last AS (
				  SELECT DISTINCT ON (m.party_a, m.party_b)
				         m.party_a, m.party_b, m.sender_user_id, m.body, m.sent_at, m.read_at
				    FROM staff_messages m
				   ORDER BY m.party_a, m.party_b, m.sent_at DESC
				)
				SELECT l.party_a::text, l.party_b::text,
				       COALESCE(ua.full_name, ''), COALESCE(ub.full_name, ''),
				       COALESCE(su.full_name, ''), l.body, l.sent_at, l.read_at IS NULL
				  FROM last l
				  LEFT JOIN users ua ON ua.id = l.party_a
				  LEFT JOIN users ub ON ub.id = l.party_b
				  LEFT JOIN users su ON su.id = l.sender_user_id
				 WHERE ($1 = '%%' OR lower(concat_ws(' ', ua.full_name, ub.full_name, l.body)) LIKE $1)
				 ORDER BY l.sent_at DESC
				 LIMIT 300`, search)
			if err != nil {
				return err
			}
			for rows.Next() {
				var it inboxItem
				var a, b, na, nb, sender string
				var at time.Time
				if err := rows.Scan(&a, &b, &na, &nb, &sender, &it.LastBody, &at, &it.Pending); err != nil {
					rows.Close()
					return err
				}
				it.Channel = "staff"
				it.Key = a + "|" + b
				it.Title = na + " ↔ " + nb
				it.From = sender
				it.LastAt = at.Format(time.RFC3339)
				if it.Pending {
					counts.Staff++
				}
				items = append(items, it)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		// --- circulars: one-way, but one that asked for an acknowledgement is
		// waiting until everybody it went to has answered.
		if channel == "" || channel == "circular" {
			rows, err := tx.Query(ctx, `
				SELECT a.id::text, a.title, a.kind, COALESCE(a.audience_role, ''),
				       COALESCE(cu.full_name, ''), left(a.body, 200),
				       COALESCE(a.publish_at, a.created_at), a.requires_ack,
				       (SELECT count(*)::int FROM announcement_acks k WHERE k.announcement_id = a.id AND k.acked_at IS NOT NULL),
				       (SELECT count(*)::int FROM announcement_acks k WHERE k.announcement_id = a.id)
				  FROM announcements a
				  LEFT JOIN users cu ON cu.id = a.created_by
				 WHERE ($1 = '%%' OR lower(concat_ws(' ', a.title, a.body, cu.full_name)) LIKE $1)
				 ORDER BY COALESCE(a.publish_at, a.created_at) DESC
				 LIMIT 200`, search)
			if err != nil {
				return err
			}
			for rows.Next() {
				var it inboxItem
				var aid, title, kind, audience, from string
				var at time.Time
				var requiresAck bool
				var acked, asked int
				if err := rows.Scan(&aid, &title, &kind, &audience, &from, &it.LastBody, &at,
					&requiresAck, &acked, &asked); err != nil {
					rows.Close()
					return err
				}
				it.Channel = "circular"
				it.Key = aid
				it.Title = title
				it.From = from
				about := strings.TrimSpace(kind + " " + audience)
				if about != "" {
					it.About = &about
				}
				it.LastAt = at.Format(time.RFC3339)
				if requiresAck {
					it.Acked, it.Asked = &acked, &asked
					it.Pending = asked > acked
				}
				if it.Pending {
					counts.Circulars++
				}
				items = append(items, it)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		// --- counsellor: a number only. Never the contents.
		if err := tx.QueryRow(ctx, `
			SELECT count(*)::int FROM counselor_threads t
			 WHERE t.status <> 'closed'`).Scan(&counts.Counsellor); err != nil {
			// The table may be empty or absent of a status column on an old
			// tenant; a zero here must not cost the rest of the desk.
			counts.Counsellor = 0
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Status filter after the fact: the per-channel "pending" is computed in
	// SQL, but filtering there would mean four copies of the predicate.
	if status != "all" {
		want := status == "pending"
		kept := items[:0]
		for _, it := range items {
			if it.Pending == want {
				kept = append(kept, it)
			}
		}
		items = kept
	}
	// Newest first across channels.
	sortByLastAtDesc(items)
	counts.Total = counts.ParentTeacher + counts.Concerns + counts.Staff + counts.Circulars

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":  items,
		"counts": counts,
	})
}

func sortByLastAtDesc(items []inboxItem) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].LastAt > items[j-1].LastAt; j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

// adminInboxCount is the badge: how many conversations wait on the school.
func (s *Server) adminInboxCount(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var n int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  (SELECT count(*) FROM (
			     SELECT DISTINCT ON (m.student_id, m.parent_user_id, m.teacher_user_id)
			            m.sender_user_id = m.parent_user_id AS pending
			       FROM parent_teacher_messages m
			      ORDER BY m.student_id, m.parent_user_id, m.teacher_user_id, m.sent_at DESC) x WHERE x.pending)
			+ (SELECT count(*) FROM support_tickets t
			    WHERE t.status NOT IN ('resolved','closed')
			      AND NOT EXISTS (SELECT 1 FROM grievance_updates g WHERE g.ticket_id = t.id AND g.visible_to_parent))
			+ (SELECT count(*) FROM (
			     SELECT DISTINCT ON (m.party_a, m.party_b) m.read_at IS NULL AS pending
			       FROM staff_messages m ORDER BY m.party_a, m.party_b, m.sent_at DESC) y WHERE y.pending)
			+ (SELECT count(*) FROM announcements a
			    WHERE a.requires_ack
			      AND (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id AND k.acked_at IS NOT NULL)
			        < (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id))`).Scan(&n)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"pending": n})
}

// adminInboxThread is one parent thread, in full, for the desk to read
// before replying.
func (s *Server) adminInboxThread(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	sid, err1 := uuid.Parse(q.Get("student_id"))
	pid, err2 := uuid.Parse(q.Get("parent_user_id"))
	tid, err3 := uuid.Parse(q.Get("teacher_user_id"))
	if err1 != nil || err2 != nil || err3 != nil {
		httpx.BadRequest(w, r, "student_id, parent_user_id and teacher_user_id must be uuids")
		return
	}
	type msg struct {
		ID     string `json:"id"`
		Sender string `json:"sender"`
		Mine   bool   `json:"from_school"`
		Body   string `json:"body"`
		SentAt string `json:"sent_at"`
	}
	out := []msg{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT m.id::text, COALESCE(u.full_name, ''), m.sender_user_id <> m.parent_user_id,
			       m.body, m.sent_at
			  FROM parent_teacher_messages m
			  LEFT JOIN users u ON u.id = m.sender_user_id
			 WHERE m.student_id = $1 AND m.parent_user_id = $2 AND m.teacher_user_id = $3
			 ORDER BY m.sent_at`, sid, pid, tid)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m msg
			var at time.Time
			if err := rows.Scan(&m.ID, &m.Sender, &m.Mine, &m.Body, &at); err != nil {
				return err
			}
			m.SentAt = at.Format(time.RFC3339)
			out = append(out, m)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

type adminInboxReply struct {
	StudentID     string `json:"student_id"`
	ParentUserID  string `json:"parent_user_id"`
	TeacherUserID string `json:"teacher_user_id"`
	Body          string `json:"body"`
}

// adminInboxReplyParent lets the desk answer a parent in the teacher's
// thread. The row keeps the teacher as the thread's teacher and names the
// admin as sender, so the parent sees who wrote and the teacher sees the
// reply in their own inbox rather than finding the thread silently closed.
func (s *Server) adminInboxReplyParent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req adminInboxReply
	if !httpx.Decode(w, r, &req) {
		return
	}
	sid, err1 := uuid.Parse(req.StudentID)
	pid, err2 := uuid.Parse(req.ParentUserID)
	tid, err3 := uuid.Parse(req.TeacherUserID)
	if err1 != nil || err2 != nil || err3 != nil {
		httpx.BadRequest(w, r, "student_id, parent_user_id and teacher_user_id must be uuids")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		httpx.BadRequest(w, r, "a reply needs some words")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM parent_teacher_messages
			                WHERE student_id = $1 AND parent_user_id = $2 AND teacher_user_id = $3)`,
			sid, pid, tid).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO parent_teacher_messages
			    (institution_id, student_id, parent_user_id, teacher_user_id, sender_user_id, body)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			id.InstitutionID, sid, pid, tid, id.UserID, body)
		return err
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
