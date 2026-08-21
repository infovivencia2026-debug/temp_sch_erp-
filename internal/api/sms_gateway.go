package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The server half of a phone SMS gateway.

   A spare Android handset with a SIM becomes the school's SMS provider. It
   exists because super_admin.messaging.sms_gateway_integration and everything
   downstream of it -- absence alerts, fee reminders, PTM reminders -- have been
   waiting on a vendor account that procurement has not finished buying, and a
   school of three hundred families sending twenty messages a day does not need
   a bulk provider to tell a parent their child is not in school.

   The wire contract is docs/SMS_GATEWAY_CONTRACT.md and is authoritative; the
   Android half is built against the same file. Nothing here changes it.

   ---------------------------------------------------------------------------
   What this is not

   Not a replacement for a licensed bulk-SMS provider, and the admin screen
   says so in the product rather than only here. Indian commercial SMS requires
   DLT-registered sender ids and templates under the TRAI regime; a personal
   SIM sending hundreds of messages is throttled by the carrier and may be
   disconnected outright. The rate cap below is not a performance knob, it is
   the thing keeping the school's SIM alive.

   ---------------------------------------------------------------------------
   Why the phone pulls

   The obvious design has the server POST to the phone, and it does not survive
   contact with a mobile network: the handset sits behind carrier-grade NAT
   with no inbound route, its address rotates, and Doze suspends a listening
   socket. So the phone polls. It is reachable from nowhere and reaches out to
   one place, which is also the security posture you want on a device that
   lives in an office drawer.

   ---------------------------------------------------------------------------
   The property this file exists to protect

   A second send to a parent is the failure that matters. A fee reminder that
   arrives late is an annoyance; the same fee demand twice is a phone call to
   the office and a family that stops trusting the school's messages. So:

     - claims are atomic, under FOR UPDATE SKIP LOCKED, with a lease
     - receipts are idempotent on the message id
     - an unconfirmed lease returns to queued a *bounded* number of times,
       because a message that may already have left the handset is not worth
       sending again

   And the property beside it: a gateway that has silently died is worse than
   no gateway, because the school believes messages are going out. So a stale
   heartbeat makes the provider report Configured() = false with the elapsed
   time in the sentence, the dispatcher holds the message in 'queued' rather
   than pretending, and the admin screen shouts rather than showing a grey dot.

   ---------------------------------------------------------------------------
   Never a message body

   message_log holds the body. Nothing in this file writes one anywhere else,
   logs one, or puts one in an error string. The gateway tables reference the
   message; the outbox reads the body through that reference at the moment the
   phone asks for it, and it exists in this process for exactly that long. */

// --- the shape of the thing --------------------------------------------------

const (
	/* How long a phone may be silent before the school is told.

	   Fifteen minutes against a twenty-second poll is forty-five consecutive
	   missed polls -- comfortably past a lift, a reboot, or a Wi-Fi handover,
	   and well short of a morning's absence alerts piling up unnoticed. The
	   number is generous on purpose: an administrator who is warned about a
	   phone that was merely in the basement learns to ignore the warning, and
	   then misses the one that matters. */
	smsGatewayHeartbeatWindow = 15 * time.Minute

	/* How long a device may hold a claimed message before it returns to the
	   queue.

	   Five minutes, against a handset that is expected to send and acknowledge
	   within seconds. It has to be long enough that a phone which genuinely
	   sent the message has reported the receipt before the lease lapses --
	   because a lapsed lease is re-sent, and re-sending something that was
	   already delivered is the one outcome this file is built to avoid. */
	smsGatewayLease = 5 * time.Minute

	/* How many times one message may be leased before it is given up on.

	   Three. The first attempt is the normal path. The second covers a phone
	   that died between claiming and sending -- a flat battery, a crash --
	   where nothing went out and re-sending is right. By the third failure the
	   evidence has stopped pointing at "it never left": something is
	   repeatedly claiming and not confirming, and the honest reading is that
	   the message may have gone out. It is marked failed and left for a human,
	   rather than retried into a duplicate. */
	smsGatewayMaxAttempts = 3

	/* How long a message waits for a phone to collect it at all.

	   A handset switched off on Friday evening must not wake on Monday and
	   deliver a Friday absence alert. Past this, the dispatch is abandoned and
	   message_log says so. */
	smsGatewayCollectWindow = 12 * time.Hour

	// The pair code's life. Long enough to walk the phone across the office,
	// short enough that a code left on a whiteboard is worthless by lunch.
	smsGatewayPairTTL = 10 * time.Minute

	// Defaults handed to a newly claimed handset; both are per-device columns
	// the admin screen can change afterwards.
	smsGatewayDefaultPoll = 20
	smsGatewayDefaultCap  = 6

	// Most a single poll may take, whatever the phone asks for. A handset that
	// requests a thousand is a handset that will hold a thousand leases and
	// then die.
	smsGatewayMaxBatch = 20
)

/*
smsGatewayProviderName is what goes in message_log.provider for this channel.

	Fixed rather than derived from the device, because the outbox claims rows by
	this value and a name that varied per handset would make that query a
	pattern match. Which phone actually sent it is on the dispatch ledger, where
	it belongs.
*/
const smsGatewayProviderName = "sms:phone"

// --- the provider ------------------------------------------------------------

/*
phoneGatewayProvider is the fifth MessagingProvider, and the proof of a claim.

	messaging.go says a new channel is "a struct and a case in loadProviders; it
	is not a change to any caller". This is that struct and that case, and
	nothing else in messaging.go moved: not the MessagingProvider interface, not
	OutboundMessage, not DispatchMessages, not one call site. The four lines
	added to loadProviders choose between this provider and the HTTP one on the
	stored config, which is what "configures channel sms with provider kind
	phone" means in the schema that already exists.

	Send is the interesting half. Every other provider in this codebase makes a
	network call and learns the outcome inside Send. This one cannot: the
	handset is unreachable by design, and the send happens seconds to minutes
	later when the phone next polls. So Send makes the message *available* and
	returns, and 'sent' in message_log means for this provider exactly what it
	has always meant for the others -- accepted by the provider for delivery,
	not confirmed in a parent's hand. The SMTP provider's 'sent' is a mail
	server's 250, and the vendor gateway's 'sent' is an HTTP 200; neither is
	proof a human read anything. The dispatch ledger carries the rest of the
	truth, and a handset that reports a failure writes it back into message_log.

	What keeps that honest rather than a pretend send is Configured(). If no
	phone is paired, or every paired phone has missed its heartbeat window, this
	provider refuses at the door: DispatchMessages holds the row in 'queued'
	with the reason attached, and the school reads "the office phone has not
	reported in for 40 minutes" on the screen instead of finding out from a
	parent.
*/
type phoneGatewayProvider struct {
	// The transaction this provider was loaded on. DispatchMessages loads
	// providers inside the same transaction it locks the message row in, so a
	// write here commits or rolls back with the message_log update rather than
	// leaving a ledger row for a message that never moved.
	//
	// Nil when the provider was built outside a transaction -- the draft
	// "test connection" path does that -- and Send says so rather than
	// panicking.
	tx   pgx.Tx
	inst uuid.UUID

	// Resolved once at load, because Configured() has neither a context nor an
	// error to report a query failure through. Loading it eagerly costs one
	// small indexed read per fan-out, which is the same bargain loadProviders
	// already makes for every other channel.
	reason string
}

func (phoneGatewayProvider) Channel() string { return "sms" }
func (phoneGatewayProvider) Name() string    { return smsGatewayProviderName }

func (p phoneGatewayProvider) Configured() bool { return p.reason == "" }
func (p phoneGatewayProvider) Why() string      { return p.reason }

