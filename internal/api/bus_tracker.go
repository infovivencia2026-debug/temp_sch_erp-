package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

// errNoSuchRoute is returned inside the platform-scoped trip transaction when
// the route named by a handset is not the device's school's. It travels back
// out of the closure so the caller can answer 404 rather than 500 — a wrong
// route id is the caller's mistake, not the server's.
var errNoSuchRoute = errors.New("route does not belong to this institution")

/*
errRouteOtherVehicle is the route that exists, in this school, and is the

	standing assignment of a different bus. Kept apart from errNoSuchRoute
	because the two need opposite answers: the first is a handset naming
	something that is not ours, the second is the right school's route on the
	wrong bus, which is a driver who picked the line above the one he drives.
	Told apart so the app can say which.
*/
var errRouteOtherVehicle = errors.New("route is assigned to another vehicle")

// errBusNotFound is a scanned sticker this school has no bus for -- a code from
// another school, or a vehicle that has been retired.
var errBusNotFound = errors.New("no bus matches that code")

/* The driver's phone as the vehicle's GPS unit.

   Eight catalogued transport features were deferred on one sentence — "GPS
   tracker fitted to each vehicle" — and fitting fifty units is a procurement
   project a school does not begin in August. The driver already carries a
   phone with a better GNSS chip than most fleet boxes, and this codebase has
   already turned a spare handset into the school's SMS gateway, so the shape
   and its failure modes are known.

   docs/BUS_TRACKER_CONTRACT.md is the wire contract, written before either
   half. The SMS gateway shipped a silent misbehaviour because its contract
   never named the rate-cap field and two workers picked two names; nothing
   failed and nothing logged.

   The one structural difference from the gateway: that phone polls because the
   server holds work for it and cannot reach a handset behind carrier-grade
   NAT. This phone holds the data, so it pushes, and takes its configuration
   back on the same response rather than in a call of its own.

   The trip is the unit of visibility, and that is a privacy decision rather
   than a modelling one. The handset belongs to the driver and does not stop
   reporting at four o'clock. Position is filed against a trip, and a trip is
   opened deliberately; nothing outside one is visible to a parent. A map that
   shows a school employee at their own front door in the evening is workplace
   surveillance that happens to be spelled "transport feature".
*/

const (
	busTrackerTokenPrefix = "bustrk"
	busTrackerPairTTL     = 10 * time.Minute

	// Most fixes one push may carry. A bus out of coverage for half an hour at
	// a fifteen-second ping has 120; 200 leaves room without letting a
	// misbehaving build post a megabyte.
	busTrackerMaxFixes = 200

	/* How far a fix's own clock may be from the server's before it is refused.

	   Wide on purpose. The phone's clock is the one that was actually there
	   when the fix was taken, and a bus genuinely can upload a morning run in
	   the afternoon. What this rejects is the handset whose clock is set to
	   2019, whose fixes would otherwise be written into history that cannot
	   afterwards be untangled from the real thing. */
	busTrackerMaxSkew = 24 * time.Hour

	/* Codes are read off one screen and typed into another.

	   Digits, and nine of them, which is what the SMS gateway settled on for
	   the same job. The letters were Crockford-ish and unambiguous to read,
	   and still wrong for the person doing the typing: a driver at six in the
	   morning is holding a phone whose keyboard opens on numbers, and every
	   letter is a switch to another layout and back. Two pairing flows in one
	   product that disagree about what a code looks like is also its own kind
	   of support call.

	   Nine digits is a billion, against a ten-minute window and the rate limit
	   on the claim. */
	busTrackerCodeAlphabet = "0123456789"

	// The length, named once. The app enforces the same number, and the claim
	// below reads this rather than a literal -- the SMS gateway shipped nine
	// digits against a hard-coded eight and refused every code it printed.
	busTrackerCodeLength = 9
)

// --- pairing credentials -----------------------------------------------------

func newBusTrackerToken(device uuid.UUID) (token, secret string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	secret = base64.RawURLEncoding.EncodeToString(raw)
	return busTrackerTokenPrefix + "." + device.String() + "." + secret, secret, nil
}

func splitBusTrackerToken(token string) (uuid.UUID, string, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != busTrackerTokenPrefix {
		return uuid.Nil, "", false
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || parts[2] == "" {
		return uuid.Nil, "", false
	}
	return id, parts[2], true
}

func newBusTrackerPairCode() (string, error) {
	b := make([]byte, busTrackerCodeLength)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, busTrackerCodeLength)
	for i, x := range b {
		out[i] = busTrackerCodeAlphabet[int(x)%len(busTrackerCodeAlphabet)]
	}
	return string(out), nil
}

func hashBusTrackerCode(code string) []byte {
	sum := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(code))))
	return sum[:]
}

// --- geometry ----------------------------------------------------------------

