package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Writing the bus register.

	The vehicles table has been readable since the baseline and writable by
	nobody: rows arrived only through the demo seed, so a real school could
	never add its own bus. That gap is not cosmetic. The driver handset signs
	in by looking up vehicles.driver_employee_id, and with no way to set that
	column every driver was told no vehicle is assigned to them.

	The one rule worth enforcing here is that a driver drives one active bus.
	The sign-in query picks the driver's vehicle with ORDER BY registration_no
	and takes the first, so a second claim on the same driver does not fail
	loudly -- it silently hands the handset whichever bus sorts first. Better
	to refuse the second assignment and name the bus already holding him, so
	the office can free it deliberately.
*/
type vehicleRequest struct {
	CampusID        string `json:"campus_id,omitempty"`
	RegistrationNo  string `json:"registration_no"`
	Model           string `json:"model,omitempty"`
	Capacity        *int   `json:"capacity,omitempty"`
	DriverID        string `json:"driver_employee_id,omitempty"`
	AttendantID     string `json:"attendant_employee_id,omitempty"`
	InsuranceExpiry string `json:"insurance_expiry,omitempty"`
	FitnessExpiry   string `json:"fitness_expiry,omitempty"`
	PermitExpiry    string `json:"permit_expiry,omitempty"`
	PucExpiry       string `json:"puc_expiry,omitempty"`
	Status          string `json:"status,omitempty"`
}

// normalise validates the parts of the body that do not need the database,
// so both create and update reject the same bad input in the same words.
func (req *vehicleRequest) normalise() (driver, attendant, campus *uuid.UUID, capacity int, err error) {
	req.RegistrationNo = strings.ToUpper(strings.TrimSpace(req.RegistrationNo))
	req.Model = strings.TrimSpace(req.Model)
	if req.RegistrationNo == "" {
		return nil, nil, nil, 0, errors.New("the bus needs its registration number")
	}
	if req.Status == "" {
		req.Status = "active"
	}
	switch req.Status {
	case "active", "maintenance", "retired":
	default:
		return nil, nil, nil, 0, errors.New("status must be active, maintenance or retired")
	}
	// Forty is the table's own default, kept here so an omitted capacity means
	// the same thing on an update as it does on a create.
	capacity = 40
	if req.Capacity != nil {
		capacity = *req.Capacity
	}
	if capacity <= 0 {
		return nil, nil, nil, 0, errors.New("capacity must be more than zero")
	}
	if driver, err = optionalUUID(req.DriverID); err != nil {
		return nil, nil, nil, 0, errors.New("driver_employee_id must be a uuid")
	}
	if attendant, err = optionalUUID(req.AttendantID); err != nil {
		return nil, nil, nil, 0, errors.New("attendant_employee_id must be a uuid")
	}
	if campus, err = optionalUUID(req.CampusID); err != nil {
		return nil, nil, nil, 0, errors.New("campus_id must be a uuid")
	}
	return driver, attendant, campus, capacity, nil
}

// errDriverTaken carries the other bus's registration back out of the
// transaction, because the useful half of the refusal is which bus to look at.
type errDriverTaken struct{ registration string }

func (e errDriverTaken) Error() string { return "driver already on " + e.registration }

/*
driverFree refuses a driver who is already on another active bus.

	Scoped to active vehicles only: a retired bus still carrying its last
	driver must not block him from being put on his new one.
*/
func driverFree(r *http.Request, tx pgx.Tx, driver *uuid.UUID, exclude *uuid.UUID) error {
	if driver == nil {
		return nil
	}
	var other string
	err := tx.QueryRow(r.Context(), `
		SELECT registration_no
		  FROM vehicles
		 WHERE driver_employee_id = $1
		   AND status = 'active'
		   AND ($2::uuid IS NULL OR id <> $2)
		 LIMIT 1`, *driver, exclude).Scan(&other)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return errDriverTaken{registration: other}
}

/*
staffBelongs refuses an employee id that is not this school's.

	The FK to employees is not the guard it looks like: Postgres checks
	referential integrity with RLS bypassed, so a uuid belonging to another
	school satisfies it and lands in the row. vehicles' own RLS only constrains
	institution_id, so nothing else catches it either -- the bus would be this
	school's and its driver another school's, and that driver could then sign a
	handset into a bus he has nothing to do with.

	One statement for both ids: an attendant from another school is the same
	leak with a quieter consequence.
*/
func staffBelongs(r *http.Request, tx pgx.Tx, ids ...*uuid.UUID) error {
	for _, id := range ids {
		if id == nil {
			continue
		}
		var ok bool
		// The tenant transaction already restricts employees by RLS, so
		// EXISTS answering false is exactly "not one of ours".
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM employees WHERE id = $1)`, *id).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return errNotOurStaff
		}
	}
	return nil
}

var errNotOurStaff = errors.New("that person is not on this school's staff")

/*
campusBelongs does the same for an explicitly supplied campus.

	Same reasoning, same hole: campuses is reached by FK, the FK bypasses RLS,
	and vehicles' WITH CHECK never looks at campus_id. A bus filed against
	another school's campus reads as normal in the register while every
	campus-scoped count quietly excludes it.
*/
func campusBelongs(r *http.Request, tx pgx.Tx, campus *uuid.UUID) error {
	if campus == nil {
		return nil
	}
	var ok bool
	if err := tx.QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM campuses WHERE id = $1)`, *campus).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return errNotOurCampus
	}
	return nil
}

