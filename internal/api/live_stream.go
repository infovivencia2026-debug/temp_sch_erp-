package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/live"
)

/* LIVE, FOR THE TWO PEOPLE IN A CONVERSATION.

   A message between a teacher and a parent arrived on the other phone up to
   thirty seconds later, when the revision poll happened to notice the
   notification it had left behind — and the sender's own screen did not move
   at all. Two people typing at each other need the other's words as they
   land, a sign that the other is typing, and the bell to ring at once.

   One stream per signed-in tab. GET /live/stream holds a Server-Sent Events
   response open and writes an event whenever the bus (internal/live, Postgres
   LISTEN/NOTIFY) names this user. The event is a hint — thread, peer, child —
   and the client refetches through the ordinary API, so authority and RLS
   stay exactly where they are; the stream carries no message bodies.

   EventSource sends the session cookie and nothing else, which is all the
   auth middleware needs. It cannot send X-Acting-Institution, so a platform
   operator standing inside a school gets no live stream — they are not the
   messaging audience. Cloud Run cuts a request at its timeout and the
   browser reconnects by itself; a comment line every twenty seconds keeps
   the proxies from idling the connection out earlier than that. The 30s
   revision poll stays as the fallback and keeps the session's idle clock
   moving, since a stream is one request however long it lives. */

func (s *Server) mountLive(r chi.Router) {
	r.Get("/live/stream", s.liveStream)
	r.Post("/live/typing", s.liveTyping)
}

func (s *Server) liveStream(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if s.Live == nil {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{"error": "live updates are not enabled"})
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)

	events, unsubscribe := s.Live.Subscribe(id.UserID)
	defer unsubscribe()

	// Something on the wire immediately, so the browser fires `open` and the
	// proxies commit to streaming rather than buffering an empty response.
	fmt.Fprint(w, ": hello\n\n")
	if err := rc.Flush(); err != nil {
		return
	}

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		case ev, ok := <-events:
			if !ok {
				return
			}
			body, err := json.Marshal(map[string]any{
				"type": ev.Type, "scope": ev.Scope, "from": ev.From.String(),
				"keys": ev.Keys, "at": ev.At.Format(time.RFC3339),
			})
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n",
				ev.At.UnixMilli(), ev.Type, body); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		}
	}
}

/* publishLive puts a hint on the bus from inside the writer's transaction.
   Never fails the write it sits beside: a message that saved but whose hint
   did not go out is still a message, and the poll picks it up. */
func (s *Server) publishLive(ctx context.Context, tx pgx.Tx, ev live.Event) {
	if s.Live == nil || len(ev.Users) == 0 {
		return
	}
	_ = live.Publish(ctx, tx, ev)
}

type typingRequest struct {
	Scope   string `json:"scope"` // staff | parent | counselor
	Peer    string `json:"peer,omitempty"`    // staff: the colleague's user id
	Student string `json:"student,omitempty"` // parent: the child
	Parent  string `json:"parent,omitempty"`  // parent: the parent's user id
	Teacher string `json:"teacher,omitempty"` // parent: the teacher's user id
	Thread  string `json:"thread,omitempty"`  // counselor: the thread id
}

/* liveTyping is POST /live/typing: "I am typing to you". No row is written;
   the request is validated against the conversation it claims — you may only
   signal a conversation you are actually a party to — and then a typing
   event is put on the bus for the other party. The client throttles to one
   post every few seconds while the composer has focus; the event expires on
   the receiving side, so a closed tab never leaves "typing…" on the screen. */
func (s *Server) liveTyping(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if s.Live == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var req typingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	scope := strings.ToLower(strings.TrimSpace(req.Scope))

	var recipients []uuid.UUID
	keys := map[string]string{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		switch scope {
		case "staff":
			peer, err := uuid.Parse(req.Peer)
			if err != nil {
				return errBadTyping
			}
			var one int
			if err := tx.QueryRow(r.Context(),
				`SELECT 1 FROM users WHERE id = $1`, peer).Scan(&one); err != nil {
				return errBadTyping
			}
			recipients = []uuid.UUID{peer}
			keys["peer"] = id.UserID.String()
		case "parent":
			sid, e1 := uuid.Parse(req.Student)
			pid, e2 := uuid.Parse(req.Parent)
			tid, e3 := uuid.Parse(req.Teacher)
			if e1 != nil || e2 != nil || e3 != nil || (id.UserID != pid && id.UserID != tid) {
				return errBadTyping
			}
			// The pair must be a real conversation this person is in.
			var one int
			if err := tx.QueryRow(r.Context(), `
				SELECT 1 FROM parent_teacher_messages
				 WHERE student_id = $1 AND parent_user_id = $2 AND teacher_user_id = $3
				 LIMIT 1`, sid, pid, tid).Scan(&one); err != nil {
				return errBadTyping
			}
			to := pid
			if id.UserID == pid {
				to = tid
			}
			recipients = []uuid.UUID{to}
			keys["student"] = sid.String()
			keys["parent"] = pid.String()
			keys["teacher"] = tid.String()
		case "counselor":
			thread, err := uuid.Parse(req.Thread)
			if err != nil {
				return errBadTyping
			}
			rows, err := tx.Query(r.Context(), `
				SELECT user_id FROM counselor_thread_participants
				 WHERE thread_id = $1 AND removed_at IS NULL`, thread)
			if err != nil {
				return err
			}
			defer rows.Close()
			party := false
			for rows.Next() {
				var u uuid.UUID
				if err := rows.Scan(&u); err != nil {
					return err
				}
				if u == id.UserID {
					party = true
				} else {
					recipients = append(recipients, u)
				}
			}
			if !party {
				return errBadTyping
			}
			keys["thread"] = thread.String()
		default:
			return errBadTyping
		}
		s.publishLive(r.Context(), tx, live.Event{
			Institution: id.InstitutionID, Users: recipients, Type: "typing",
			Scope: scope, From: id.UserID, Keys: keys,
		})
		return nil
	})
	if err == errBadTyping {
		httpx.BadRequest(w, r, "that is not a conversation you are part of")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var errBadTyping = fmt.Errorf("typing: not a party")
