package api

import (
	"context"
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

/* WHAT A MESSAGE COSTS, AND WHO IS COUNTING.

   Every SMS and every WhatsApp template is real money on the school's own
   vendor account. Nothing counted them before: a reminder rule aimed at the
   wrong audience spent that money at whatever rate the dispatcher managed, and
   the first anybody knew was the bill.

   This is a meter, not a till. No money moves through this product — the
   school pays its vendor directly — so a credit is one send rather than an
   amount. Rates differ by vendor, by destination and by template, and a
   currency figure here would drift from the vendor's own invoice while looking
   authoritative.

   Email and in-app are absent because they cost nothing per message. Metering
   them would mean a school unable to send a receipt because it had run out of
   something that was never scarce. */

// Channels that cost money per message. Email is absent because an SMTP send
// is a connection rather than a billed unit, and a school unable to send a fee
// receipt for want of a credit would be absurd.
func metered(channel string) bool { return channel == "sms" || channel == "whatsapp" }

/* Channels where "whose account does this leave by" is a real question.
 *
 * Wider than metered on purpose. A school may well want its circulars and
 * receipts to leave from its own mail server — its own domain, its own
 * reputation — while letting SMS go through us. That is a routing decision
 * with no money attached, and the two lists differ for exactly that reason. */
func routable(channel string) bool { return metered(channel) || channel == "email" }

/*
NO ROW MEANS NOT METERED, and this is the whole compatibility story.

	If an absent row read as a zero balance, the migration that created this
	table would have silently stopped every message in the product for every
	school already configured: a fee reminder that never goes, an absence alert
	a parent never gets, and no screen saying why. Metering begins when somebody
	sets a balance, deliberately.

	Returns (balance, metered, error).
*/
func creditBalance(ctx context.Context, tx pgx.Tx, inst uuid.UUID, channel string) (int, bool, error) {
	if !metered(channel) {
		return 0, false, nil
	}
	var balance int
	err := tx.QueryRow(ctx,
		`SELECT balance FROM message_credits WHERE institution_id = $1 AND channel = $2`,
		inst, channel).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		/* WHAT AN ABSENT ROW MEANS DEPENDS ON WHOSE ACCOUNT IS PAYING, and
		 * that is the route rather than the pack.
		 *
		 * Sending by the school's own vendor, no row means no meter: the
		 * school pays that bill and a ceiling on it would be ours to impose on
		 * money we neither spend nor see. Somebody may still set one
		 * deliberately.
		 *
		 * Sending by ours, no row means zero — recharge to send. "Unlimited by
		 * default" there is a school spending our money with nothing counting
		 * it, which is the hole this was built to close. Messages are held
		 * rather than lost, so a school that recharges gets the backlog it
		 * queued while empty.
		 *
		 * Keyed on the route and not on the pack, because the top pack may be
		 * on either: a school on Complete that chose our account is metered
		 * exactly like one on Starter. */
		route, rErr := routeFor(ctx, tx, inst, channel)
		if rErr != nil {
			return 0, false, rErr
		}
		return 0, route == RouteEduCloud, nil
	}
	if err != nil {
		return 0, false, err
	}
	return balance, true, nil
}

