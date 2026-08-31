package api

import (
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a bounced cheque costs, decided once rather than argued each time.

   Lateness has had a rules engine since the beginning: grace days, per-day or
   percent, a cap, preview before apply. A dishonoured cheque had nothing — the
   penalty was typed into a box at the moment somebody pressed Bounce. Three
   things follow from that, and a school meets all three:

     the figure drifts, because two people at the counter remember it
     differently and the second one is not wrong, only later;

     a family that argues gets a different answer from the one that does not,
     which is the thing a school least wants to be true of its fees;

     and nobody can say what the policy is, because it exists only in whatever
     was typed the last few times.

   So it is a setting: one amount, per school. Bounce still accepts a figure —
   a cheque dishonoured for a reason the school decides not to charge for is
   ordinary — but when none is given the standing amount applies.

   WHY module_settings AND NOT A TABLE

   It is one number. A table would need a screen to manage rows, a rule about
   which row wins, and a migration; module_settings already holds exactly this
   kind of one-line answer for other modules and needs none of them.
*/

const chequeBounceFineKey = "cheque_bounce_fine_paise"

type chequeFineSetting struct {
	// In rupees, as a school talks about it. A counter screen that asks for
	// paise is a screen where somebody eventually charges two rupees fifty.
	Amount float64 `json:"amount"`
}

func (s *Server) getChequeBounceFine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var paise int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var v *string
		if err := tx.QueryRow(r.Context(),
			`SELECT config->>'`+chequeBounceFineKey+`' FROM module_settings
			  WHERE module = 'finance'`).Scan(&v); err != nil {
			// No row for the module yet is not an error; it is a school that
			// has not been asked the question.
			return nil
		}
		if v != nil {
			paise, _ = strconv.ParseInt(*v, 10, 64)
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"amount": float64(paise) / 100,
		// So the screen can say "nothing is charged automatically" rather than
		// showing a zero that looks like a figure somebody chose.
		"set": paise > 0,
	})
}

func (s *Server) setChequeBounceFine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req chequeFineSetting
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Amount < 0 {
		httpx.BadRequest(w, r, "a fine cannot be less than nothing")
		return
	}
	if req.Amount > 100000 {
		httpx.BadRequest(w, r,
			"that is over ₹1,00,000 for one bounced cheque — if it is right, "+
				"charge it as a penalty on the bill so the reason is on the record")
		return
	}
	paise := int64(req.Amount*100 + 0.5)

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO module_settings (institution_id, module, enabled, config)
			VALUES ($1, 'finance', true,
			        jsonb_build_object('`+chequeBounceFineKey+`', $2::text))
			ON CONFLICT (institution_id, module)
			-- Merged, not replaced: finance's settings are not only ours.
			DO UPDATE SET config = module_settings.config || EXCLUDED.config`,
			id.InstitutionID, strconv.FormatInt(paise, 10))
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"amount": req.Amount, "set": paise > 0})
}
