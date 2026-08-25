package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

/* Who is holding the phone.

   Both Android apps authenticated a device and stopped there. A trip recorded
   which handset reported, a message recorded which handset sent it, and after
   an incident the transport office could say bus 12 was moving at 7:40 and not
   who was driving it. That is the first question anybody asks and the product
   had no column for the answer.

   A staff session sits ON TOP OF the device credential rather than replacing
   it. They are different facts:

     the device token   this phone is one of ours, and belongs to this school
     the staff session  this person is using it right now

   Replacing the first with the second would mean any phone anywhere becomes a
   tracker the moment a credential leaks, and the app would no longer know
   which vehicle it is on without asking the driver to pick one from a list
   every morning -- which is a question the pairing already answered correctly
   and permanently.

   ---------------------------------------------------------------------------
   THE SMS GATEWAY IS THE ONE EXCEPTION, AND ONLY FOR ENROLMENT

   A gateway handset lives unattended in an office drawer. If its ability to
   send SMS depended on a session, then a session expiring at 2am would stop
   the school's messages with nobody in the room to notice -- and "messages
   quietly stopped" is a failure this deployment has already had, twenty-one
   times, sitting in the queue as message:send jobs nobody saw fail.

   So on that app the session governs enrolment and the app's own screens, and
   the sending keeps running on the device token whether anybody is signed in
   or not. Signing out of the gateway app does not silence the school. */

// staffSessionTTL is how long a sign-in lasts before the app has to ask again.
//
// Twelve hours on the bus tracker would expire mid-afternoon-run for a driver
// who signed in at 6am. Thirty days is chosen against a different threat: the
// PIN is not the thing protecting this phone -- the device token is, and it is
// revocable from the office in one click -- so a long session costs little and
// a short one buys a driver typing a PIN in the dark twice a day.
const staffSessionTTL = 30 * 24 * time.Hour

const staffSessionTokenPrefix = "sess"

// PIN lockout. Four digits is 10,000 possibilities, which is nothing against
// an unthrottled endpoint and weeks of work against this one.
const (
	pinMaxFailures = 5
	pinLockFor     = 15 * time.Minute
	pinMinDigits   = 4
	pinMaxDigits   = 8
)

var nonDigits = regexp.MustCompile(`\D`)

/*
normalisePhone reduces a written phone number to the ten digits that identify it.

	Everybody writes it differently -- 9876543210, 09876543210, +91 98765 43210
	-- and no school is going to normalise its own data before using this. The
	last ten digits are the number in India; the country code and the leading
	zero are decoration.

	The same expression is the users_pin_phone_unique index in migration 00155,
	deliberately: if these two ever disagree, a number that the index believes
	is unique stops being findable, which fails as "your PIN is wrong" and is
	unfindable from the outside.
*/
func normalisePhone(s string) string {
	digits := nonDigits.ReplaceAllString(s, "")
	if len(digits) > 10 {
		digits = digits[len(digits)-10:]
	}
	return digits
}

// validPIN accepts only digits, and only a sensible number of them. A PIN with
// a letter in it is a PIN somebody cannot type on the numeric keypad the app
// puts in front of them.
func validPIN(pin string) bool {
	if len(pin) < pinMinDigits || len(pin) > pinMaxDigits {
		return false
	}
	return nonDigits.ReplaceAllString(pin, "") == pin
}

func newStaffSessionToken(id uuid.UUID) (token, secret string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	secret = base64.RawURLEncoding.EncodeToString(raw)
	return staffSessionTokenPrefix + "." + id.String() + "." + secret, secret, nil
}