/*
metresBetween is the great-circle distance between two fixes.

	Haversine rather than a projected approximation. The cheap version — treat
	a degree of latitude and longitude as fixed metres — is off by the cosine
	of the latitude, which at Hyderabad's 17°N understates east-west distance
	by about 4%. On a 120m geofence that is five metres, which sounds
	survivable until it is the difference between a bus that arrived and a bus
	that did not.
*/
func metresBetween(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusM = 6371008.8
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLon := (lon2 - lon1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	// Clamped before the arcsine: floating point can put a fractionally over 1
	// for antipodal-ish inputs, and Asin would return NaN rather than pi/2.
	return 2 * earthRadiusM * math.Asin(math.Sqrt(math.Min(1, a)))
}

// --- the tracking policy -----------------------------------------------------

// trackingPolicy is the school's settings, with the defaults the schema
// carries. Read on every ingest, so it is one row by primary key.
type trackingPolicy struct {
	DefaultGeofenceM int
	SpeedLimitKmph   int
	SpeedingHoldSecs int
	TripTimeoutMins  int
	PingSeconds      int
	ParentsMayWatch  bool
	WatchWindowMins  int
	RetainDays       int
}

/*
trackingPolicyFor reads a school's settings, creating the defaults if it has
none.

	Created on read rather than refused, for the reason the leave policy is:
	a school that has never opened the settings screen still runs buses, and
	the defaults are the ones the evaluator would fall back to anyway.
*/
func trackingPolicyFor(ctx context.Context, tx pgx.Tx, inst uuid.UUID) (*trackingPolicy, error) {
	p := &trackingPolicy{}
	scan := func() error {
		return tx.QueryRow(ctx, `
			SELECT default_geofence_m, speed_limit_kmph, speeding_hold_secs,
			       trip_timeout_mins, ping_seconds, parents_may_watch,
			       watch_window_mins, retain_days
			  FROM transport_tracking_policy WHERE institution_id = $1`, inst).
			Scan(&p.DefaultGeofenceM, &p.SpeedLimitKmph, &p.SpeedingHoldSecs,
				&p.TripTimeoutMins, &p.PingSeconds, &p.ParentsMayWatch,
				&p.WatchWindowMins, &p.RetainDays)
	}
	if err := scan(); errors.Is(err, pgx.ErrNoRows) {
		if _, err := tx.Exec(ctx, `
			INSERT INTO transport_tracking_policy (institution_id) VALUES ($1)
			ON CONFLICT DO NOTHING`, inst); err != nil {
			return nil, err
		}
		if err := scan(); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	return p, nil
}

// --- device authentication ---------------------------------------------------

type busTrackerCtxKey struct{}

// busTracker is the paired handset, as every device handler needs it.
type busTracker struct {
	ID          uuid.UUID
	Institution uuid.UUID
	Vehicle     uuid.UUID
	Name        string
	PingSeconds int
	Paused      bool
}

func busTrackerFrom(ctx context.Context) *busTracker {
	dev, _ := ctx.Value(busTrackerCtxKey{}).(*busTracker)
	return dev
}

func busTrackerUnauthorized(w http.ResponseWriter, r *http.Request) {
	httpx.Error(w, r, http.StatusUnauthorized, "unauthorized",
		"this tracker is not paired, or its pairing has been revoked; pair the phone again from the transport screen")
}

/*
requireBusTracker authenticates the handset and nothing else.

	AsPlatform, because a phone holds no session and therefore no
	app_current_institution(). The tenant comes from the tracker row, which is
	the only place it can come from, and every handler below writes with the
	institution it found here rather than one the request supplied.
*/
func (s *Server) requireBusTracker(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			token = strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		}
		id, secret, ok := splitBusTrackerToken(token)
		if !ok {
			busTrackerUnauthorized(w, r)
			return
		}

		var (
			dev      busTracker
			sealed   []byte
			revoked  *time.Time
			approved *time.Time
		)
		err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT id, institution_id, vehicle_id, name, token_sealed,
				       revoked_at, approved_at, ping_seconds, paused
				  FROM vehicle_trackers WHERE id = $1`, id).
				Scan(&dev.ID, &dev.Institution, &dev.Vehicle, &dev.Name, &sealed,
					&revoked, &approved, &dev.PingSeconds, &dev.Paused)
		})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			busTrackerUnauthorized(w, r)
			return
		case err != nil:
			// A database fault is not an authentication failure, and reporting
			// it as one sends somebody out to look at a phone that is fine.
			httpx.Internal(w, r, err)
			return
		}
		if revoked != nil {
			busTrackerUnauthorized(w, r)
			return
		}

		/* Enrolled is not the same as allowed to report.

		   A handset the driver signed in on holds a real credential and sends
		   nothing until the principal lets it in. Said plainly rather than as
		   a generic refusal, unlike every other rejection here: this one is
		   not adversarial. The phone is ours, we know exactly which driver
		   enrolled it, and the person holding it needs to be told to go and
		   ask rather than left staring at a screen that says it is not
		   paired. */
		if approved == nil {
			httpx.Error(w, r, http.StatusForbidden, "awaiting_approval",
				"this phone is registered but not yet approved, ask the principal "+
					"to approve it on the transport screen")
			return
		}

		want, err := openSecret(sealed)
		if err != nil {
			// CREDENTIAL_KEY rotated, or the row is damaged. There is nothing
			// the phone can do with the token it holds but pair again.
			busTrackerUnauthorized(w, r)
			return
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(secret)) != 1 {
			busTrackerUnauthorized(w, r)
			return
		}

		next.ServeHTTP(w, r.WithContext(
			context.WithValue(r.Context(), busTrackerCtxKey{}, &dev)))
	})
}

// --- pairing -----------------------------------------------------------------

type busTrackerPairRequest struct {
	VehicleID string `json:"vehicle_id"`
	Name      string `json:"name,omitempty"`
}

type busTrackerPairResponse struct {
	PairCode     string `json:"pair_code"`
	ExpiresAt    string `json:"expires_at"`
	ValidMinutes int    `json:"valid_minutes"`
	Vehicle      string `json:"vehicle"`
}

/*
pairBusTracker mints a code against one named vehicle.

	The vehicle is chosen here rather than typed into the handset. A driver
	entering a registration number is a driver mistyping a registration number,
	and a bus reporting as another bus is worse than a bus not reporting: the
	first is wrong information that a parent acts on, the second is an absence
	they can see.

	Generating a code retires every other unclaimed code for the school, for
	the same reason the SMS gateway does — two live codes is one administrator
	reading out the stale one while a colleague generates another.
*/
func (s *Server) pairBusTracker(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req busTrackerPairRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	vehicle, err := uuid.Parse(req.VehicleID)
	if err != nil {
		httpx.BadRequest(w, r, "vehicle_id must be a uuid")
		return
	}

	code, err := newBusTrackerPairCode()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	expires := time.Now().Add(busTrackerPairTTL)

	var registration string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT registration_no FROM vehicles WHERE id = $1`, vehicle).
			Scan(&registration); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE vehicle_tracker_pair_codes SET expires_at = now()
			 WHERE institution_id = $1 AND claimed_at IS NULL AND expires_at > now()`,
			id.InstitutionID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO vehicle_tracker_pair_codes (institution_id, vehicle_id,
			    code_hash, expires_at, created_by)
			VALUES ($1,$2,$3,$4,$5)`,
			id.InstitutionID, vehicle, hashBusTrackerCode(code), expires, id.UserID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, busTrackerPairResponse{
		PairCode:     code,
		ExpiresAt:    expires.Format(time.RFC3339),
		ValidMinutes: int(busTrackerPairTTL / time.Minute),
		Vehicle:      registration,
	})
}

