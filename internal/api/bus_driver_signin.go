package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE DRIVER SIGNS IN. NOTHING ELSE.

   Getting a handset onto a bus took two people and a stopwatch: somebody in
   the office generated a nine-digit pair code, and the driver typed it
   within ten minutes. The driver is standing beside the bus at six in the
   morning; the office opens at nine.

   The second route, self-enrolment, replaced the code with the registration
   number painted on the bus -- better, and still asking a driver to type
   something they have to read off the vehicle in the dark.

   Neither is necessary. HR already records who drives which bus:
   vehicles.driver_employee_id has been on that table since the baseline
   migration. So the phone number and the PIN the office issued are enough on
   their own -- the same PIN that signs the driver in to everything else, so
   there is nothing new for anybody to remember and nothing for HR to do that
   they were not already doing.

   Install, type your number and PIN, drive.

   ---------------------------------------------------------------------------
   WHAT THIS DOES NOT LOOSEN

   The device token is still what authorises position reports, and it is still
   minted by the server rather than chosen by the phone. What changed is who
   proves they may have one: a pair code proved somebody had spoken to the
   office, and a PIN proves who the person is, which is strictly more.

   It is also narrower than the routes it replaces. A pair code let anybody
   holding it pair to the named bus. This only ever returns the bus HR has put
   this driver against, so a driver cannot attach a handset to somebody else's
   route by typing a number they overheard.

   No approval step, deliberately. The bus is the one HR assigned, the person
   is the one the PIN identifies, and asking a principal to approve a pairing
   the office already decided is a queue with nothing in it -- which is the
   shape of process that gets worked around by handing out pair codes.
*/

var (
	errDriverNoVehicle = errors.New("no vehicle is assigned to this driver")
	// A code was typed or scanned and no active bus in this school carries it.
	// Deliberately separate from "you are assigned to nothing": one is a
	// mistyped sticker, the other is a conversation with the office.
	errNoSuchBus      = errors.New("no bus in this school has that code")
	errDriverNoRecord = errors.New("this login is not an employee record")
)

type driverSignInRequest struct {
	Phone string `json:"phone"`
	// The driver's ordinary login password. "pin" is still read, so a handset
	// built before this change goes on working after the server updates.
	Password string `json:"password"`
	PIN      string `json:"pin"`
	// The handset, for the transport screen. All optional: a driver who
	// declines the permission still gets a working tracker.
	DeviceModel    string `json:"device_model,omitempty"`
	AndroidVersion string `json:"android_version,omitempty"`
	AppVersion     string `json:"app_version,omitempty"`
	/* WHICH BUS, TODAY.

	   The six digits on the sticker in the cab, scanned or typed. Sign-in used
	   to take the vehicle HR had put this driver against, which assumes a
	   driver is permanent on a bus — and no school works that way. The regular
	   man is on leave, the spare bus goes out, two drivers swap at lunch, and
	   the map then shows a bus that is standing in the yard.

	   Optional, so a handset built before this goes on working: with no code
	   the assigned vehicle is still used. */
	BusCode string `json:"bus_code,omitempty"`
}