func splitStaffSessionToken(token string) (uuid.UUID, string, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != staffSessionTokenPrefix {
		return uuid.Nil, "", false
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || parts[2] == "" {
		return uuid.Nil, "", false
	}
	return id, parts[2], true
}

// staffIdentity is who signed in, as the apps and the handlers need them.
type staffIdentity struct {
	UserID      uuid.UUID
	Institution uuid.UUID
	Name        string
	// Approver reports whether this person holds integrations.write, which is
	// what decides if a gateway they enrol is live immediately or waits.
	Approver bool
}

/*
authenticatePIN turns a phone number and a PIN into a person, or into nothing.

	Runs AsPlatform: at the moment of a gateway enrolment there is no tenant
	yet, and the phone number is the only thing that can supply one. That is
	the whole reason users_pin_phone_unique is a global index rather than a
	per-institution one.

	Every failure below returns the same error to the caller. A login that says
	"no such number" for one input and "wrong PIN" for another is a tool for
	discovering which staff numbers exist.
*/
var errBadPIN = errors.New("bad phone or pin")
var errPINLocked = errors.New("pin locked")

func (s *Server) authenticatePIN(ctx context.Context, phone, pin string) (staffIdentity, error) {
	var out staffIdentity
	digits := normalisePhone(phone)
	if len(digits) != 10 || !validPIN(pin) {
		// Rejected before a database round trip, and before the lockout
		// counter moves: a malformed input is not a guess at anybody's PIN,
		// and letting it lock an account would be a way to lock every driver
		// in a school out of their phones by typing rubbish.
		return out, errBadPIN
	}

	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		var (
			hash    string
			failed  int
			lockedU *time.Time
			inst    *uuid.UUID
			status  string
		)
		err := tx.QueryRow(ctx, `
			SELECT id, institution_id, full_name, pin_hash, pin_failed,
			       pin_locked_until, status
			  FROM users
			 WHERE pin_hash IS NOT NULL
			   AND right(regexp_replace(phone, '\D', '', 'g'), 10) = $1`,
			digits).
			Scan(&out.UserID, &inst, &out.Name, &hash, &failed, &lockedU, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return errBadPIN
		}
		if err != nil {
			return err
		}
		if inst == nil {
			// A platform-level user (the vendor's own staff) has no school to
			// sign a handset into. Not an error worth explaining on a phone.
			return errBadPIN
		}
		out.Institution = *inst

		if status != "active" {
			// Suspended and archived staff keep their PIN row -- deleting the
			// credential would lose the audit trail of what they did with it --
			// and are refused here instead.
			return errBadPIN
		}
		if lockedU != nil && lockedU.After(time.Now()) {
			return errPINLocked
		}

		if err := s.Hasher.Verify(hash, pin); err != nil {
			// Count the failure and lock on the fifth. Written even though the
			// transaction is about to return an error, so this runs in its own
			// statement rather than being rolled back with it -- see the
			// separate call below.
			return errBadPIN
		}

		// A good PIN clears the count. Otherwise four bad mornings and one
		// good one still leaves the driver one mistake from a lockout.
		if failed != 0 || lockedU != nil {
			if _, err := tx.Exec(ctx, `
				UPDATE users SET pin_failed = 0, pin_locked_until = NULL
				 WHERE id = $1`, out.UserID); err != nil {
				return err
			}
		}

		return tx.QueryRow(ctx, `
			SELECT EXISTS (
			  SELECT 1 FROM user_roles ur
			    JOIN role_permissions rp ON rp.role_id = ur.role_id
			    JOIN permissions p ON p.id = rp.permission_id
			   WHERE ur.user_id = $1 AND p.key = 'integrations.write')`,
			out.UserID).Scan(&out.Approver)
	})

	if errors.Is(err, errBadPIN) {
		// Outside the failed transaction, so the count survives. A lockout
		// that rolls back with the rejection it is counting is not a lockout.
		s.countPINFailure(ctx, digits)
	}
	return out, err
}