type busTrackerClaimRequest struct {
	PairCode       string `json:"pair_code"`
	DeviceName     string `json:"device_name,omitempty"`
	DeviceModel    string `json:"device_model,omitempty"`
	AndroidVersion string `json:"android_version,omitempty"`
	AppVersion     string `json:"app_version,omitempty"`
}

/*
claimBusTrackerPairCode turns a code into a paired phone.

	Unauthenticated — the handset has no credential until this succeeds — and
	so it says as little as possible on failure. An expired code, a claimed
	code and a code that never existed all answer the same way: a caller
	guessing nine digits must not learn that they were close.

	The response echoes the vehicle's registration so the driver can see which
	bus their phone has become before it starts reporting. A driver shown the
	wrong registration has to be able to stop there, which is the whole reason
	the field is on the response.
*/
func (s *Server) claimBusTrackerPairCode(w http.ResponseWriter, r *http.Request) {
	var req busTrackerClaimRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	refuse := func() {
		httpx.Error(w, r, http.StatusUnauthorized, "bad_pair_code",
			"that pairing code is not valid; generate a new one from the transport screen")
	}
	if strings.TrimSpace(req.PairCode) == "" {
		refuse()
		return
	}
	name := strings.TrimSpace(req.DeviceName)
	if name == "" {
		name = strings.TrimSpace(req.DeviceModel)
	}
	if name == "" {
		name = "Driver's phone"
	}

	var (
		deviceID     uuid.UUID
		token        string
		inst         uuid.UUID
		vehicle      uuid.UUID
		registration string
		ping         int
	)
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var codeID uuid.UUID
		// Null once the administrator who generated the code is deleted; the
		// pairing itself outlives staff turnover.
		var by *uuid.UUID
		err := tx.QueryRow(r.Context(), `
			UPDATE vehicle_tracker_pair_codes
			   SET claimed_at = now()
			 WHERE code_hash = $1 AND claimed_at IS NULL AND expires_at > now()
			RETURNING id, institution_id, vehicle_id, created_by`,
			hashBusTrackerCode(req.PairCode)).
			Scan(&codeID, &inst, &vehicle, &by)
		if err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(),
			`SELECT registration_no FROM vehicles WHERE id = $1`, vehicle).
			Scan(&registration); err != nil {
			return err
		}

		/* Replacing a phone must not need a revoke first.

		   A driver's handset is lost, broken or swapped, and the office pairs
		   the new one. The unique index permits exactly one live tracker per
		   vehicle, so the old one is retired here rather than rejecting the
		   claim with a constraint error the driver cannot act on. */
		if _, err := tx.Exec(r.Context(), `
			UPDATE vehicle_trackers
			   SET revoked_at = now(),
			       revoked_reason = 'replaced by a newly paired phone'
			 WHERE vehicle_id = $1 AND revoked_at IS NULL`, vehicle); err != nil {
			return err
		}

		policy, err := trackingPolicyFor(r.Context(), tx, inst)
		if err != nil {
			return err
		}
		ping = policy.PingSeconds

		if err := tx.QueryRow(r.Context(), `
			/* approved_at is set HERE, and forgetting it broke the only
			   pairing path the shipped app has.

			   Migration 00156 added the column and backfilled every existing
			   tracker from paired_at, on the reasoning that a code an
			   authorised person generated IS the approval. That reasoning is
			   right and it applies to codes generated from now on just as much
			   as to the ones already claimed -- but the backfill only touched
			   rows that existed when it ran, and this INSERT was left naming
			   the old column list. Every phone that claimed a code afterwards
			   came out permanently pending and was refused by
			   requireBusTracker, which is a live bus off the map.

			   The enrol path deliberately does NOT do this: nobody authorised
			   a driver signing themselves in, which is the whole reason that
			   route waits for the principal. Here, somebody with
			   transport.write pressed a button. */
			INSERT INTO vehicle_trackers (institution_id, vehicle_id, name,
			    device_model, android_version, app_version, token_sealed,
			    pair_code_id, paired_by, ping_seconds, approved_at, approved_by)
			VALUES ($1,$2,$3,$4,$5,$6,'\x00'::bytea,$7,$8,$9,now(),$8)
			RETURNING id`,
			inst, vehicle, name, nullString(req.DeviceModel),
			nullString(req.AndroidVersion), nullString(req.AppVersion),
			codeID, by, ping).Scan(&deviceID); err != nil {
			return err
		}

		// The token carries the row id, so it cannot be minted before the row
		// exists. Sealed in a second statement inside the same transaction:
		// either the tracker has a real credential or it was never created.
		var secret string
		token, secret, err = newBusTrackerToken(deviceID)
		if err != nil {
			return err
		}
		sealed, err := sealSecret(secret)
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(),
			`UPDATE vehicle_trackers SET token_sealed = $2 WHERE id = $1`,
			deviceID, sealed)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		refuse()
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"device_id":    deviceID.String(),
		"device_token": token,
		"institution":  inst.String(),
		"vehicle": map[string]any{
			"id":              vehicle.String(),
			"registration_no": registration,
		},
		"ping_seconds": ping,
	})
}

// --- trips -------------------------------------------------------------------

type startTripRequest struct {
	RouteID string `json:"route_id"`
	/* The bus the driver is actually on, read off the sticker in its
	   windscreen. Empty means the one this handset is paired to, which is what
	   every existing app sends and what a school with one bus per driver
	   wants. A school where drivers swap buses scans instead, and the scan
	   wins for this trip only — the pairing is not disturbed. */
	BusCode   string `json:"bus_code,omitempty"`
	Direction string `json:"direction"`
	StartedAt string `json:"started_at,omitempty"`
	Supersede bool   `json:"supersede,omitempty"`
}

type tripStop struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Sequence    int      `json:"sequence"`
	Latitude    *float64 `json:"latitude,omitempty"`
	Longitude   *float64 `json:"longitude,omitempty"`
	GeofenceM   int      `json:"geofence_m"`
	ScheduledAt *string  `json:"scheduled_at,omitempty"`
}

