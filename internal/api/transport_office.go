package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The transport office.

   The product knew which bus ran which route and which child was on it. What
   it could not answer is everything a transport manager is actually asked:
   whose licence expires next month, who got on the bus this morning, what the
   diesel cost, and where the 3:15 has got to. */

var (
	errStopNotOnRoute = errors.New("stop is not on that route")
	errOdometerBack   = errors.New("odometer reading went backwards")
	// Raised by the admissions handoff, which takes these ids from a form
	// rather than from a picker that could only offer valid ones.
	errBadTransportRef = errors.New("route_id and pickup_stop_id must be uuids")
)

// --- drivers and attendants -----------------------------------------------

type transportStaffRow struct {
	ID            string  `json:"id"`
	EmployeeID    string  `json:"employee_id"`
	Name          string  `json:"name"`
	Role          string  `json:"role"`
	LicenceNo     *string `json:"licence_no,omitempty"`
	LicenceExpiry *string `json:"licence_expiry,omitempty"`
	BadgeNo       *string `json:"badge_no,omitempty"`
	PoliceOn      *string `json:"police_verified_on,omitempty"`
	MedicalExpiry *string `json:"medical_expiry,omitempty"`
	Phone         *string `json:"phone,omitempty"`
	Vehicle       *string `json:"vehicle,omitempty"`
	// Days until the soonest of the licence, medical and police checks lapses.
	// Negative means it already has. One number because the office's question
	// is "who must I chase", not "which of three dates is nearest".
	DaysToLapse *int   `json:"days_to_lapse,omitempty"`
	Lapsed      string `json:"lapsed_item,omitempty"`
}