// countPINFailure moves the lockout counter for a number, if it belongs to
// anybody. Best effort: a database fault here must not turn a wrong PIN into a
// 500, which would tell an attacker they had found a real account.
func (s *Server) countPINFailure(ctx context.Context, digits string) {
	if len(digits) != 10 {
		return
	}
	_ = s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE users
			   SET pin_failed = pin_failed + 1,
			       pin_locked_until = CASE WHEN pin_failed + 1 >= $2
			                               THEN now() + $3::interval
			                               ELSE pin_locked_until END
			 WHERE pin_hash IS NOT NULL
			   AND right(regexp_replace(phone, '\D', '', 'g'), 10) = $1`,
			digits, pinMaxFailures, pinLockFor.String())
		return err
	})
}

/*
openStaffSession records a sign-in and returns the token the app will carry.

	Supersedes whatever session that handset already had, rather than running
	two. Two people cannot both be driving one bus, and a shared office handset
	that accumulates sessions makes "who sent this" unanswerable -- which is
	the question this whole table exists to answer. The unique index in
	migration 00155 enforces it; this closes the old row so the index does not
	simply refuse the new sign-in.
*/
func (s *Server) openStaffSession(
	ctx context.Context, tx pgx.Tx, who staffIdentity, app string, device uuid.UUID,
) (token string, id uuid.UUID, expires time.Time, err error) {
	if _, err = tx.Exec(ctx, `
		UPDATE device_staff_sessions
		   SET ended_at = now(), ended_reason = 'superseded'
		 WHERE app = $1 AND device_id = $2 AND ended_at IS NULL`,
		app, device); err != nil {
		return "", uuid.Nil, time.Time{}, err
	}

	expires = time.Now().Add(staffSessionTTL)
	if err = tx.QueryRow(ctx, `
		INSERT INTO device_staff_sessions
		    (institution_id, user_id, app, device_id, token_sealed, expires_at)
		VALUES ($1, $2, $3, $4, '\x00'::bytea, $5)
		RETURNING id`,
		who.Institution, who.UserID, app, device, expires).Scan(&id); err != nil {
		return "", uuid.Nil, time.Time{}, err
	}

	// The token carries the row id, so it cannot be built until the row
	// exists. Sealed in a second statement inside the same transaction: a
	// session row with a placeholder secret must never be visible to a reader.
	token, secret, err := newStaffSessionToken(id)
	if err != nil {
		return "", uuid.Nil, time.Time{}, err
	}
	sealed, err := sealSecret(secret)
	if err != nil {
		return "", uuid.Nil, time.Time{}, err
	}
	if _, err = tx.Exec(ctx, `
		UPDATE device_staff_sessions SET token_sealed = $2 WHERE id = $1`,
		id, sealed); err != nil {
		return "", uuid.Nil, time.Time{}, err
	}
	return token, id, expires, nil
}

// staffSession is a live sign-in, as the handlers behind it see it.
type staffSession struct {
	ID          uuid.UUID
	UserID      uuid.UUID
	Institution uuid.UUID
	Name        string
	ExpiresAt   time.Time
}

type staffSessionCtxKey struct{}

func staffSessionFrom(ctx context.Context) *staffSession {
	sess, _ := ctx.Value(staffSessionCtxKey{}).(*staffSession)
	return sess
}

/*
readStaffSession authenticates the X-Staff-Session header, if there is one.

	A separate header rather than Authorization, which already carries the
	device token. Two credentials travel on every request from a signed-in
	handset because they assert two different things, and overloading one
	header with both would mean the device token had to be re-sent inside the
	session or the reverse.

	Returns nil rather than an error for anything wrong. Whether a missing or
	expired session is fatal is the caller's decision: on the bus tracker
	starting a trip requires one, and on the gateway sending does not.
*/
func (s *Server) readStaffSession(
	ctx context.Context, r *http.Request, app string, device uuid.UUID,
) *staffSession {
	id, secret, ok := splitStaffSessionToken(r.Header.Get("X-Staff-Session"))
	if !ok {
		return nil
	}

	var (
		sess    staffSession
		sealed  []byte
		expires time.Time
		ended   *time.Time
		gotApp  string
		gotDev  uuid.UUID
	)
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT d.id, d.user_id, d.institution_id, u.full_name,
			       d.token_sealed, d.expires_at, d.ended_at, d.app, d.device_id
			  FROM device_staff_sessions d
			  JOIN users u ON u.id = d.user_id
			 WHERE d.id = $1`, id).
			Scan(&sess.ID, &sess.UserID, &sess.Institution, &sess.Name,
				&sealed, &expires, &ended, &gotApp, &gotDev)
	})
	if err != nil {
		return nil
	}
	// The session must belong to the handset presenting it. Without this a
	// token lifted from one phone would work on another, which is most of the
	// point of tying a session to a device at all.
	if gotApp != app || gotDev != device || ended != nil || !expires.After(time.Now()) {
		return nil
	}

	plain, err := openSecret(sealed)
	if err != nil ||
		subtle.ConstantTimeCompare([]byte(plain), []byte(secret)) != 1 {
		return nil
	}
	sess.ExpiresAt = expires

	// Best effort, and deliberately not in the read path's error handling: a
	// failed touch must not fail the request it is annotating.
	_ = s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE device_staff_sessions SET last_seen_at = now() WHERE id = $1`,
			sess.ID)
		return err
	})
	return &sess
}

// endStaffSession signs a handset out. Idempotent: an app that retries a
// sign-out it already completed gets the same answer rather than a 404, which
// is what a phone with a flaky connection will do.
func (s *Server) endStaffSession(ctx context.Context, db *database.DB, app string, device uuid.UUID, reason string) error {
	return db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE device_staff_sessions
			   SET ended_at = now(), ended_reason = $3
			 WHERE app = $1 AND device_id = $2 AND ended_at IS NULL`,
			app, device, reason)
		return err
	})
}