/*
Send makes one message available to a paired handset.

	No HTTP call, and deliberately no ledger write either.

	The ledger row is created by the outbox when a device claims the message,
	not here, and the reason is the MessagingProvider interface: Send is handed
	an OutboundMessage carrying To, Subject, Body and a DLT id, and no message
	id. It could not write a row referencing message_log if it wanted to. The
	alternative -- adding an ID field to OutboundMessage and populating it in
	DispatchMessages -- is precisely the change to a caller that this file set
	out to show is unnecessary, and it would have bought nothing: the outbox
	query finds its work by provider name and status, which is information the
	dispatcher records anyway.

	So "available" means: this returns success, DispatchMessages marks the row
	sent with provider 'sms:phone', and the outbox selects on exactly that.
	What Send does do is refuse when there is no live phone, which is the whole
	safety property -- and sweep expired leases, because it runs inside
	DispatchMessages, which the asynq scheduler already calls every five minutes
	per institution. That is an existing scheduled path rather than a second
	one.
*/
func (p phoneGatewayProvider) Send(ctx context.Context, _ OutboundMessage) (string, error) {
	if !p.Configured() {
		return "", fmt.Errorf("sms: %w: %s", ErrProviderNotConfigured, p.reason)
	}
	if p.tx == nil {
		return "", errors.New("the phone gateway cannot be tested from an unsaved draft — pair a handset first, then send a test")
	}
	// Bookkeeping, not correctness: the outbox claim treats a lapsed lease as
	// takeable on its own, so re-delivery never waits on this. What the sweep
	// buys is a ledger and an admin screen that say "the phone claimed this and
	// never confirmed it" rather than showing a row stuck in 'dispatching'
	// forever.
	if err := sweepSMSGatewayLeases(ctx, p.tx, p.inst); err != nil {
		return "", err
	}
	// Nothing to return. message_log.provider_msg_id stays null until the
	// handset reports one; inventing a handle here would put a value in the
	// column that no phone would ever quote back.
	return "", nil
}

/*
phoneGatewayConfigured reads the sms channel's stored settings.

	The discriminator is a single field, `kind`, on the config JSON the
	messaging provider screen already stores per channel. Absent or anything
	other than "phone" means the HTTP gateway, so every school configured before
	this file existed keeps the provider it had.

	Declared here rather than as a field on gatewaySettings so that messaging.go
	needs no edit beyond the four lines in loadProviders.
*/
type phoneGatewaySettings struct {
	Kind string `json:"kind"`
}

// isPhoneGatewayConfig reads the discriminator out of a stored sms config.
//
// Unreadable JSON answers false rather than erroring: the caller's fallback is
// the HTTP gateway, which will itself report "stored settings are not readable"
// through the same Why() an administrator is already looking at. Two different
// error paths for one corrupt row would be one more than anybody needs.
func isPhoneGatewayConfig(cfg []byte) bool {
	if len(cfg) == 0 {
		return false
	}
	var st phoneGatewaySettings
	if err := json.Unmarshal(cfg, &st); err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(st.Kind), "phone")
}

/*
loadPhoneGateway builds the provider for one school, liveness and all.

	This is the whole of the "case in loadProviders" that messaging.go promised
	would be enough. It keeps the transaction so Send can sweep on it, and it
	resolves the reason eagerly because Configured() has no way to report a
	query failure — an error here becomes an unconfigured provider carrying the
	error as its sentence, which is exactly how loadProviders already treats a
	credential it cannot open.
*/
func (s *Server) loadPhoneGateway(ctx context.Context, tx pgx.Tx, inst uuid.UUID) MessagingProvider {
	reason, err := smsGatewayReason(ctx, tx, inst)
	if err != nil {
		return unconfiguredProvider{"sms", "could not read the paired phones: " + err.Error()}
	}
	return phoneGatewayProvider{tx: tx, inst: inst, reason: reason}
}

// --- liveness ----------------------------------------------------------------

/*
smsGatewayReason answers "can this school send an SMS right now", in a sentence.

	Three answers, and the difference between them is what an administrator does
	next:

	  no device paired          -> go and pair one; there is a button
	  every device paused       -> somebody turned it off on purpose
	  every device stale        -> go and look at the phone in the drawer

	The stale case names the elapsed time because "not reporting" is a state
	somebody has to judge the seriousness of, and forty minutes and four minutes
	are different emergencies.
*/
func smsGatewayReason(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (string, error) {
	var (
		paired   int
		active   int
		lastSeen *time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE NOT paused),
		       max(last_seen_at) FILTER (WHERE NOT paused)
		  FROM sms_gateway_devices
		 WHERE institution_id = $1 AND revoked_at IS NULL`, inst).
		Scan(&paired, &active, &lastSeen)
	if err != nil {
		return "", err
	}
	switch {
	case paired == 0:
		return "no phone is paired — pair the office handset to start sending SMS", nil
	case active == 0:
		return "every paired phone is paused — switch one back on to start sending", nil
	case lastSeen == nil:
		return "the paired phone has never reported in — open the gateway app on the handset", nil
	}
	silent := time.Since(*lastSeen)
	if silent > smsGatewayHeartbeatWindow {
		return "the office phone has not reported in for " + humanSilence(silent), nil
	}
	return "", nil
}

/*
humanSilence renders an outage the way somebody would say it out loud.

	"40 minutes", "3 hours", "2 days". Not "40m0s", and not a timestamp the
	reader has to subtract from the clock on the wall while a parent is on the
	phone asking why they were not told their child was absent.
*/
func humanSilence(d time.Duration) string {
	switch {
	case d < 2*time.Minute:
		return "a minute"
	case d < time.Hour:
		return strconv.Itoa(int(d.Minutes())) + " minutes"
	case d < 2*time.Hour:
		return "an hour"
	case d < 48*time.Hour:
		return strconv.Itoa(int(d.Hours())) + " hours"
	}
	return strconv.Itoa(int(d.Hours())/24) + " days"
}

// --- the lease sweeper -------------------------------------------------------

/*
sweepSMSGatewayLeases returns abandoned claims to the queue, and gives up on the
ones that have been abandoned too often.

	Runs on three paths, all of them existing ones: inside Send, which the asynq
	scheduler drives every five minutes per institution; and on the outbox and
	heartbeat polls, which is where it matters most, because a phone coming back
	from an outage should find its own unfinished work waiting rather than
	needing a scheduler tick to release it. No new schedule was added.

	Correctness never depends on it. The outbox claim predicate treats a lapsed
	lease as takeable in the same statement that takes it, so a message is
	recoverable whether or not this has run. What this adds is the ledger the
	admin screen reads and the attempt counter that stops recovery becoming a
	duplicate.
*/
func sweepSMSGatewayLeases(ctx context.Context, tx pgx.Tx, inst uuid.UUID) error {
	// Under the attempt bound: back to the queue, unclaimed, for any phone.
	if _, err := tx.Exec(ctx, `
		UPDATE sms_gateway_dispatch
		   SET state = 'queued', device_id = NULL, lease_expires_at = NULL,
		       claimed_at = NULL, updated_at = now(),
		       error = 'the phone claimed this and did not confirm it; returned to the queue'
		 WHERE institution_id = $1
		   AND state = 'dispatching'
		   AND lease_expires_at < now()
		   AND attempt < $2`, inst, smsGatewayMaxAttempts); err != nil {
		return err
	}

	/* Over the bound: stop.

	   This is the duplicate-suppression rule, and it is the one place in this
	   file where the safe thing and the helpful thing disagree. A message that
	   has been claimed three times and confirmed none of them might never have
	   left the handset -- or might have left it three times, with the receipts
	   lost. There is no way to tell from here. Re-queueing it a fourth time
	   optimises for the first case and risks the second, and the second is the
	   one that makes a parent ring the office. So it stops, message_log is told
	   why, and a human decides. */
	rows, err := tx.Query(ctx, `
		UPDATE sms_gateway_dispatch
		   SET state = 'expired', completed_at = now(), updated_at = now(),
		       error = 'claimed by a phone that never confirmed it, and not re-sent — it may already have gone out'
		 WHERE institution_id = $1
		   AND state = 'dispatching'
		   AND lease_expires_at < now()
		   AND attempt >= $2
		RETURNING message_id`, inst, smsGatewayMaxAttempts)
	if err != nil {
		return err
	}
	var abandoned []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		abandoned = append(abandoned, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(abandoned) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE message_log
			   SET status = 'failed',
			       error  = 'the office phone claimed this message and never confirmed it. It was not sent again, because it may already have gone out — check with the recipient before re-sending.'
			 WHERE institution_id = $1 AND id = ANY($2) AND status <> 'failed'`,
			inst, abandoned); err != nil {
			return err
		}
	}

	/* Never collected at all: no phone ever asked for it.

	   Distinct from the case above, and a much easier call -- nothing claimed
	   it, so nothing sent it, and there is no duplicate risk in saying so
	   plainly. A handset switched off over a weekend must not wake on Monday
	   and deliver Friday's absence alerts, which would be worse than silence:
	   the parent gets a notice about a day that is already resolved. */
	_, err = tx.Exec(ctx, `
		UPDATE message_log
		   SET status = 'failed',
		       error  = 'no paired phone collected this message in time, so it was not sent'
		 WHERE institution_id = $1
		   AND provider = $2
		   AND status = 'sent'
		   AND sent_at < now() - $3::interval
		   AND NOT EXISTS (
		         SELECT 1 FROM sms_gateway_dispatch d
		          WHERE d.message_id = message_log.id
		            AND d.state <> 'queued')`,
		inst, smsGatewayProviderName,
		fmt.Sprintf("%d seconds", int(smsGatewayCollectWindow.Seconds())))
	return err
}

