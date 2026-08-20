package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
One message, one number, sent now.

	Every other producer in this building queues *for* somebody the school
	already knows: a guardian resolved from a student, a staff member resolved
	from an employee row. There was no way to send to a bare number, which made
	the phone gateway impossible to exercise -- the provider "test" endpoint
	calls Send directly, and phoneGatewayProvider.Send deliberately writes no
	message_log row, so it proves a handset is alive and delivers nothing.

	This is the missing half: it writes the row the outbox actually claims, then
	runs the dispatcher immediately rather than leaving it to the five-minute
	scheduler, because somebody standing over a handset waiting for a beep is
	the whole point of the endpoint.
*/

type directSendRequest struct {
	To   string `json:"to"`
	Text string `json:"text"`
	// Channel defaults to sms when empty, which is what the SMS test page
	// sends and keeps that page working unchanged. email and whatsapp let one
	// page exercise every channel the school has configured.
	Channel string `json:"channel"`
	// Subject is used only by email; sms and whatsapp ignore it.
	Subject string `json:"subject"`
}

func (s *Server) sendDirectMessage(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req directSendRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	to := strings.TrimSpace(req.To)
	text := strings.TrimSpace(req.Text)
	channel := strings.TrimSpace(req.Channel)
	if channel == "" {
		channel = "sms"
	}
	if channel != "sms" && channel != "email" && channel != "whatsapp" {
		httpx.BadRequest(w, r, "channel must be sms, email or whatsapp")
		return
	}
	if to == "" {
		httpx.BadRequest(w, r, "a recipient is required")
		return
	}
	if text == "" {
		httpx.BadRequest(w, r, "a message is required")
		return
	}
	// The 480 cap is an SMS concern -- one text silently split or truncated by
	// a carrier. Email and WhatsApp carry long bodies fine, so the limit only
	// applies to the channel it protects.
	if channel == "sms" && len(text) > 480 {
		httpx.BadRequest(w, r, "message is too long -- keep it under 480 characters")
		return
	}
	// Email wants a subject line; the others ignore it. A sensible default
	// rather than an empty header, which some servers score as spam.
	subject := strings.TrimSpace(req.Subject)
	if subject == "" {
		subject = "Message from school"
	}

	var res SendResult
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		res, err = s.QueueMessage(r.Context(), tx, id.InstitutionID, SendRequest{
			Channel:      channel,
			TemplateCode: "messaging.direct",
			Vars:         map[string]any{"text": text, "subject": subject},
			Recipient:    to,
		})
		return err
	}); err != nil {
		// A provider that is not set up is the operator's problem to fix, not
		// a server fault, and its Why() already says what is missing.
		httpx.Error(w, r, http.StatusConflict, "not_sent", err.Error())
		return
	}

	// Hand it to the dispatcher now. Errors here are not the caller's fault --
	// the row is queued and the scheduler will retry -- so they are reported
	// rather than returned as a failure of the request.
	sent, failed, err := s.DispatchMessages(r.Context(), id.InstitutionID, false, 25)
	out := map[string]any{"id": res.ID, "sent": sent, "failed": failed}
	if err != nil {
		out["dispatch_error"] = err.Error()
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) mountDirectSend(r chi.Router) {
	r.With(httpx.RequirePermission(rbac.MessagesSend)).
		Post("/messaging/send-direct", s.sendDirectMessage)
}