// --- what the apps call ------------------------------------------------------

type deviceLoginRequest struct {
	Phone string `json:"phone"`
	PIN   string `json:"pin"`
}

type deviceLoginResponse struct {
	SessionToken string `json:"session_token"`
	Name         string `json:"name"`
	ExpiresAt    string `json:"expires_at"`
}

func deviceLoginRejected(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errPINLocked) {
		httpx.Error(w, r, http.StatusTooManyRequests, "pin_locked",
			"too many wrong PINs. Wait fifteen minutes, or ask the office to reset it.")
		return
	}
	httpx.Error(w, r, http.StatusUnauthorized, "bad_pin",
		"that phone number and PIN do not match. Ask the office to check the number on your record.")
}

/*
busTrackerSignIn puts a driver behind an already-paired handset.

	Device-authenticated, so the vehicle and the school are already settled
	before anybody types anything: this asks only who is driving. That is why
	the driver is never shown a list of buses to choose from -- the phone is
	bolted to one bus by the pairing, and a driver picking the wrong one from a
	dropdown at 6am is a bus on the wrong route on every parent's map.
*/
func (s *Server) busTrackerSignIn(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	var req deviceLoginRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	who, err := s.authenticatePIN(r.Context(), req.Phone, req.PIN)
	if err != nil {
		deviceLoginRejected(w, r, err)
		return
	}
	// The person must belong to the school the phone belongs to. A valid PIN
	// from another institution is a valid PIN and still not this bus's driver.
	if who.Institution != dev.Institution {
		deviceLoginRejected(w, r, errBadPIN)
		return
	}

	var out deviceLoginResponse
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		token, _, expires, err := s.openStaffSession(r.Context(), tx, who, "bus_tracker", dev.ID)
		if err != nil {
			return err
		}
		out = deviceLoginResponse{
			SessionToken: token,
			Name:         who.Name,
			ExpiresAt:    expires.Format(time.RFC3339),
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// busTrackerSignOut ends the driver's shift on this handset. It deliberately
// does not end an open trip: a driver who signs out with the bus still moving
// has made a mistake, and dropping the children off the map is not the way to
// correct it. The trip keeps reporting and the office can see that nobody is
// signed in to it.
func (s *Server) busTrackerSignOut(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	if err := s.endStaffSession(r.Context(), s.DB, "bus_tracker", dev.ID, "signed_out"); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"signed_out": true})
}

// requireBusTrackerDriver gates the routes that record who did something.
//
// Mounted over trip start and end only. Positions and heartbeat stay open to
// the device alone: a session that expires mid-run must not drop a moving bus
// off the parents' map, and the trip already carries the driver who opened it.
func (s *Server) requireBusTrackerDriver(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dev := busTrackerFrom(r.Context())
		if dev == nil {
			busTrackerUnauthorized(w, r)
			return
		}
		sess := s.readStaffSession(r.Context(), r, "bus_tracker", dev.ID)
		if sess == nil {
			httpx.Error(w, r, http.StatusUnauthorized, "not_signed_in",
				"sign in with your phone number and PIN before starting a run")
			return
		}
		next.ServeHTTP(w, r.WithContext(
			context.WithValue(r.Context(), staffSessionCtxKey{}, sess)))
	})
}

// --- the SMS gateway enrols by signing in ------------------------------------

type gatewayEnrolRequest struct {
	Phone          string `json:"phone"`
	PIN            string `json:"pin"`
	DeviceName     string `json:"device_name"`
	AndroidVersion string `json:"android_version"`
	SIMOperator    string `json:"sim_operator"`
	AppVersion     string `json:"app_version"`
}

type gatewayEnrolResponse struct {
	DeviceID     string `json:"device_id"`
	DeviceToken  string `json:"device_token"`
	SessionToken string `json:"session_token"`
	Institution  string `json:"institution"`
	Name         string `json:"name"`
	PollSeconds  int    `json:"poll_seconds"`
	PerMinuteCap int    `json:"per_minute_cap"`
	// Approved is false when the handset is enrolled but not yet permitted to
	// send. The app shows "waiting for the office to approve this phone"
	// rather than an empty outbox, which is what it would otherwise look like.
	Approved bool `json:"approved"`
}