// --- device credentials ------------------------------------------------------

/*
The device token, and why it looks like this.

	Three parts: a version tag, the device id, and 32 random bytes.

	    sgw1.<device-uuid>.<43 chars of base64url>

	The id travels in the token because the secret half is stored sealed, and
	AES-GCM's random nonce means the ciphertext is not a value anything can be
	looked up by. So the token names the row, the server opens that row's sealed
	secret, and compares. The alternative -- storing a digest and indexing it --
	would have worked equally well but would be a second at-rest scheme beside
	the one this codebase already operates for provider credentials, and one
	scheme that everybody understands beats two that are each nearly right.

	The version tag is there so that swapping the scheme later is a migration
	rather than an outage: a phone presenting sgw1 when the server has moved on
	gets told to re-pair instead of being told its credential is wrong.

	The comparison is constant-time. A token check that returns early on the
	first wrong byte is a token check that can be solved one byte at a time by
	anything that can measure a response, and this endpoint is reachable from
	the public internet by design.
*/
const smsGatewayTokenPrefix = "sgw1"

func newSMSGatewayToken(device uuid.UUID) (token, secret string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	secret = base64.RawURLEncoding.EncodeToString(raw)
	return smsGatewayTokenPrefix + "." + device.String() + "." + secret, secret, nil
}

func splitSMSGatewayToken(token string) (uuid.UUID, string, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != smsGatewayTokenPrefix {
		return uuid.Nil, "", false
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || parts[2] == "" {
		return uuid.Nil, "", false
	}
	return id, parts[2], true
}

/*
The pair code alphabet.

	Crockford-ish: no I, L, O, U, 0 or 1. Somebody is reading this off a screen
	and typing it into a phone with a cracked digitiser, and "was that a zero or
	an O" is the difference between a paired handset and a support call. Eight
	characters from thirty-two symbols is forty bits, which against a ten-minute
	window and the rate limit below is not brute-forceable.
*/
const smsGatewayCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

func newSMSGatewayPairCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, 8)
	for i, x := range b {
		// Modulo bias over a 30-symbol alphabet is a fraction of a bit against
		// forty. Not worth a rejection loop that could, in principle, not
		// terminate.
		out[i] = smsGatewayCodeAlphabet[int(x)%len(smsGatewayCodeAlphabet)]
	}
	return string(out), nil
}

func hashSMSGatewayCode(code string) []byte {
	sum := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(code))))
	return sum[:]
}

// --- device authentication ---------------------------------------------------

/*
smsGatewayDevice is an authenticated handset: who it is and which school it may
touch.

	Deliberately not an httpx.Identity. A device is not a user: it holds no
	role, appears in no audit trail as a person, and must reach exactly three
	routes. Giving it an Identity would make every RequirePermission in the
	building a decision about a phone, and the one that got it wrong would be
	the one nobody thought to check.
*/
type smsGatewayDevice struct {
	ID           uuid.UUID
	Institution  uuid.UUID
	Name         string
	PollSeconds  int
	PerMinuteCap int
	Paused       bool
}

type smsGatewayCtxKey struct{}

func smsGatewayDeviceFrom(ctx context.Context) *smsGatewayDevice {
	d, _ := ctx.Value(smsGatewayCtxKey{}).(*smsGatewayDevice)
	return d
}