/*
Spend one, at the moment the message is known to have gone.

	Called inside the dispatcher's transaction, immediately after the row is
	marked sent, so the credit and the send commit together or not at all. The
	alternative — reserving before the send — was rejected: a provider that
	times out after delivering would then have been paid for twice, once by the
	reservation and once by the retry that follows.

	The decrement is conditional on the balance being positive rather than
	checked first and written after. Two dispatch workers can run against one
	school; a read-then-write would let both see 1 and both spend it. `WHERE
	balance > 0` makes the database settle it.

	A school that is not metered has no row, so this updates nothing and writes
	no ledger entry, which is exactly right: there is nothing to count.
*/
func spendCredit(ctx context.Context, tx pgx.Tx, inst uuid.UUID, channel string, msgID uuid.UUID) error {
	if !metered(channel) {
		return nil
	}
	tag, err := tx.Exec(ctx, `
		UPDATE message_credits
		   SET balance = balance - 1, updated_at = now()
		 WHERE institution_id = $1 AND channel = $2 AND balance > 0`, inst, channel)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	/* A nil id is stored as NULL rather than as a zero uuid, which no message
	   has and the foreign key rightly refuses. The column is nullable because
	   the ledger has to outlive the log it points at -- message_log is pruned
	   and the money still went -- so "no message" is a value it already
	   understands. */
	var ref *uuid.UUID
	if msgID != uuid.Nil {
		ref = &msgID
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO message_credit_entries (institution_id, channel, delta, reason, message_id)
		VALUES ($1, $2, -1, 'send', $3)`, inst, channel, ref)
	return err
}

// ErrNoCredits is what the dispatcher shows on a message it is holding.
//
// Deliberately a sentence a school administrator can act on rather than a
// code. It appears verbatim on the message log beside the message that has not
// gone, which is the only place anybody looks when something did not arrive.
var ErrNoCredits = errors.New(
	"out of message credits for this channel — top up to resume sending")

/* Add credits, or correct them.
 *
 * `delta` is signed so one path serves a top-up and a correction; a separate
 * "remove credits" endpoint would be a second way to write the same row and
 * the two would disagree about the ledger. Clamped at zero because a negative
 * balance is not a debt anybody can collect — the vendor was already paid —
 * and would silently allow sends once topped back up.
 */
func addCredits(ctx context.Context, tx pgx.Tx, inst uuid.UUID, channel string,
	delta int, reason, note string, actor uuid.UUID) (int, error) {
	var balance int
	err := tx.QueryRow(ctx, `
		INSERT INTO message_credits (institution_id, channel, balance)
		VALUES ($1, $2, GREATEST($3, 0))
		ON CONFLICT (institution_id, channel) DO UPDATE
		   SET balance = GREATEST(message_credits.balance + $3, 0), updated_at = now()
		RETURNING balance`, inst, channel, delta).Scan(&balance)
	if err != nil {
		return 0, err
	}
	if delta != 0 {
		var actorID *uuid.UUID
		if actor != uuid.Nil {
			actorID = &actor
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_credit_entries
			       (institution_id, channel, delta, reason, actor_id, note)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))`,
			inst, channel, delta, reason, actorID, note); err != nil {
			return 0, err
		}
	}
	return balance, nil
}

/*
THE SCREENS.

	Reading the balance is gated on reading the institution, because a head
	teacher who cannot see how many messages are left cannot plan a term's
	communication and will discover the limit by messages not arriving.

	Changing it is gated on IntegrationsWrite — the same permission that holds
	the vendor credentials — because a credit here corresponds to money already
	spent with that vendor, and the person who linked the account is the person
	who knows what was bought.
*/
func (s *Server) mountMessageCredits(r chi.Router) {
	read := httpx.RequirePermission(rbac.InstitutionRead)
	write := httpx.RequirePermission(rbac.IntegrationsWrite)

	r.With(read).Get("/messaging/credits", s.listMessageCredits)
	r.With(read).Get("/messaging/credits/{channel}/entries", s.listMessageCreditEntries)
	r.With(write).Post("/messaging/credits/{channel}", s.topUpMessageCredits)
	r.With(write).Delete("/messaging/credits/{channel}", s.stopMeteringChannel)

	/* Which account each channel leaves by. Readable on every pack, because a
	   school must always be able to see how its own messages are sent; the
	   choice itself is checked in the handler, since only one of the two
	   answers needs the pack. */
	r.With(read).Get("/messaging/routing", s.listMessageRoutes)
	r.With(write).Put("/messaging/routing/{channel}", s.setMessageRoute)
}

type creditView struct {
	Channel string `json:"channel"`
	// Absent for a school nobody has metered. The screen must be able to say
	// "not metered" rather than "0 left", which are opposite facts.
	Metered  bool `json:"metered"`
	Balance  int  `json:"balance"`
	LowWater int  `json:"low_water"`
	Low      bool `json:"low"`
	Empty    bool `json:"empty"`
}