/*
signInBusDriver exchanges a phone and a PIN for a device token and a bus.

	Public, like the pair-code claim it replaces: the phone has no credential
	of any kind until this succeeds, so there is nothing to authenticate with.
	The PIN is the credential.
*/
func (s *Server) signInBusDriver(w http.ResponseWriter, r *http.Request) {
	var req driverSignInRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	/* No limiter here, and that is not an oversight: authenticatePIN counts
	   failures against the account itself and locks it, which is the right
	   place for a PIN. A per-connection limit on top would let somebody lock
	   every driver in a school out of their phones by typing rubbish from one
	   address. */
	secret := req.Password
	if secret == "" {
		secret = req.PIN
	}
	who, err := s.authenticateStaffLogin(r.Context(), req.Phone, secret)
	if err != nil {
		deviceLoginRejected(w, r, err)
		return
	}

	type routeRow struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Code string `json:"code,omitempty"`
	}
	var (
		token, registration, vehicleModel string
		sessionToken                      string
		deviceID, vehicleID               uuid.UUID
		routes                            = []routeRow{}
	)
	/* TENANT-SCOPED, NOT PLATFORM.

	   The authentication above had to run AsPlatform: it looks a person up by
	   email or phone across the whole installation, because nobody has told us
	   which school this is yet. From here we know -- who.Institution -- and
	   the rest must run as that school.

	   Not a tidiness point. device_staff_sessions' RLS policy is
	   `institution_id = app_current_institution()` in both USING and WITH
	   CHECK, with no platform escape, so opening the driver's shift inside a
	   platform transaction is refused with 42501 and the sign-in dies at the
	   last statement having already done everything else. AsPlatform is not a
	   master key; it is a scope with no institution in it, and a policy that
	   asks which institution gets no answer. */
	err = s.DB.InTenant(r.Context(), tenantScopeFor(who.Institution, false),
		func(tx pgx.Tx) error {
			/* The bus HR put this person against.

			   Joined through employees rather than users: driver_employee_id
			   points at the personnel record, and a driver has one login and one
			   employee row. An active vehicle only -- a handset paired to a bus
			   in the workshop reports a route nobody is driving. */
			/* THE BUS HE SAYS HE IS ON, or the one HR put him against.

			   The code wins when it is given. It is not a credential and does
			   not need to be: the driver has already proved who he is with his
			   own login, and what the code answers is "which of this school's
			   buses am I sitting in" — a question the school would rather he
			   answered by scanning the windscreen than by ringing the office
			   because the spare bus went out this morning.

			   Scoped to his own school either way, so a code read off a bus in
			   another yard resolves to nothing. */
			busCode := strings.TrimSpace(req.BusCode)
			if busCode != "" {
				if qerr := tx.QueryRow(r.Context(), `
				SELECT v.id, v.registration_no, COALESCE(v.model,'')
				  FROM vehicles v
				 WHERE v.institution_id = $1
				   AND v.bus_code = $2
				   AND v.status = 'active'`, who.Institution, busCode).
					Scan(&vehicleID, &registration, &vehicleModel); qerr != nil {
					if errors.Is(qerr, pgx.ErrNoRows) {
						return errNoSuchBus
					}
					return qerr
				}
			} else if qerr := tx.QueryRow(r.Context(), `
			SELECT v.id, v.registration_no, COALESCE(v.model,'')
			  FROM vehicles v
			  JOIN employees e ON e.id = v.driver_employee_id
			 WHERE e.user_id = $1
			   AND v.institution_id = $2
			   AND v.status = 'active'
			 ORDER BY v.registration_no
			 LIMIT 1`, who.UserID, who.Institution).
				Scan(&vehicleID, &registration, &vehicleModel); qerr != nil {
				if errors.Is(qerr, pgx.ErrNoRows) {
					return errDriverNoVehicle
				}
				return qerr
			}

			/* ONE LIVE TRACKER PER BUS. Signing in on a new phone retires the old.

			   A driver whose handset was lost, replaced or wiped signs in on the
			   new one and it works, which is what a school expects and the reason
			   pair codes were being re-issued constantly. The previous row is
			   revoked rather than deleted -- a trip already recorded against it
			   must keep its device -- and the moment it is revoked its token stops
			   being accepted, so a handset that has left the school cannot go on
			   reporting a bus full of children.

			   Two statements rather than an upsert: vehicle_trackers has no unique
			   index on vehicle_id (only on pair_code_id), so ON CONFLICT has
			   nothing to name. Adding one would have to decide what to do about
			   the revoked rows this deliberately keeps. */
			if _, rerr := tx.Exec(r.Context(), `
			UPDATE vehicle_trackers
			   SET revoked_at = now(),
			       revoked_reason = 'replaced when the driver signed in on another phone'
			 WHERE vehicle_id = $1 AND revoked_at IS NULL`, vehicleID); rerr != nil {
				return rerr
			}
			if ierr := tx.QueryRow(r.Context(), `
			INSERT INTO vehicle_trackers
			       (institution_id, vehicle_id, name, device_model, android_version,
			        app_version, token_sealed, enrolled_by, approved_at, approved_by)
			/* token_sealed is bytea NOT NULL with no default, and the real
			   value cannot exist yet: it is derived from the row's own id,
			   which this statement is still generating. A placeholder, then,
			   overwritten by the UPDATE below in this same transaction, so no
			   committed row ever carries the sentinel.

			   Omitting it did not fail to compile and did not fail review. It
			   raised 23502 at runtime on every single call, which surfaced as
			   a bare 500 on the driver's sign-in screen -- and is why no trip
			   has ever been opened on this installation. The two sibling paths
			   both do this; only this one was written from scratch. */
			VALUES ($1,$2,$3,$4,$5,$6,'\x00'::bytea,$7, now(), $7)
			RETURNING id`,
				who.Institution, vehicleID,
				// The name the transport screen shows. The driver's own, because
				// that is who somebody rings when a bus stops reporting.
				who.Name+"'s phone",
				nullIfBlank(req.DeviceModel), nullIfBlank(req.AndroidVersion),
				nullIfBlank(req.AppVersion), who.UserID).Scan(&deviceID); ierr != nil {
				return ierr
			}

			/* THE ROUTES THIS BUS RUNS, so the driver never types a uuid.

			   routes.vehicle_id has been on that table since the baseline
			   migration: the office already decides which route a bus runs. The
			   app had no way to ask, so it kept a "route book" the driver filled
			   in by hand -- and what it asked them to type was a uuid, at twenty
			   to seven in the morning, off a piece of paper.

			   Sent with the sign-in rather than behind a second call: the phone has
			   just proved who is driving and which bus, and one round trip on a
			   school connection is worth more than the tidiness of a separate
			   endpoint. */
			rows, rerr := tx.Query(r.Context(), `
			SELECT id::text, name, COALESCE(code,'')
			  FROM routes
			 WHERE institution_id = $1 AND vehicle_id = $2
			 ORDER BY name`, who.Institution, vehicleID)
			if rerr != nil {
				return rerr
			}
			for rows.Next() {
				var rr routeRow
				if serr := rows.Scan(&rr.ID, &rr.Name, &rr.Code); serr != nil {
					rows.Close()
					return serr
				}
				routes = append(routes, rr)
			}
			rows.Close()
			if rerr := rows.Err(); rerr != nil {
				return rerr
			}

			// The token carries the row id, so it cannot be minted before the row
			// exists -- the same order claimBusTrackerPairCode uses.
			var secret string
			var terr error
			token, secret, terr = newBusTrackerToken(deviceID)
			if terr != nil {
				return terr
			}
			sealed, terr := sealSecret(secret)
			if terr != nil {
				return terr
			}
			if _, terr = tx.Exec(r.Context(),
				`UPDATE vehicle_trackers SET token_sealed = $2 WHERE id = $1`,
				deviceID, sealed); terr != nil {
				return terr
			}

			/* THE SHIFT, OPENED HERE.

			   Starting and ending a trip is gated on X-Staff-Session, not on the
			   device token: the school records who drove each run. This handler
			   minted the device token and stopped, so a driver signed in, saw his
			   bus, pressed Start Run and was told to sign in first -- with the
			   only other way to get a session being the PIN endpoint, and nothing
			   in HR's give-login flow ever writing a PIN.

			   So it is minted here, from the password he has just proved, which is
			   the only credential he has. */
			sessionToken, _, _, terr = s.openStaffSession(
				r.Context(), tx, who, "bus_tracker", deviceID)
			return terr
		})

	switch {
	case errors.Is(err, errNoSuchBus):
		httpx.Error(w, r, http.StatusNotFound, "no_such_bus",
			"no bus in this school has that code. Check the sticker in the cab, "+
				"or ask the office which bus you are on")
		return
	case errors.Is(err, errDriverNoVehicle):
		/* Named plainly, because the fix is somebody else's and the driver has
		   to be able to repeat it down a phone line. */
		httpx.Error(w, r, http.StatusConflict, "no_vehicle",
			"no bus is assigned to you yet. Ask the office to put you against a "+
				"vehicle in Transport, then sign in again")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"device_id":    deviceID.String(),
		"device_token": token,
		// The shift. Without it the app holds a tracker that reports position
		// and can never open a trip.
		"session_token": sessionToken,
		"institution":   who.Institution.String(),
		"vehicle": map[string]any{
			"id":              vehicleID.String(),
			"registration_no": registration,
			"model":           vehicleModel,
		},
		"driver": who.Name,
		/* Empty is not an error. A bus with no route yet still tracks -- the
		   parents see it move -- and the screen says so rather than the sign-in
		   failing over a setup step the office has not reached. */
		"routes": routes,
	})
}

