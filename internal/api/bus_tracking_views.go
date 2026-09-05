package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* What the office and the family are shown.

   Two audiences over one position, and they are not the same read. The
   transport office is looking at a fleet and is entitled to it: every bus,
   moving or parked, with the trackers that have gone quiet listed first
   because a bus missing from the map is the thing worth knowing. A parent is
   looking for one bus, the one their child is on, and only while it is
   actually running.

   The difference is enforced in SQL rather than by the screens asking
   politely. Every parent read below joins through transport_allocations to a
   student the caller is a guardian of and through an open trip, so a family
   cannot see a route they are not on and cannot see any bus outside its run.
   That second clause is the one that matters: the tracker is the driver's own
   phone, and a parent who can watch it at nine in the evening is watching a
   school employee at home.
*/

// staleAfter is how long a position may go unrefreshed before the screens call
// it stale. Three pings plus a margin: one missed push is a tunnel, three is a
// phone that has stopped.
func staleAfter(pingSeconds int) time.Duration {
	return time.Duration(pingSeconds*3+15) * time.Second
}

type liveVehicleRow struct {
	VehicleID    string   `json:"vehicle_id"`
	Registration string   `json:"registration_no"`
	Route        *string  `json:"route,omitempty"`
	RouteID      *string  `json:"route_id,omitempty"`
	Direction    *string  `json:"direction,omitempty"`
	TripID       *string  `json:"trip_id,omitempty"`
	Driver       *string  `json:"driver,omitempty"`
	DriverPhone  *string  `json:"driver_phone,omitempty"`
	Latitude     *float64 `json:"latitude,omitempty"`
	Longitude    *float64 `json:"longitude,omitempty"`
	SpeedKmph    *float64 `json:"speed_kmph,omitempty"`
	HeadingDeg   *int     `json:"heading_deg,omitempty"`
	RecordedAt   *string  `json:"recorded_at,omitempty"`
	AgeSeconds   *int     `json:"age_seconds,omitempty"`

	// The three states a marker can be in, decided here so every screen
	// colours them the same way.
	//   running  an open trip and a fresh fix
	//   stale    an open trip and a fix older than staleAfter
	//   idle     no open trip; the bus is parked and that is not a fault
	State string `json:"state"`

	TrackerName *string `json:"tracker,omitempty"`
	BatteryPct  *int    `json:"battery_pct,omitempty"`
	Charging    *bool   `json:"charging,omitempty"`
	// False means the phone is reporting in but the OS is not giving it
	// location. Everything looks healthy and the bus is not on the map, which
	// is the failure this column exists to surface.
	LocationOK  *bool   `json:"location_ok,omitempty"`
	TrackerSeen *string `json:"tracker_last_seen,omitempty"`
	Paired      bool    `json:"paired"`
}

