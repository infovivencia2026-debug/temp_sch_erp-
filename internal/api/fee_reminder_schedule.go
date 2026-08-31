package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The standing arrangement, in the words an accountant uses.

   The rules engine can already express this — a plan whose first chase is a
   negative number of days fires before the deadline — and the screen that
   edits plans asks for an event, a condition, an audience, a template code, a
   quiet window and a lead time. That screen is right for somebody building an
   automation. It is wrong for the person who wants one sentence to be true:

     "Remind the family seven days before the fee is due, by WhatsApp."

   So this reads and writes exactly that sentence, against the same plan row
   the engine runs. Nothing here is a second mechanism: change it on either
   screen and the other shows the change.

   WHY days_before AND NOT days_after

   Both, in one signed number. min_days_overdue is what the engine filters on
   and it counts from the due date, so -7 is a week before and 3 is three days
   after. Two fields would be two ways to say the same thing, and the day they
   disagree is the day a family gets chased twice.
*/

const feeScheduleName = "Fee reminder"

type feeReminderSchedule struct {
	// Negative is before the due date, positive after. The screen sends the
	// number of days and which side, and the arithmetic stays here.
	DaysBefore int `json:"days_before"`
	// sms, whatsapp or email. One channel per plan, because the engine sends
	// one message per occurrence and a plan that fanned out to three would
	// bill a school three times for one reminder.
	Channel string `json:"channel"`
	Active  bool   `json:"active"`
	// Repeat and cap, so a family that ignores the first is chased again
	// without being chased for ever.
	RepeatDays  int `json:"repeat_days"`
	MaxAttempts int `json:"max_attempts"`
}

func (s *Server) getFeeReminderSchedule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := feeReminderSchedule{DaysBefore: 7, Channel: "whatsapp", RepeatDays: 7, MaxAttempts: 3}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var cond []byte
		var channel string
		var repeat, attempts int
		var active bool
		err := tx.QueryRow(r.Context(), `
			SELECT condition, channel, repeat_days, max_attempts, is_active
			  FROM message_trigger_rules
			 WHERE institution_id = $1 AND plan_kind = 'fee_reminder'
			 ORDER BY created_at LIMIT 1`, id.InstitutionID).
			Scan(&cond, &channel, &repeat, &attempts, &active)
		if errors.Is(err, pgx.ErrNoRows) {
			// No plan yet: the defaults above are the school's starting point
			// rather than an empty form nobody knows how to fill.
			out.Active = false
			return nil
		}
		if err != nil {
			return err
		}
		var c map[string]any
		_ = json.Unmarshal(cond, &c)
		if v, ok := c["min_days_overdue"].(float64); ok {
			out.DaysBefore = -int(v)
		}
		out.Channel, out.RepeatDays, out.MaxAttempts, out.Active = channel, repeat, attempts, active
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) saveFeeReminderSchedule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req feeReminderSchedule
	if !httpx.Decode(w, r, &req) {
		return
	}
	channel := strings.ToLower(strings.TrimSpace(req.Channel))
	switch channel {
	case "sms", "whatsapp", "email":
	default:
		httpx.BadRequest(w, r, "choose SMS, WhatsApp or email")
		return
	}
	/* A reminder more than two months ahead is a reminder about money the
	   school has not asked for yet, and the finder only looks 60 days out — a
	   plan set further would silently never fire, which is worse than being
	   told it cannot. */
	if req.DaysBefore < -60 || req.DaysBefore > 60 {
		httpx.BadRequest(w, r, "keep it within 60 days either side of the due date")
		return
	}
	if req.MaxAttempts < 1 {
		req.MaxAttempts = 1
	}
	if req.RepeatDays < 0 {
		req.RepeatDays = 0
	}

	cond, _ := json.Marshal(map[string]any{"min_days_overdue": -req.DaysBefore})

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var existing uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT id FROM message_trigger_rules
			 WHERE institution_id = $1 AND plan_kind = 'fee_reminder'
			 ORDER BY created_at LIMIT 1`, id.InstitutionID).Scan(&existing)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if errors.Is(err, pgx.ErrNoRows) {
			_, err = tx.Exec(r.Context(), `
				INSERT INTO message_trigger_rules
				    (institution_id, name, event, condition, audience, channel,
				     template_code, plan_kind, repeat_days, max_attempts, is_active)
				VALUES ($1,$2,'invoice.overdue',$3,'family',$4,
				        'fees.overdue','fee_reminder',$5,$6,$7)`,
				id.InstitutionID, feeScheduleName, cond, channel,
				req.RepeatDays, req.MaxAttempts, req.Active)
			return err
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE message_trigger_rules
			   SET condition = $2, channel = $3, repeat_days = $4,
			       max_attempts = $5, is_active = $6,
			       -- Both halves of the household, always. A fee reminder that
			       -- reaches only the guardians misses the child who carries
			       -- the money to the office.
			       audience = 'family'
			 WHERE id = $1`,
			existing, cond, channel, req.RepeatDays, req.MaxAttempts, req.Active)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}