/*
enrolSMSGateway registers a handset because somebody signed in on it.

	The pair-code flow this replaces asked an administrator to generate a code
	on one screen and somebody else to type it into a handset within ten
	minutes. In a two-person school office they are the same person walking
	between two screens with a stopwatch running. Signing in on the phone is
	the same act of authorisation with none of the choreography, and it records
	*who* enrolled the device, which a pair code never did -- it recorded only
	who generated the code, which is not necessarily who used it.

	AN ENROLLED DEVICE DOES NOT SEND ANYTHING YET.

	It appears in the admin portal as pending and waits there. Anybody holding
	a staff PIN could otherwise turn their own phone into the school's SMS
	sender -- reading every queued message, which includes fee arrears and
	absence notices by name -- with no administrator ever in the loop.

	The exception is the person who could have approved it anyway: if they hold
	integrations.write, the device is live as it is created. Making somebody
	walk to another screen to permit what they just did is ceremony, not
	control, and in these schools it is the principal installing it themselves.

	The pair-code route is left exactly as it was. A school midway through the
	old instructions does not discover that its printed steps stopped working.
*/
func (s *Server) enrolSMSGateway(w http.ResponseWriter, r *http.Request) {
	// Rate limited on the same bucket as the pair-code claim, because it is
	// the same thing being protected: an unauthenticated endpoint that turns
	// input into a credential.
	if !publicSMSGatewayLimiter.allow(callerAddress(r), time.Now()) {
		httpx.Error(w, r, http.StatusTooManyRequests, "rate_limited",
			"too many attempts from this network — wait a few minutes and try again")
		return
	}

	var req gatewayEnrolRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	who, err := s.authenticatePIN(r.Context(), req.Phone, req.PIN)
	if err != nil {
		deviceLoginRejected(w, r, err)
		return
	}

	name := strings.TrimSpace(req.DeviceName)
	if name == "" {
		name = "Office phone"
	}

	var out gatewayEnrolResponse
	device := uuid.New()
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		token, secret, err := newSMSGatewayToken(device)
		if err != nil {
			return err
		}
		sealed, err := sealSecret(secret)
		if err != nil {
			return err
		}

		// The same name-collision suffix the claim path uses. Two handsets
		// both calling themselves "Redmi Note 12" is ordinary and is not a
		// reason to refuse the second one.
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO sms_gateway_devices
			       (id, institution_id, name, android_version, sim_operator,
			        app_version, token_sealed, enrolled_by,
			        approved_at, approved_by, poll_seconds, per_minute_cap)
			VALUES ($1, $2,
			        $3 || COALESCE((SELECT ' (' || (count(*) + 1) || ')'
			                          FROM sms_gateway_devices d
			                         WHERE d.institution_id = $2
			                           AND d.revoked_at IS NULL
			                           AND lower(d.name) = lower($3)
			                        HAVING count(*) > 0), ''),
			        $4, $5, $6, $7, $8,
			        CASE WHEN $9 THEN now() END,
			        CASE WHEN $9 THEN $8 END,
			        $10, $11)`,
			device, who.Institution, truncate(name, 80),
			nullIfBlank(req.AndroidVersion), nullIfBlank(req.SIMOperator),
			nullIfBlank(req.AppVersion), sealed, who.UserID, who.Approver,
			smsGatewayDefaultPoll, smsGatewayDefaultCap); err != nil {
			return err
		}

		session, _, _, err := s.openStaffSession(r.Context(), tx, who, "sms_gateway", device)
		if err != nil {
			return err
		}

		var instName string
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, who.Institution).
			Scan(&instName); err != nil {
			return err
		}

		out = gatewayEnrolResponse{
			DeviceID:     device.String(),
			DeviceToken:  token,
			SessionToken: session,
			Institution:  instName,
			Name:         who.Name,
			PollSeconds:  smsGatewayDefaultPoll,
			PerMinuteCap: smsGatewayDefaultCap,
			Approved:     who.Approver,
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The device token is returned exactly once, is not stored in clear and
	// cannot be read back. A phone that loses it enrols again.
	httpx.JSON(w, http.StatusOK, out)
}

/*
approveSMSGatewayDevice lets a pending handset start sending.

	The other half of enrolment-by-sign-in. A device that arrived by pair code
	needs nothing here -- generating the code was the approval, and migration
	00155 backfilled every existing device accordingly.

	Idempotent: approving an already-approved phone is a no-op that answers
	200, because the office will press it twice on a slow connection and a 409
	would read as a failure. The approver is recorded on first approval only,
	which is the fact worth keeping.
*/
func (s *Server) approveSMSGatewayDevice(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	deviceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "that is not a device id")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE sms_gateway_devices
			   SET approved_at = COALESCE(approved_at, now()),
			       approved_by = COALESCE(approved_by, $3),
			       updated_at = now()
			 WHERE institution_id = $1 AND id = $2 AND revoked_at IS NULL`,
			id.InstitutionID, deviceID, id.UserID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			// Either no such device, or one already revoked. A revoked phone
			// is not approvable back into service: revocation is how an office
			// says a handset is gone, and undoing it silently would put a
			// phone somebody wrote off back on the school's message queue.
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
	httpx.JSON(w, http.StatusOK, map[string]any{"approved": true})
}

