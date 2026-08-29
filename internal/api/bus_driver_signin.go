package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE DRIVER SIGNS IN. NOTHING ELSE.

   Getting a handset onto a bus took two people and a stopwatch: somebody in
   the office generated an eight-character pair code, and the driver typed it
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
	errDriverNoRecord  = errors.New("this login is not an employee record")
)

type driverSignInRequest struct {
	Phone string `json:"phone"`
	PIN   string `json:"pin"`
	// The handset, for the transport screen. All optional: a driver who
	// declines the permission still gets a working tracker.
	DeviceModel    string `json:"device_model,omitempty"`
	AndroidVersion string `json:"android_version,omitempty"`
	AppVersion     string `json:"app_version,omitempty"`
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
	who, err := s.authenticatePIN(r.Context(), req.Phone, req.PIN)
	if err != nil {
		deviceLoginRejected(w, r, err)
		return
	}

	var (
		token, registration, vehicleModel string
		deviceID, vehicleID               uuid.UUID
	)
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		/* The bus HR put this person against.

		   Joined through employees rather than users: driver_employee_id
		   points at the personnel record, and a driver has one login and one
		   employee row. An active vehicle only -- a handset paired to a bus
		   in the workshop reports a route nobody is driving. */
		if qerr := tx.QueryRow(r.Context(), `
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
			        app_version, enrolled_by, approved_at, approved_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $7)
			RETURNING id`,
			who.Institution, vehicleID,
			// The name the transport screen shows. The driver's own, because
			// that is who somebody rings when a bus stops reporting.
			who.Name+"'s phone",
			nullIfBlank(req.DeviceModel), nullIfBlank(req.AndroidVersion),
			nullIfBlank(req.AppVersion), who.UserID).Scan(&deviceID); ierr != nil {
			return ierr
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
		_, terr = tx.Exec(r.Context(),
			`UPDATE vehicle_trackers SET token_sealed = $2 WHERE id = $1`, deviceID, sealed)
		return terr
	})

	switch {
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
		"institution":  who.Institution.String(),
		"vehicle": map[string]any{
			"id":               vehicleID.String(),
			"registration_no":  registration,
			"model":            vehicleModel,
		},
		"driver": who.Name,
	})
}
