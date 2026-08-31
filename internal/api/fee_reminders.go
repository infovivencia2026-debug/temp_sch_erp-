package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Chasing a fee now, rather than by rule.

   The plan engine handles the standing arrangement: remind a week before, chase
   three days after, stop when it is paid. What it cannot do is the Tuesday
   morning an accountant looks at a section, sees eleven families still owing,
   and wants to send to those eleven — today, on the channels the school is
   willing to pay for.

   Sent to the household, not only the guardians: in a boarding school and
   anywhere the child carries the money to the office, the child is the one who
   has to act on it. Same reasoning as the plan's audience.

   The message carries the amount and the date it was due, because a reminder
   that says "fees are outstanding" and nothing else is one the family has to
   ring the office to act on — which is the errand the reminder exists to save.
*/

type feeReminderRequest struct {
	// Who to chase. Explicit ids rather than a filter, so what the accountant
	// ticked is what goes out: a filter re-evaluated on the server can gain a
	// family between the screen rendering and the button being pressed.
	StudentIDs []string `json:"student_ids"`
	// sms, whatsapp, email — whichever the school is willing to pay for today.
	// The in-app alert always goes; it costs nothing.
	Channels []string `json:"channels"`
}

func (s *Server) sendFeeReminders(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req feeReminderRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.StudentIDs) == 0 {
		httpx.BadRequest(w, r, "choose at least one family to remind")
		return
	}
	if len(req.StudentIDs) > 2000 {
		httpx.BadRequest(w, r, "that is more families than one send should carry")
		return
	}
	students := make([]uuid.UUID, 0, len(req.StudentIDs))
	for _, raw := range req.StudentIDs {
		sid, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			httpx.BadRequest(w, r, "every student_id must be a uuid")
			return
		}
		students = append(students, sid)
	}
	channels := cleanChannels(req.Channels)

	type target struct {
		student  uuid.UUID
		name     string
		due      int64
		dueOn    string
		userID   *uuid.UUID
		phone    string
		email    string
		isParent bool
	}

	var told, queued, noAccount int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The balance is read here, not taken from the screen.

		   A screen's figure is a figure as it was when the page loaded, and the
		   counter may have taken a cheque since — a reminder for money already
		   paid is the one thing that makes a family distrust every later one. */
		rows, err := tx.Query(r.Context(), `
			SELECT st.id,
			       concat_ws(' ', st.first_name, st.last_name),
			       SUM(inv.net_paise - inv.paid_paise),
			       to_char(MIN(inv.due_on), 'DD Mon')
			  FROM invoices inv
			  JOIN students st ON st.id = inv.student_id
			 WHERE inv.student_id = ANY($1)
			   AND inv.status NOT IN ('cancelled','draft','paid')
			   AND inv.net_paise > inv.paid_paise
			 GROUP BY st.id, st.first_name, st.last_name
			HAVING SUM(inv.net_paise - inv.paid_paise) > 0`, students)
		if err != nil {
			return err
		}
		owing := []target{}
		for rows.Next() {
			var t target
			var dueOn *string
			if err := rows.Scan(&t.student, &t.name, &t.due, &dueOn); err != nil {
				rows.Close()
				return err
			}
			if dueOn != nil {
				t.dueOn = *dueOn
			}
			owing = append(owing, t)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, t := range owing {
			amount := "₹" + strconv.FormatFloat(float64(t.due)/100, 'f', 2, 64)
			body := t.name + ": " + amount + " is outstanding"
			if t.dueOn != "" {
				body += ", due " + t.dueOn
			}
			body += ". Please pay at the school office or through the app."

			/* Everyone in the household with an account gets the alert; the
			   paid channels go to whoever has a number or an address. */
			people, err := tx.Query(r.Context(), `
				SELECT g.user_id, g.phone, g.email::text
				  FROM student_guardians sg
				  JOIN guardians g ON g.id = sg.guardian_id
				 WHERE sg.student_id = $1
				UNION ALL
				SELECT u.id, u.phone, u.email::text
				  FROM students st JOIN users u ON u.id = st.user_id
				 WHERE st.id = $1`, t.student)
			if err != nil {
				return err
			}
			type person struct {
				uid          *uuid.UUID
				phone, email *string
			}
			var ppl []person
			for people.Next() {
				var pn person
				if err := people.Scan(&pn.uid, &pn.phone, &pn.email); err != nil {
					people.Close()
					return err
				}
				ppl = append(ppl, pn)
			}
			people.Close()
			if err := people.Err(); err != nil {
				return err
			}

			st := t.student
			for _, pn := range ppl {
				if pn.uid == nil {
					/* A guardian the school has a number for and no login.

					   Common: a family that has never opened the app. The
					   in-app alert cannot reach them and the paid channels
					   still can, so this is counted rather than treated as a
					   failure — and the screen says so, because "Reminded 0
					   people" about a send that texted eleven families reads
					   as a broken button. */
					noAccount++
				}
				if pn.uid != nil {
					if err := notify(r, tx, id.InstitutionID, *pn.uid, &st, "fee_due",
						amount+" outstanding", body, "/go/fees_payments", "student", &st); err != nil {
						return err
					}
					told++
				}
				for _, ch := range channels {
					to := ""
					if ch == "email" && pn.email != nil {
						to = strings.TrimSpace(*pn.email)
					} else if ch != "email" && pn.phone != nil {
						to = strings.TrimSpace(*pn.phone)
					}
					if to == "" {
						// No number or no address. Skipped rather than failed:
						// the app alert has already reached them, and a send
						// must not stop because one family has no mobile.
						continue
					}
					if _, err := s.QueueMessage(r.Context(), tx, id.InstitutionID, SendRequest{
						Channel:      ch,
						TemplateCode: "messaging.direct",
						Vars:         map[string]any{"text": body, "subject": "School fees outstanding"},
						Recipient:    to,
					}); err != nil {
						// A gateway the school has not configured is theirs to
						// fix, not a reason to abandon a send already half done.
						continue
					}
					queued++
				}
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	if queued > 0 {
		go func() {
			_, _, _ = s.DispatchMessages(context.WithoutCancel(r.Context()),
				id.InstitutionID, false, 500)
		}()
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"told": told, "messages_queued": queued, "channels": channels,
		// People the app could not reach because they have no account.
		"no_account": noAccount,
	})
}
