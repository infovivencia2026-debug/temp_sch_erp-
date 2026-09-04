package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE DRIVER'S OWN BUS, ON THE WEB.

   A driver holds TransportRead and nothing else, and every transport list
   that permission opens is the office's: all vehicles, all routes, every
   check on every bus. A driver signing in on the web had no way to say
   "mine" — the session carries a user id, the vehicle carries an employee
   id, and nothing on the client joins the two.

   This is that join, done once, server-side, on the same predicate the
   handset's sign-in uses: the employee row whose user_id is the caller, and
   the vehicle HR put that employee against. No id in the request, so it
   cannot be aimed at somebody else's bus.

   Deliberately read-only. The pre-trip check, the roll and the trip itself
   are the handset's job, where the phone is the tracker; this screen is for
   a driver at a desk who wants to know which bus, which route, and whether
   today's check went in. */

type myBusStop struct {
	Name       string  `json:"name"`
	Sequence   int     `json:"sequence"`
	PickupTime *string `json:"pickup_time,omitempty"`
	DropTime   *string `json:"drop_time,omitempty"`
	Riders     int     `json:"riders"`
}

type myBusCheck struct {
	OnDate  string   `json:"on_date"`
	Leg     string   `json:"leg"`
	Cleared bool     `json:"cleared"`
	Failed  []string `json:"failed_items"`
}

type myBusResponse struct {
	// Note is set, and everything else empty, when the caller is not on the
	// staff roll or has no bus against their name. A screen can say so.
	Note string `json:"note,omitempty"`

	EmployeeCode string `json:"employee_code,omitempty"`
	VehicleID    string `json:"vehicle_id,omitempty"`
	Registration string `json:"registration_no,omitempty"`
	Model        string `json:"model,omitempty"`
	Capacity     *int   `json:"capacity,omitempty"`
	Attendant    string `json:"attendant,omitempty"`
	NextExpiry   string `json:"next_expiry,omitempty"`

	RouteID   string      `json:"route_id,omitempty"`
	RouteName string      `json:"route_name,omitempty"`
	RouteCode string      `json:"route_code,omitempty"`
	Riders    int         `json:"riders"`
	Stops     []myBusStop `json:"stops"`

	// The open trip, if the handset has one running.
	TripDirection string `json:"trip_direction,omitempty"`
	TripStartedAt string `json:"trip_started_at,omitempty"`
	TrackerPaired bool   `json:"tracker_paired"`

	// The last fortnight's pre-trip checks on this bus, newest first.
	Checks []myBusCheck `json:"checks"`
}

func (s *Server) getMyBus(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	out := myBusResponse{Stops: []myBusStop{}, Checks: []myBusCheck{}}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var empID string
		err := tx.QueryRow(r.Context(),
			`SELECT id::text, employee_code FROM employees WHERE user_id = $1 AND status = 'active'`,
			id.UserID).Scan(&empID, &out.EmployeeCode)
		if err == pgx.ErrNoRows {
			out.Note = "This login is not on the staff roll, so no bus can be found against it."
			return nil
		}
		if err != nil {
			return err
		}

		var model, attendant, nextExpiry, routeID, routeName, routeCode *string
		err = tx.QueryRow(r.Context(), `
			SELECT v.id::text, v.registration_no, v.model, v.capacity,
			       NULLIF(concat_ws(' ', a.first_name, a.last_name), ''),
			       to_char(NULLIF(least(
			           COALESCE(v.insurance_expiry,'infinity'::date),
			           COALESCE(v.fitness_expiry,  'infinity'::date),
			           COALESCE(v.permit_expiry,   'infinity'::date),
			           COALESCE(v.puc_expiry,      'infinity'::date)),
			         'infinity'::date), 'YYYY-MM-DD'),
			       rt.id::text, rt.name, rt.code,
			       EXISTS (SELECT 1 FROM vehicle_trackers tr
			                WHERE tr.vehicle_id = v.id AND tr.revoked_at IS NULL)
			  FROM vehicles v
			  LEFT JOIN employees a ON a.id = v.attendant_employee_id
			  LEFT JOIN routes rt ON rt.vehicle_id = v.id AND rt.is_active
			 WHERE v.driver_employee_id = $1::uuid AND v.status <> 'retired'
			 ORDER BY rt.name NULLS LAST
			 LIMIT 1`, empID).
			Scan(&out.VehicleID, &out.Registration, &model, &out.Capacity, &attendant,
				&nextExpiry, &routeID, &routeName, &routeCode, &out.TrackerPaired)
		if err == pgx.ErrNoRows {
			out.Note = "No bus is assigned to you yet. The transport office puts a driver on a bus."
			return nil
		}
		if err != nil {
			return err
		}
		out.Model = deref(model)
		out.Attendant = deref(attendant)
		out.NextExpiry = deref(nextExpiry)
		out.RouteID, out.RouteName, out.RouteCode = deref(routeID), deref(routeName), deref(routeCode)

		if routeID != nil {
			rows, err := tx.Query(r.Context(), `
				SELECT rs.name, rs.sequence,
				       to_char(rs.pickup_time,'HH24:MI'), to_char(rs.drop_time,'HH24:MI'),
				       (SELECT count(*) FROM transport_allocations ta
				         WHERE ta.pickup_stop_id = rs.id AND ta.valid_to IS NULL)::int
				  FROM route_stops rs
				 WHERE rs.route_id = $1::uuid
				 ORDER BY rs.sequence`, *routeID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var st myBusStop
				if err := rows.Scan(&st.Name, &st.Sequence, &st.PickupTime, &st.DropTime, &st.Riders); err != nil {
					rows.Close()
					return err
				}
				out.Riders += st.Riders
				out.Stops = append(out.Stops, st)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		var dir, started *string
		err = tx.QueryRow(r.Context(), `
			SELECT t.direction,
			       to_char(t.started_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI:SS')
			  FROM vehicle_trips t
			 WHERE t.vehicle_id = $1::uuid AND t.ended_at IS NULL
			 ORDER BY t.started_at DESC LIMIT 1`, out.VehicleID).Scan(&dir, &started)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		out.TripDirection, out.TripStartedAt = deref(dir), deref(started)

		rows, err := tx.Query(r.Context(), `
			SELECT to_char(tc.on_date,'YYYY-MM-DD'), tc.leg, tc.cleared,
			       array_remove(ARRAY[
			           CASE WHEN NOT tc.brakes_ok THEN 'brakes' END,
			           CASE WHEN NOT tc.tyres_ok THEN 'tyres' END,
			           CASE WHEN NOT tc.lights_ok THEN 'lights' END,
			           CASE WHEN NOT tc.first_aid_ok THEN 'first aid' END,
			           CASE WHEN NOT tc.extinguisher_ok THEN 'extinguisher' END,
			           CASE WHEN NOT tc.doors_ok THEN 'doors' END,
			           CASE WHEN COALESCE(tc.breathalyser,0) > 0 THEN 'breathalyser' END
			       ], NULL)
			  FROM trip_checks tc
			 WHERE tc.vehicle_id = $1::uuid AND tc.on_date >= current_date - 14
			 ORDER BY tc.on_date DESC, tc.leg
			 LIMIT 30`, out.VehicleID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c myBusCheck
			if err := rows.Scan(&c.OnDate, &c.Leg, &c.Cleared, &c.Failed); err != nil {
				return err
			}
			if c.Failed == nil {
				c.Failed = []string{}
			}
			out.Checks = append(out.Checks, c)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