func (s *Server) listMessageCredits(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	ctx := r.Context()
	out := []creditView{}
	err := s.DB.InTenant(ctx, tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT channel, balance, low_water
			  FROM message_credits WHERE institution_id = $1`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		seen := map[string]creditView{}
		for rows.Next() {
			var v creditView
			if err := rows.Scan(&v.Channel, &v.Balance, &v.LowWater); err != nil {
				return err
			}
			v.Metered = true
			v.Empty = v.Balance <= 0
			v.Low = !v.Empty && v.Balance <= v.LowWater
			seen[v.Channel] = v
		}
		if err := rows.Err(); err != nil {
			return err
		}
		/* Every channel appears, and whether it is metered is RESOLVED rather
		 * than read off the table.
		 *
		 * The bug this replaces: the screen reported "not metered" for any
		 * channel with no row, while the dispatcher meters anything sending on
		 * our account whether or not a row exists. So a school on our route
		 * with no balance was told it had no limit, and then found its
		 * messages held — two sources of truth for one fact, disagreeing.
		 *
		 * The dispatcher's answer is the true one, so this asks the same
		 * function the dispatcher asks. */
		for _, ch := range []string{"sms", "whatsapp"} {
			v, ok := seen[ch]
			if !ok {
				v = creditView{Channel: ch}
			}
			_, isMetered, err := creditBalance(ctx, tx, id.InstitutionID, ch)
			if err != nil {
				return err
			}
			v.Metered = isMetered
			v.Empty = isMetered && v.Balance <= 0
			v.Low = isMetered && !v.Empty && v.LowWater > 0 && v.Balance <= v.LowWater
			out = append(out, v)
		}
		return nil
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "credits_failed",
			"Could not read the message credits.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

type creditEntryView struct {
	ID        uuid.UUID `json:"id"`
	Delta     int       `json:"delta"`
	Reason    string    `json:"reason"`
	Note      *string   `json:"note,omitempty"`
	Actor     *string   `json:"actor,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) listMessageCreditEntries(w http.ResponseWriter, r *http.Request) {
	channel := chi.URLParam(r, "channel")
	if !metered(channel) {
		httpx.BadRequest(w, r, "channel must be sms or whatsapp")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := []creditEntryView{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT e.id, e.delta, e.reason, e.note, u.full_name, e.created_at
			  FROM message_credit_entries e
			  LEFT JOIN users u ON u.id = e.actor_id
			 WHERE e.institution_id = $1 AND e.channel = $2
			 ORDER BY e.created_at DESC
			 LIMIT 200`, id.InstitutionID, channel)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v creditEntryView
			if err := rows.Scan(&v.ID, &v.Delta, &v.Reason, &v.Note, &v.Actor, &v.CreatedAt); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "credits_failed",
			"Could not read the credit history.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) topUpMessageCredits(w http.ResponseWriter, r *http.Request) {
	channel := chi.URLParam(r, "channel")
	if !metered(channel) {
		httpx.BadRequest(w, r, "channel must be sms or whatsapp")
		return
	}
	var body struct {
		Delta    *int   `json:"delta"`
		LowWater *int   `json:"low_water"`
		Note     string `json:"note"`
		Reason   string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.BadRequest(w, r, "body must be json")
		return
	}
	/* A cap on one entry, because the damage from a typo is not symmetrical.
	   Too few credits stops messages and somebody notices within the hour; too
	   many silently removes the ceiling this whole feature exists to provide,
	   and nobody notices until the vendor's bill. */
	if body.Delta != nil && (*body.Delta > 1_000_000 || *body.Delta < -1_000_000) {
		httpx.BadRequest(w, r, "delta must be between -1000000 and 1000000")
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		reason = "topup"
	}

	id := httpx.IdentityFrom(r.Context())
	var balance int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		delta := 0
		if body.Delta != nil {
			delta = *body.Delta
		}
		b, err := addCredits(r.Context(), tx, id.InstitutionID, channel, delta,
			reason, strings.TrimSpace(body.Note), id.UserID)
		if err != nil {
			return err
		}
		balance = b
		if body.LowWater != nil && *body.LowWater >= 0 {
			if _, err := tx.Exec(r.Context(),
				`UPDATE message_credits SET low_water = $3, updated_at = now()
				  WHERE institution_id = $1 AND channel = $2`,
				id.InstitutionID, channel, *body.LowWater); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "credits_failed",
			"Could not change the message credits.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": channel, "balance": balance})
}

/*
STOP METERING, which is not the same as setting the balance to zero.

	This gap was found by using the feature: taking a balance back down to zero
	leaves the school METERED at zero, and a metered channel at zero is stopped.
	So the only way to undo "I metered the wrong school" was to leave its
	messages held forever, and there was no path back to the state every school
	starts in.

	Removing the row is that path: no row means no meter, which is exactly how
	an untouched school behaves.

	The ledger is deliberately NOT removed. It is the record of money already
	spent with the vendor, and it has to survive somebody switching the meter
	off — otherwise the way to make an awkward month disappear is to stop
	metering and start again.
*/
func (s *Server) stopMeteringChannel(w http.ResponseWriter, r *http.Request) {
	channel := chi.URLParam(r, "channel")
	if !metered(channel) {
		httpx.BadRequest(w, r, "channel must be sms or whatsapp")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var balance int
		err := tx.QueryRow(r.Context(),
			`DELETE FROM message_credits WHERE institution_id = $1 AND channel = $2
			 RETURNING balance`, id.InstitutionID, channel).Scan(&balance)
		if errors.Is(err, pgx.ErrNoRows) {
			// Already unmetered. Saying so as success rather than 404: the
			// caller asked for a state and the state is what they asked for.
			return nil
		}
		if err != nil {
			return err
		}
		/* What was left is written off in the ledger rather than vanishing.
		   A balance that simply disappears makes the history stop adding up,
		   and this history exists to be checked against a vendor's bill. */
		if balance > 0 {
			_, err = tx.Exec(r.Context(), `
				INSERT INTO message_credit_entries
				       (institution_id, channel, delta, reason, actor_id, note)
				VALUES ($1, $2, $3, 'adjustment', $4, 'metering switched off')`,
				id.InstitutionID, channel, -balance, id.UserID)
		}
		return err
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "credits_failed",
			"Could not switch metering off.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": channel, "metered": false})
}

/* Whether this school's pack lets it send on its own vendor account.
 *
 * Read here rather than taken from the request's entitlement because the
 * dispatcher has no request: it runs from the queue, on a schedule, for a
 * school nobody is signed in as.
 *
 * A school with no subscription at all reads as false — the safe direction.
 * It is not on the pack that permits its own vendor, so it is metered, and a
 * meter with no credits holds messages rather than spending anything.
 */
func planAllowsCustomIntegration(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (bool, error) {
	var allowed *bool
	err := tx.QueryRow(ctx, `
		SELECT p.custom_integration
		  FROM subscriptions s
		  LEFT JOIN plans p ON p.code = s.plan_code
		 WHERE s.institution_id = $1
		 ORDER BY s.started_on DESC NULLS LAST
		 LIMIT 1`, inst).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return allowed != nil && *allowed, nil
}

/*
THE LINKING SCREEN IS THE TOP PACK'S, AND THE GATE IS HERE.

	Enforced on the server, not by hiding a tab. The screen is hidden too,
	because offering a form somebody cannot submit is its own kind of rude —
	but a hidden tab stops nobody who can type a URL or a curl command, and what
	is behind this gate is the ability to route a school's messages away from
	the account the seller is metering. A client-side check would make the meter
	optional for anybody willing to read the bundle.

	402 rather than 403: the request is well formed and the caller has every
	permission for it. What is missing is the pack, which is a commercial fact
	and has a status code of its own. The client already branches on 402 to show
	the plan notice.
*/
func (s *Server) RequireCustomIntegration(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		st, err := s.entitlementFor(r)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if !st.CustomIntegration {
			httpx.Error(w, r, http.StatusPaymentRequired, "plan_required",
				"Linking your own SMS or WhatsApp account is part of the Complete pack. "+
					"On this pack messages send through us and are paid for with credits.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Route names which account a channel leaves by.
const (
	RouteOwn      = "own"       // the school's linked vendor
	RouteEduCloud = "edu_cloud" // ours, paid for with credits
)

/*
WHICH ACCOUNT THIS CHANNEL LEAVES BY, resolved rather than assumed.

	An explicit choice wins. Where there is none, the answer is inferred from
	what the school actually has: a configured provider of its own means it is
	already sending by that and must keep doing so, and anything else means
	ours.

	Inferring rather than defaulting to a constant is the whole point. A blanket
	default of 'edu_cloud' would have silently re-routed any school that had
	already linked a vendor — and metered it, since our route always is — which
	is a school suddenly unable to send on an account it pays for itself.

	The lower packs are edu_cloud whatever is stored. Enforced here, at the
	point of reading, rather than by refusing to store 'own': a school that
	chose its own vendor and then moved DOWN a pack should get that choice back
	when it moves up again, not have it erased.
*/
func routeFor(ctx context.Context, tx pgx.Tx, inst uuid.UUID, channel string) (string, error) {
	if !routable(channel) {
		return RouteOwn, nil
	}
	custom, err := planAllowsCustomIntegration(ctx, tx, inst)
	if err != nil {
		return RouteEduCloud, err
	}
	if !custom {
		return RouteEduCloud, nil
	}

	var stored string
	err = tx.QueryRow(ctx,
		`SELECT route FROM message_routing WHERE institution_id = $1 AND channel = $2`,
		inst, channel).Scan(&stored)
	if err == nil {
		return stored, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return RouteEduCloud, err
	}

	// No choice recorded: follow what the school already has configured.
	var configured bool
	if err := tx.QueryRow(ctx, `
		SELECT count(*) > 0 FROM integrations
		 WHERE institution_id = $1 AND kind = 'messaging' AND provider = $2 AND enabled`,
		inst, channel).Scan(&configured); err != nil {
		return RouteEduCloud, err
	}
	if configured {
		return RouteOwn, nil
	}
	return RouteEduCloud, nil
}

type routeView struct {
	Channel string `json:"channel"`
	Route   string `json:"route"`
	// Whether this school may change it. False on the lower packs, where the
	// answer is always ours and the screen should say so rather than offer a
	// control that will be refused.
	MayChoose bool `json:"may_choose"`
}

func (s *Server) listMessageRoutes(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []routeView{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		custom, err := planAllowsCustomIntegration(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		for _, ch := range []string{"email", "sms", "whatsapp"} {
			route, err := routeFor(r.Context(), tx, id.InstitutionID, ch)
			if err != nil {
				return err
			}
			out = append(out, routeView{Channel: ch, Route: route, MayChoose: custom})
		}
		return nil
	})
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "routing_failed",
			"Could not read how messages are being sent.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

/* Choose the account a channel leaves by.
 *
 * Only 'own' needs the pack. Moving TO our account is always allowed, on any
 * pack — it is the route that costs the school nothing to be on, and refusing
 * it would strand a school that wanted to stop using a vendor it was leaving.
 */
func (s *Server) setMessageRoute(w http.ResponseWriter, r *http.Request) {
	channel := chi.URLParam(r, "channel")
	if !routable(channel) {
		httpx.BadRequest(w, r, "channel must be email, sms or whatsapp")
		return
	}
	var body struct {
		Route string `json:"route"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.BadRequest(w, r, "body must be json")
		return
	}
	route := strings.TrimSpace(body.Route)
	if route != RouteOwn && route != RouteEduCloud {
		httpx.BadRequest(w, r, "route must be own or edu_cloud")
		return
	}

	id := httpx.IdentityFrom(r.Context())
	refused := false
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if route == RouteOwn {
			custom, err := planAllowsCustomIntegration(r.Context(), tx, id.InstitutionID)
			if err != nil {
				return err
			}
			if !custom {
				refused = true
				return nil
			}
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO message_routing (institution_id, channel, route)
			VALUES ($1, $2, $3)
			ON CONFLICT (institution_id, channel) DO UPDATE
			   SET route = EXCLUDED.route, updated_at = now()`,
			id.InstitutionID, channel, route)
		return err
	})
	if refused {
		httpx.Error(w, r, http.StatusPaymentRequired, "plan_required",
			"Sending on your own vendor account is part of the Complete pack.")
		return
	}
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "routing_failed",
			"Could not change how messages are sent.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": channel, "route": route})
}