/*
startBusTrackerTrip opens a run and hands back the stops it will pass.

	The stop list travels with the trip so the app can judge arrivals without a
	network. A bus in a cellular dead zone still knows it has reached a stop,
	and the server reconciles when the buffer uploads. Sending it here rather
	than making the app fetch it separately also means the geofence radii the
	phone uses and the ones the server evaluates came from one read.
*/
func (s *Server) startBusTrackerTrip(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	// Guaranteed non-nil: requireBusTrackerDriver refuses the request without
	// one. Read here so the driver lands on the trip row rather than being
	// looked up afterwards from a session that may have ended by then.
	driver := staffSessionFrom(r.Context())
	var req startTripRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	/* Every refusal below carries its own code.

	   httpx.BadRequest answers "bad_request" for all of them, and a shipped
	   app that can only read the status has to guess which field the server
	   meant. That guessing is exactly how a 409 for one reason was displayed
	   as another and a driver was told his bus had a run in progress when it
	   did not. */
	route, err := uuid.Parse(req.RouteID)
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "bad_route_id",
			"route_id must be a uuid")
		return
	}
	if req.Direction != "pickup" && req.Direction != "drop" {
		httpx.Error(w, r, http.StatusBadRequest, "bad_direction",
			"direction must be pickup or drop")
		return
	}
	started := time.Now()
	if req.StartedAt != "" {
		if t, err := time.Parse(time.RFC3339, req.StartedAt); err == nil {
			started = t
		}
	}

	var tripID uuid.UUID
	stops := []tripStop{}
	var conflict bool
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		/* The route has to belong to the device's own school.

		   Everything in this closure runs as platform, so RLS is not standing
		   behind it: route_id arrives from the handset and was until now only
		   parsed as a uuid. A paired device could name another school's route
		   and the stop sequence read below would come back from that school's
		   route_stops -- a cross-tenant read of somewhere else's addresses and
		   timings. Checked first, before any row is written. */
		var routeVehicle *uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT vehicle_id FROM routes
			 WHERE id = $1 AND institution_id = $2`,
			route, dev.Institution).Scan(&routeVehicle)
		if errors.Is(err, pgx.ErrNoRows) {
			// Deliberately the same answer as a route that does not exist: a
			// device must not be able to probe for another school's route ids.
			return errNoSuchRoute
		}
		if err != nil {
			return err
		}

		/* And the route has to be this bus's, when it is anybody's.

		   routes.vehicle_id is the standing assignment. A null one is a route
		   no bus is fixed to, which a relief vehicle legitimately runs, so
		   that is allowed. A route assigned to another bus is not: the trip
		   would file this vehicle's positions against the other bus's line,
		   and the parents watching that line would be shown the wrong bus
		   moving along their child's route. */
		/* THE BUS FOR THIS RUN.

		   dev.Vehicle is what the handset was paired to. A scanned code
		   replaces it for this trip and nothing else: the pairing row is
		   untouched, so a driver who scans a relief bus this morning is back on
		   his own tomorrow without anybody re-pairing anything.

		   Resolved inside the device's institution, so a code from another
		   school matches nothing. Both the sticker's bus_code and a typed
		   registration are accepted, for the same reason enrolment accepts
		   both. */
		tripVehicle := dev.Vehicle
		if code := strings.ToUpper(strings.TrimSpace(req.BusCode)); code != "" {
			if err := tx.QueryRow(r.Context(), `
				SELECT id FROM vehicles
				 WHERE institution_id = $1
				   AND (upper(bus_code) = $2
				        OR upper(regexp_replace(registration_no,'[^A-Za-z0-9]','','g')) = $2)
				   AND status <> 'retired'
				 LIMIT 1`, dev.Institution, code).Scan(&tripVehicle); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return errBusNotFound
				}
				return err
			}
		}

		if routeVehicle != nil && *routeVehicle != tripVehicle {
			return errRouteOtherVehicle
		}

		policy, err := trackingPolicyFor(r.Context(), tx, dev.Institution)
		if err != nil {
			return err
		}

		/* A run nothing has been heard from is over before this one starts.

		   The scheduled sweep in bus_tracker_jobs.go is the general answer,
		   but it only closes a stale trip when the worker actually runs it,
		   and until then the row sits open: the parents' map draws it as a bus
		   still coming, and the driver reaching for a fresh run is refused
		   with trip_already_open over a trip that ended when his battery did.
		   Closed here, against the same rule and the same ended_reason the
		   sweep uses, so the two can never disagree about when the run ended. */
		if err := closeTimedOutTrips(r.Context(), tx, tripVehicle, policy.TripTimeoutMins); err != nil {
			return err
		}

		/* An already-open trip is a decision, not an error to swallow.

		   A driver who force-quits the app and reopens it means "carry on";
		   a phone that never closed yesterday's run means "that one is over".
		   The app says which by setting supersede, and the default is to
		   refuse, because silently closing a run nobody asked to close loses
		   the record of where the bus was. */
		var open uuid.UUID
		err = tx.QueryRow(r.Context(), `
			SELECT id FROM vehicle_trips
			 WHERE vehicle_id = $1 AND ended_at IS NULL`, tripVehicle).Scan(&open)
		switch {
		case err == nil && !req.Supersede:
			conflict = true
			return nil
		case err == nil:
			if _, err := tx.Exec(r.Context(), `
				UPDATE vehicle_trips
				   SET ended_at = now(), ended_reason = 'superseded'
				 WHERE id = $1`, open); err != nil {
				return err
			}
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO vehicle_trips (institution_id, vehicle_id, route_id,
			    tracker_id, direction, started_at, started_by, driver_session_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			RETURNING id`,
			dev.Institution, tripVehicle, route, dev.ID, req.Direction, started,
			driver.UserID, driver.ID).
			Scan(&tripID); err != nil {
			return err
		}

		/* Ordered the way the bus will actually drive it.

		   The afternoon run is the morning's sequence reversed. An ETA
		   computed against the wrong direction is not slightly wrong, it is
		   backwards, and it is the parent at the last stop who is told the bus
		   is two minutes away when it has not left the school. */
		order := "cs.sequence"
		if req.Direction == "drop" {
			order = "cs.sequence DESC"
		}
		rows, err := tx.Query(r.Context(), `
			SELECT cs.id::text, cs.name, cs.sequence,
			       cs.latitude::float8, cs.longitude::float8,
			       COALESCE(cs.geofence_m, $2),
			       to_char(CASE WHEN $3 = 'drop' THEN cs.drop_time ELSE cs.pickup_time END,
			               'HH24:MI')
			  FROM route_stops cs
			 WHERE cs.route_id = $1
			 ORDER BY `+order, route, policy.DefaultGeofenceM, req.Direction)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v tripStop
			if err := rows.Scan(&v.ID, &v.Name, &v.Sequence, &v.Latitude,
				&v.Longitude, &v.GeofenceM, &v.ScheduledAt); err != nil {
				return err
			}
			stops = append(stops, v)
		}
		return rows.Err()
	})
	if errors.Is(err, errNoSuchRoute) {
		httpx.Error(w, r, http.StatusNotFound, "no_such_route",
			"that route does not belong to this school")
		return
	}
	if errors.Is(err, errBusNotFound) {
		httpx.Error(w, r, http.StatusNotFound, "bus_not_found",
			"that sticker is not a bus at this school. Check it is the right "+
				"vehicle, or ask the office")
		return
	}
	if errors.Is(err, errRouteOtherVehicle) {
		httpx.Error(w, r, http.StatusConflict, "route_not_this_bus",
			"that route is assigned to a different bus; pick the route this "+
				"bus runs, or ask the office to reassign it")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if conflict {
		httpx.Error(w, r, http.StatusConflict, "trip_already_open",
			"this bus already has a run in progress; end it, or send supersede to replace it")
		return
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"trip_id": tripID.String(),
		"stops":   stops,
	})
}