func (s *Server) listTransportStaff(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ts.id::text, ts.employee_id::text,
		       concat_ws(' ', e.first_name, e.last_name),
		       ts.role, ts.licence_no,
		       to_char(ts.licence_expiry,'YYYY-MM-DD'), ts.badge_no,
		       to_char(ts.police_verified_on,'YYYY-MM-DD'),
		       to_char(ts.medical_expiry,'YYYY-MM-DD'),
		       ts.phone, v.registration_no,
		       soonest.days, COALESCE(soonest.item, '')
		  FROM transport_staff ts
		  JOIN employees e ON e.id = ts.employee_id
		  LEFT JOIN vehicles v
		         ON v.driver_employee_id = ts.employee_id
		         OR v.attendant_employee_id = ts.employee_id
		  /* Police verification is treated as lapsing after a year, which is
		     the interval most state transport authorities require a re-check
		     at. A verification with no date at all is the finding, and sorts
		     first because it is worse than an expired one. */
		  LEFT JOIN LATERAL (
		      SELECT (d - current_date)::int AS days, label AS item
		        FROM (VALUES
		            (ts.licence_expiry, 'licence'),
		            (ts.medical_expiry, 'medical'),
		            (ts.police_verified_on + 365, 'police check')
		        ) AS x(d, label)
		       WHERE d IS NOT NULL
		       ORDER BY d
		       LIMIT 1
		  ) soonest ON TRUE
		 WHERE ts.is_active
		 ORDER BY soonest.days NULLS FIRST, e.first_name
		 LIMIT 200`, nil,
		func(rows pgx.Rows) (transportStaffRow, error) {
			var v transportStaffRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.Name, &v.Role, &v.LicenceNo,
				&v.LicenceExpiry, &v.BadgeNo, &v.PoliceOn, &v.MedicalExpiry,
				&v.Phone, &v.Vehicle, &v.DaysToLapse, &v.Lapsed)
		})
	respond(w, r, items, err)
}

type transportStaffRequest struct {
	EmployeeID    string `json:"employee_id"`
	Role          string `json:"role,omitempty"`
	LicenceNo     string `json:"licence_no,omitempty"`
	LicenceExpiry string `json:"licence_expiry,omitempty"`
	BadgeNo       string `json:"badge_no,omitempty"`
	PoliceOn      string `json:"police_verified_on,omitempty"`
	PoliceRef     string `json:"police_ref,omitempty"`
	MedicalExpiry string `json:"medical_expiry,omitempty"`
	BloodGroup    string `json:"blood_group,omitempty"`
	Phone         string `json:"phone,omitempty"`
	Notes         string `json:"notes,omitempty"`
}

func (s *Server) saveTransportStaff(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req transportStaffRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	employee, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if req.Role == "" {
		req.Role = "driver"
	}
	if req.LicenceNo != "" && req.LicenceExpiry == "" {
		httpx.BadRequest(w, r,
			"a licence number needs its expiry date. A licence on file with no expiry is a gap that hides itself")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO transport_staff
			    (institution_id, employee_id, role, licence_no, licence_expiry,
			     badge_no, police_verified_on, police_ref, medical_expiry,
			     blood_group, phone, notes)
			VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,'')::date,NULLIF($6,''),
			        NULLIF($7,'')::date,NULLIF($8,''),NULLIF($9,'')::date,
			        NULLIF($10,''),NULLIF($11,''),NULLIF($12,''))
			ON CONFLICT (employee_id) WHERE is_active
			DO UPDATE SET role = EXCLUDED.role,
			              licence_no = EXCLUDED.licence_no,
			              licence_expiry = EXCLUDED.licence_expiry,
			              badge_no = EXCLUDED.badge_no,
			              police_verified_on = EXCLUDED.police_verified_on,
			              police_ref = EXCLUDED.police_ref,
			              medical_expiry = EXCLUDED.medical_expiry,
			              blood_group = EXCLUDED.blood_group,
			              phone = EXCLUDED.phone,
			              notes = EXCLUDED.notes,
			              updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, employee, req.Role, req.LicenceNo, req.LicenceExpiry,
			req.BadgeNo, req.PoliceOn, req.PoliceRef, req.MedicalExpiry,
			req.BloodGroup, req.Phone, req.Notes).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

// --- student allocation ---------------------------------------------------

type allocationRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	Name        string  `json:"full_name"`
	AdmissionNo string  `json:"admission_no"`
	ClassName   *string `json:"class_name,omitempty"`
	Route       *string `json:"route,omitempty"`
	RouteID     *string `json:"route_id,omitempty"`
	PickupStop  *string `json:"pickup_stop,omitempty"`
	DropStop    *string `json:"drop_stop,omitempty"`
	PickupTime  *string `json:"pickup_time,omitempty"`
	// The fare the chosen stop implies. Read from the stop rather than typed,
	// because a transport fee that disagrees with the stop it was set from is
	// an argument at the counter every August.
	FarePaise *int64 `json:"fare_paise,omitempty"`
}

func (s *Server) listTransportAllocations(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ta.id::text, st.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       cl.name, rt.name, rt.id::text, ps.name, ds.name,
		       to_char(ps.pickup_time,'HH24:MI'), ps.fare_paise
		  FROM transport_allocations ta
		  JOIN students st ON st.id = ta.student_id
		  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
		  LEFT JOIN sections sec ON sec.id = en.section_id
		  LEFT JOIN classes cl ON cl.id = sec.class_id
		  LEFT JOIN routes rt ON rt.id = ta.route_id
		  LEFT JOIN route_stops ps ON ps.id = ta.pickup_stop_id
		  LEFT JOIN route_stops ds ON ds.id = ta.drop_stop_id
		 WHERE ta.valid_to IS NULL OR ta.valid_to >= current_date
		 ORDER BY rt.name, ps.sequence, st.first_name
		 LIMIT 600`, nil,
		func(rows pgx.Rows) (allocationRow, error) {
			var v allocationRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.Name, &v.AdmissionNo,
				&v.ClassName, &v.Route, &v.RouteID, &v.PickupStop, &v.DropStop,
				&v.PickupTime, &v.FarePaise)
		})
	respond(w, r, items, err)
}

type allocationRequest struct {
	StudentID    string `json:"student_id"`
	RouteID      string `json:"route_id"`
	PickupStopID string `json:"pickup_stop_id"`
	DropStopID   string `json:"drop_stop_id,omitempty"`
}

