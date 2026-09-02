package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/static"
)

/* Getting back in.

   The only recovery was an administrator issuing a temporary password by hand,
   on the reasoning that self-service reset needs a delivery gateway this
   deployment does not have. That was true when it was written. It stopped
   being the whole truth once there was a message log: a message can be
   recorded, and the page can be honest about whether it left the building.

   Three rules, and they are the ones that make a reset link safe:

     The token is stored hashed. For fifteen minutes it is a password, and a
     table of live ones is a table worth stealing.

     The request never says whether the account exists. "If that address is on
     an account, a link is on its way" is the same sentence for a real address
     and a guess, because the alternative turns this form into a way of asking
     which of a school's staff are on the system.

     Using it revokes every session. If the account was taken over, the reset
     is how the owner throws the intruder out; leaving the intruder's session
     alive would make the reset theatre. */

// PasswordReset is the pair of public pages: ask for a link, and use one.
type PasswordReset struct {
	DB     *database.DB
	Tpl    *template.Template
	Hasher *auth.Hasher
	// BaseURL is what goes into the email. A relative path is fine on the page
	// that produced it and useless in a mail client.
	BaseURL string
	// EmailReady reports whether the account's own school can carry the link
	// on the chosen channel. Where it can, the page stops printing the link on
	// screen — showing it there would hand a reset to whoever is at the
	// keyboard rather than to the account's owner. Where it cannot, the link
	// is the only way back in and the page says so.
	EmailReady func(r *http.Request, inst uuid.UUID, channel string) bool
}

type resetView struct {
	AssetVersion string
	Error        string
	Notice       string
	Token        string
	// Link is shown only where no provider is configured. A page that claims
	// to have sent something nothing could send is worse than one that admits
	// it and hands over the link.
	Link string
	Done bool
	// Channel is what was chosen, echoed so the confirmation names it: "sent
	// to your email" and "sent to your WhatsApp" are different promises, and
	// somebody watching the wrong one waits for ever.
	Channel string
	// Sent is the address or number it went to, masked. Shown because "we
	// sent it" is not much use to somebody who cannot remember which address
	// the school holds.
	Sent string
}

const resetWindow = 15 * time.Minute

func (p *PasswordReset) render(w http.ResponseWriter, r *http.Request, name string, status int, v resetView) {
	v.AssetVersion = static.Version()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := p.Tpl.ExecuteTemplate(w, name, v); err != nil {
		httpx.Internal(w, r, err)
	}
}

// ShowForgot renders the "what is your email" page.
func (p *PasswordReset) ShowForgot(w http.ResponseWriter, r *http.Request) {
	p.render(w, r, "forgot.gohtml", http.StatusOK, resetView{})
}