/*
closeTimedOutTrips ends one vehicle's open runs that nothing has been heard
from, exactly as the scheduled sweep would.

	The rule is clampTripTimeoutMins and the last of started_at and the newest
	fix, which is SweepTripTimeouts' rule reached through the same helpers so
	the two cannot drift into closing trips at different instants. ended_at is
	that last-heard moment rather than now(): a run that went quiet at 08:12
	and is noticed at 09:30 did not carry children for the hour in between,
	and writing now() would put that hour into every report.

	Open safety episodes are closed with the trip for the same reason the
	sweep closes them: a speeding row with a start and no end reads on the
	office's list as a bus that is over the limit right now, forever.
*/
func closeTimedOutTrips(ctx context.Context, tx pgx.Tx, vehicle uuid.UUID, timeoutMins int) error {
	rows, err := tx.Query(ctx, `
		UPDATE vehicle_trips t
		   SET ended_at = stale.last_heard, ended_reason = 'timeout'
		  FROM (
		      SELECT o.id,
		             GREATEST(o.started_at,
		                      COALESCE(max(p.recorded_at), o.started_at)) AS last_heard
		        FROM vehicle_trips o
		        LEFT JOIN vehicle_positions p ON p.trip_id = o.id
		       WHERE o.vehicle_id = $1 AND o.ended_at IS NULL
		       GROUP BY o.id, o.started_at) stale
		 WHERE t.id = stale.id
		   AND t.ended_at IS NULL
		   AND stale.last_heard + make_interval(mins => $2) < now()
		RETURNING t.id`, vehicle, clampTripTimeoutMins(timeoutMins))
	if err != nil {
		return err
	}
	var closed []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		closed = append(closed, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(closed) == 0 {
		return nil
	}
	// GREATEST guards the period CHECK: a fix filed out of a dead-zone buffer
	// can open an episode marginally after the position the trip is closed at.
	_, err = tx.Exec(ctx, `
		UPDATE transport_safety_events e
		   SET ended_at = GREATEST(e.started_at, t.ended_at)
		  FROM vehicle_trips t
		 WHERE t.id = e.trip_id
		   AND e.trip_id = ANY($1)
		   AND e.ended_at IS NULL`, closed)
	return err
}

type endTripRequest struct {
	EndedAt string `json:"ended_at,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// endBusTrackerTrip closes a run the driver ended. Only this path may write
// reason 'driver' — the sweeper writes 'timeout' — because only this one means
// the children were actually dropped off.
func (s *Server) endBusTrackerTrip(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	tripID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req endTripRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	ended := time.Now()
	if req.EndedAt != "" {
		if t, err := time.Parse(time.RFC3339, req.EndedAt); err == nil {
			ended = t
		}
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE vehicle_trips
			   SET ended_at = GREATEST($3, started_at), ended_reason = 'driver'
			 WHERE id = $1 AND vehicle_id = $2 AND ended_at IS NULL`,
			tripID, dev.Vehicle, ended)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		// Any speeding episode still open ends with the run. Left open it
		// would sit on the manager's list forever with no end time, which
		// reads as "still happening".
		_, err = tx.Exec(r.Context(), `
			UPDATE transport_safety_events
			   SET ended_at = GREATEST($2, started_at)
			 WHERE trip_id = $1 AND ended_at IS NULL`, tripID, ended)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// One code for both, because the phone's move is the same either way:
		// stop pushing and let the driver start a fresh run.
		httpx.Error(w, r, http.StatusNotFound, "no_such_trip",
			"that run is not this bus's, or it has already ended")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ended": true})
}

// --- positions ---------------------------------------------------------------

type positionFix struct {
	RecordedAt string   `json:"recorded_at"`
	Latitude   float64  `json:"latitude"`
	Longitude  float64  `json:"longitude"`
	SpeedKmph  *float64 `json:"speed_kmph,omitempty"`
	HeadingDeg *int     `json:"heading_deg,omitempty"`
	AccuracyM  *float64 `json:"accuracy_m,omitempty"`
}

type positionsRequest struct {
	TripID string        `json:"trip_id"`
	Fixes  []positionFix `json:"fixes"`
}