func (s *Server) allocateTransport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req allocationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	route, err := uuid.Parse(req.RouteID)
	if err != nil {
		httpx.BadRequest(w, r, "route_id must be a uuid")
		return
	}
	if req.DropStopID == "" {
		req.DropStopID = req.PickupStopID
	}

	/* NULLABLE, because a fare is.

	   route_stops.fare_paise is nullable and a school that has not priced its
	   stops yet is the ordinary case in a first term. This scanned into an
	   int64 and every allocation against an unpriced stop failed with
	   "cannot scan NULL into *int64" behind a 400 -- so no child could be put
	   on a bus at all until somebody had typed a fare, and nothing said so. */
	var fare *int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// A stop that belongs to a different route is the mistake this catches:
		// the two dropdowns are filled in separately and nothing else notices.
		var ok bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM route_stops
			                WHERE id = $1::uuid AND route_id = $2)`,
			req.PickupStopID, route).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return errStopNotOnRoute
		}
		// Ending the old allocation rather than deleting it: a child who moved
		// stop in October was on the old one until then, and the fee already
		// raised against it has to stay explicable.
		if _, err := tx.Exec(r.Context(), `
			UPDATE transport_allocations
			   SET valid_to = current_date - 1
			 WHERE student_id = $1 AND (valid_to IS NULL OR valid_to >= current_date)`,
			student); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO transport_allocations
			    (institution_id, student_id, academic_year_id, route_id,
			     pickup_stop_id, drop_stop_id, valid_from)
			VALUES ($1,$2,(SELECT id FROM academic_years WHERE is_current LIMIT 1),
			        $3,$4::uuid,$5::uuid,current_date)
			RETURNING (SELECT fare_paise FROM route_stops WHERE id = $4::uuid)`,
			id.InstitutionID, student, route, req.PickupStopID, req.DropStopID).Scan(&fare)
	})
	if err == errStopNotOnRoute {
		httpx.BadRequest(w, r, "that stop is not on that route")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	// Null rather than zero: "no fare set on this stop" and "this stop is free"
	// are different facts, and a receipt built from the wrong one is a refund.
	httpx.JSON(w, http.StatusCreated, map[string]any{"fare_paise": fare})
}

// --- route attendance -----------------------------------------------------

type busAttendanceRow struct {
	StudentID   string  `json:"student_id"`
	Name        string  `json:"full_name"`
	AdmissionNo string  `json:"admission_no"`
	Stop        *string `json:"stop,omitempty"`
	Status      string  `json:"status"`
	BoardedAt   *string `json:"boarded_at,omitempty"`
	AlightedAt  *string `json:"alighted_at,omitempty"`
	Source      string  `json:"source"`
	// Still on the bus: boarded and never seen to get off. The single most
	// urgent row on this screen.
	StillAboard bool `json:"still_aboard"`
}

/*
listBusAttendance is a route's register for one leg of one day.

	Built from the allocation rather than from the attendance table, so a child
	who was never scanned appears as not_scanned rather than not appearing at
	all. A register that silently omits the missing child is the failure mode
	worth designing against.
*/
func (s *Server) listBusAttendance(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	leg := q.Get("leg")
	if leg == "" {
		leg = "morning"
	}
	items, err := collect(s, r, `
		SELECT st.id::text, concat_ws(' ', st.first_name, st.last_name),
		       st.admission_no, ps.name,
		       COALESCE(att.status, 'not_scanned'),
		       to_char(att.boarded_at,'HH24:MI'),
		       to_char(att.alighted_at,'HH24:MI'),
		       COALESCE(att.source, 'manual'),
		       att.boarded_at IS NOT NULL AND att.alighted_at IS NULL
		         AND att.status = 'boarded'
		  FROM transport_allocations ta
		  JOIN students st ON st.id = ta.student_id
		  LEFT JOIN route_stops ps ON ps.id = ta.pickup_stop_id
		  LEFT JOIN transport_attendance att
		         ON att.student_id = st.id
		        AND att.on_date = COALESCE(NULLIF($2,'')::date, current_date)
		        AND att.leg = $3
		 WHERE (ta.valid_to IS NULL OR ta.valid_to >= current_date)
		   AND ($1::uuid IS NULL OR ta.route_id = $1::uuid)
		 ORDER BY ps.sequence, st.first_name
		 LIMIT 400`,
		[]any{nullString(q.Get("route_id")), q.Get("on_date"), leg},
		func(rows pgx.Rows) (busAttendanceRow, error) {
			var v busAttendanceRow
			return v, rows.Scan(&v.StudentID, &v.Name, &v.AdmissionNo, &v.Stop,
				&v.Status, &v.BoardedAt, &v.AlightedAt, &v.Source, &v.StillAboard)
		})
	respond(w, r, items, err)
}

type busMarkRequest struct {
	StudentID string `json:"student_id"`
	RouteID   string `json:"route_id,omitempty"`
	Leg       string `json:"leg"`
	OnDate    string `json:"on_date,omitempty"`
	// boarded | alighted | absent
	Status string `json:"status"`
	Source string `json:"source,omitempty"`
}

