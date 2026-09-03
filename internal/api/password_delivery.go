package api

import (
	"context"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* A password an administrator issues goes to the person, not just to the
   screen.

   Until now the one-time value was shown to whoever pressed the button and
   the rest was a walk across the corridor. HR resetting a teacher's login
   or admissions issuing a parent's does not always have the person in the
   room, and a value read down a telephone is the value most often mistyped.
   So the same row the self-service reset queues is queued here, carrying
   the password itself rather than a link: the template code is the one the
   dispatcher hands to the seller's providers, which is what EDU CLOUD
   promises — resets leave by its channels whether or not the school has
   any of its own.

   The screen still shows the value. Delivery is asynchronous and a message
   can fail after this returns; an administrator who can see the value can
   still hand it over. */

// platformChannels is what the seller has switched on: the channels a
// password_reset row can actually leave by. Read outside the caller's tenant
// transaction, on its own connection, as the self-service reset does.
func (s *Server) platformChannels(ctx context.Context) map[string]bool {
	out := map[string]bool{}
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT provider FROM integrations
			 WHERE institution_id IS NULL AND kind = 'messaging' AND enabled`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var ch string
			if err := rows.Scan(&ch); err != nil {
				return err
			}
			out[ch] = true
		}
		return rows.Err()
	})
	if err != nil {
		slog.Warn("issued password: could not read the seller's channels", "err", err)
	}
	return out
}

// queueIssuedPassword picks the first channel that has both a contact and a
// provider — email first, then SMS, then WhatsApp — and queues the message.
// It returns the channel used and the masked contact, or "" when the account
// carries no contact a message could go to.
func (s *Server) queueIssuedPassword(ctx context.Context, tx pgx.Tx, inst, userID uuid.UUID,
	email, phone *string, login, temp string, enabled map[string]bool) (string, string, error) {
	mail, mobile := "", ""
	if email != nil {
		mail = strings.TrimSpace(*email)
	}
	if phone != nil {
		mobile = strings.TrimSpace(*phone)
	}
	type route struct{ ch, to string }
	routes := []route{{"email", mail}, {"sms", mobile}, {"whatsapp", mobile}}
	to, ch := "", ""
	for _, r := range routes {
		if r.to != "" && enabled[r.ch] {
			to, ch = r.to, r.ch
			break
		}
	}
	/* No provider on any channel the person has a contact for: queue by the
	   first contact anyway. The row waits in the log where the seller can see
	   what did not go out, rather than vanishing. */
	if to == "" {
		for _, r := range routes {
			if r.to != "" {
				to, ch = r.to, r.ch
				break
			}
		}
	}
	if to == "" {
		return "", "", nil
	}
	base := strings.TrimSuffix(s.BaseURL, "/")
	body := "Your login has been reset.\n\nSign in as " + login + " with this temporary password:\n" +
		temp + "\n\n" + base + "/login\n\nYou will be asked to choose your own password the first time."
	if ch != "email" {
		body = "Login reset. Sign in as " + login + " with temporary password " + temp +
			" at " + base + "/login and choose your own."
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_log (institution_id, channel, template_code,
		                         recipient, user_id, subject, body, status)
		VALUES ($1,$2,'password_reset',$3,$4,$5,$6,'queued')`,
		inst, ch, to, userID, "Your login", body); err != nil {
		return "", "", err
	}
	return ch, maskContact(to), nil
}