/*
ingestBusTrackerPositions files a batch of fixes.

	Batched because a bus through a dead zone must not lose its history, and
	idempotent because the phone will retry a batch whose response it never
	saw. The unique index on (trip_id, recorded_at) is what makes the retry a
	no-op; the handler does not check for duplicates, it lets the index decide.

	The response returns the recorded_at values actually stored rather than a
	count. That is the SMS gateway's lesson repeated: a count cannot tell the
	phone which fix to stop retrying, so a partial accept degrades into an
	all-or-nothing retry, and the phone either loses history or sends it
	forever.
*/
func (s *Server) ingestBusTrackerPositions(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	var req positionsRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	tripID, err := uuid.Parse(req.TripID)
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "bad_trip_id",
			"trip_id must be a uuid")
		return
	}
	// Separate codes because the phone's response differs: an empty push is a
	// bug in its own buffering, an oversized one it can fix by splitting.
	if len(req.Fixes) == 0 {
		httpx.Error(w, r, http.StatusBadRequest, "no_fixes", "send at least one fix")
		return
	}
	if len(req.Fixes) > busTrackerMaxFixes {
		httpx.Error(w, r, http.StatusBadRequest, "too_many_fixes",
			fmt.Sprintf("send at most %d fixes in one push", busTrackerMaxFixes))
		return
	}

	now := time.Now()
	fixes := make([]bufferedFix, 0, len(req.Fixes))
	for i, f := range req.Fixes {
		at, err := time.Parse(time.RFC3339, f.RecordedAt)
		if err != nil {
			httpx.Error(w, r, http.StatusBadRequest, "bad_recorded_at",
				fmt.Sprintf("fix %d: recorded_at must be RFC 3339 with an offset", i+1))
			return
		}
		/* A phone whose clock is years out would write history that cannot
		   afterwards be told apart from the real thing. Inside the window the
		   phone's time wins, because it is the clock that was there. */
		if at.Sub(now) > busTrackerMaxSkew || now.Sub(at) > busTrackerMaxSkew {
			httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": map[string]any{
					"code": "skewed_clock",
					"message": "this phone's clock is more than a day from the server's; " +
						"correct it before reporting, or the history cannot be trusted",
				},
				"server_time": now.Format(time.RFC3339),
			})
			return
		}
		if f.Latitude < -90 || f.Latitude > 90 || f.Longitude < -180 || f.Longitude > 180 {
			httpx.Error(w, r, http.StatusBadRequest, "bad_coordinates",
				fmt.Sprintf("fix %d: latitude or longitude is out of range", i+1))
			return
		}
		fixes = append(fixes, bufferedFix{at: at, f: f})
	}
	// The phone may buffer out of order after a restart; everything downstream
	// — the last position, the geofence walk, the speeding episode — assumes
	// time moves forwards.
	for i := 1; i < len(fixes); i++ {
		for j := i; j > 0 && fixes[j].at.Before(fixes[j-1].at); j-- {
			fixes[j], fixes[j-1] = fixes[j-1], fixes[j]
		}
	}

	accepted := []string{}
	var tripOpen bool
	var ping int
	var paused bool

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var route uuid.UUID
		var direction string
		err := tx.QueryRow(r.Context(), `
			SELECT route_id, direction, ended_at IS NULL
			  FROM vehicle_trips
			 WHERE id = $1 AND vehicle_id = $2`, tripID, dev.Vehicle).
			Scan(&route, &direction, &tripOpen)
		if err != nil {
			return err
		}
		policy, err := trackingPolicyFor(r.Context(), tx, dev.Institution)
		if err != nil {
			return err
		}
		ping, paused = policy.PingSeconds, dev.Paused

		// A closed trip is not an error — the server may have timed it out
		// while the bus was in a tunnel. The phone is told so it can stop,
		// rather than being 404'd into a retry loop over a run that is over.
		if !tripOpen {
			return nil
		}

		for _, p := range fixes {
			var stored bool
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO vehicle_positions (institution_id, trip_id, vehicle_id,
				    recorded_at, latitude, longitude, speed_kmph, heading_deg, accuracy_m)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				ON CONFLICT (trip_id, recorded_at) DO NOTHING
				RETURNING true`,
				dev.Institution, tripID, dev.Vehicle, p.at, p.f.Latitude, p.f.Longitude,
				p.f.SpeedKmph, p.f.HeadingDeg, p.f.AccuracyM).Scan(&stored); err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				// Already had this fix. Still acknowledged, so the phone stops
				// resending it — that is the whole point of the idempotency.
				accepted = append(accepted, p.at.Format(time.RFC3339))
				continue
			}
			accepted = append(accepted, p.at.Format(time.RFC3339))
		}

		if err := s.updateLastPosition(r.Context(), tx, dev, tripID, fixes[len(fixes)-1].at,
			fixes[len(fixes)-1].f); err != nil {
			return err
		}
		if err := s.walkGeofences(r.Context(), tx, dev, tripID, route, direction,
			policy, fixesAsPoints(fixes)); err != nil {
			return err
		}
		return s.trackSpeeding(r.Context(), tx, dev, tripID, policy, fixesAsPoints(fixes))
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "no_such_trip",
			"that run is not this bus's")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"accepted":     accepted,
		"ping_seconds": ping,
		"paused":       paused,
		"trip_open":    tripOpen,
	})
}

// point is one fix reduced to what the evaluators below need.
type point struct {
	At    time.Time
	Lat   float64
	Lon   float64
	Speed *float64
}

// bufferedFix is one decoded fix: what the phone sent, plus its parsed time.
// A named type rather than an anonymous struct because the evaluators below
// take a slice of it, and a slice of an anonymous struct is not assignable to
// a slice of a named one however identical they look.
type bufferedFix struct {
	at time.Time
	f  positionFix
}

func fixesAsPoints(fixes []bufferedFix) []point {
	out := make([]point, 0, len(fixes))
	for _, p := range fixes {
		out = append(out, point{At: p.at, Lat: p.f.Latitude, Lon: p.f.Longitude, Speed: p.f.SpeedKmph})
	}
	return out
}

// updateLastPosition overwrites the one row the live map, every parent poll and
// every ETA read. Kept apart from the history because the two have opposite
// shapes — see the migration.
func (s *Server) updateLastPosition(ctx context.Context, tx pgx.Tx, dev *busTracker,
	trip uuid.UUID, at time.Time, f positionFix) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO vehicle_last_position (vehicle_id, institution_id, trip_id,
		    recorded_at, received_at, latitude, longitude, speed_kmph,
		    heading_deg, accuracy_m, tracker_id)
		VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10)
		ON CONFLICT (vehicle_id) DO UPDATE SET
		    trip_id = EXCLUDED.trip_id, recorded_at = EXCLUDED.recorded_at,
		    received_at = EXCLUDED.received_at, latitude = EXCLUDED.latitude,
		    longitude = EXCLUDED.longitude, speed_kmph = EXCLUDED.speed_kmph,
		    heading_deg = EXCLUDED.heading_deg, accuracy_m = EXCLUDED.accuracy_m,
		    tracker_id = EXCLUDED.tracker_id
		 -- A late-arriving buffered fix must not overwrite a newer live one.
		 WHERE EXCLUDED.recorded_at > vehicle_last_position.recorded_at`,
		dev.Vehicle, dev.Institution, trip, at, f.Latitude, f.Longitude,
		f.SpeedKmph, f.HeadingDeg, f.AccuracyM, dev.ID)
	return err
}

