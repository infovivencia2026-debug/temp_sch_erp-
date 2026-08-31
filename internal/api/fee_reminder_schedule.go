package api

import (
	"encoding/json"
	"errors"
	"net/http"

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
	/* Any of sms, whatsapp, email — a school that wants both a text and a
	   WhatsApp message is not unusual, and the two reach different people in
	   the same house.

	   Held as one plan row per channel rather than a list on one row: the
	   engine sends one message per occurrence per rule, so three channels is
	   three rules, and the alternative would be teaching the sender to fan out
	   — which is the same code with a second way to be wrong. */
	Channels []string `json:"channels"`
	Active   bool     `json:"active"`
	// Repeat and cap, so a family that ignores the first is chased again
	// without being chased for ever.
	RepeatDays  int `json:"repeat_days"`
	MaxAttempts int `json:"max_attempts"`
}

func (s *Server) getFeeReminderSchedule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := feeReminderSchedule{
		DaysBefore: 7, Channels: []string{}, RepeatDays: 7, MaxAttempts: 3,
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT condition, channel, repeat_days, max_attempts, is_active
			  FROM message_trigger_rules
			 WHERE institution_id = $1 AND plan_kind = 'fee_reminder'
			 ORDER BY created_at`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		first := true
		for rows.Next() {
			var cond []byte
			var channel string
			var repeat, attempts int
			var active bool
			if err := rows.Scan(&cond, &channel, &repeat, &attempts, &active); err != nil {
				return err
			}
			/* The timing is the school's, not the channel's: three rows for
			   three channels say the same thing about when, and the first one
			   read is as good as any. A screen that let them differ would be a
			   screen where a family gets the SMS on Monday and the WhatsApp on
			   Thursday for no reason anybody chose. */
			if first {
				var c map[string]any
				_ = json.Unmarshal(cond, &c)
				if v, ok := c["min_days_overdue"].(float64); ok {
					out.DaysBefore = -int(v)
				}
				out.RepeatDays, out.MaxAttempts, out.Active = repeat, attempts, active
				first = false
			}
			if active {
				out.Channels = append(out.Channels, channel)
			}
		}
		return rows.Err()
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
	channels := cleanChannels(req.Channels)
	if req.Active && len(channels) == 0 {
		httpx.BadRequest(w, r,
			"choose at least one of SMS, WhatsApp or email — or switch the "+
				"automatic reminder off")
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
		/* A channel the school has turned off is switched off, not deleted.

		   Deleting the rule would take its history with it — which chases have
		   gone out, to whom — and a school that turns WhatsApp off for a term
		   and back on in April would find the counter restarted and every
		   family chased from the beginning again. */
		if _, err := tx.Exec(r.Context(), `
			UPDATE message_trigger_rules SET is_active = false
			 WHERE institution_id = $1 AND plan_kind = 'fee_reminder'`,
			id.InstitutionID); err != nil {
			return err
		}
		for _, ch := range channels {
			var existing uuid.UUID
			err := tx.QueryRow(r.Context(), `
				SELECT id FROM message_trigger_rules
				 WHERE institution_id = $1 AND plan_kind = 'fee_reminder'
				   AND channel = $2
				 ORDER BY created_at LIMIT 1`, id.InstitutionID, ch).Scan(&existing)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if errors.Is(err, pgx.ErrNoRows) {
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO message_trigger_rules
					    (institution_id, name, event, condition, audience, channel,
					     template_code, plan_kind, repeat_days, max_attempts, is_active)
					VALUES ($1,$2,'invoice.overdue',$3,'family',$4,
					        'fees.overdue','fee_reminder',$5,$6,$7)`,
					id.InstitutionID, feeScheduleName+" — "+ch, cond, ch,
					req.RepeatDays, req.MaxAttempts, req.Active); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE message_trigger_rules
				   SET condition = $2, repeat_days = $3, max_attempts = $4,
				       is_active = $5,
				       -- Both halves of the household, always. A fee reminder
				       -- that reaches only the guardians misses the child who
				       -- carries the money to the office.
				       audience = 'family'
				 WHERE id = $1`,
				existing, cond, req.RepeatDays, req.MaxAttempts, req.Active); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}