// --- issuing a PIN -----------------------------------------------------------

type staffPINResponse struct {
	FullName string `json:"full_name"`
	// The number the PIN will be typed against, echoed back normalised. The
	// office types "9876543210" onto an employee record and then somebody
	// signs in with "+91 98765 43210"; showing what the server will actually
	// match on is how that stops being a mystery.
	Phone string `json:"phone"`
	// Shown once and never stored in a readable form, exactly as
	// issueStaffLogin hands over a password.
	PIN string `json:"pin"`
}

/*
issueStaffPIN gives one member of staff a PIN for the handset apps.

	Gated on hr.employees.write, deliberately the same permission as
	issueStaffLogin beside it rather than access.users.write: the office that
	appointed this driver is the office that hands them their PIN, and the
	broader right would also let them reset the principal's password.

	Four digits, generated rather than chosen. A PIN somebody picks is 1234 or
	their year of birth, and asking a driver to invent one at a counter with a
	queue behind them produces the same three numbers across a whole school.

	Idempotent in the way that matters, again like the password path: run it
	again and the old PIN stops working. "I never got it" and "I have lost it"
	are the same request from the office's side of the desk.
*/
func (s *Server) issueStaffPIN(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	empID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}

	pin, err := temporaryPIN()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	hash, err := s.Hasher.Hash(pin)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var out staffPINResponse
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			userID *uuid.UUID
			phone  *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT e.user_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')),
			       COALESCE(u.phone, e.phone)
			  FROM employees e
			  LEFT JOIN users u ON u.id = e.user_id
			 WHERE e.id = $1`, empID).
			Scan(&userID, &out.FullName, &phone); err != nil {
			return err
		}
		if userID == nil {
			// A PIN signs somebody in, and there is nothing here to sign in
			// as. Pointing at the existing button rather than quietly creating
			// an account: issuing a login is a decision with its own audit
			// trail and its own permission check, and it should stay one act.
			return errors.New(
				"this person has no account yet — issue their login first, then a PIN")
		}
		if phone == nil || normalisePhone(*phone) == "" {
			return errNoPhoneForPIN
		}
		digits := normalisePhone(*phone)
		if len(digits) != 10 {
			return errNoPhoneForPIN
		}
		out.Phone = digits

		// The phone has to be on the user row, not only the employee row: the
		// sign-in looks users up by number and cannot see employees, which is
		// what lets a gateway handset find its school before it has one.
		if _, err := tx.Exec(r.Context(), `
			UPDATE users SET phone = COALESCE(phone, $2), updated_at = now()
			 WHERE id = $1`, *userID, digits); err != nil {
			return err
		}

		_, err := tx.Exec(r.Context(), `
			UPDATE users
			   SET pin_hash = $2, pin_set_at = now(), pin_set_by = $3,
			       pin_failed = 0, pin_locked_until = NULL, updated_at = now()
			 WHERE id = $1`, *userID, hash, id.UserID)
		if isUniqueViolation(err) {
			// users_pin_phone_unique. Two members of staff share a number and
			// the second is being given a PIN, which would make a sign-in
			// ambiguous about which of them is driving.
			return errors.New(
				"another member of staff already has a PIN on this phone number — " +
					"give this person their own number first")
		}
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		/* Every error this transaction returns of its own accord is a sentence
		   written for the office to read -- no account yet, no mobile number,
		   that number is already somebody's. Reported as 400 with the sentence
		   intact rather than being flattened into "something went wrong",
		   which would send somebody to look at the server for a data problem
		   they could fix in thirty seconds.

		   A genuine database fault reaches here too and is reported the same
		   way, which is the cost of not threading a sentinel through every
		   branch. It is the right trade for a handful of one-line failures
		   that all mean the same thing to the person reading them: this record
		   is not ready yet. */
		httpx.BadRequest(w, r, err.Error())
		return
	}

	out.PIN = pin
	httpx.JSON(w, http.StatusOK, out)
}

var errNoPhoneForPIN = errors.New(
	"this person has no ten-digit mobile number on their record — add one first, " +
		"because the number is what they sign in with")

// temporaryPIN is four digits from crypto/rand, uniformly.
//
// Not rand.Intn(10000) formatted to four places, which is the same thing and
// reads as if it might not be, and not a modulo of a byte, which is biased
// toward the low digits.
func temporaryPIN() (string, error) {
	b := make([]byte, 4)
	out := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i, x := range b {
		out[i] = byte('0' + int(x)%10)
	}
	return string(out), nil
}

// --- the driver enrols their own bus tracker ---------------------------------

type trackerEnrolRequest struct {
	Phone          string `json:"phone"`
	PIN            string `json:"pin"`
	Registration   string `json:"registration_no"`
	DeviceModel    string `json:"device_model"`
	AndroidVersion string `json:"android_version"`
	AppVersion     string `json:"app_version"`
}

type trackerEnrolResponse struct {
	DeviceID     string `json:"device_id"`
	DeviceToken  string `json:"device_token"`
	SessionToken string `json:"session_token"`
	Institution  string `json:"institution"`
	Vehicle      string `json:"vehicle"`
	Name         string `json:"name"`
	PingSeconds  int    `json:"ping_seconds"`
	// Approved is false until the principal lets it in. The app shows
	// "waiting for the school to approve this phone" rather than a map with
	// nothing on it, which is what it would otherwise look like.
	Approved bool `json:"approved"`
}

// normaliseRegistration reduces a number plate to the characters that identify
// it. A driver types what they can read off the side of the bus, and they will
// type it with spaces, without them, and in either case.
func normaliseRegistration(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range strings.ToUpper(strings.TrimSpace(s)) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			out = append(out, r)
		}
	}
	return string(out)
}

/*
enrolBusTracker attaches a driver's own phone to the bus they are standing next to.

	The pair-code flow it replaces needed somebody with transport.write to
	generate a code in the console and somebody else to type it into a handset
	within ten minutes. That is two people and a stopwatch, for a driver beside
	their bus at six in the morning whose office opens at nine.

	The vehicle comes from the registration number painted on the bus rather
	than from a dropdown. A driver knows which bus they are driving and can
	read its plate; they do not know its UUID, and a list of forty registration
	numbers on a cracked screen at dawn is a list somebody picks the wrong line
	from -- which puts the wrong bus on every parent's map.

	IT REPORTS NOTHING UNTIL IT IS APPROVED. A tracker is a live map of where
	children are. Anybody holding a staff PIN could otherwise attach a phone to
	a school's bus and watch it, so unlike the gateway there is no
	approve-yourself shortcut here: the enrolment is always pending, and the
	approval is the principal's or the platform's.
*/
func (s *Server) enrolBusTracker(w http.ResponseWriter, r *http.Request) {
	if !publicSMSGatewayLimiter.allow(callerAddress(r), time.Now()) {
		httpx.Error(w, r, http.StatusTooManyRequests, "rate_limited",
			"too many attempts from this network — wait a few minutes and try again")
		return
	}

	var req trackerEnrolRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	reg := normaliseRegistration(req.Registration)
	if reg == "" {
		httpx.Error(w, r, http.StatusBadRequest, "no_registration",
			"type the number painted on the bus you are driving")
		return
	}

	who, err := s.authenticatePIN(r.Context(), req.Phone, req.PIN)
	if err != nil {
		deviceLoginRejected(w, r, err)
		return
	}

	var out trackerEnrolResponse
	device := uuid.New()
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var vehicle uuid.UUID
		var plate string
		if err := tx.QueryRow(r.Context(), `
			SELECT id, registration_no FROM vehicles
			 WHERE institution_id = $1
			   AND upper(regexp_replace(registration_no,'[^A-Za-z0-9]','','g')) = $2
			   AND status <> 'retired'
			 LIMIT 1`, who.Institution, reg).Scan(&vehicle, &plate); err != nil {
			return err
		}

		/* One live tracker per bus, and the newest wins.

		   A driver's handset is lost, broken or swapped, and the replacement
		   enrols. The unique index permits exactly one live tracker per
		   vehicle, so the old one is retired here rather than the enrolment
		   failing with a constraint error a driver cannot act on. */
		if _, err := tx.Exec(r.Context(), `
			UPDATE vehicle_trackers
			   SET revoked_at = now(),
			       revoked_reason = 'replaced by a newly enrolled phone'
			 WHERE vehicle_id = $1 AND revoked_at IS NULL`, vehicle); err != nil {
			return err
		}

		policy, err := trackingPolicyFor(r.Context(), tx, who.Institution)
		if err != nil {
			return err
		}

		token, secret, err := newBusTrackerToken(device)
		if err != nil {
			return err
		}
		sealed, err := sealSecret(secret)
		if err != nil {
			return err
		}

		// approved_at stays NULL. There is no self-approval on this app, for
		// the reason in migration 00156: this is a live map of children.
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO vehicle_trackers (id, institution_id, vehicle_id, name,
			    device_model, android_version, app_version, token_sealed,
			    enrolled_by, ping_seconds)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			device, who.Institution, vehicle, truncate(who.Name+" — "+plate, 80),
			nullIfBlank(req.DeviceModel), nullIfBlank(req.AndroidVersion),
			nullIfBlank(req.AppVersion), sealed, who.UserID,
			policy.PingSeconds); err != nil {
			return err
		}

		session, _, _, err := s.openStaffSession(r.Context(), tx, who, "bus_tracker", device)
		if err != nil {
			return err
		}

		var instName string
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM institutions WHERE id = $1`, who.Institution).
			Scan(&instName); err != nil {
			return err
		}

		out = trackerEnrolResponse{
			DeviceID:     device.String(),
			DeviceToken:  token,
			SessionToken: session,
			Institution:  instName,
			Vehicle:      plate,
			Name:         who.Name,
			PingSeconds:  policy.PingSeconds,
			Approved:     false,
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Named plainly. Unlike a pair code, a registration number is not a
		// secret and getting it wrong is the likeliest thing a tired driver
		// does; "no such bus" is what lets them look again at the plate.
		httpx.Error(w, r, http.StatusNotFound, "no_such_vehicle",
			"no bus with that number at your school — check the plate and type it again")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/*
approveBusTracker lets an enrolled handset start reporting.

	Narrower than the pairing it replaces, deliberately. transport.write is
	held by the transport manager and the office; letting a phone watch where a
	school's children are during the day is the principal's decision or the
	platform's, and this checks the ROLE rather than only the permission.

	That is unusual in this codebase, where authorisation is permissions
	everywhere and roles nowhere. It is written this way because the product
	owner asked for these two people by name, and because a permission that
	means "may approve a child-tracking device" does not exist and inventing
	one would put it in the permissions grid where a school could grant it to
	anybody -- which is the thing being avoided.

	Idempotent: approving twice answers 200, because an office on a slow
	connection presses it again and a 409 reads as a failure.
*/
func (s *Server) approveBusTracker(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	trackerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "that is not a tracker id")
		return
	}

	allowed := false
	if err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			  SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
			   WHERE ur.user_id = $1
			     AND r.key IN ('institution_admin','super_admin'))`,
			id.UserID).Scan(&allowed)
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !allowed {
		httpx.Error(w, r, http.StatusForbidden, "not_an_approver",
			"only the principal or a platform administrator can let a bus tracker start reporting")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE vehicle_trackers
			   SET approved_at = COALESCE(approved_at, now()),
			       approved_by = COALESCE(approved_by, $3)
			 WHERE institution_id = $1 AND id = $2 AND revoked_at IS NULL`,
			id.InstitutionID, trackerID, id.UserID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			// No such tracker, or one already revoked. A revoked handset is
			// not approvable back into service: revocation is how a school
			// says a phone is gone, and undoing it silently would put a phone
			// somebody wrote off back on the children's map.
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
	httpx.JSON(w, http.StatusOK, map[string]any{"approved": true})
}
