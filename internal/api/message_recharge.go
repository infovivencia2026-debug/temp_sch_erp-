package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* ASKING FOR MORE MESSAGES.

   Credits are added by hand — no money moves through this product, and the
   payment happens somewhere this system does not watch. What was missing was
   the other half: the school had no way to ASK. A head teacher whose reminders
   had stopped saw a balance of zero and a top-up form they cannot use, and the
   next step was a phone call nobody recorded.

   So a request is a row. The school gets a button that does something, the
   seller gets a queue rather than the memory of a conversation, and the
   audit trail joins "they asked for ten thousand" to "we granted eight".

   NOT A PAYMENT, and there is no price anywhere in here. The unit is messages,
   because that is the only quantity both sides can check against the same
   evidence. What it cost and whether it was paid belong to whatever the seller
   invoices with. */

// The sizes offered on the screen. Round numbers of MESSAGES and nothing else:
// no rupees, no vendor names, no "transactional" — a school counts what it
// sends, not what a gateway calls it.
var rechargeSizes = []int{1000, 5000, 10000, 25000, 50000}

type rechargeView struct {
	ID          uuid.UUID  `json:"id"`
	Channel     string     `json:"channel"`
	Messages    int        `json:"messages"`
	Status      string     `json:"status"`
	Note        *string    `json:"note,omitempty"`
	Response    *string    `json:"response,omitempty"`
	RequestedBy *string    `json:"requested_by,omitempty"`
	RequestedAt time.Time  `json:"requested_at"`
	Granted     *int       `json:"granted,omitempty"`
	DecidedAt   *time.Time `json:"decided_at,omitempty"`
	// Only on the seller's list: the school's name, since a queue of requests
	// from "an institution id" is not a queue anybody can work.
	School string `json:"school,omitempty"`
}

func (s *Server) mountRecharge(r chi.Router) {
	read := httpx.RequirePermission(rbac.InstitutionRead)
	ask := httpx.RequirePermission(rbac.IntegrationsWrite)

	r.With(read).Get("/messaging/recharges", s.listRecharges)
	r.With(read).Get("/messaging/recharge-sizes", s.listRechargeSizes)
	r.With(ask).Post("/messaging/recharges/{channel}", s.requestRecharge)
	r.With(ask).Delete("/messaging/recharges/{id}", s.cancelRecharge)
}

func (s *Server) listRechargeSizes(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{"items": rechargeSizes})
}