/*
listLiveVehicles is the office's map: every vehicle, whether or not it is
moving.

	Unpaired and idle buses are returned rather than filtered out, for the
	reason the onboarding list returns employees with no file: a map showing
	only the buses that are reporting answers "where are these four" and hides
	"and the other eleven are not on here at all", which is the question the
	transport office is actually asking at ten past seven.
*/
func (s *Server) listLiveVehicles(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var ping int
	items, err := collect(s, r, `
		SELECT v.id::text, v.registration_no,
		       rt.name, rt.id::text, t.direction, t.id::text,
		       concat_ws(' ', e.first_name, e.last_name), e.phone,
		       lp.latitude::float8, lp.longitude::float8, lp.speed_kmph::float8,
		       lp.heading_deg,
		       to_char(lp.recorded_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI:SS'),
		       EXTRACT(epoch FROM now() - lp.recorded_at)::int,
		       tr.name, tr.battery_pct, tr.charging, tr.location_ok,
		       to_char(tr.last_seen_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI:SS'),
		       tr.id IS NOT NULL
		  FROM vehicles v
		  LEFT JOIN vehicle_trackers tr
		         ON tr.vehicle_id = v.id AND tr.revoked_at IS NULL
		  LEFT JOIN vehicle_trips t
		         ON t.vehicle_id = v.id AND t.ended_at IS NULL
		  LEFT JOIN routes rt ON rt.id = t.route_id
		  LEFT JOIN vehicle_last_position lp
		         ON lp.vehicle_id = v.id AND lp.trip_id = t.id
		  LEFT JOIN employees e ON e.id = v.driver_employee_id
		 WHERE v.status <> 'retired'
		 ORDER BY t.id IS NULL, rt.name NULLS LAST, v.registration_no`, nil,
		func(rows pgx.Rows) (liveVehicleRow, error) {
			var v liveVehicleRow
			return v, rows.Scan(&v.VehicleID, &v.Registration, &v.Route, &v.RouteID,
				&v.Direction, &v.TripID, &v.Driver, &v.DriverPhone,
				&v.Latitude, &v.Longitude, &v.SpeedKmph, &v.HeadingDeg,
				&v.RecordedAt, &v.AgeSeconds, &v.TrackerName, &v.BatteryPct,
				&v.Charging, &v.LocationOK, &v.TrackerSeen, &v.Paired)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		p, err := trackingPolicyFor(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		ping = p.PingSeconds
		return nil
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}

	stale := int(staleAfter(ping).Seconds())
	for i := range items {
		switch {
		case items[i].TripID == nil:
			items[i].State = "idle"
		case items[i].AgeSeconds == nil || *items[i].AgeSeconds > stale:
			items[i].State = "stale"
		default:
			items[i].State = "running"
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "ping_seconds": ping, "stale_after_seconds": stale,
	})
}

type childBusRow struct {
	StudentID    string  `json:"student_id"`
	StudentName  string  `json:"student_name"`
	Route        string  `json:"route"`
	Registration string  `json:"registration_no"`
	Direction    *string `json:"direction,omitempty"`
	Driver       *string `json:"driver,omitempty"`
	// Shown to a parent only while a run is open. A driver's number published
	// all day is a driver's number rung all day.
	DriverPhone *string  `json:"driver_phone,omitempty"`
	StopName    *string  `json:"stop,omitempty"`
	ScheduledAt *string  `json:"scheduled_at,omitempty"`
	ArrivedAt   *string  `json:"arrived_at,omitempty"`
	Latitude    *float64 `json:"latitude,omitempty"`
	Longitude   *float64 `json:"longitude,omitempty"`
	StopLat     *float64 `json:"stop_latitude,omitempty"`
	StopLon     *float64 `json:"stop_longitude,omitempty"`
	/* The whole route, for the map.

	   The parent's map drew their own stop and the bus and nothing else, so
	   a bus two stops away sat in a blank field with no sense of where it was
	   on its way. Every stop on the route with a position, in order, and the
	   id of the child's own so the screen can single it out. */
	RouteID    string         `json:"route_id"`
	StopID     *string        `json:"stop_id,omitempty"`
	Stops      []childBusStop `json:"stops"`
	AgeSeconds *int           `json:"age_seconds,omitempty"`
	MetresAway *int           `json:"metres_away,omitempty"`
	/* Minutes to the stop, and how it was arrived at.

	   A parent watching a dot move asks one question and this product could
	   not answer it: nothing anywhere computed a time. The number is
	   deliberately coarse and the basis says so -- see etaMinutes. */
	EtaMinutes  *int     `json:"eta_minutes,omitempty"`
	SpeedKmph   *float64 `json:"speed_kmph,omitempty"`
	State       string   `json:"state"`
	RefreshSecs int      `json:"refresh_seconds"`
	ProximityM  int      `json:"proximity_m"`
	Watchable   bool     `json:"watchable"`
}

type childBusStop struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Sequence  int     `json:"sequence"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	GeofenceM *int    `json:"geofence_m,omitempty"`
	routeID   string
}

/*
getChildBus is the parent's view: one row per child who is allocated to a bus.

	Returned whether or not a run is open, because "no bus is running" is the
	answer to the question a parent asked, and an empty response is not. What
	changes with the run is what is populated: outside one there is no
	position, no driver number and no distance, and the state says why.

	Three gates, all in SQL. The child must be one the caller is a guardian
	of; the school must have turned parent watching on; and the position must
	belong to a trip that is open. The middle one defaults to off in the
	schema, because publishing a vehicle's live position to several hundred
	families is a thing a school does deliberately after telling them.
*/
func (s *Server) getChildBus(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var policy *trackingPolicy
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		p, err := trackingPolicyFor(r.Context(), tx, id.InstitutionID)
		policy = p
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}

	items, err := collect(s, r, `
		WITH mine AS (
		    SELECT st.id AS student_id,
		           concat_ws(' ', st.first_name, st.last_name) AS student_name
		      FROM students st
		      JOIN student_guardians sg ON sg.student_id = st.id
		      JOIN guardians g ON g.id = sg.guardian_id
		     WHERE g.user_id = $1
		)
		SELECT m.student_id::text, m.student_name, rt.name, COALESCE(v.registration_no, ''),
		       rt.id::text, rs.id::text,
		       t.direction,
		       concat_ws(' ', e.first_name, e.last_name),
		       CASE WHEN t.id IS NOT NULL THEN e.phone END,
		       rs.name,
		       to_char(CASE WHEN t.direction = 'drop' THEN rs.drop_time
		                    ELSE rs.pickup_time END, 'HH24:MI'),
		       to_char(ev.occurred_at AT TIME ZONE 'Asia/Kolkata','HH24:MI'),
		       lp.latitude::float8, lp.longitude::float8, lp.speed_kmph::float8,
		       rs.latitude::float8, rs.longitude::float8,
		       EXTRACT(epoch FROM now() - lp.recorded_at)::int,
		       COALESCE(wp.refresh_seconds, wpall.refresh_seconds, $2),
		       COALESCE(wp.proximity_m, wpall.proximity_m, $3)
		  FROM mine m
		  JOIN transport_allocations ta ON ta.student_id = m.student_id
		       AND ta.valid_from <= CURRENT_DATE
		       AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE)
		  JOIN routes rt ON rt.id = ta.route_id
		  LEFT JOIN vehicle_trips t
		         ON t.route_id = rt.id AND t.ended_at IS NULL
		  /* THE BUS THAT IS RUNNING, NOT THE BUS ON THE ROUTE.

		     The route carries a standing vehicle, and the driver scans
		     whichever bus he is actually on at the start of the run. The
		     position row is keyed by the bus that ran, so joining it through
		     the route's vehicle found nothing whenever the two differed, or
		     the route had none: the run showed as open, the driver's phone
		     was pushing every fifteen seconds and answered 200, and the
		     parent read "has not sent a position yet". The trip's vehicle
		     is the truth while a run is open; the route's is the fallback
		     for the registration and driver name between runs. */
		  LEFT JOIN vehicles v ON v.id = COALESCE(t.vehicle_id, rt.vehicle_id)
		  -- The stop that matters depends on which way the bus is going.
		  LEFT JOIN route_stops rs
		         ON rs.id = CASE WHEN t.direction = 'drop'
		                         THEN ta.drop_stop_id ELSE ta.pickup_stop_id END
		  LEFT JOIN transport_stop_events ev
		         ON ev.trip_id = t.id AND ev.stop_id = rs.id AND ev.kind = 'arrived'
		  LEFT JOIN vehicle_last_position lp
		         ON lp.vehicle_id = v.id AND lp.trip_id = t.id
		  LEFT JOIN employees e ON e.id = v.driver_employee_id
		  LEFT JOIN transport_watch_prefs wp
		         ON wp.user_id = $1 AND wp.student_id = m.student_id
		  LEFT JOIN transport_watch_prefs wpall
		         ON wpall.user_id = $1 AND wpall.student_id IS NULL
		 ORDER BY m.student_name`,
		[]any{id.UserID, 20, 800},
		func(rows pgx.Rows) (childBusRow, error) {
			var v childBusRow
			return v, rows.Scan(&v.StudentID, &v.StudentName, &v.Route, &v.Registration,
				&v.RouteID, &v.StopID,
				&v.Direction, &v.Driver, &v.DriverPhone, &v.StopName, &v.ScheduledAt,
				&v.ArrivedAt, &v.Latitude, &v.Longitude, &v.SpeedKmph, &v.StopLat, &v.StopLon,
				&v.AgeSeconds, &v.RefreshSecs, &v.ProximityM)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Every stop on each child's route, one query for all of them. Stops
	   without a position are left out: the map cannot draw them and the
	   list on the screen is not this feed's job. Empty, not null, so the
	   screen can map over it without a guard. */
	routeIDs := []string{}
	seen := map[string]bool{}
	for i := range items {
		if !seen[items[i].RouteID] {
			seen[items[i].RouteID] = true
			routeIDs = append(routeIDs, items[i].RouteID)
		}
		items[i].Stops = []childBusStop{}
	}
	if len(routeIDs) > 0 {
		stops, err := collect(s, r, `
			SELECT id::text, route_id::text, name, sequence,
			       latitude::float8, longitude::float8, geofence_m
			  FROM route_stops
			 WHERE route_id = ANY($1::uuid[])
			   AND latitude IS NOT NULL AND longitude IS NOT NULL
			 ORDER BY route_id, sequence`,
			[]any{routeIDs},
			func(rows pgx.Rows) (childBusStop, error) {
				var st childBusStop
				return st, rows.Scan(&st.ID, &st.routeID, &st.Name, &st.Sequence,
					&st.Latitude, &st.Longitude, &st.GeofenceM)
			})
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		for i := range items {
			for _, st := range stops {
				if st.routeID == items[i].RouteID {
					items[i].Stops = append(items[i].Stops, st)
				}
			}
		}
	}

	stale := int(staleAfter(policy.PingSeconds).Seconds())
	for i := range items {
		it := &items[i]
		it.Watchable = policy.ParentsMayWatch

		// Distance is computed here rather than in SQL because the haversine
		// belongs in one place, and that place is already the geofence walk.
		if it.Latitude != nil && it.Longitude != nil && it.StopLat != nil && it.StopLon != nil {
			m := int(metresBetween(*it.Latitude, *it.Longitude, *it.StopLat, *it.StopLon))
			it.MetresAway = &m
		}

		/* The time, computed only where it means something.

		   After the state is decided, because a stale fix's distance is a
		   distance the bus left ten minutes ago and a minutes figure built on
		   it is a lie with a decimal point. Set below, once the state is
		   known. */

		switch {
		case !policy.ParentsMayWatch:
			// The school has not switched this on. Said plainly rather than
			// shown as an empty map, which reads as a fault.
			it.State = "not_published"
			it.Latitude, it.Longitude, it.DriverPhone = nil, nil, nil
		case it.ArrivedAt != nil:
			it.State = "arrived"
		case it.Direction == nil:
			it.State = "not_running"
		case it.Latitude == nil || it.AgeSeconds == nil:
			it.State = "no_signal"
		case *it.AgeSeconds > stale:
			it.State = "stale"
		default:
			it.State = "running"
		}

		if it.State == "running" && it.MetresAway != nil {
			it.EtaMinutes = etaMinutes(*it.MetresAway, it.SpeedKmph)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "stale_after_seconds": stale,
		"parents_may_watch": policy.ParentsMayWatch,
	})
}

type watchPrefRequest struct {
	StudentID      string `json:"student_id,omitempty"`
	RefreshSeconds int    `json:"refresh_seconds,omitempty"`
	ProximityM     int    `json:"proximity_m,omitempty"`
	NotifyApproach *bool  `json:"notify_approach,omitempty"`
}

/*
saveWatchPrefs stores what a family chose for themselves.

	Bounded in the schema as well as here: a refresh of one second is the
	parent's battery and the server's load, and neither is theirs alone to
	spend. The bounds are stated in the error rather than silently clamped,
	because a setting that quietly becomes a different setting is the kind of
	thing a person reports as the app being broken.
*/
func (s *Server) saveWatchPrefs(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req watchPrefRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.RefreshSeconds == 0 {
		req.RefreshSeconds = 20
	}
	if req.ProximityM == 0 {
		req.ProximityM = 800
	}
	if req.RefreshSeconds < 10 || req.RefreshSeconds > 300 {
		httpx.BadRequest(w, r, "refresh between 10 and 300 seconds")
		return
	}
	if req.ProximityM < 100 || req.ProximityM > 5000 {
		httpx.BadRequest(w, r, "the alert distance has to be between 100 m and 5 km")
		return
	}
	notify := true
	if req.NotifyApproach != nil {
		notify = *req.NotifyApproach
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* A parent may only set preferences for a child of theirs. Checked
		   here and not assumed from the request: the row is keyed by user and
		   student, so an unchecked student_id would let anybody write a
		   preference row against any child in the school. */
		if req.StudentID != "" {
			var ok bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				    SELECT 1 FROM student_guardians sg
				      JOIN guardians g ON g.id = sg.guardian_id
				     WHERE g.user_id = $1 AND sg.student_id = $2)`,
				id.UserID, req.StudentID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return pgx.ErrNoRows
			}
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO transport_watch_prefs (institution_id, user_id, student_id,
			    refresh_seconds, proximity_m, notify_approach)
			VALUES ($1,$2,$3::uuid,$4,$5,$6)
			ON CONFLICT (user_id,
			    COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET refresh_seconds = EXCLUDED.refresh_seconds,
			              proximity_m = EXCLUDED.proximity_m,
			              notify_approach = EXCLUDED.notify_approach,
			              updated_at = now()`,
			id.InstitutionID, id.UserID, nullID(req.StudentID),
			req.RefreshSeconds, req.ProximityM, notify)
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
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

type safetyEventRow struct {
	ID           string   `json:"id"`
	Registration string   `json:"registration_no"`
	Route        *string  `json:"route,omitempty"`
	Driver       *string  `json:"driver,omitempty"`
	Kind         string   `json:"kind"`
	StartedAt    string   `json:"started_at"`
	Minutes      int      `json:"minutes"`
	PeakKmph     *float64 `json:"peak_kmph,omitempty"`
	LimitKmph    *int     `json:"limit_kmph,omitempty"`
	Latitude     *float64 `json:"latitude,omitempty"`
	Longitude    *float64 `json:"longitude,omitempty"`
	ReviewedAt   *string  `json:"reviewed_at,omitempty"`
	ReviewNote   *string  `json:"review_note,omitempty"`
}

// listSafetyEvents is the transport manager's Friday: what happened, on which
// bus, driven by whom. Open items first because the list exists to be closed.
func (s *Server) listSafetyEvents(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT se.id::text, v.registration_no, rt.name,
		       concat_ws(' ', e.first_name, e.last_name),
		       se.kind,
		       to_char(se.started_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI'),
		       GREATEST(1, (EXTRACT(epoch FROM COALESCE(se.ended_at, now()) - se.started_at) / 60)::int),
		       se.peak_kmph::float8, se.limit_kmph, se.latitude::float8, se.longitude::float8,
		       to_char(se.reviewed_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI'),
		       se.review_note
		  FROM transport_safety_events se
		  JOIN vehicles v ON v.id = se.vehicle_id
		  LEFT JOIN vehicle_trips t ON t.id = se.trip_id
		  LEFT JOIN routes rt ON rt.id = t.route_id
		  LEFT JOIN employees e ON e.id = v.driver_employee_id
		 WHERE ($1::bool IS NOT TRUE OR se.reviewed_at IS NULL)
		 ORDER BY se.reviewed_at IS NOT NULL, se.started_at DESC
		 LIMIT 300`,
		[]any{r.URL.Query().Get("open") == "true"},
		func(rows pgx.Rows) (safetyEventRow, error) {
			var v safetyEventRow
			return v, rows.Scan(&v.ID, &v.Registration, &v.Route, &v.Driver, &v.Kind,
				&v.StartedAt, &v.Minutes, &v.PeakKmph, &v.LimitKmph,
				&v.Latitude, &v.Longitude, &v.ReviewedAt, &v.ReviewNote)
		})
	respond(w, r, items, err)
}