var errNotOurCampus = errors.New("that campus is not this school's")

// vehicleWriteFailed renders the two refusals both write paths share, and
// reports whether it answered the request.
func vehicleWriteFailed(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, errNotOurStaff) || errors.Is(err, errNotOurCampus) {
		httpx.BadRequest(w, r, err.Error())
		return true
	}
	var taken errDriverTaken
	if errors.As(err, &taken) {
		httpx.Error(w, r, http.StatusConflict, "driver_assigned",
			"that driver is already on bus "+taken.registration+
				". Take him off it first, or the handset cannot tell which bus he is signing into")
		return true
	}
	if uniqueViolationOn(err, "vehicles_institution_id_registration_no_key") || isUniqueViolation(err) {
		httpx.Error(w, r, http.StatusConflict, "duplicate_registration",
			"a bus with that registration number is already on the register")
		return true
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return true
	}
	return false
}

func (s *Server) createVehicle(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req vehicleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	driver, attendant, campus, capacity, verr := req.normalise()
	if verr != nil {
		httpx.BadRequest(w, r, verr.Error())
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if verr := staffBelongs(r, tx, driver, attendant); verr != nil {
			return verr
		}
		if verr := campusBelongs(r, tx, campus); verr != nil {
			return verr
		}
		if derr := driverFree(r, tx, driver, nil); derr != nil {
			return derr
		}
		// campus_id is NOT NULL and most schools run one campus, so an
		// omitted campus lands the bus on the founding one rather than
		// making the office look up an id it does not have.
		/* THE CODE ON THE STICKER, minted with the bus.

		   Generated here rather than left for somebody to fill in, because a
		   bus without one is a bus no driver can sign on to, and the office
		   would find that out at six in the morning. Six digits drawn until
		   one is free in this school -- a thousand buses in, a collision is
		   still under one draw in a thousand, and the unique index is the
		   thing that actually decides. */
		var code string
		for attempt := 0; ; attempt++ {
			if err := tx.QueryRow(r.Context(), `
				SELECT lpad((floor(random() * 1000000))::int::text, 6, '0')`).
				Scan(&code); err != nil {
				return err
			}
			var taken bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM vehicles
				                WHERE institution_id = $1 AND bus_code = $2)`,
				id.InstitutionID, code).Scan(&taken); err != nil {
				return err
			}
			if !taken {
				break
			}
			// Ten thousand buses would be a different product. Bail rather
			// than spin: a vehicle with no code is caught by the NOT NULL
			// nothing else in this transaction can satisfy.
			if attempt > 20 {
				return errors.New("could not allocate a bus code")
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO vehicles
			    (institution_id, campus_id, registration_no, model, capacity,
			     driver_employee_id, attendant_employee_id, insurance_expiry,
			     fitness_expiry, permit_expiry, puc_expiry, status, bus_code)
			VALUES ($1,
			        COALESCE($2::uuid, (SELECT id FROM campuses ORDER BY created_at LIMIT 1)),
			        $3, NULLIF($4,''), $5, $6, $7,
			        NULLIF($8,'')::date, NULLIF($9,'')::date,
			        NULLIF($10,'')::date, NULLIF($11,'')::date, $12, $13)
			RETURNING id::text`,
			id.InstitutionID, campus, req.RegistrationNo, req.Model, capacity,
			driver, attendant, req.InsuranceExpiry, req.FitnessExpiry,
			req.PermitExpiry, req.PucExpiry, req.Status, code).Scan(&newID)
	})
	if vehicleWriteFailed(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID, "registration_no": req.RegistrationNo,
	})
}