func (s *Server) markBusAttendance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req busMarkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.Leg == "" {
		req.Leg = "morning"
	}
	if !oneOfStr(req.Status, "boarded", "alighted", "absent") {
		httpx.BadRequest(w, r, "status must be boarded, alighted or absent")
		return
	}
	if req.Source == "" {
		req.Source = "manual"
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO transport_attendance
			    (institution_id, student_id, route_id, stop_id, on_date, leg,
			     status, source, marked_by,
			     boarded_at, alighted_at)
			SELECT $1, $2,
			       COALESCE(NULLIF($3,'')::uuid, ta.route_id), ta.pickup_stop_id,
			       COALESCE(NULLIF($4,'')::date, current_date), $5, $6, $7, $8,
			       CASE WHEN $6 = 'boarded' THEN now() END,
			       CASE WHEN $6 = 'alighted' THEN now() END
			  FROM transport_allocations ta
			 WHERE ta.student_id = $2
			   AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)
			 LIMIT 1
			ON CONFLICT (student_id, on_date, leg)
			DO UPDATE SET status = EXCLUDED.status,
			              source = EXCLUDED.source,
			              marked_by = EXCLUDED.marked_by,
			              -- Keep the earlier timestamp: alighting must not
			              -- erase the record of having boarded.
			              boarded_at = COALESCE(transport_attendance.boarded_at,
			                                    EXCLUDED.boarded_at),
			              alighted_at = COALESCE(EXCLUDED.alighted_at,
			                                     transport_attendance.alighted_at)`,
			id.InstitutionID, student, req.RouteID, req.OnDate, req.Leg,
			req.Status, req.Source, id.UserID)
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"marked": req.Status})
}

// --- fuel, servicing and repairs ------------------------------------------

type vehicleLogRow struct {
	ID          string   `json:"id"`
	Vehicle     string   `json:"vehicle"`
	VehicleID   string   `json:"vehicle_id"`
	Kind        string   `json:"kind"`
	OnDate      string   `json:"on_date"`
	OdometerKm  *int     `json:"odometer_km,omitempty"`
	Litres      *float64 `json:"litres,omitempty"`
	AmountPaise int64    `json:"amount_paise"`
	Vendor      *string  `json:"vendor,omitempty"`
	NextDueOn   *string  `json:"next_due_on,omitempty"`
	Notes       *string  `json:"notes,omitempty"`
	// Kilometres per litre since the previous fuel entry for this vehicle.
	// Computed from the odometer rather than trusted from a form, and null
	// until there are two readings to work from.
	KmPerLitre *float64 `json:"km_per_litre,omitempty"`
}

func (s *Server) listVehicleLogs(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := collect(s, r, `
		WITH fuel AS (
		    SELECT vl.id,
		           vl.odometer_km - lag(vl.odometer_km) OVER (
		               PARTITION BY vl.vehicle_id ORDER BY vl.on_date, vl.id) AS run_km
		      FROM vehicle_logs vl
		     WHERE vl.kind = 'fuel' AND vl.odometer_km IS NOT NULL
		)
		SELECT vl.id::text, v.registration_no, v.id::text, vl.kind,
		       to_char(vl.on_date,'YYYY-MM-DD'), vl.odometer_km, vl.litres,
		       vl.amount_paise, vl.vendor, to_char(vl.next_due_on,'YYYY-MM-DD'),
		       vl.notes,
		       CASE WHEN f.run_km > 0 AND vl.litres > 0
		            THEN round(f.run_km / vl.litres, 2) END
		  FROM vehicle_logs vl
		  JOIN vehicles v ON v.id = vl.vehicle_id
		  LEFT JOIN fuel f ON f.id = vl.id
		 WHERE vl.on_date BETWEEN $1::date AND $2::date
		   AND ($3::uuid IS NULL OR vl.vehicle_id = $3::uuid)
		 ORDER BY vl.on_date DESC, v.registration_no
		 LIMIT 300`,
		[]any{rng.From, rng.To, nullString(r.URL.Query().Get("vehicle_id"))},
		func(rows pgx.Rows) (vehicleLogRow, error) {
			var v vehicleLogRow
			return v, rows.Scan(&v.ID, &v.Vehicle, &v.VehicleID, &v.Kind, &v.OnDate,
				&v.OdometerKm, &v.Litres, &v.AmountPaise, &v.Vendor,
				&v.NextDueOn, &v.Notes, &v.KmPerLitre)
		})
	respond(w, r, items, err)
}

type vehicleLogRequest struct {
	VehicleID   string   `json:"vehicle_id"`
	Kind        string   `json:"kind"`
	OnDate      string   `json:"on_date,omitempty"`
	OdometerKm  *int     `json:"odometer_km,omitempty"`
	Litres      *float64 `json:"litres,omitempty"`
	AmountPaise int64    `json:"amount_paise"`
	Vendor      string   `json:"vendor,omitempty"`
	InvoiceNo   string   `json:"invoice_no,omitempty"`
	NextDueOn   string   `json:"next_due_on,omitempty"`
	Notes       string   `json:"notes,omitempty"`
}

func (s *Server) recordVehicleLog(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req vehicleLogRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	vehicle, err := uuid.Parse(req.VehicleID)
	if err != nil {
		httpx.BadRequest(w, r, "vehicle_id must be a uuid")
		return
	}
	if !oneOfStr(req.Kind, "fuel", "service", "repair", "tyre", "insurance", "other") {
		httpx.BadRequest(w, r, "unknown kind "+req.Kind)
		return
	}
	if req.Kind == "fuel" && (req.Litres == nil || *req.Litres <= 0) {
		httpx.BadRequest(w, r, "a fuel entry needs the litres, or mileage can never be worked out")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// An odometer that goes backwards is a typo, and catching it here is
		// the difference between one wrong row and a mileage figure that is
		// quietly wrong for the rest of the year.
		if req.OdometerKm != nil {
			var last *int
			if err := tx.QueryRow(r.Context(), `
				SELECT max(odometer_km) FROM vehicle_logs
				 WHERE vehicle_id = $1 AND on_date <= COALESCE(NULLIF($2,'')::date, current_date)`,
				vehicle, req.OnDate).Scan(&last); err != nil {
				return err
			}
			if last != nil && *req.OdometerKm < *last {
				return errOdometerBack
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO vehicle_logs
			    (institution_id, vehicle_id, kind, on_date, odometer_km, litres,
			     amount_paise, vendor, invoice_no, next_due_on, notes, recorded_by)
			VALUES ($1,$2,$3,COALESCE(NULLIF($4,'')::date, current_date),$5,$6,$7,
			        NULLIF($8,''),NULLIF($9,''),NULLIF($10,'')::date,NULLIF($11,''),$12)
			RETURNING id::text`,
			id.InstitutionID, vehicle, req.Kind, req.OnDate, req.OdometerKm,
			req.Litres, req.AmountPaise, req.Vendor, req.InvoiceNo,
			req.NextDueOn, req.Notes, id.UserID).Scan(&newID)
	})
	if err == errOdometerBack {
		httpx.BadRequest(w, r,
			"that odometer reading is lower than an earlier one for this vehicle")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- the pre-trip check ---------------------------------------------------

type tripCheckRow struct {
	ID        string   `json:"id"`
	Vehicle   string   `json:"vehicle"`
	Route     *string  `json:"route,omitempty"`
	OnDate    string   `json:"on_date"`
	Leg       string   `json:"leg"`
	Driver    *string  `json:"driver,omitempty"`
	Cleared   bool     `json:"cleared"`
	Breath    *float64 `json:"breathalyser,omitempty"`
	Failed    []string `json:"failed_items"`
	Remarks   *string  `json:"remarks,omitempty"`
	CheckedBy *string  `json:"checked_by,omitempty"`
}

func (s *Server) listTripChecks(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT tc.id::text, v.registration_no, rt.name,
		       to_char(tc.on_date,'YYYY-MM-DD'), tc.leg,
		       concat_ws(' ', e.first_name, e.last_name),
		       tc.cleared, tc.breathalyser,
		       -- The failures, named. "Not cleared" without saying what failed
		       -- sends someone to look at the whole bus.
		       array_remove(ARRAY[
		           CASE WHEN NOT tc.brakes_ok THEN 'brakes' END,
		           CASE WHEN NOT tc.tyres_ok THEN 'tyres' END,
		           CASE WHEN NOT tc.lights_ok THEN 'lights' END,
		           CASE WHEN NOT tc.first_aid_ok THEN 'first aid' END,
		           CASE WHEN NOT tc.extinguisher_ok THEN 'extinguisher' END,
		           CASE WHEN NOT tc.doors_ok THEN 'doors' END,
		           CASE WHEN COALESCE(tc.breathalyser,0) > 0 THEN 'breathalyser' END
		       ], NULL),
		       tc.remarks, u.full_name
		  FROM trip_checks tc
		  JOIN vehicles v ON v.id = tc.vehicle_id
		  LEFT JOIN routes rt ON rt.id = tc.route_id
		  LEFT JOIN employees e ON e.id = tc.driver_employee_id
		  LEFT JOIN users u ON u.id = tc.checked_by
		 WHERE tc.on_date >= current_date - 14
		 ORDER BY tc.on_date DESC, tc.leg, v.registration_no
		 LIMIT 200`, nil,
		func(rows pgx.Rows) (tripCheckRow, error) {
			var v tripCheckRow
			err := rows.Scan(&v.ID, &v.Vehicle, &v.Route, &v.OnDate, &v.Leg,
				&v.Driver, &v.Cleared, &v.Breath, &v.Failed, &v.Remarks, &v.CheckedBy)
			if v.Failed == nil {
				v.Failed = []string{}
			}
			return v, err
		})
	respond(w, r, items, err)
}

type tripCheckRequest struct {
	VehicleID  string   `json:"vehicle_id"`
	RouteID    string   `json:"route_id,omitempty"`
	Leg        string   `json:"leg"`
	OnDate     string   `json:"on_date,omitempty"`
	DriverID   string   `json:"driver_employee_id,omitempty"`
	Brakes     bool     `json:"brakes_ok"`
	Tyres      bool     `json:"tyres_ok"`
	Lights     bool     `json:"lights_ok"`
	FirstAid   bool     `json:"first_aid_ok"`
	Extinguish bool     `json:"extinguisher_ok"`
	Doors      bool     `json:"doors_ok"`
	Breath     *float64 `json:"breathalyser,omitempty"`
	Remarks    string   `json:"remarks,omitempty"`
}

/*
recordTripCheck signs off a bus before it moves.

	cleared is derived here rather than accepted from the form. A screen that
	lets someone tick "cleared" over a failed brake check is not a safety
	record, and this is the one row in the product a court would read.
*/
func (s *Server) recordTripCheck(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req tripCheckRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	vehicle, err := uuid.Parse(req.VehicleID)
	if err != nil {
		httpx.BadRequest(w, r, "vehicle_id must be a uuid")
		return
	}
	if req.Leg == "" {
		req.Leg = "morning"
	}
	cleared := req.Brakes && req.Tyres && req.Lights && req.FirstAid &&
		req.Extinguish && req.Doors && (req.Breath == nil || *req.Breath == 0)

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO trip_checks
			    (institution_id, vehicle_id, route_id, on_date, leg,
			     driver_employee_id, brakes_ok, tyres_ok, lights_ok,
			     first_aid_ok, extinguisher_ok, doors_ok, breathalyser,
			     cleared, remarks, checked_by)
			VALUES ($1,$2,NULLIF($3,'')::uuid,COALESCE(NULLIF($4,'')::date,current_date),
			        $5,NULLIF($6,'')::uuid,$7,$8,$9,$10,$11,$12,$13,$14,NULLIF($15,''),$16)
			ON CONFLICT (vehicle_id, on_date, leg)
			DO UPDATE SET brakes_ok = EXCLUDED.brakes_ok,
			              tyres_ok = EXCLUDED.tyres_ok,
			              lights_ok = EXCLUDED.lights_ok,
			              first_aid_ok = EXCLUDED.first_aid_ok,
			              extinguisher_ok = EXCLUDED.extinguisher_ok,
			              doors_ok = EXCLUDED.doors_ok,
			              breathalyser = EXCLUDED.breathalyser,
			              cleared = EXCLUDED.cleared,
			              remarks = EXCLUDED.remarks,
			              checked_by = EXCLUDED.checked_by,
			              checked_at = now()
			RETURNING id::text`,
			id.InstitutionID, vehicle, req.RouteID, req.OnDate, req.Leg,
			req.DriverID, req.Brakes, req.Tyres, req.Lights, req.FirstAid,
			req.Extinguish, req.Doors, req.Breath, cleared, req.Remarks,
			id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID, "cleared": cleared})
}