// reviewSafetyEvent closes one off with what was said about it. A note is
// required: an alert list acknowledged with a click is a list nobody learns
// anything from.
func (s *Server) reviewSafetyEvent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eventID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		Note string `json:"review_note"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Note) == 0 {
		httpx.BadRequest(w, r, "say what was done about it before closing it")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE transport_safety_events
			   SET reviewed_at = now(), reviewed_by = $2, review_note = $3
			 WHERE id = $1 AND reviewed_at IS NULL`, eventID, id.UserID, req.Note)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "already_reviewed",
			"that alert is either missing or already closed")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"reviewed": true})
}

// mountBusTracking registers the two audiences' reads.
//
// The parent routes are gated on self.profile.read rather than a transport
// permission, and narrowed to the caller's own children in SQL. A guardian
// holds no transport grant and must not need one to see their child's bus,
// which is the same mistake the leave queue made before it was fixed.
func (s *Server) mountBusTracking(r chi.Router) {
	read := httpx.RequirePermission(rbac.TransportRead)
	write := httpx.RequirePermission(rbac.TransportWrite)
	self := httpx.RequirePermission(rbac.SelfProfileRead)

	r.With(read).Get("/transport/live", s.listLiveVehicles)
	r.With(read).Get("/transport/safety-events", s.listSafetyEvents)
	r.With(write).Post("/transport/safety-events/{id}/review", s.reviewSafetyEvent)

	r.With(self).Get("/me/child-bus", s.getChildBus)
	r.With(self).Post("/me/child-bus/prefs", s.saveWatchPrefs)
}

/*
etaMinutes turns a distance and a speed into the one number a parent actually
wants, and refuses to invent it when it cannot.

	Crow-flies, like the distance it is built from, and rounded up to the
	minute: the road is longer than the straight line, so a figure that errs
	early is the wrong way to err. A parent who comes down two minutes late
	has missed the bus.

	The speed is the last fix's, floored at a walking-pace crawl. Without the
	floor a bus stopped at a signal divides by zero and a parent is told their
	child's bus is four hundred minutes away; with it, a stopped bus reads as a
	slow one, which is what a bus at a signal is. A fix that carried no speed
	at all gets no estimate rather than a made-up one -- the chip is saying it
	does not know, and passing that on is more use than a confident number
	drawn from nothing.
*/
func etaMinutes(metres int, speedKmph *float64) *int {
	if speedKmph == nil || metres < 0 {
		return nil
	}
	// 8 km/h: slower than any bus that is moving, faster than the zero a
	// stationary one reports. See the note above.
	const crawlKmph = 8.0
	speed := *speedKmph
	if speed < crawlKmph {
		speed = crawlKmph
	}
	mins := int(float64(metres)/(speed*1000/60)) + 1
	return &mins
}