// --- geofences ---------------------------------------------------------------

/*
walkGeofences records arrival at and departure from each stop on the route.

	The unique index on (trip_id, stop_id, kind) is what makes this safe to run
	on every push, including on a replayed batch. It is not an optimisation: a
	bus idling on the edge of a circle crosses it eleven times in four minutes,
	and eleven "your child's bus has arrived" messages is how a school turns
	the feature off in week two. One arrival per stop per run, decided by the
	database rather than by this function remembering.

	Departure is only recorded for a stop already marked arrived, so a bus that
	drives past a circle on its way somewhere else does not generate a
	departure from a stop it never reached.

	Deviation against the scheduled time is computed here, once, so the delay
	report and the parent's screen cannot disagree about how late the bus was.
*/
func (s *Server) walkGeofences(ctx context.Context, tx pgx.Tx, dev *busTracker,
	trip, route uuid.UUID, direction string, policy *trackingPolicy, points []point) error {

	type stop struct {
		id        uuid.UUID
		lat, lon  float64
		radius    float64
		scheduled *time.Time
		arrived   bool
		departed  bool
	}

	/* Scheduled time is a time-of-day; the deviation needs an instant. Anchored
	   to the date of the fix being evaluated, in India rather than UTC — a box
	   running UTC rolls over at half past five in the evening local, and a
	   pickup at 07:40 would be compared against the wrong day's seven o'clock
	   for every run after that. daterange.go names this same trap. */
	rows, err := tx.Query(ctx, `
		SELECT rs.id, rs.latitude::float8, rs.longitude::float8,
		       COALESCE(rs.geofence_m, $2)::float8,
		       CASE WHEN $3 = 'drop' THEN rs.drop_time ELSE rs.pickup_time END,
		       EXISTS (SELECT 1 FROM transport_stop_events e
		                WHERE e.trip_id = $4 AND e.stop_id = rs.id AND e.kind = 'arrived'),
		       EXISTS (SELECT 1 FROM transport_stop_events e
		                WHERE e.trip_id = $4 AND e.stop_id = rs.id AND e.kind = 'departed')
		  FROM route_stops rs
		 WHERE rs.route_id = $1
		   AND rs.latitude IS NOT NULL AND rs.longitude IS NOT NULL`,
		route, policy.DefaultGeofenceM, direction, trip)
	if err != nil {
		return err
	}
	var stops []stop
	for rows.Next() {
		var st stop
		if err := rows.Scan(&st.id, &st.lat, &st.lon, &st.radius, &st.scheduled,
			&st.arrived, &st.departed); err != nil {
			rows.Close()
			return err
		}
		stops = append(stops, st)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(stops) == 0 {
		// A route whose stops carry no coordinates cannot be geofenced. That
		// is a setup gap, not a failure of this run, and it must not stop the
		// positions being filed.
		return nil
	}

	for _, p := range points {
		for i := range stops {
			st := &stops[i]
			inside := metresBetween(p.Lat, p.Lon, st.lat, st.lon) <= st.radius

			switch {
			case inside && !st.arrived:
				var deviation *int
				if st.scheduled != nil {
					local := p.At.In(indiaTZ())
					want := time.Date(local.Year(), local.Month(), local.Day(),
						st.scheduled.Hour(), st.scheduled.Minute(), 0, 0, indiaTZ())
					mins := int(local.Sub(want).Round(time.Minute) / time.Minute)
					deviation = &mins
				}
				if _, err := tx.Exec(ctx, `
					INSERT INTO transport_stop_events (institution_id, trip_id, stop_id,
					    kind, occurred_at, latitude, longitude, deviation_mins)
					VALUES ($1,$2,$3,'arrived',$4,$5,$6,$7)
					ON CONFLICT (trip_id, stop_id, kind) DO NOTHING`,
					dev.Institution, trip, st.id, p.At, p.Lat, p.Lon, deviation); err != nil {
					return err
				}
				st.arrived = true

			case !inside && st.arrived && !st.departed:
				if _, err := tx.Exec(ctx, `
					INSERT INTO transport_stop_events (institution_id, trip_id, stop_id,
					    kind, occurred_at, latitude, longitude)
					VALUES ($1,$2,$3,'departed',$4,$5,$6)
					ON CONFLICT (trip_id, stop_id, kind) DO NOTHING`,
					dev.Institution, trip, st.id, p.At, p.Lat, p.Lon); err != nil {
					return err
				}
				st.departed = true
			}
		}
	}
	return nil
}

// --- speeding ----------------------------------------------------------------

/*
trackSpeeding opens, extends and closes one speeding episode per run.

	Sustained rather than instantaneous, which is the difference between a
	feature a transport manager uses and a list nobody opens. A single fix
	reading three over on a flyover is not rash driving; the episode has to
	survive speeding_hold_secs to be kept at all, and an episode that ends
	before it does is deleted rather than filed.

	One open episode per trip per kind, by unique index. A bus over the limit
	for two minutes is one event with a duration, not twelve events.
*/
func (s *Server) trackSpeeding(ctx context.Context, tx pgx.Tx, dev *busTracker,
	trip uuid.UUID, policy *trackingPolicy, points []point) error {

	limit := float64(policy.SpeedLimitKmph)
	hold := time.Duration(policy.SpeedingHoldSecs) * time.Second

	for _, p := range points {
		if p.Speed == nil {
			// No Doppler speed from the chip. Differentiating position would
			// invent one noisy enough to raise an alert on a stationary bus,
			// so this fix simply says nothing about speed.
			continue
		}
		over := *p.Speed > limit

		var (
			eventID uuid.UUID
			started time.Time
			peak    float64
		)
		err := tx.QueryRow(ctx, `
			SELECT id, started_at, COALESCE(peak_kmph, 0)::float8
			  FROM transport_safety_events
			 WHERE trip_id = $1 AND kind = 'speeding' AND ended_at IS NULL`, trip).
			Scan(&eventID, &started, &peak)
		open := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		switch {
		case over && !open:
			if _, err := tx.Exec(ctx, `
				INSERT INTO transport_safety_events (institution_id, trip_id, vehicle_id,
				    kind, started_at, peak_kmph, limit_kmph, latitude, longitude)
				VALUES ($1,$2,$3,'speeding',$4,$5,$6,$7,$8)
				ON CONFLICT (trip_id, kind, COALESCE(ended_at, 'epoch'::timestamptz))
				DO NOTHING`,
				dev.Institution, trip, dev.Vehicle, p.At, *p.Speed,
				policy.SpeedLimitKmph, p.Lat, p.Lon); err != nil {
				return err
			}

		case over && open:
			if *p.Speed > peak {
				if _, err := tx.Exec(ctx, `
					UPDATE transport_safety_events
					   SET peak_kmph = $2, latitude = $3, longitude = $4
					 WHERE id = $1`, eventID, *p.Speed, p.Lat, p.Lon); err != nil {
					return err
				}
			}

		case !over && open:
			if p.At.Sub(started) < hold {
				// Too brief to be worth a driver's Friday. Deleted rather than
				// filed closed, because an episode nobody should see is not
				// improved by being visible and marked short.
				if _, err := tx.Exec(ctx,
					`DELETE FROM transport_safety_events WHERE id = $1`, eventID); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.Exec(ctx, `
				UPDATE transport_safety_events SET ended_at = $2 WHERE id = $1`,
				eventID, p.At); err != nil {
				return err
			}
		}
	}
	return nil
}

// --- heartbeat ---------------------------------------------------------------

type busTrackerHeartbeat struct {
	BatteryPct *int    `json:"battery_pct,omitempty"`
	Charging   *bool   `json:"charging,omitempty"`
	LocationOK *bool   `json:"location_ok,omitempty"`
	AppVersion *string `json:"app_version,omitempty"`
}

/*
busTrackerHeartbeatHandler is how the office knows the phone is alive.

	location_ok is the field that earns this endpoint. A handset that is
	online, charged and reporting false — background location permission
	revoked, or the OS denying it — is the exact failure where every other
	indicator is green and the bus is not on the map. Without it the screen
	would show a healthy tracker and an absent bus and offer no connection
	between the two.
*/
func (s *Server) busTrackerHeartbeatHandler(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	var req busTrackerHeartbeat
	if !httpx.Decode(w, r, &req) {
		return
	}
	var ping int
	var paused bool
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			UPDATE vehicle_trackers
			   SET last_seen_at = now(),
			       battery_pct = COALESCE($2, battery_pct),
			       charging    = COALESCE($3, charging),
			       location_ok = COALESCE($4, location_ok),
			       app_version = COALESCE($5, app_version),
			       updated_at  = now()
			 WHERE id = $1
			RETURNING ping_seconds, paused`,
			dev.ID, req.BatteryPct, req.Charging, req.LocationOK, req.AppVersion).
			Scan(&ping, &paused)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ping_seconds": ping, "paused": paused})
}

// --- mounting ----------------------------------------------------------------

// mountBusTrackerDevice carries the routes a phone uses, and the one that turns
// a code into a phone.
//
// Spliced into api.go *outside* the authenticated group, beside
// mountSMSGatewayDevice. It has to be: a handset holds no session, and the
// claim has no credential at all until it succeeds.
func (s *Server) mountBusTrackerDevice(r chi.Router) {
	r.Post("/public/bus-tracker/claim", s.claimBusTrackerPairCode)
	/* The way in that needs nobody in the office. HR already records who
	   drives which bus, so a phone number and the PIN they were issued are
	   enough on their own -- see bus_driver_signin.go. */
	r.Post("/public/bus-tracker/driver-signin", s.signInBusDriver)

	// The driver enrols their own handset against the number painted on the
	// bus. The claim above stays: a school midway through printed
	// instructions should not find that they stopped working.
	r.Post("/public/bus-tracker/enrol", s.enrolBusTracker)

	r.Group(func(r chi.Router) {
		r.Use(s.requireBusTracker)

		// Who is driving. Device-authenticated but not driver-authenticated,
		// for the obvious reason: this is the request that produces a driver.
		r.Post("/bus-tracker/session", s.busTrackerSignIn)
		r.Post("/bus-tracker/session/end", s.busTrackerSignOut)

		// Opening and closing a run names a person, so both require one to be
		// signed in. Positions and heartbeat deliberately do not: a session
		// that lapses mid-route must never drop a moving bus off the parents'
		// map, and the trip already records the driver who opened it.
		r.With(s.requireBusTrackerDriver).Post("/bus-tracker/trips", s.startBusTrackerTrip)
		r.With(s.requireBusTrackerDriver).Post("/bus-tracker/trips/{id}/end", s.endBusTrackerTrip)

		/* Which lines this bus runs, asked once the sticker has been read.
		   Device-authenticated only: choosing a bus is not naming a person. */
		r.Get("/bus-tracker/routes", s.busTrackerRoutesForBus)

		r.Post("/bus-tracker/positions", s.ingestBusTrackerPositions)
		r.Post("/bus-tracker/heartbeat", s.busTrackerHeartbeatHandler)
	})
}

// mountBusTrackerAdmin registers the office's half: pairing a phone and
// retiring one. Gated on transport.write, which is what the transport office
// already holds.
func (s *Server) mountBusTrackerAdmin(r chi.Router) {
	write := httpx.RequirePermission(rbac.TransportWrite)
	r.With(write).Post("/transport/trackers/pair", s.pairBusTracker)

	/* Letting an enrolled handset start reporting.

	   Gated on transport.write like everything else here, and then narrowed
	   again inside the handler to the principal and the platform. A tracker is
	   a live map of where children are during the day, and that is not the
	   same decision as editing a route. */
	r.With(write).Post("/transport/trackers/{id}/approve", s.approveBusTracker)
}