// --- delays, breakdowns and the children still aboard ---------------------

type incidentRow struct {
	ID          string  `json:"id"`
	Vehicle     *string `json:"vehicle,omitempty"`
	Route       *string `json:"route,omitempty"`
	OnDate      string  `json:"on_date"`
	Leg         *string `json:"leg,omitempty"`
	Kind        string  `json:"kind"`
	ReportedAt  string  `json:"reported_at"`
	Delay       *int    `json:"delay_minutes,omitempty"`
	Description string  `json:"description"`
	Replacement *string `json:"replacement_vehicle,omitempty"`
	Informed    bool    `json:"parents_informed"`
	ResolvedAt  *string `json:"resolved_at,omitempty"`
	Resolution  *string `json:"resolution,omitempty"`
	// How many children were allocated to the affected route, so the office
	// knows the size of the phone call they are about to make.
	ChildrenAffected int `json:"children_affected"`
}

func (s *Server) listTransportIncidents(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := collect(s, r, `
		SELECT i.id::text, v.registration_no, rt.name,
		       to_char(i.on_date,'YYYY-MM-DD'), i.leg, i.kind,
		       to_char(i.reported_at,'YYYY-MM-DD"T"HH24:MI'), i.delay_minutes,
		       i.description, rv.registration_no, i.parents_informed,
		       to_char(i.resolved_at,'YYYY-MM-DD"T"HH24:MI'), i.resolution,
		       COALESCE((SELECT count(*)::int FROM transport_allocations ta
		                  WHERE ta.route_id = i.route_id
		                    AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)), 0)
		  FROM transport_incidents i
		  LEFT JOIN vehicles v ON v.id = i.vehicle_id
		  LEFT JOIN vehicles rv ON rv.id = i.replacement_vehicle_id
		  LEFT JOIN routes rt ON rt.id = i.route_id
		 WHERE i.on_date BETWEEN $1::date AND $2::date
		 ORDER BY (i.resolved_at IS NULL) DESC, i.reported_at DESC
		 LIMIT 200`, []any{rng.From, rng.To},
		func(rows pgx.Rows) (incidentRow, error) {
			var v incidentRow
			return v, rows.Scan(&v.ID, &v.Vehicle, &v.Route, &v.OnDate, &v.Leg,
				&v.Kind, &v.ReportedAt, &v.Delay, &v.Description, &v.Replacement,
				&v.Informed, &v.ResolvedAt, &v.Resolution, &v.ChildrenAffected)
		})
	respond(w, r, items, err)
}