/*
authenticateStaffLogin turns whatever the office wrote on a slip of paper into
a person.

	The credential is the driver's ordinary login -- the same one HR issues from
	"give login" on the staff record, typed into the same kind of box he would
	type it into on the website. That is the whole point: a school hands a
	driver one set of credentials, not one set for the website and a second,
	numeric one for the phone.

	It matters more than tidiness. Nothing in the HR flow ever writes pin_hash;
	only a deliberate PIN-issuing step does. So a driver given a login today has
	no PIN at all, and a PIN-only sign-in rejects him with "that number and PIN
	do not match" -- which reads as a wrong password and sends the office
	looking for a typo that is not there.

	The PIN stays as a second attempt, for the handsets and the drivers already
	carrying one, and because six digits are genuinely easier at six in the
	morning than a password with a capital letter in it. Password first
	because it is the one that always exists.

	Identifier is a phone number, but not necessarily only that: users match on
	email or username too, so a school that put a driver in by email still
	works. A wrong password here does NOT touch the PIN lockout counter -- the
	two credentials have to fail independently, or typing a password into a
	phone that wanted a PIN would lock the account.
*/
func (s *Server) authenticateStaffLogin(ctx context.Context, identifier, secret string) (staffIdentity, error) {
	if strings.TrimSpace(identifier) == "" || secret == "" {
		return staffIdentity{}, errBadPIN
	}

	var out staffIdentity
	var hash *string
	// Same rule the website's sign-in uses: an identifier that matches a user
	// in two tenants is refused rather than guessed at, because authenticating
	// whichever row sorted first signs the driver into the wrong school -- and
	// here that puts a bus on another school's map.
	var matches int
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		/* The school's status counts here too. A driver whose school has been
		   archived must not be able to put a bus on anybody's map, and a phone
		   left behind by a shut-off tenant must not make a live driver's number
		   look ambiguous. Same join, same reasoning, as the browser sign-in. */
		if err := tx.QueryRow(ctx, `
			SELECT count(*)
			  FROM users u
			  LEFT JOIN institutions i ON i.id = u.institution_id
			 WHERE u.status = 'active'
			   AND (u.institution_id IS NULL OR i.status = 'active')
			   AND (u.email = $1::citext OR u.phone = $1 OR u.username = $1::citext
			        OR right(regexp_replace(u.phone, '\D', '', 'g'), 10) = $1)`,
			identifier).Scan(&matches); err != nil {
			return err
		}
		if matches != 1 {
			return pgx.ErrNoRows
		}
		return tx.QueryRow(ctx, `
			SELECT u.id, u.institution_id, COALESCE(u.full_name,''), u.password_hash
			  FROM users u
			  LEFT JOIN institutions i ON i.id = u.institution_id
			 WHERE u.status = 'active'
			   AND (u.institution_id IS NULL OR i.status = 'active')
			   AND (u.email = $1::citext OR u.phone = $1 OR u.username = $1::citext
			        OR right(regexp_replace(u.phone, '\D', '', 'g'), 10) = $1)`,
			identifier).Scan(&out.UserID, &out.Institution, &out.Name, &hash)
	})
	if err == nil && hash != nil && s.Hasher.Verify(*hash, secret) == nil {
		return out, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return staffIdentity{}, err
	}

	// Not a password, or no password set. Try it as a PIN -- and only now, so
	// a mistyped password never counts towards the PIN lockout.
	return s.authenticatePIN(ctx, identifier, secret)
}