func (s *Server) updateVehicle(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	vid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid vehicle id")
		return
	}
	var req vehicleRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	driver, attendant, _, capacity, verr := req.normalise()
	if verr != nil {
		httpx.BadRequest(w, r, verr.Error())
		return
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if verr := staffBelongs(r, tx, driver, attendant); verr != nil {
			return verr
		}
		if derr := driverFree(r, tx, driver, &vid); derr != nil {
			return derr
		}
		/* The whole row is rewritten rather than patched field by field.
		   Papers are the reason: an omitted insurance expiry has to be able
		   to clear a date that turned out to be wrong, and a PATCH shape
		   where absence means "leave it" can never express that. */
		tag, terr := tx.Exec(r.Context(), `
			UPDATE vehicles
			   SET registration_no = $2,
			       model = NULLIF($3,''),
			       capacity = $4,
			       driver_employee_id = $5,
			       attendant_employee_id = $6,
			       insurance_expiry = NULLIF($7,'')::date,
			       fitness_expiry = NULLIF($8,'')::date,
			       permit_expiry = NULLIF($9,'')::date,
			       puc_expiry = NULLIF($10,'')::date,
			       status = $11
			 WHERE id = $1`,
			vid, req.RegistrationNo, req.Model, capacity, driver, attendant,
			req.InsuranceExpiry, req.FitnessExpiry, req.PermitExpiry,
			req.PucExpiry, req.Status)
		found = terr == nil && tag.RowsAffected() > 0
		return terr
	})
	if vehicleWriteFailed(w, r, err) {
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": vid.String(), "registration_no": req.RegistrationNo,
	})
}

type vehicleRouteRequest struct {
	RouteID string `json:"route_id"`
}

/*
setVehicleRoute points a route at this bus.

	The link lives on routes.vehicle_id, not on the vehicle, so assigning is a
	write to the route. A route carries at most one bus, and the driver sign-in
	lists the stops of every route pointing at the vehicle, so the same route
	left on two buses would show one driver another bus's stops. Clearing the
	route off whatever held it before is therefore part of the same statement,
	not a separate call the office could forget to make.

	An empty route_id detaches every route from this bus, which is how a bus
	goes off the road without being retired.
*/
func (s *Server) setVehicleRoute(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	vid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid vehicle id")
		return
	}
	var req vehicleRouteRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	route, err := optionalUUID(req.RouteID)
	if err != nil {
		httpx.BadRequest(w, r, "route_id must be a uuid")
		return
	}

	var vehicleFound, routeFound bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if qerr := tx.QueryRow(r.Context(),
			`SELECT true FROM vehicles WHERE id = $1`, vid).Scan(&vehicleFound); qerr != nil {
			if errors.Is(qerr, pgx.ErrNoRows) {
				return nil
			}
			return qerr
		}
		// The route is confirmed before anything is cleared, so a mistyped
		// route id cannot leave the bus stripped of the route it had.
		if route != nil {
			if qerr := tx.QueryRow(r.Context(),
				`SELECT true FROM routes WHERE id = $1`, *route).Scan(&routeFound); qerr != nil {
				if errors.Is(qerr, pgx.ErrNoRows) {
					return nil
				}
				return qerr
			}
		} else {
			routeFound = true
		}
		if _, cerr := tx.Exec(r.Context(),
			`UPDATE routes SET vehicle_id = NULL WHERE vehicle_id = $1`, vid); cerr != nil {
			return cerr
		}
		if route == nil {
			return nil
		}
		_, uerr := tx.Exec(r.Context(),
			`UPDATE routes SET vehicle_id = $2 WHERE id = $1`, *route, vid)
		return uerr
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !vehicleFound || !routeFound {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": vid.String(), "route_id": req.RouteID,
	})
}

type assignableStaffRow struct {
	ID   string `json:"id"`
	Name string `json:"full_name"`
	Code string `json:"employee_code,omitempty"`
}

/*
listAssignableStaff is the people a bus can be given to.

	Deliberately not /transport/staff, which lists only those already on the
	Drivers tab. A school that has just hired a driver has him in HR and
	nowhere else, and a picker that cannot see him means the bus cannot be
	given to him -- so this reads the staff roll itself.

	Transport had been borrowing HR's /hr/employees for this, which sits behind
	EmployeesRead -- a permission neither transport_manager nor operations
	holds. So for every role that can actually reach the transport screens the
	list 403'd, the dropdown rendered empty with no error shown, and the office
	could save a bus with no driver on it and no idea why. That is the whole
	feature failing silently for exactly the people it is for.

	Reading the staff roll is not the same act as reading HR records, and this
	returns only what a picker needs: a name, and the code that tells two
	people with the same name apart. No salary, no documents, no contact
	details.
*/
func (s *Server) listAssignableStaff(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.id::text,
		       COALESCE(NULLIF(concat_ws(' ', e.first_name, e.last_name), ''), 'Unnamed'),
		       COALESCE(e.employee_code, '')
		  FROM employees e
		 WHERE e.status = 'active'
		 ORDER BY e.first_name, e.last_name
		 LIMIT 500`, nil,
		func(rows pgx.Rows) (assignableStaffRow, error) {
			var v assignableStaffRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Code)
		})
	respond(w, r, items, err)
}