/*
requireSMSGatewayDevice is a second authentication path, and is written as one.

	This is the part of the feature most worth being nervous about. Everything
	else in this API authenticates a human through one middleware that has been
	read a hundred times; this admits a credential that lives in a drawer, and
	it had to be built rather than borrowed because a device has no session, no
	user row and no permissions.

	Four properties, each of which is a test in sms_gateway_test.go:

	  A device token reaches nothing but the three routes this wraps. It is not
	  an Identity, so it cannot satisfy RequireAuth, and every authenticated
	  route in the building sits behind RequireAuth.

	  A device is pinned to its own institution, taken from its row and never
	  from the request. There is no parameter a phone can send that changes
	  which school it is talking about.

	  A revoked device is refused immediately. Revocation has to be the thing
	  that actually stops a lost handset, or it is a checkbox.

	  Wrong, malformed, unknown and revoked all answer the same 401. A phone
	  cannot learn which of those it is, and neither can anything else pointed
	  at this endpoint.

	The lookup runs AsPlatform because there is no institution to scope to until
	the device is found -- the same reason the login lookup does. It is a single
	equality on a primary key, which is the narrowness that doc asks for.
*/
func (s *Server) requireSMSGatewayDevice(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			token = strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		}
		id, secret, ok := splitSMSGatewayToken(token)
		if !ok {
			smsGatewayUnauthorized(w, r)
			return
		}

		var (
			sealed  []byte
			dev     smsGatewayDevice
			revoked *time.Time
		)
		err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT id, institution_id, name, token_sealed, revoked_at,
				       poll_seconds, per_minute_cap, paused
				  FROM sms_gateway_devices
				 WHERE id = $1`, id).
				Scan(&dev.ID, &dev.Institution, &dev.Name, &sealed, &revoked,
					&dev.PollSeconds, &dev.PerMinuteCap, &dev.Paused)
		})
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				// A database fault is not an authentication failure, and
				// reporting it as one would send an operator to look at the
				// phone.
				httpx.Internal(w, r, err)
				return
			}
			smsGatewayUnauthorized(w, r)
			return
		}
		if revoked != nil {
			smsGatewayUnauthorized(w, r)
			return
		}

		want, err := openSecret(sealed)
		if err != nil {
			// CREDENTIAL_KEY has been rotated or the row is damaged. The phone
			// must re-pair; there is nothing it can do with the token it holds.
			smsGatewayUnauthorized(w, r)
			return
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(secret)) != 1 {
			smsGatewayUnauthorized(w, r)
			return
		}

		ctx := context.WithValue(r.Context(), smsGatewayCtxKey{}, &dev)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// One answer for every way of failing. "Unknown device", "wrong secret" and
// "revoked" are the same sentence, because the difference between them is
// information the caller has not earned.
func smsGatewayUnauthorized(w http.ResponseWriter, r *http.Request) {
	httpx.Error(w, r, http.StatusUnauthorized, "device_unauthenticated",
		"this device is not paired with any school — pair it again from the SMS gateway screen")
}

// --- rate limiting the public surface ----------------------------------------

/*
The claim endpoint is unauthenticated, so it is rate limited.

	Reusing the shape admissions_growth.go established for the public admission
	form rather than inventing a second one: an in-process per-address bucket,
	declared as exactly what it is. Behind more than one process it limits per
	process. That is honest and it is enough here, because the thing being
	defended is a forty-bit code with a ten-minute life, and a bucket this size
	makes exhausting it take longer than the code exists for.

	Every attempt counts, valid or not. Limiting only successful claims would
	make a flood of wrong codes free, which is the flood that matters.

	Six in ten minutes is set against the real user: somebody typing an
	eight-character code off a screen into a phone. Three fat-fingered attempts
	and a retry is four; six leaves room without leaving the door open.
*/
type smsGatewayClaimLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

var publicSMSGatewayLimiter = &smsGatewayClaimLimiter{hits: map[string][]time.Time{}}

const (
	smsGatewayClaimWindow = 10 * time.Minute
	smsGatewayClaimBurst  = 6
)

// allow mirrors formLimiter.allow, including the opportunistic single-bucket
// sweep that keeps the map bounded over a long-running process without ever
// walking it under load.
func (l *smsGatewayClaimLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-smsGatewayClaimWindow)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= smsGatewayClaimBurst {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	for k, v := range l.hits {
		if len(v) == 0 || v[len(v)-1].Before(cutoff) {
			delete(l.hits, k)
			break
		}
	}
	return true
}

// --- mounting ----------------------------------------------------------------

/*
mountSMSGateway carries the routes a human uses.

	Spliced into api.go inside the authenticated group, at the top level beside
	s.mountComms(r), so the paths are /api/v1/sms-gateway/... exactly as the wire
	contract states. It inherits RequireAuth, ActingInstitution and
	RequireSubscription from that group and adds its own permission per route.

	The rung is IntegrationsWrite -- institution.integrations.write -- which is
	the same permission the messaging provider screen already requires to store
	an SMTP password (creds in mountMessaging). Nothing was invented: pairing a
	phone mints a credential that can send messages as the school, which is the
	same act as entering a gateway API key, so it is the same rung. Reading the
	screen is InstitutionRead, matching the provider list beside it.

	Both are institution-scoped, and that is the point. This is the school's own
	handset, with the school's own SIM, in the school's own office, paired by
	the school's own administrator -- who holds both of these rungs as a matter
	of course, since institution_admin carries everything except the two
	platform keys. No platform rung appears anywhere in this feature: if
	platform.tenants.write were required, every school would raise a ticket to
	plug in a phone sitting on their own desk. Pinned in
	TestSMSGatewayIsAnInstitutionAdminScreenNotAPlatformOne.

	institution.settings.write would have been defensible too. IntegrationsWrite
	is chosen over it because it is the narrower of the two and is already the
	rung for exactly this class of act -- storing a credential that can send on
	the school's behalf -- so a school that separates "may change settings" from
	"may hold sending credentials" keeps that separation here.
*/
func (s *Server) mountSMSGateway(r chi.Router) {
	read := httpx.RequirePermission(rbac.InstitutionRead)
	creds := httpx.RequirePermission(rbac.IntegrationsWrite)

	r.With(read).Get("/sms-gateway", s.getSMSGatewayOverview)
	r.With(creds).Post("/sms-gateway/pair", s.pairSMSGatewayDevice)
	r.With(creds).Put("/sms-gateway/devices/{id}", s.updateSMSGatewayDevice)
	r.With(creds).Post("/sms-gateway/devices/{id}/revoke", s.revokeSMSGatewayDevice)
}

/*
mountSMSGatewayDevice carries the routes a phone uses, and the one that turns a
code into a phone.

	Spliced into api.go *outside* the authenticated group, beside
	s.mountAdmissionsPublic(r). It has to be: a handset holds no session, and
	the claim has no credential at all until it succeeds. Both would be rejected
	by RequireAuth before reaching a handler.

	The three device routes share the /sms-gateway prefix with the admin routes
	above but are distinct patterns, so chi routes each to its own middleware
	chain. That is worth stating because it looks like an overlap and is not:
	/sms-gateway/pair is registered inside the group with RequireAuth, and
	/sms-gateway/outbox is registered outside it with requireSMSGatewayDevice.
	Neither can be reached by the other's credential.
*/
func (s *Server) mountSMSGatewayDevice(r chi.Router) {
	// Unauthenticated, rate limited, and the only way to become a device.
	r.Post("/public/sms-gateway/claim", s.claimSMSGatewayPairCode)

	r.Group(func(r chi.Router) {
		r.Use(s.requireSMSGatewayDevice)
		r.Get("/sms-gateway/outbox", s.smsGatewayOutbox)
		r.Post("/sms-gateway/receipts", s.smsGatewayReceipts)
		r.Post("/sms-gateway/heartbeat", s.smsGatewayHeartbeat)
	})
}

// --- pairing -----------------------------------------------------------------

type smsGatewayPairResponse struct {
	PairCode  string `json:"pair_code"`
	ExpiresAt string `json:"expires_at"`
	// Repeated on the response so the screen can print the instruction beside
	// the code without a second constant that drifts from this one.
	ValidMinutes int `json:"valid_minutes"`
}

/*
pairSMSGatewayDevice mints a code.

	Generating a new code retires every other unclaimed code for this school.
	Two live codes is a support call waiting to happen -- an administrator reads
	out the one still on their screen while a colleague generates another -- and
	there is no case for a school pairing two handsets in the same ten minutes
	that is not better served by doing it twice.
*/
func (s *Server) pairSMSGatewayDevice(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	code, err := newSMSGatewayPairCode()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	expires := time.Now().Add(smsGatewayPairTTL)

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			UPDATE sms_gateway_pair_codes
			   SET expires_at = now()
			 WHERE institution_id = $1 AND claimed_at IS NULL AND expires_at > now()`,
			id.InstitutionID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO sms_gateway_pair_codes
			       (institution_id, code_hash, created_by, expires_at)
			VALUES ($1, $2, $3, $4)`,
			id.InstitutionID, hashSMSGatewayCode(code), id.UserID, expires)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The one and only time this value exists outside the administrator's
	// screen. It is not logged, and the digest is all that is stored.
	httpx.JSON(w, http.StatusOK, smsGatewayPairResponse{
		PairCode:     code,
		ExpiresAt:    expires.Format(time.RFC3339),
		ValidMinutes: int(smsGatewayPairTTL.Minutes()),
	})
}

type smsGatewayClaimRequest struct {
	PairCode       string `json:"pair_code"`
	DeviceName     string `json:"device_name"`
	AndroidVersion string `json:"android_version"`
	SIMOperator    string `json:"sim_operator"`
	AppVersion     string `json:"app_version"`
}

type smsGatewayClaimResponse struct {
	DeviceID     string `json:"device_id"`
	DeviceToken  string `json:"device_token"`
	Institution  string `json:"institution"`
	PollSeconds  int    `json:"poll_seconds"`
	PerMinuteCap int    `json:"per_minute_cap"`
}

/*
claimSMSGatewayPairCode exchanges a code for a device token, with no credential.

	This is the only unauthenticated write in the feature and it is written
	defensively:

	  Rate limited per address, before anything else, counting every attempt
	  including malformed ones.

	  Invalid, expired and already-claimed are one response. They are genuinely
	  different conditions and the difference is not the caller's to have: an
	  "expired" that differs from "invalid" tells a prober that the code it
	  guessed was real, which is most of the work of guessing it.

	  The institution is never leaked. The response names the school only after
	  a valid code has been presented, which is the point at which the caller
	  already knows which school it is pairing with -- somebody read them the
	  code. Nothing in the failure path names anything.

	  The claim is taken under FOR UPDATE. Two handsets racing on one code both
	  reach the row; the second finds claimed_at set by the first and is refused,
	  rather than both being told yes and the school owning two phones that each
	  believe they are the gateway.
*/
func (s *Server) claimSMSGatewayPairCode(w http.ResponseWriter, r *http.Request) {
	if !publicSMSGatewayLimiter.allow(callerAddress(r), time.Now()) {
		httpx.Error(w, r, http.StatusTooManyRequests, "rate_limited",
			"too many pairing attempts from this network — wait a few minutes and try again")
		return
	}

	var req smsGatewayClaimRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	code := strings.ToUpper(strings.TrimSpace(req.PairCode))
	name := strings.TrimSpace(req.DeviceName)
	if name == "" {
		name = "Office phone"
	}
	// Length is checked before the database is touched, but the answer for a
	// wrong length is the same refusal as for a wrong code.
	if len(code) != 8 {
		smsGatewayClaimRefused(w, r)
		return
	}

	var (
		device   uuid.UUID
		inst     uuid.UUID
		instName string
		token    string
	)
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var codeID uuid.UUID
		var createdBy *uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT id, institution_id, created_by
			  FROM sms_gateway_pair_codes
			 WHERE code_hash = $1
			   AND claimed_at IS NULL
			   AND expires_at > now()
			 FOR UPDATE`, hashSMSGatewayCode(code)).
			Scan(&codeID, &inst, &createdBy)
		if err != nil {
			return err
		}

		device = uuid.New()
		var secret string
		token, secret, err = newSMSGatewayToken(device)
		if err != nil {
			return err
		}
		sealed, err := sealSecret(secret)
		if err != nil {
			return err
		}

		/* A name collision is not a reason to refuse a pairing.

		   Two handsets both reporting "Redmi Note 12" is ordinary, and the
		   unique index is on the live rows. The office can rename either one
		   afterwards; being unable to pair the second phone at all would be a
		   worse answer than a suffix. */
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO sms_gateway_devices
			       (id, institution_id, name, android_version, sim_operator,
			        app_version, token_sealed, pair_code_id, paired_by,
			        poll_seconds, per_minute_cap)
			VALUES ($1, $2,
			        $3 || COALESCE((SELECT ' (' || (count(*) + 1) || ')'
			                          FROM sms_gateway_devices d
			                         WHERE d.institution_id = $2
			                           AND d.revoked_at IS NULL
			                           AND lower(d.name) = lower($3)
			                        HAVING count(*) > 0), ''),
			        $4, $5, $6, $7, $8, $9, $10, $11)`,
			device, inst, truncate(name, 80),
			nullIfBlank(req.AndroidVersion), nullIfBlank(req.SIMOperator),
			nullIfBlank(req.AppVersion), sealed, codeID, createdBy,
			smsGatewayDefaultPoll, smsGatewayDefaultCap); err != nil {
			return err
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE sms_gateway_pair_codes
			   SET claimed_at = now(), claimed_device_id = $2
			 WHERE id = $1`, codeID, device); err != nil {
			return err
		}

		return tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, inst).Scan(&instName)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			smsGatewayClaimRefused(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}

	// The token is returned exactly once. It is not stored in clear, not
	// logged, and there is no endpoint that reads it back — a phone that loses
	// it re-pairs.
	httpx.JSON(w, http.StatusOK, smsGatewayClaimResponse{
		DeviceID:     device.String(),
		DeviceToken:  token,
		Institution:  instName,
		PollSeconds:  smsGatewayDefaultPoll,
		PerMinuteCap: smsGatewayDefaultCap,
	})
}