func (s *Server) listRecharges(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []rechargeView{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT q.id, q.channel, q.messages, q.status, q.note, q.response,
			       u.full_name, q.requested_at, q.granted, q.decided_at
			  FROM message_credit_requests q
			  LEFT JOIN users u ON u.id = q.requested_by
			 WHERE q.institution_id = $1
			 ORDER BY q.requested_at DESC
			 LIMIT 50`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v rechargeView
			if err := rows.Scan(&v.ID, &v.Channel, &v.Messages, &v.Status, &v.Note,
				&v.Response, &v.RequestedBy, &v.RequestedAt, &v.Granted, &v.DecidedAt); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "recharge_failed",
			"Could not read the recharge requests.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) requestRecharge(w http.ResponseWriter, r *http.Request) {
	channel := chi.URLParam(r, "channel")
	if !metered(channel) {
		httpx.BadRequest(w, r, "channel must be sms or whatsapp")
		return
	}
	var body struct {
		Messages int    `json:"messages"`
		Note     string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.BadRequest(w, r, "body must be json")
		return
	}
	if body.Messages <= 0 || body.Messages > 1_000_000 {
		httpx.BadRequest(w, r, "messages must be between 1 and 1000000")
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var existing bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* One open request per channel. A school that presses the button twice
		   because nothing visibly happened must not produce two grants for one
		   need — the seller would fulfil both and the school would be billed
		   for both. The unique index makes the database settle it. */
		err := tx.QueryRow(r.Context(), `
			INSERT INTO message_credit_requests
			       (institution_id, channel, messages, note, requested_by)
			VALUES ($1, $2, $3, NULLIF($4, ''), $5)
			ON CONFLICT DO NOTHING
			RETURNING true`,
			id.InstitutionID, channel, body.Messages,
			strings.TrimSpace(body.Note), id.UserID).Scan(&existing)
		if errors.Is(err, pgx.ErrNoRows) {
			existing = false
			return nil
		}
		existing = true
		return err
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "recharge_failed",
			"Could not send the recharge request.")
		return
	}
	if !existing {
		httpx.Error(w, r, http.StatusConflict, "recharge_pending",
			"There is already a recharge request waiting for this channel.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Withdrawn by the school — it asked by mistake, or no longer needs it.
// Only its own, and only while nobody has acted on it.
func (s *Server) cancelRecharge(w http.ResponseWriter, r *http.Request) {
	reqID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, e := tx.Exec(r.Context(), `
			UPDATE message_credit_requests
			   SET status = 'cancelled', decided_at = now()
			 WHERE id = $1 AND institution_id = $2 AND status = 'pending'`,
			reqID, id.InstitutionID)
		return e
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "recharge_failed",
			"Could not withdraw the request.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

/* ── THE SELLER'S SIDE ──────────────────────────────────────────────────────

   The queue, and the one action that empties it. Granting adds the credits and
   settles the request in ONE transaction: a grant recorded without the credits
   arriving is a school still unable to send while the screen says it was
   handled, and credits added without the request being settled invites the
   next operator to grant it again. */

func (s *Server) mountSellerRecharge(r chi.Router) {
	r.Get("/recharges", s.listAllRecharges)
	r.Post("/recharges/{id}", s.decideRecharge)
}

func (s *Server) listAllRecharges(w http.ResponseWriter, r *http.Request) {
	out := []rechargeView{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT q.id, q.channel, q.messages, q.status, q.note, q.response,
			       u.full_name, q.requested_at, q.granted, q.decided_at, i.name
			  FROM message_credit_requests q
			  LEFT JOIN users u ON u.id = q.requested_by
			  JOIN institutions i ON i.id = q.institution_id
			 ORDER BY (q.status = 'pending') DESC, q.requested_at DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v rechargeView
			if err := rows.Scan(&v.ID, &v.Channel, &v.Messages, &v.Status, &v.Note,
				&v.Response, &v.RequestedBy, &v.RequestedAt, &v.Granted,
				&v.DecidedAt, &v.School); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "recharge_failed",
			"Could not read the recharge queue.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) decideRecharge(w http.ResponseWriter, r *http.Request) {
	reqID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var body struct {
		// grant | decline
		Decision string `json:"decision"`
		// How many to actually add. Absent means "as asked", which is the
		// common case and should not require retyping the number.
		Messages *int   `json:"messages"`
		Response string `json:"response"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.BadRequest(w, r, "body must be json")
		return
	}
	if body.Decision != "grant" && body.Decision != "decline" {
		httpx.BadRequest(w, r, "decision must be grant or decline")
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var missing bool
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var inst uuid.UUID
		var channel string
		var asked int
		e := tx.QueryRow(r.Context(), `
			SELECT institution_id, channel, messages
			  FROM message_credit_requests
			 WHERE id = $1 AND status = 'pending'
			 FOR UPDATE`, reqID).Scan(&inst, &channel, &asked)
		if errors.Is(e, pgx.ErrNoRows) {
			missing = true
			return nil
		}
		if e != nil {
			return e
		}

		granted := 0
		if body.Decision == "grant" {
			granted = asked
			if body.Messages != nil && *body.Messages >= 0 {
				granted = *body.Messages
			}
			/* The credits and the decision, together. A grant recorded without
			   the credits arriving is a school still unable to send while the
			   screen says it was handled; credits added without the request
			   being settled invites the next operator to grant it twice. */
			if _, e := addCredits(r.Context(), tx, inst, channel, granted,
				"topup", strings.TrimSpace(body.Response), id.UserID); e != nil {
				return e
			}
		}

		status := "granted"
		if body.Decision == "decline" {
			status = "declined"
		}
		_, e = tx.Exec(r.Context(), `
			UPDATE message_credit_requests
			   SET status = $2, granted = $3, response = NULLIF($4, ''),
			       decided_by = $5, decided_at = now()
			 WHERE id = $1`,
			reqID, status, granted, strings.TrimSpace(body.Response), id.UserID)
		return e
	})
	if missing {
		httpx.Error(w, r, http.StatusConflict, "recharge_settled",
			"That request has already been dealt with.")
		return
	}
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "recharge_failed",
			"Could not record the decision.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