// Forgot issues a reset link for an account, if there is one.
func (p *PasswordReset) Forgot(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpx.BadRequest(w, r, "could not read the form")
		return
	}
	who := strings.TrimSpace(r.PostFormValue("identifier"))
	if who == "" {
		p.render(w, r, "forgot.gohtml", http.StatusBadRequest,
			resetView{Error: "Enter the email address, username or phone number you sign in with."})
		return
	}

	/* Where to send it.

	   An email address is not something every person at a school has. A
	   teacher on a government roll often has one only because the office
	   invented it; a parent has a phone. Offering the choice is the difference
	   between a reset somebody can complete and one they have to telephone the
	   office about — and the office issuing a password by hand is exactly what
	   this page exists to stop.

	   Anything unrecognised falls back to email rather than being refused: a
	   hand-typed form value is not worth an error page on the screen somebody
	   already reached because something went wrong. */
	channel := strings.TrimSpace(r.PostFormValue("channel"))
	if channel != "whatsapp" {
		channel = "email"
	}

	// Said the same way whether or not the account exists.
	const sameAnswer = "If that account exists, a reset link has been issued. " +
		"It is good for fifteen minutes."

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	token := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))

	var link string
	var queued bool
	// Which school the account belongs to, kept for the readiness check below:
	// it is only known once the user has been found.
	var owner uuid.UUID
	// Where it went, masked for the confirmation line.
	var sentTo string
	// Absolute: the link is opened from a mail client, not from the page that
	// produced it.
	base := strings.TrimSuffix(p.BaseURL, "/")
	err := p.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var userID uuid.UUID
		var instID *uuid.UUID
		var email *string

		/* Exactly one, the way signing in insists on exactly one.

		   An address is unique within a school and not across them, so two
		   people at two schools can share one — and this identifier arrives
		   with no school attached, because nobody has signed in yet. LIMIT 1
		   would have picked whichever the planner returned first and mailed a
		   link that resets a stranger's account. Refusing the ambiguous case
		   matches what the sign-in handler already does with it. */
		/* THE SAME SET SIGN-IN CONSIDERS, AND NO WIDER.

		   This counted every user whose status was not 'disabled' — archived
		   people included — and never asked whether their school still
		   operated. Sign-in counts active users of active institutions. So the
		   two disagreed, and this one found two candidates where sign-in found
		   one: it gave up, queued nothing, and the page reported the only
		   reason it knew how to report, which was that the school had no
		   delivery channel.

		   That sentence was false for every account tried on this deployment,
		   including the administrator's own, on a school whose SMTP is
		   configured, enabled and sending. A leftover row at a shut-off school
		   was silently vetoing password resets for a live one.

		   Whatever the rule is, both paths have to use it. A person who can
		   sign in must be able to reset, and a row that cannot sign anybody in
		   must not be able to block them. */
		var matches int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)
			  FROM users u
			  LEFT JOIN institutions i ON i.id = u.institution_id
			 WHERE u.status = 'active'
			   AND (u.institution_id IS NULL OR i.status = 'active')
			   AND (u.email = $1::citext OR u.username = $1::citext OR u.phone = $1)`,
			who).Scan(&matches); err != nil {
			return err
		}
		if matches != 1 {
			/* Said the same way as "no such account": a form that distinguishes
			   them tells a stranger which addresses are shared between schools.

			   Logged, though. Silence here is what made a false sentence the
			   only evidence anybody had. */
			if matches > 1 {
				slog.Warn("password reset: identifier matches more than one live account",
					"matches", matches)
			}
			return nil
		}

		var phone *string
		err := tx.QueryRow(r.Context(), `
			SELECT u.id, u.institution_id, u.email::text, u.phone
			  FROM users u
			  LEFT JOIN institutions i ON i.id = u.institution_id
			 WHERE u.status = 'active'
			   AND (u.institution_id IS NULL OR i.status = 'active')
			   AND (u.email = $1::citext OR u.username = $1::citext OR u.phone = $1)`,
			who).Scan(&userID, &instID, &email, &phone)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // answered identically below
		}
		if err != nil {
			return err
		}

		if _, err := tx.Exec(r.Context(), `
			INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip)
			VALUES ($1,$2,$3,$4)`,
			userID, hex.EncodeToString(sum[:]), time.Now().Add(resetWindow),
			nullString(r.Header.Get("X-Real-IP"))); err != nil {
			return err
		}
		link = "/reset?token=" + token

		/* Whichever way they asked to be reached.

		   The address is not always the useful one. A teacher on a government
		   roll often has an email only because the office invented it, and
		   reads WhatsApp; a parent may have no address at all. Falling back to
		   the other channel when the chosen one is missing is deliberate —
		   being strict about the choice would refuse somebody a reset over a
		   field the school never filled in.

		   Queued, not marked sent. The worker hands queued rows to whatever
		   provider the school has, so this becomes a real message the moment
		   the credentials exist, and stays honestly waiting when they do not.
		   Writing 'sent' here made the log claim a delivery nothing performed.

		   The body carries the link and never a password: a link expires and a
		   password sitting in a message log does not. */
		/* A CHANNEL THE SCHOOL CAN ACTUALLY SEND ON.

		   The old order asked two questions — which channel was requested, and
		   which contact exists — and never the third: whether the school has
		   that channel at all. So a request defaulting to WhatsApp, for a
		   person who has a mobile, queued a WhatsApp message at a school with
		   no WhatsApp account, and the page reported that the school had no
		   delivery channel. It had one. Nobody asked about it.

		   Measured here: every reset on Yajur failed this way, including the
		   administrator's own, while its SMTP was configured, enabled, tested
		   and sending mail the same afternoon.

		   Read from the same table the dispatcher reads, in this transaction,
		   rather than through the readiness callback — that opens its own
		   connection, and doing it inside this one risks waiting on a pool
		   this transaction is already holding. */
		enabled := map[string]bool{}
		{
			rows, err := tx.Query(r.Context(), `
				SELECT provider FROM integrations
				 WHERE institution_id = $1 AND kind = 'messaging' AND enabled`, *instID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var ch string
				if err := rows.Scan(&ch); err != nil {
					rows.Close()
					return err
				}
				enabled[ch] = true
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		mail := ""
		if email != nil {
			mail = strings.TrimSpace(*email)
		}
		mobile := ""
		if phone != nil {
			mobile = strings.TrimSpace(*phone)
		}

		/* Preference order: what they asked for, then whatever else can carry
		   it. A channel with no contact is no use, and a contact on a channel
		   the school cannot send through is worse than no use — it queues a
		   message that will never leave and tells the person a link is coming. */
		type route struct{ ch, to string }
		var routes []route
		if channel == "whatsapp" {
			routes = []route{{"whatsapp", mobile}, {"email", mail}}
		} else {
			routes = []route{{"email", mail}, {"whatsapp", mobile}}
		}
		to, ch := "", channel
		for _, r := range routes {
			if r.to != "" && enabled[r.ch] {
				to, ch = r.to, r.ch
				break
			}
		}
		if to == "" {
			// Nothing the school can send through. Queue on whichever contact
			// exists so the row is an honest record of the attempt, and let the
			// page say it could not be sent.
			for _, r := range routes {
				if r.to != "" {
					to, ch = r.to, r.ch
					break
				}
			}
		}

		if instID != nil && to != "" {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO message_log (institution_id, channel, template_code,
				                         recipient, user_id, subject, body, status)
				VALUES ($1,$6,'password_reset',$2,$3,$4,$5,'queued')`,
				*instID, to, userID, "Reset your password",
				"Open this link within fifteen minutes to choose a new password:\n"+
					base+link+"\n\nIf you did not ask for this, ignore it and nothing changes.",
				ch); err != nil {
				return err
			}
			queued = true
			owner = *instID
			channel = ch
			sentTo = maskContact(to)
		}
		return nil
	})
	if err != nil {
		httpx.LogError(r, err)
		p.render(w, r, "forgot.gohtml", http.StatusInternalServerError,
			resetView{Error: "Something went wrong at our end. Please try again."})
		return
	}

	view := resetView{Channel: channel, Sent: sentTo}
	if !queued || p.EmailReady == nil || !p.EmailReady(r, owner, channel) {
		/* SECURITY: never show the link on screen.
		   The previous behaviour printed a clickable reset URL whenever the
		   school had no email provider, which let anybody who knew an
		   identifier reset any account from a shared computer. The link is
		   still created and stored — it can be consumed if the school
		   configures delivery later within 15 minutes — but the page no
		   longer hands it over without verification. */
		/* Three different reasons reach this branch — the school has no
		   provider, the account has no address or mobile on it, or the link
		   could not be queued — and the page cannot tell the reader which
		   without saying whether the account exists, which this form must not
		   do. So it stops asserting the one it used to pick.

		   The old sentence named the school's configuration outright, and was
		   wrong in the field: a school with a working, tested mail server was
		   told it had no delivery channel. Being vague about which of three
		   causes it is beats being confidently wrong about one. The log now
		   carries the specific reason for whoever can act on it. */
		view.Notice = "We could not send a reset link — either this school has " +
			"no email or WhatsApp set up, or there is no address or mobile on " +
			"the account. Please ask your school office to reset your password."
	} else {
		view.Notice = sameAnswer
	}
	p.render(w, r, "forgot.gohtml", http.StatusOK, view)
}