type incidentRequest struct {
	ID          string `json:"id,omitempty"`
	VehicleID   string `json:"vehicle_id,omitempty"`
	RouteID     string `json:"route_id,omitempty"`
	Leg         string `json:"leg,omitempty"`
	Kind        string `json:"kind"`
	Delay       *int   `json:"delay_minutes,omitempty"`
	Description string `json:"description,omitempty"`
	Replacement string `json:"replacement_vehicle_id,omitempty"`
	Informed    bool   `json:"parents_informed,omitempty"`
	Resolution  string `json:"resolution,omitempty"`
}

func (s *Server) saveTransportIncident(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req incidentRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	// Closing one out.
	if req.ID != "" {
		if strings.TrimSpace(req.Resolution) == "" {
			httpx.BadRequest(w, r, "say how it ended. A breakdown closed with no note cannot be reviewed")
			return
		}
		incID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE transport_incidents
				   SET resolved_at = now(), resolution = $2,
				       parents_informed = parents_informed OR $3,
				       replacement_vehicle_id =
				           COALESCE(NULLIF($4,'')::uuid, replacement_vehicle_id)
				 WHERE id = $1`, incID, req.Resolution, req.Informed, req.Replacement)
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"resolved": true})
		return
	}

	if strings.TrimSpace(req.Description) == "" {
		httpx.BadRequest(w, r, "say what happened")
		return
	}
	if !oneOfStr(req.Kind, "breakdown", "delay", "diversion", "accident", "other") {
		httpx.BadRequest(w, r, "unknown kind "+req.Kind)
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO transport_incidents
			    (institution_id, vehicle_id, route_id, leg, kind, delay_minutes,
			     description, replacement_vehicle_id, parents_informed, reported_by)
			VALUES ($1,NULLIF($2,'')::uuid,NULLIF($3,'')::uuid,NULLIF($4,''),$5,$6,$7,
			        NULLIF($8,'')::uuid,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, req.VehicleID, req.RouteID, req.Leg, req.Kind,
			req.Delay, req.Description, req.Replacement, req.Informed,
			id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// oneOfStr is the small membership test the enum-ish handlers all want.
func oneOfStr(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}
