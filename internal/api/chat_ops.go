package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/live"
)

/*
Correcting what was said: edit, and unsend.

	A teacher who sent a message to the wrong parent could not take it back,
	and a fee figure typed with a digit missing stood as written. Both are
	ordinary and both were dead ends.

	Two rules make this safe in a school record rather than merely convenient:

	ONLY THE AUTHOR. Nobody may touch anybody else's words, on either side of
	any conversation.

	REWRITING IS FOR A WHILE; WITHDRAWING IS NOT. An edit has a window --
	editWindow -- because a message quietly rewritten a week later is a record
	that cannot be trusted: a parent told a thing on Tuesday must not find on
	Friday that it says something else. Withdrawing carries no such risk and no
	window, because it hides nothing: the row stays, its place in the thread
	stays, and what is left says a message was withdrawn. The author of a
	message sent to the wrong family last month can still take it back, which
	is the whole point of the control.

	AND NOTHING VANISHES. An unsent message keeps its row and its place in the
	thread, with its body cleared and deleted_at set, so the conversation still
	reads "she wrote, I answered" and the gap says a message was withdrawn.
	Purging the row would leave a reply answering nothing, and would let a line
	be removed from the school's record without trace.
*/

// editWindow is how long after sending the author may still change or withdraw
// a message. Long enough for the mistake you notice while reading it back,
// short enough that it is not a way to rewrite last term.
const editWindow = 15 * time.Minute

// Raised inside the write transaction so the handler can answer 403 or 400
// rather than 500.
var (
	errChatNotYours = errors.New("not the author")
	errChatTooOld   = errors.New("past the edit window")
)

type chatEditRequest struct {
	Body string `json:"body"`
}

// editChatMessage rewrites the body of the caller's own recent message.
func (s *Server) editChatMessage(w http.ResponseWriter, r *http.Request) {
	s.amendMessage(w, r, false)
}

// unsendChatMessage withdraws the caller's own recent message, leaving the row
// and its place in the thread behind.
func (s *Server) unsendChatMessage(w http.ResponseWriter, r *http.Request) {
	s.amendMessage(w, r, true)
}

func (s *Server) amendMessage(w http.ResponseWriter, r *http.Request, unsend bool) {
	id := httpx.IdentityFrom(r.Context())
	mid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "message id must be a uuid")
		return
	}
	// Which conversation the message is in. The two tables hold the same three
	// columns for this purpose, and the caller says which they mean rather than
	// this guessing by trying one and then the other.
	table := "staff_messages"
	if r.URL.Query().Get("channel") == "parent" {
		table = "parent_teacher_messages"
	}

	var body string
	if !unsend {
		var req chatEditRequest
		if !httpx.Decode(w, r, &req) {
			return
		}
		body = strings.TrimSpace(req.Body)
		if body == "" {
			httpx.BadRequest(w, r, "an edited message still needs some words; use unsend to withdraw it")
			return
		}
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var sender uuid.UUID
		var sentAt time.Time
		var gone *time.Time
		if err := tx.QueryRow(r.Context(),
			`SELECT sender_user_id, sent_at, deleted_at FROM `+table+` WHERE id = $1`,
			mid).Scan(&sender, &sentAt, &gone); err != nil {
			return err
		}
		if sender != id.UserID {
			return errChatNotYours
		}
		if gone != nil {
			// Already withdrawn: saying so is better than a second success that
			// changed nothing.
			return errChatTooOld
		}
		// The window is the edit's; withdrawing has none. See the note above.
		if !unsend && time.Since(sentAt) > editWindow {
			return errChatTooOld
		}
		if unsend {
			/* ONLY deleted_at.

			   This blanked the body and the attachments too, and both tables
			   carry a check constraint saying a message must have one or the
			   other -- so every withdrawal violated it and came back as
			   "something went wrong". The row keeps what it said; deleted_at
			   is the tombstone, and every read already returns an empty body
			   and no attachments once it is set. That is the better record in
			   any case: a message withdrawn in front of a parent is still a
			   thing the school said, and a school's record should be able to
			   show that it was said and then taken back. */
			_, err := tx.Exec(r.Context(),
				`UPDATE `+table+` SET deleted_at = now() WHERE id = $1`, mid)
			return err
		}
		_, err := tx.Exec(r.Context(),
			`UPDATE `+table+` SET body = $2, edited_at = now() WHERE id = $1`, mid, body)
		return err
	})
	switch {
	case err == pgx.ErrNoRows:
		httpx.NotFound(w, r)
	case err == errChatNotYours:
		httpx.Forbidden(w, r, "the author of this message")
	case err == errChatTooOld:
		httpx.BadRequest(w, r, "a message can be edited for fifteen minutes after it is sent; after that it can only be withdrawn")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// markParentThreadRead sets the tick on the other side's messages, when they
// have actually been on screen rather than merely when the thread was opened.
func (s *Server) markParentThreadRead(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	sid, err1 := uuid.Parse(q.Get("student_id"))
	pid, err2 := uuid.Parse(q.Get("parent_user_id"))
	tid, err3 := uuid.Parse(q.Get("teacher_user_id"))
	if err1 != nil || err2 != nil || err3 != nil {
		httpx.BadRequest(w, r, "student_id, parent_user_id and teacher_user_id must be uuids")
		return
	}
	/* A party marks the other side's messages. The head or the principal,
	   reading a teacher's thread under the read-all grant, marks the
	   PARENT'S messages: the school has now seen what the family wrote, and
	   an unread count that survives the principal reading it is a count
	   that stops meaning anything. The teacher's own words are never marked
	   by a third reader -- the parent's tick must mean the parent read them. */
	party := id.UserID == pid || id.UserID == tid
	if !party && !id.Can(rbac.MessagesReadAll) {
		httpx.Forbidden(w, r, "a party to this conversation")
		return
	}
	notFrom := id.UserID
	if !party {
		notFrom = tid
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, uerr := tx.Exec(r.Context(), `
			UPDATE parent_teacher_messages SET read_at = now()
			 WHERE student_id = $1 AND parent_user_id = $2 AND teacher_user_id = $3
			   AND sender_user_id <> $4 AND read_at IS NULL`, sid, pid, tid, notFrom)
		if uerr != nil || tag.RowsAffected() == 0 {
			return uerr
		}
		/* Tell the sender, now. Without this the second tick waited for their
		   next poll -- half a minute of a message that has plainly been read
		   still showing as merely delivered. Nothing marked, nothing said. */
		other := pid
		if id.UserID == pid {
			other = tid
		}
		s.publishLive(r.Context(), tx, live.Event{
			Institution: id.InstitutionID, Users: []uuid.UUID{other}, Type: "read",
			Scope: "parent", From: id.UserID,
			Keys: map[string]string{
				"student": sid.String(), "parent": pid.String(), "teacher": tid.String(),
			},
		})
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
