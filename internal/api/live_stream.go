package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
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
	r.Post("/live/seen", s.liveSeen)
}

/*
liveSeen is POST /live/seen: "this conversation is on my screen". The bell

	entries that pointed at it are marked read, so a person who has just read
	the messages is not also told about them — the rule every phone follows.
	The conversation is identified the same way the typing signal names it,
	and matched against the link each notification was written with.
*/
func (s *Server) liveSeen(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req typingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	var kind, like string
	switch strings.ToLower(strings.TrimSpace(req.Scope)) {
	case "staff":
		if _, err := uuid.Parse(req.Peer); err != nil {
			httpx.BadRequest(w, r, "peer must be a uuid")
			return
		}
		kind, like = "staff_message", "%with="+req.Peer+"%"
	case "parent":
		sid, e1 := uuid.Parse(req.Student)
		pid, e2 := uuid.Parse(req.Parent)
		tid, e3 := uuid.Parse(req.Teacher)
		if e1 != nil || e2 != nil || e3 != nil {
			httpx.BadRequest(w, r, "student, parent and teacher must be uuids")
			return
		}
		kind = "parent_message"
		if id.UserID == pid {
			like = "%student_id=" + sid.String() + "&teacher_user_id=" + tid.String() + "%"
		} else {
			like = "%child=" + sid.String() + "&with=" + pid.String() + "%"
		}
	case "counselor":
		if _, err := uuid.Parse(req.Thread); err != nil {
			httpx.BadRequest(w, r, "thread must be a uuid")
			return
		}
		kind, like = "counselor_message", "%thread="+req.Thread+"%"
	default:
		httpx.BadRequest(w, r, "scope must be staff, parent or counselor")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			UPDATE notifications SET read_at = now()
			 WHERE user_id = $1 AND read_at IS NULL AND kind = $2 AND link LIKE $3`,
			id.UserID, kind, like)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
	/* THE 40-SECOND CUT. The server carries a 30s read and write deadline for
	   every request, sized for small JSON. On a stream the read deadline fires
	   in the background reader and Go cancels the request context — logged as
	   "client or proxy closed" at 40s on every stream, with nothing sent. A
	   stream is the one request those deadlines must not touch. */
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	events, unsubscribe := s.Live.Subscribe(id.UserID)
	defer unsubscribe()

	// Something on the wire immediately, so the browser fires `open` and the
	// proxies commit to streaming rather than buffering an empty response.
	fmt.Fprint(w, ": hello\n\n")
	if err := rc.Flush(); err != nil {
		return
	}

	/* Why and when each stream ends is logged, because the failure mode of a
	   stream is silence: every browser reconnecting on a fixed cycle looks,
	   from the page, exactly like nothing ever being sent. */
	started := time.Now()
	sent := 0
	end := func(why string) {
		slog.Info("live: stream ended", "why", why, "after", time.Since(started).Round(time.Second),
			"events", sent, "user", id.UserID)
	}
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			end("client or proxy closed")
			return
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				end("ping write: " + err.Error())
				return
			}
			if err := rc.Flush(); err != nil {
				end("ping flush: " + err.Error())
				return
			}
		case ev, ok := <-events:
			if !ok {
				end("subscription closed")
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
				end("event write: " + err.Error())
				return
			}
			if err := rc.Flush(); err != nil {
				end("event flush: " + err.Error())
				return
			}
			sent++
			slog.Info("live: event sent", "type", ev.Type, "scope", ev.Scope, "to", id.UserID)
		}
	}
}

/*
LiveProbe is a public, unauthenticated stream that ticks once a second for

	twelve seconds and ends. It exists to answer one question from a terminal:
	do bytes reach a client incrementally through the proxies in front of this
	service, or are they buffered and delivered at the end? `curl -N` against
	the Pages origin and against the Cloud Run origin, with timestamps, tells
	which hop buffers. It carries no data and takes no input.
*/
func (s *Server) LiveProbe(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	// ?seconds=90 (capped at 120) proves the stream outlives the 30s server
	// deadlines and whatever sits in front; the default stays short.
	ticks := 12
	if n, err := strconv.Atoi(r.URL.Query().Get("seconds")); err == nil && n > 0 && n <= 120 {
		ticks = n
	}
	for i := 1; i <= ticks; i++ {
		if _, err := fmt.Fprintf(w, "data: tick %d %s\n\n", i, time.Now().UTC().Format("15:04:05.000")); err != nil {
			return
		}
		if err := rc.Flush(); err != nil {
			fmt.Fprintf(w, "data: flush-error %v\n\n", err)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
	}
	fmt.Fprint(w, "data: done\n\n")
	_ = rc.Flush()
}

/*
publishLive puts a hint on the bus from inside the writer's transaction.

	Never fails the write it sits beside: a message that saved but whose hint
	did not go out is still a message, and the poll picks it up.
*/
func (s *Server) publishLive(ctx context.Context, tx pgx.Tx, ev live.Event) {
	if s.Live == nil || len(ev.Users) == 0 {
		return
	}
	_ = live.Publish(ctx, tx, ev)
}

type typingRequest struct {
	Scope   string `json:"scope"`             // staff | parent | counselor
	Peer    string `json:"peer,omitempty"`    // staff: the colleague's user id
	Student string `json:"student,omitempty"` // parent: the child
	Parent  string `json:"parent,omitempty"`  // parent: the parent's user id
	Teacher string `json:"teacher,omitempty"` // parent: the teacher's user id
	Thread  string `json:"thread,omitempty"`  // counselor: the thread id
}

/*
liveTyping is POST /live/typing: "I am typing to you". No row is written;

	the request is validated against the conversation it claims — you may only
	signal a conversation you are actually a party to — and then a typing
	event is put on the bus for the other party. The client throttles to one
	post every few seconds while the composer has focus; the event expires on
	the receiving side, so a closed tab never leaves "typing…" on the screen.
*/
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