// ShowReset renders the "choose a new password" page for a token.
func (p *PasswordReset) ShowReset(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if _, err := p.userForToken(r, token); err != nil {
		p.render(w, r, "reset.gohtml", http.StatusOK, resetView{
			Error: "That link has expired or has already been used. Ask for another.",
		})
		return
	}
	p.render(w, r, "reset.gohtml", http.StatusOK, resetView{Token: token})
}

// Reset sets the new password and spends the token.
func (p *PasswordReset) Reset(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpx.BadRequest(w, r, "could not read the form")
		return
	}
	token := r.PostFormValue("token")
	pw := r.PostFormValue("password")
	again := r.PostFormValue("password2")

	bad := func(msg string) {
		p.render(w, r, "reset.gohtml", http.StatusBadRequest, resetView{Token: token, Error: msg})
	}
	switch {
	case len(pw) < 10:
		bad("Use at least ten characters. A short password on a school system is everybody's problem, not just yours.")
		return
	case pw != again:
		bad("Those two do not match.")
		return
	}

	userID, err := p.userForToken(r, token)
	if err != nil {
		bad("That link has expired or has already been used. Ask for another.")
		return
	}
	hash, err := p.Hasher.Hash(pw)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	sum := sha256.Sum256([]byte(token))
	err = p.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(),
			`UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`,
			userID, hash); err != nil {
			return err
		}
		// Spent, and every other outstanding link for this account with it: a
		// second live link after a reset is a second way back in for whoever
		// prompted the reset.
		if _, err := tx.Exec(r.Context(), `
			UPDATE password_resets SET used_at = now()
			 WHERE user_id = $1 AND used_at IS NULL`, userID); err != nil {
			return err
		}
		// Every session, including one an intruder is holding. Done in the
		// same transaction as the password change: a reset that sets the
		// password and then fails to sign the old sessions out has locked the
		// owner out and left the intruder in.
		if _, err := tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now()
			 WHERE user_id = $1 AND revoked_at IS NULL`, userID); err != nil {
			return err
		}
		_ = sum
		return nil
	})
	if err != nil {
		httpx.LogError(r, err)
		bad("Something went wrong at our end. Please try again.")
		return
	}

	p.render(w, r, "reset.gohtml", http.StatusOK, resetView{Done: true})
}

// userForToken returns the account a live token belongs to.
func (p *PasswordReset) userForToken(r *http.Request, token string) (uuid.UUID, error) {
	if len(token) < 32 {
		return uuid.Nil, errors.New("no token")
	}
	sum := sha256.Sum256([]byte(token))
	var userID uuid.UUID
	err := p.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT user_id FROM password_resets
			 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
			hex.EncodeToString(sum[:])).Scan(&userID)
	})
	return userID, err
}

/*
maskContact shows enough of an address or number to recognise, and no more.

	The confirmation has to be useful to the person who asked and useless to
	somebody typing other people's usernames into the form to see what the
	school holds. "so••@gmail.com" is recognisable to its owner and to
	nobody else.
*/
func maskContact(v string) string {
	if i := strings.IndexByte(v, '@'); i > 0 {
		head := v[:i]
		if len(head) > 2 {
			head = head[:2] + strings.Repeat("•", len(head)-2)
		}
		return head + v[i:]
	}
	if len(v) > 5 {
		return strings.Repeat("•", len(v)-5) + v[len(v)-5:]
	}
	return v
}