// One sentence for invalid, expired and already-used alike, naming no school.
func smsGatewayClaimRefused(w http.ResponseWriter, r *http.Request) {
	httpx.Error(w, r, http.StatusUnauthorized, "pair_code_invalid",
		"that pairing code is not usable — ask the school office for a new one")
}

func nullIfBlank(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	out := truncate(s, 80)
	return &out
}

// --- the polling loop --------------------------------------------------------

type smsGatewayOutboxMessage struct {
	ID      string `json:"id"`
	To      string `json:"to"`
	Body    string `json:"body"`
	Attempt int    `json:"attempt"`
}

type smsGatewayOutboxResponse struct {
	Messages     []smsGatewayOutboxMessage `json:"messages"`
	PollSeconds  int                       `json:"poll_seconds"`
	PerMinuteCap int                       `json:"per_minute_cap"`
	Paused       bool                      `json:"paused"`
}

/*
smsGatewayOutbox hands a phone its work, atomically.

	The claim is the heart of the feature. Two phones paired to one school
	polling at the same instant must never both receive the same message, and
	the mechanism is the one DispatchMessages already uses a few lines away:
	SELECT ... FOR UPDATE SKIP LOCKED, then move the rows to a state the next
	claim will not select.

	SKIP LOCKED rather than a plain FOR UPDATE because the second phone should
	walk past the first phone's rows and take different ones, not queue behind
	them for the duration of a network round trip.

	The predicate has two legs, and both are needed:

	  no ledger row yet          -- the message has never been offered
	  a ledger row whose lease
	  has run out                -- a phone took it and did not come back

	The second leg is what makes re-delivery independent of the sweeper: a
	lapsed lease is takeable in the same statement that takes it, so nothing
	waits on a scheduler tick. attempt is carried forward and bounded, which is
	what stops recovery turning into a parent's second copy.

	The body is read from message_log here and travels no further. It is not
	written to the ledger, not logged, and the response is the only place it
	exists outside that table.
*/
func (s *Server) smsGatewayOutbox(w http.ResponseWriter, r *http.Request) {
	dev := smsGatewayDeviceFrom(r.Context())
	if dev == nil {
		smsGatewayUnauthorized(w, r)
		return
	}

	max := smsGatewayMaxBatch
	if raw := strings.TrimSpace(r.URL.Query().Get("max")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n < max {
			max = n
		}
	}

	out := smsGatewayOutboxResponse{
		Messages:     []smsGatewayOutboxMessage{},
		PollSeconds:  dev.PollSeconds,
		PerMinuteCap: dev.PerMinuteCap,
		Paused:       dev.Paused,
	}

	// A paused device is told the truth and given nothing. It keeps polling, so
	// un-pausing takes effect within one poll without anybody touching the
	// phone.
	if dev.Paused {
		httpx.JSON(w, http.StatusOK, out)
		return
	}

	// The device's own institution, from its row. Never from the request: there
	// is no parameter here that can change which school's messages are read.
	scope := tenantScopeFor(dev.Institution, false)

	err := s.DB.InTenant(r.Context(), scope, func(tx pgx.Tx) error {
		if err := sweepSMSGatewayLeases(r.Context(), tx, dev.Institution); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			WITH claimable AS (
			    SELECT m.id AS message_id, d.id AS dispatch_id,
			           COALESCE(d.attempt, 0) AS attempt
			      FROM message_log m
			      LEFT JOIN sms_gateway_dispatch d ON d.message_id = m.id
			     WHERE m.institution_id = $1
			       AND m.channel  = 'sms'
			       AND m.provider = $2
			       AND m.status   = 'sent'
			       AND m.sent_at > now() - $5::interval
			       AND (
			             d.id IS NULL
			             OR (d.state = 'queued')
			             OR (d.state = 'dispatching' AND d.lease_expires_at < now()
			                 AND d.attempt < $6)
			           )
			     ORDER BY m.queued_at
			     FOR UPDATE OF m SKIP LOCKED
			     LIMIT $3
			)
			INSERT INTO sms_gateway_dispatch
			       (institution_id, message_id, device_id, state, attempt,
			        claimed_at, lease_expires_at)
			SELECT $1, c.message_id, $4, 'dispatching', c.attempt + 1,
			       now(), now() + $7::interval
			  FROM claimable c
			ON CONFLICT (message_id) DO UPDATE
			   SET device_id        = EXCLUDED.device_id,
			       state            = 'dispatching',
			       attempt          = sms_gateway_dispatch.attempt + 1,
			       claimed_at       = now(),
			       lease_expires_at = EXCLUDED.lease_expires_at,
			       error            = NULL,
			       updated_at       = now()
			RETURNING message_id, attempt`,
			dev.Institution, smsGatewayProviderName, max, dev.ID,
			fmt.Sprintf("%d seconds", int(smsGatewayCollectWindow.Seconds())),
			smsGatewayMaxAttempts,
			fmt.Sprintf("%d seconds", int(smsGatewayLease.Seconds())))
		if err != nil {
			return err
		}
		claimed := map[uuid.UUID]int{}
		order := []uuid.UUID{}
		for rows.Next() {
			var id uuid.UUID
			var attempt int
			if err := rows.Scan(&id, &attempt); err != nil {
				rows.Close()
				return err
			}
			claimed[id] = attempt
			order = append(order, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(order) == 0 {
			return nil
		}

		/* The bodies, read only now and only for the rows this device just
		   won.

		   A separate statement rather than a RETURNING over a join, because
		   the INSERT ... RETURNING can only return columns of the row it wrote
		   and the ledger row has no body in it -- which is the point. */
		bodies, err := tx.Query(r.Context(), `
			SELECT id, recipient, COALESCE(body, '')
			  FROM message_log
			 WHERE institution_id = $1 AND id = ANY($2)`,
			dev.Institution, order)
		if err != nil {
			return err
		}
		defer bodies.Close()
		byID := map[uuid.UUID]smsGatewayOutboxMessage{}
		for bodies.Next() {
			var id uuid.UUID
			var to, body string
			if err := bodies.Scan(&id, &to, &body); err != nil {
				return err
			}
			byID[id] = smsGatewayOutboxMessage{
				ID: id.String(), To: to, Body: body, Attempt: claimed[id],
			}
		}
		if err := bodies.Err(); err != nil {
			return err
		}
		// Oldest first, which is the order the claim chose and the order a
		// school would want a backlog sent in.
		for _, id := range order {
			if m, ok := byID[id]; ok {
				out.Messages = append(out.Messages, m)
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type smsGatewayReceipt struct {
	ID     string  `json:"id"`
	Status string  `json:"status"`
	SentAt *string `json:"sent_at,omitempty"`
	Error  *string `json:"error,omitempty"`
	Parts  *int    `json:"parts,omitempty"`
}

type smsGatewayReceiptsRequest struct {
	Receipts []smsGatewayReceipt `json:"receipts"`
}

/*
smsGatewayReceipts records what actually happened, idempotently.

	A phone that sends a message and then loses the network before its receipt
	lands will retry that receipt. It must be free to do so: the retry has to
	change nothing and must certainly not cause a second send.

	Idempotency is on the message id, which the unique index on
	sms_gateway_dispatch(message_id) makes structural. The UPDATE is guarded on
	the row still being in flight, so a receipt arriving for a message already
	settled is counted as accepted and applied to nothing. The phone gets its
	acknowledgement either way, because a phone that is told "no" retries
	forever.

	A device may only settle rows it holds. The WHERE names this device, so a
	second handset on the same school cannot report on the first one's work --
	which would otherwise be a way to mark a message sent that was never sent.

	A failure is written back to message_log so the message log screen and the
	admin screen agree. It is written as 'failed' rather than returned to the
	queue on purpose: the phone has told us it tried, and the retry decision for
	a message that may have been partly delivered belongs to a person.
*/
func (s *Server) smsGatewayReceipts(w http.ResponseWriter, r *http.Request) {
	dev := smsGatewayDeviceFrom(r.Context())
	if dev == nil {
		smsGatewayUnauthorized(w, r)
		return
	}
	var req smsGatewayReceiptsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Receipts) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]int{"accepted": 0})
		return
	}
	if len(req.Receipts) > 200 {
		httpx.BadRequest(w, r, "too many receipts in one call — send at most 200")
		return
	}

	accepted := 0
	// Raised when a receipt names a message this school has no ledger row for.
	// See the check below.
	var errForeignMessage = errors.New("receipt names a message that is not this school's")

	err := s.DB.InTenant(r.Context(), tenantScopeFor(dev.Institution, false), func(tx pgx.Tx) error {
		/* Every id in the batch must belong to this device's own school.

		   A phone only ever learns an id by being handed one from its own
		   outbox, so an id from anywhere else is not a bug to be tolerated --
		   it is somebody with a device token probing for another school's
		   messages. It is refused as 404: not 403, because "you may not touch
		   that" concedes that it exists, and a device that can tell a real
		   message id of another school from a made-up one can enumerate them.
		   To this device the row simply is not there, which is also exactly
		   what RLS makes true one layer down.

		   The whole batch is rejected rather than the offending entry skipped.
		   A mixed batch is not a phone making a mistake. */
		ids := make([]uuid.UUID, 0, len(req.Receipts))
		for _, rec := range req.Receipts {
			if id, err := uuid.Parse(strings.TrimSpace(rec.ID)); err == nil {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			var known int
			if err := tx.QueryRow(r.Context(), `
				SELECT count(DISTINCT message_id)
				  FROM sms_gateway_dispatch
				 WHERE institution_id = $1 AND message_id = ANY($2)`,
				dev.Institution, ids).Scan(&known); err != nil {
				return err
			}
			distinct := map[uuid.UUID]struct{}{}
			for _, id := range ids {
				distinct[id] = struct{}{}
			}
			if known != len(distinct) {
				return errForeignMessage
			}
		}

		for _, rec := range req.Receipts {
			id, err := uuid.Parse(strings.TrimSpace(rec.ID))
			if err != nil {
				// A receipt for something that is not an id is not worth
				// failing the whole batch over; the rest are real.
				continue
			}
			status := strings.ToLower(strings.TrimSpace(rec.Status))
			if status != "sent" && status != "failed" {
				continue
			}
			accepted++

			// The handset's reason, capped. Never a body: the phone is told in
			// the contract never to log one, and this is the one field it could
			// smuggle one through, so it is bounded and stored on the ledger
			// beside a message id rather than anywhere it could be mistaken for
			// content.
			var reason *string
			if rec.Error != nil {
				if t := truncate(*rec.Error, 200); t != "" {
					reason = &t
				}
			}

			ct, err := tx.Exec(r.Context(), `
				UPDATE sms_gateway_dispatch
				   SET state        = $3,
				       completed_at = now(),
				       parts        = COALESCE($4, parts),
				       error        = $5,
				       updated_at   = now()
				 WHERE institution_id = $1
				   AND message_id     = $2
				   AND device_id      = $6
				   AND state          = 'dispatching'`,
				dev.Institution, id, status, rec.Parts, reason, dev.ID)
			if err != nil {
				return err
			}
			// Already settled by an earlier copy of this same receipt. Counted
			// as accepted, applied to nothing — which is what idempotent means
			// here.
			if ct.RowsAffected() == 0 {
				continue
			}

			if status == "failed" {
				msg := "the office phone could not send this"
				if reason != nil {
					msg += ": " + *reason
				}
				if _, err := tx.Exec(r.Context(), `
					UPDATE message_log
					   SET status = 'failed', error = $3
					 WHERE institution_id = $1 AND id = $2`,
					dev.Institution, id, truncate(msg, 500)); err != nil {
					return err
				}
				continue
			}
			// A confirmed send: clear any error a previous lapsed attempt left
			// on the row, and record the moment the handset says it went, not
			// the moment the dispatcher handed it over.
			if _, err := tx.Exec(r.Context(), `
				UPDATE message_log
				   SET error = NULL,
				       sent_at = COALESCE($3::timestamptz, sent_at)
				 WHERE institution_id = $1 AND id = $2 AND status = 'sent'`,
				dev.Institution, id, rec.SentAt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, errForeignMessage) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]int{"accepted": accepted})
}

type smsGatewayHeartbeatRequest struct {
	BatteryPct *int    `json:"battery_pct,omitempty"`
	Charging   *bool   `json:"charging,omitempty"`
	SignalDBM  *int    `json:"signal_dbm,omitempty"`
	SIMReady   *bool   `json:"sim_ready,omitempty"`
	AppVersion *string `json:"app_version,omitempty"`
	SentToday  *int    `json:"sent_today,omitempty"`
}

type smsGatewayHeartbeatResponse struct {
	PollSeconds  int  `json:"poll_seconds"`
	PerMinuteCap int  `json:"per_minute_cap"`
	Paused       bool `json:"paused"`
}

/*
smsGatewayHeartbeat is how the admin screen knows the phone is alive.

	The most important write in this file, and the cheapest. Everything the
	staleness judgement rests on is this one UPDATE landing every twenty
	seconds; if it stops, the provider goes unconfigured, the dispatcher stops
	handing over messages, and the screen says how long it has been.

	Values are clamped rather than rejected. A handset reporting a battery of
	137 is a driver quirk on some vendor ROM, and refusing the whole heartbeat
	over it would take the gateway down for a cosmetic field.
*/
func (s *Server) smsGatewayHeartbeat(w http.ResponseWriter, r *http.Request) {
	dev := smsGatewayDeviceFrom(r.Context())
	if dev == nil {
		smsGatewayUnauthorized(w, r)
		return
	}
	var req smsGatewayHeartbeatRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	out := smsGatewayHeartbeatResponse{
		PollSeconds:  dev.PollSeconds,
		PerMinuteCap: dev.PerMinuteCap,
		Paused:       dev.Paused,
	}
	err := s.DB.InTenant(r.Context(), tenantScopeFor(dev.Institution, false), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			UPDATE sms_gateway_devices
			   SET last_seen_at = now(),
			       battery_pct  = COALESCE($3, battery_pct),
			       charging     = COALESCE($4, charging),
			       signal_dbm   = COALESCE($5, signal_dbm),
			       sim_ready    = COALESCE($6, sim_ready),
			       app_version  = COALESCE($7, app_version),
			       sent_today   = COALESCE($8, sent_today),
			       updated_at   = now()
			 WHERE institution_id = $1 AND id = $2`,
			dev.Institution, dev.ID,
			clampPtr(req.BatteryPct, 0, 100),
			req.Charging,
			clampPtr(req.SignalDBM, -140, 0),
			req.SIMReady,
			nullIfBlankPtr(req.AppVersion),
			clampPtr(req.SentToday, 0, 100000)); err != nil {
			return err
		}
		// A phone checking in is the right moment to release whatever it
		// abandoned last time it did not.
		return sweepSMSGatewayLeases(r.Context(), tx, dev.Institution)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func clampPtr(p *int, lo, hi int) *int {
	if p == nil {
		return nil
	}
	v := *p
	if v < lo {
		v = lo
	}
	if v > hi {
		v = hi
	}
	return &v
}

func nullIfBlankPtr(p *string) *string {
	if p == nil {
		return nil
	}
	return nullIfBlank(*p)
}

// --- the admin screen's data -------------------------------------------------

type smsGatewayDeviceView struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	AndroidVersion *string `json:"android_version,omitempty"`
	SIMOperator    *string `json:"sim_operator,omitempty"`
	AppVersion     *string `json:"app_version,omitempty"`
	PairedAt       string  `json:"paired_at"`
	LastSeenAt     *string `json:"last_seen_at,omitempty"`
	// How long since the heartbeat, already rendered — the screen must not have
	// to do clock arithmetic to decide how loud to be, and two clients doing it
	// differently is two answers to one question.
	SilentFor string `json:"silent_for,omitempty"`
	// The judgement itself, made here: live | stale | paused | never.
	Health       string `json:"health"`
	BatteryPct   *int   `json:"battery_pct,omitempty"`
	Charging     *bool  `json:"charging,omitempty"`
	SignalDBM    *int   `json:"signal_dbm,omitempty"`
	SIMReady     *bool  `json:"sim_ready,omitempty"`
	Paused       bool   `json:"paused"`
	PollSeconds  int    `json:"poll_seconds"`
	PerMinuteCap int    `json:"per_minute_cap"`
	SentToday    int    `json:"sent_today"`
	FailedToday  int    `json:"failed_today"`
	PartsToday   int    `json:"parts_today"`
}

type smsGatewayFailureView struct {
	MessageID string  `json:"message_id"`
	Device    *string `json:"device,omitempty"`
	At        string  `json:"at"`
	Reason    string  `json:"reason"`
	State     string  `json:"state"`
}

type smsGatewayOverview struct {
	// Whether this school has chosen the phone gateway at all.
	Selected bool `json:"selected"`
	// The provider's own answer, verbatim: the sentence the dispatcher would
	// refuse with.
	Configured bool   `json:"configured"`
	Reason     string `json:"reason,omitempty"`

	Devices  []smsGatewayDeviceView  `json:"devices"`
	Failures []smsGatewayFailureView `json:"failures"`

	// Waiting for a phone to collect them.
	Waiting int `json:"waiting"`
	// Claimed by a phone right now.
	InFlight int `json:"in_flight"`

	SentToday   int `json:"sent_today"`
	FailedToday int `json:"failed_today"`
	PartsToday  int `json:"parts_today"`

	// The compliance sentence, served rather than hard-coded in the client, so
	// there is one copy of it and it cannot be edited out of the UI without
	// this file changing.
	Advisory string `json:"advisory"`
}

/*
smsGatewayAdvisory is the sentence that has to appear in the product.

	Served from the server rather than written into the screen because a
	constant in a TSX file is one refactor away from being dropped, and this one
	is not decoration. A school that believes it has bought bulk SMS will send a
	fee campaign to nine hundred families from a personal SIM and have the
	number disconnected, and the first they will know is that nothing arrives.
*/
const smsGatewayAdvisory = "This is not a licensed bulk-SMS service. Indian commercial SMS requires a DLT-registered sender id and pre-approved templates; a personal SIM sending in bulk will be throttled by the carrier and may be disconnected. Use this for tens of messages a day to a few hundred families — for a fee campaign to the whole school, buy a licensed gateway."

/*
getSMSGatewayOverview is the whole admin screen in one call.

	One endpoint rather than four, because every panel on that screen is about
	the same question and a screen assembled from four requests shows four
	different moments — the device looks alive in one card while the failure
	list beside it is from before it died.
*/
func (s *Server) getSMSGatewayOverview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := smsGatewayOverview{
		Devices:  []smsGatewayDeviceView{},
		Failures: []smsGatewayFailureView{},
		Advisory: smsGatewayAdvisory,
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Is the phone gateway the configured sms provider for this school?
		var cfg []byte
		var enabled bool
		err := tx.QueryRow(r.Context(), `
			SELECT config, enabled FROM integrations
			 WHERE institution_id = $1 AND kind = 'messaging' AND provider = 'sms'`,
			id.InstitutionID).Scan(&cfg, &enabled)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		out.Selected = err == nil && enabled && isPhoneGatewayConfig(cfg)

		// The provider's own sentence, so the screen and the dispatcher can
		// never disagree about why nothing is going out.
		reason, err := smsGatewayReason(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		out.Configured = reason == ""
		out.Reason = reason

		rows, err := tx.Query(r.Context(), `
			SELECT d.id, d.name, d.android_version, d.sim_operator, d.app_version,
			       to_char(d.paired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(d.last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       EXTRACT(EPOCH FROM (now() - d.last_seen_at)),
			       d.battery_pct, d.charging, d.signal_dbm, d.sim_ready,
			       d.paused, d.poll_seconds, d.per_minute_cap,
			       COALESCE(t.sent, 0), COALESCE(t.failed, 0), COALESCE(t.parts, 0)
			  FROM sms_gateway_devices d
			  LEFT JOIN LATERAL (
			      SELECT count(*) FILTER (WHERE g.state = 'sent')                    AS sent,
			             count(*) FILTER (WHERE g.state IN ('failed','expired'))     AS failed,
			             COALESCE(sum(g.parts) FILTER (WHERE g.state = 'sent'), 0)   AS parts
			        FROM sms_gateway_dispatch g
			       WHERE g.institution_id = d.institution_id
			         AND g.device_id      = d.id
			         AND g.completed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
			                               AT TIME ZONE 'Asia/Kolkata'
			  ) t ON true
			 WHERE d.institution_id = $1 AND d.revoked_at IS NULL
			 ORDER BY d.paired_at`, id.InstitutionID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v smsGatewayDeviceView
			var silent *float64
			if err := rows.Scan(&v.ID, &v.Name, &v.AndroidVersion, &v.SIMOperator,
				&v.AppVersion, &v.PairedAt, &v.LastSeenAt, &silent,
				&v.BatteryPct, &v.Charging, &v.SignalDBM, &v.SIMReady,
				&v.Paused, &v.PollSeconds, &v.PerMinuteCap,
				&v.SentToday, &v.FailedToday, &v.PartsToday); err != nil {
				rows.Close()
				return err
			}
			/* The judgement, made once, here.

			   'never' is separated from 'stale' because they send an
			   administrator to different places: a phone that has never
			   reported has an app that was not opened or a token that was not
			   pasted, and a phone that has stopped reporting is in a drawer
			   with a flat battery. */
			switch {
			case v.Paused:
				v.Health = "paused"
			case silent == nil:
				v.Health = "never"
			case time.Duration(*silent)*time.Second > smsGatewayHeartbeatWindow:
				v.Health = "stale"
				v.SilentFor = humanSilence(time.Duration(*silent) * time.Second)
			default:
				v.Health = "live"
				v.SilentFor = humanSilence(time.Duration(*silent) * time.Second)
			}
			out.Devices = append(out.Devices, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT
			  count(*) FILTER (WHERE m.status = 'sent' AND (g.id IS NULL OR g.state = 'queued')),
			  count(*) FILTER (WHERE g.state = 'dispatching')
			  FROM message_log m
			  LEFT JOIN sms_gateway_dispatch g ON g.message_id = m.id
			 WHERE m.institution_id = $1 AND m.provider = $2`,
			id.InstitutionID, smsGatewayProviderName).
			Scan(&out.Waiting, &out.InFlight); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE state = 'sent'),
			       count(*) FILTER (WHERE state IN ('failed','expired')),
			       COALESCE(sum(parts) FILTER (WHERE state = 'sent'), 0)
			  FROM sms_gateway_dispatch
			 WHERE institution_id = $1
			   AND completed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
			                       AT TIME ZONE 'Asia/Kolkata'`,
			id.InstitutionID).
			Scan(&out.SentToday, &out.FailedToday, &out.PartsToday); err != nil {
			return err
		}

		// Failures with their reasons. The message id, not the message: a
		// screen that listed what could not be sent would be a screen that
		// copies bodies out of message_log for anybody who can open it.
		fails, err := tx.Query(r.Context(), `
			SELECT g.message_id, d.name,
			       to_char(g.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       COALESCE(g.error, 'no reason reported'), g.state
			  FROM sms_gateway_dispatch g
			  LEFT JOIN sms_gateway_devices d ON d.id = g.device_id
			 WHERE g.institution_id = $1
			   AND g.state IN ('failed','expired')
			   AND g.completed_at IS NOT NULL
			 ORDER BY g.completed_at DESC
			 LIMIT 50`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer fails.Close()
		for fails.Next() {
			var f smsGatewayFailureView
			if err := fails.Scan(&f.MessageID, &f.Device, &f.At, &f.Reason, &f.State); err != nil {
				return err
			}
			out.Failures = append(out.Failures, f)
		}
		return fails.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type smsGatewayDevicePatch struct {
	Name         *string `json:"name,omitempty"`
	Paused       *bool   `json:"paused,omitempty"`
	PollSeconds  *int    `json:"poll_seconds,omitempty"`
	PerMinuteCap *int    `json:"per_minute_cap,omitempty"`
}

// updateSMSGatewayDevice renames a phone, pauses it, or changes the rate the
// server tells it to obey.
func (s *Server) updateSMSGatewayDevice(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	deviceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "that is not a device id")
		return
	}
	var req smsGatewayDevicePatch
	if !httpx.Decode(w, r, &req) {
		return
	}

	var name *string
	if req.Name != nil {
		if n := truncate(*req.Name, 80); n != "" {
			name = &n
		} else {
			httpx.BadRequest(w, r, "a phone needs a name somebody can recognise")
			return
		}
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE sms_gateway_devices
			   SET name           = COALESCE($3, name),
			       paused         = COALESCE($4, paused),
			       poll_seconds   = COALESCE($5, poll_seconds),
			       per_minute_cap = COALESCE($6, per_minute_cap),
			       updated_at     = now()
			 WHERE institution_id = $1 AND id = $2 AND revoked_at IS NULL`,
			id.InstitutionID, deviceID, name, req.Paused,
			clampPtr(req.PollSeconds, 5, 300),
			clampPtr(req.PerMinuteCap, 1, 60))
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type smsGatewayRevokeRequest struct {
	Reason string `json:"reason"`
}

/*
revokeSMSGatewayDevice ends a handset's life as a gateway.

	A column, not a DELETE: the dispatch ledger is the record of messages that
	did go out, and removing the device would orphan it.

	Whatever this phone was holding goes back to the queue in the same
	transaction. A lost handset that is revoked while it holds four leases must
	not take four absence alerts with it and leave them stuck until a lease
	lapses -- the office revoked it precisely because it is not coming back.
	Those rows keep their attempt count, so returning them here cannot become an
	unbounded retry.
*/
func (s *Server) revokeSMSGatewayDevice(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	deviceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "that is not a device id")
		return
	}
	var req smsGatewayRevokeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE sms_gateway_devices
			   SET revoked_at = now(), revoked_reason = $3, paused = true,
			       updated_at = now()
			 WHERE institution_id = $1 AND id = $2 AND revoked_at IS NULL`,
			id.InstitutionID, deviceID, nullIfBlank(req.Reason))
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE sms_gateway_dispatch
			   SET state = 'queued', device_id = NULL, lease_expires_at = NULL,
			       claimed_at = NULL, updated_at = now(),
			       error = 'the phone holding this was revoked; returned to the queue'
			 WHERE institution_id = $1 AND device_id = $2 AND state = 'dispatching'`,
			id.InstitutionID, deviceID)
		return err
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
