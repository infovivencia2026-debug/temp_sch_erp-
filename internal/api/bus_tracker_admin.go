package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The transport office's half of the tracker.

   bus_tracker.go is the wire, bus_tracking_views.go is the map. This file is
   the desk: which phones are paired, which buses are not, what the school has
   decided about geofences and speed, and what the geofences actually recorded.

   The organising fact is that the office's question is never "list the
   trackers". It is "which of my buses is not on the map tomorrow morning", and
   a list of trackers cannot answer it — the vehicles with no tracker are
   exactly the rows a trackers table does not contain. So the list below is
   driven from vehicles and the tracker is the optional half, the same shape
   the live map already uses for the same reason.
*/

type trackerAdminRow struct {
	VehicleID    string `json:"vehicle_id"`
	Registration string `json:"registration_no"`
	VehicleModel string `json:"vehicle_model,omitempty"`
	Status       string `json:"vehicle_status"`
	Route        string `json:"route,omitempty"`
	Driver       string `json:"driver,omitempty"`

	// Absent for a bus that has never been paired. The screen's whole point is
	// that these rows exist.
	TrackerID   *string `json:"tracker_id,omitempty"`
	TrackerName *string `json:"tracker,omitempty"`
	DeviceModel *string `json:"device_model,omitempty"`
	AppVersion  *string `json:"app_version,omitempty"`

	LastSeenAt *string `json:"last_seen_at,omitempty"`
	// Seconds since the handset last said anything at all — heartbeat or push.
	// Null when it never has, which is a phone paired and never started.
	QuietSeconds *int  `json:"quiet_seconds,omitempty"`
	BatteryPct   *int  `json:"battery_pct,omitempty"`
	Charging     *bool `json:"charging,omitempty"`
	// False is the failure worth a row of its own: online, charged, reporting,
	// and the OS is not giving it a fix, so everything looks healthy and the
	// bus is not on the map.
	LocationOK *bool `json:"location_ok,omitempty"`

	PingSeconds *int    `json:"ping_seconds,omitempty"`
	Paused      *bool   `json:"paused,omitempty"`
	RevokedAt   *string `json:"revoked_at,omitempty"`
	RevokedWhy  *string `json:"revoked_reason,omitempty"`

	// Paired means "has a live tracker". A vehicle whose only tracker was
	// revoked reports paired:false and still carries the revoked row, because
	// "this bus was unpaired last Tuesday, by whom, and why" is the question
	// that follows.
	Paired bool `json:"paired"`
}

/*
listTrackers answers "which buses are not paired" as well as "which phones are".

	The LATERAL takes one tracker per vehicle, preferring the live one and
	falling back to the most recently revoked. Without the fallback a bus whose
	driver left in July shows as a bare unpaired row and the office re-pairs a
	handset that is sitting in a drawer.
*/
func (s *Server) listTrackers(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT v.id::text, v.registration_no, COALESCE(v.model,''), v.status,
		       COALESCE(rt.name,''),
		       COALESCE(concat_ws(' ', e.first_name, e.last_name),''),
		       tr.id::text, tr.name, tr.device_model, tr.app_version,
		       to_char(tr.last_seen_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI'),
		       EXTRACT(epoch FROM now() - tr.last_seen_at)::int,
		       tr.battery_pct, tr.charging, tr.location_ok,
		       tr.ping_seconds, tr.paused,
		       to_char(tr.revoked_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI'),
		       tr.revoked_reason,
		       tr.id IS NOT NULL AND tr.revoked_at IS NULL
		  FROM vehicles v
		  LEFT JOIN LATERAL (
		       SELECT t.* FROM vehicle_trackers t
		        WHERE t.vehicle_id = v.id
		        ORDER BY t.revoked_at IS NULL DESC, t.paired_at DESC
		        LIMIT 1) tr ON TRUE
		  LEFT JOIN vehicle_trips vt ON vt.vehicle_id = v.id AND vt.ended_at IS NULL
		  LEFT JOIN routes rt ON rt.id = vt.route_id
		  LEFT JOIN employees e ON e.id = v.driver_employee_id
		 WHERE v.status <> 'retired'
		 ORDER BY tr.id IS NOT NULL AND tr.revoked_at IS NULL,
		          v.registration_no`, nil,
		func(rows pgx.Rows) (trackerAdminRow, error) {
			var v trackerAdminRow
			return v, rows.Scan(&v.VehicleID, &v.Registration, &v.VehicleModel,
				&v.Status, &v.Route, &v.Driver,
				&v.TrackerID, &v.TrackerName, &v.DeviceModel, &v.AppVersion,
				&v.LastSeenAt, &v.QuietSeconds, &v.BatteryPct, &v.Charging,
				&v.LocationOK, &v.PingSeconds, &v.Paused,
				&v.RevokedAt, &v.RevokedWhy, &v.Paired)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	unpaired := 0
	for _, it := range items {
		if !it.Paired {
			unpaired++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items,
		// Counted here rather than in the browser so the delays report, the
		// map and this screen cannot disagree about how many buses are dark.
		"unpaired": unpaired,
	})
}

type trackerUpdateRequest struct {
	// All optional: the screen edits one field at a time, and a PUT that
	// silently reset ping_seconds to the zero value because the form did not
	// send it would flatten a fleet of handsets.
	Name        *string `json:"name,omitempty"`
	PingSeconds *int    `json:"ping_seconds,omitempty"`
	Paused      *bool   `json:"paused,omitempty"`
}

/*
updateTracker renames a handset, retunes it, or parks it.

	Pausing is not revoking, and the office needs both. A phone in for repair,
	or a bus off the road for a week, should stop reporting without losing the
	pairing — revoking means the driver has to be handed a new code and read it
	out, which is the friction that gets a tracker left running instead.
*/
func (s *Server) updateTracker(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	trackerID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req trackerUpdateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		httpx.BadRequest(w, r, "give the handset a name somebody will recognise "+
			"when this bus stops reporting — \"Ravi's phone\", not a blank")
		return
	}
	if req.PingSeconds != nil && (*req.PingSeconds < 5 || *req.PingSeconds > 300) {
		httpx.BadRequest(w, r, "the phone can report every 5 to 300 seconds. "+
			"Below 5 it flattens the battery before lunch; above 300 the map is "+
			"five minutes behind the bus")
		return
	}
	if req.Name == nil && req.PingSeconds == nil && req.Paused == nil {
		httpx.BadRequest(w, r, "nothing to change: send a name, ping_seconds or paused")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var name *string
		if req.Name != nil {
			trimmed := strings.TrimSpace(*req.Name)
			name = &trimmed
		}
		// COALESCE per column so an absent field keeps what is there. Revoked
		// trackers are excluded: retuning a phone that has been unpaired tells
		// nobody anything, because it will never ask for the setting.
		tag, err := tx.Exec(r.Context(), `
			UPDATE vehicle_trackers
			   SET name = COALESCE($2, name),
			       ping_seconds = COALESCE($3, ping_seconds),
			       paused = COALESCE($4, paused),
			       updated_at = now()
			 WHERE id = $1 AND revoked_at IS NULL`,
			trackerID, name, req.PingSeconds, req.Paused)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "no_such_tracker",
			"that tracker is either missing or has already been revoked")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	// The handset learns of this on its next push; it is not told out of band.
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

/*
revokeTracker retires a pairing without erasing where the bus went.

	Revocation is a column rather than a DELETE because the position history is
	the school's record of its own vehicle, and an enquiry three weeks later
	asks about a trip driven by a phone that has since been handed back.

	The reason is required, and the schema enforces it too. "Revoked" on its own
	is the state that gets re-paired by the next person on the desk; "driver
	left, handset returned" does not.
*/
func (s *Server) revokeTracker(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	trackerID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		httpx.BadRequest(w, r, "say why this phone is being unpaired — the next "+
			"person on this desk has to decide whether to re-pair it")
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE vehicle_trackers
			   SET revoked_at = now(), revoked_reason = $2, paused = true,
			       updated_at = now()
			 WHERE id = $1 AND revoked_at IS NULL`, trackerID, reason)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		/* Close whatever run the phone had open. A revoked tracker stops being
		   authenticated on its next request, so the trip would otherwise sit
		   open until the timeout sweep and leave a stale marker telling a
		   parent the bus is still coming. */
		_, err = tx.Exec(r.Context(), `
			UPDATE vehicle_trips
			   SET ended_at = now(), ended_reason = 'admin'
			 WHERE tracker_id = $1 AND ended_at IS NULL`, trackerID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusConflict, "no_such_tracker",
			"that tracker is either missing or already revoked")
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"revoked": true})
}

// --- policy ------------------------------------------------------------------

type trackingPolicyBody struct {
	DefaultGeofenceM int  `json:"default_geofence_m"`
	SpeedLimitKmph   int  `json:"speed_limit_kmph"`
	SpeedingHoldSecs int  `json:"speeding_hold_secs"`
	TripTimeoutMins  int  `json:"trip_timeout_mins"`
	PingSeconds      int  `json:"ping_seconds"`
	ParentsMayWatch  bool `json:"parents_may_watch"`
	WatchWindowMins  int  `json:"watch_window_mins"`
	RetainDays       int  `json:"retain_days"`
}

func policyBodyOf(p *trackingPolicy) trackingPolicyBody {
	return trackingPolicyBody{
		DefaultGeofenceM: p.DefaultGeofenceM,
		SpeedLimitKmph:   p.SpeedLimitKmph,
		SpeedingHoldSecs: p.SpeedingHoldSecs,
		TripTimeoutMins:  p.TripTimeoutMins,
		PingSeconds:      p.PingSeconds,
		ParentsMayWatch:  p.ParentsMayWatch,
		WatchWindowMins:  p.WatchWindowMins,
		RetainDays:       p.RetainDays,
	}
}

/*
What turning parents_may_watch on actually publishes.

	Carried in the API response rather than typed into the screen, so the
	sentence the school is shown when it flips the switch is the same sentence
	this repository can be audited against. It is off by default: a school turns
	it on when it has told its families it will, not because a default did.
*/
const parentsMayWatchNotice = "While a bus is on a run, every guardian on that " +
	"route can see where it is, how fast it is going and how late it is. " +
	"They see nothing outside a run: the tracker is the driver's own phone, " +
	"and it is not visible before the trip starts or after it ends."

// policyLimit is one bound from migration 00122's CHECK constraints, restated
// with the sentence a person can act on. Constraint names are not error
// messages; "transport_tracking_policy_hold" tells a head of transport nothing.
type policyLimit struct {
	value    int
	lo, hi   int
	field    string
	guidance string
}

func validateTrackingPolicy(b trackingPolicyBody) string {
	for _, l := range []policyLimit{
		{b.DefaultGeofenceM, 30, 2000, "default_geofence_m",
			"under 30m a phone's own error puts the bus outside its own stop; " +
				"over 2km the circle covers the next stop as well"},
		{b.SpeedLimitKmph, 10, 120, "speed_limit_kmph",
			"this is the speed above which you want to be told, not the road's limit"},
		{b.SpeedingHoldSecs, 5, 300, "speeding_hold_secs",
			"how long the bus must stay over before it counts — too short and " +
				"every flyover raises an alert nobody reads by the second week"},
		{b.TripTimeoutMins, 5, 240, "trip_timeout_mins",
			"how long a run may go unheard before the server closes it; too long " +
				"and a parent watches a marker that stopped moving an hour ago"},
		{b.PingSeconds, 5, 300, "ping_seconds",
			"below 5 the handset is flat by two o'clock; above 300 the map is " +
				"five minutes behind the bus"},
		{b.WatchWindowMins, 5, 240, "watch_window_mins",
			"how long before the scheduled pickup the map opens to a parent"},
		{b.RetainDays, 7, 3650, "retain_days",
			"how long the breadcrumb trail is kept; an incident enquiry needs weeks"},
	} {
		if l.value < l.lo || l.value > l.hi {
			return fmt.Sprintf("%s must be between %d and %d — %s",
				l.field, l.lo, l.hi, l.guidance)
		}
	}
	return ""
}

// getTrackingPolicy reads the school's settings, creating the schema defaults
// on first read. Reuses trackingPolicyFor so the office screen and the ingest
// path can never be looking at two different readers of one row.
func (s *Server) getTrackingPolicy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var body trackingPolicyBody
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		p, err := trackingPolicyFor(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		body = policyBodyOf(p)
		return nil
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"policy":                   body,
		"parents_may_watch_notice": parentsMayWatchNotice,
	})
}

// saveTrackingPolicy writes it, refusing out-of-range values in a sentence
// rather than letting Postgres answer with a constraint name.
func (s *Server) saveTrackingPolicy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req trackingPolicyBody
	if !httpx.Decode(w, r, &req) {
		return
	}
	if msg := validateTrackingPolicy(req); msg != "" {
		httpx.BadRequest(w, r, msg)
		return
	}

	var saved trackingPolicyBody
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Read first so a school that has never opened this screen has a row to
		// update rather than a silent no-op.
		if _, err := trackingPolicyFor(r.Context(), tx, id.InstitutionID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE transport_tracking_policy
			   SET default_geofence_m = $2, speed_limit_kmph = $3,
			       speeding_hold_secs = $4, trip_timeout_mins = $5,
			       ping_seconds = $6, parents_may_watch = $7,
			       watch_window_mins = $8, retain_days = $9,
			       updated_at = now(), updated_by = $10
			 WHERE institution_id = $1`,
			id.InstitutionID, req.DefaultGeofenceM, req.SpeedLimitKmph,
			req.SpeedingHoldSecs, req.TripTimeoutMins, req.PingSeconds,
			req.ParentsMayWatch, req.WatchWindowMins, req.RetainDays,
			id.UserID); err != nil {
			return err
		}
		p, err := trackingPolicyFor(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		saved = policyBodyOf(p)
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"policy":                   saved,
		"parents_may_watch_notice": parentsMayWatchNotice,
	})
}

// --- stop events -------------------------------------------------------------

type stopEventRow struct {
	ID           string `json:"id"`
	TripID       string `json:"trip_id"`
	Registration string `json:"registration_no"`
	Route        string `json:"route"`
	Direction    string `json:"direction"`
	Stop         string `json:"stop"`
	Sequence     int    `json:"sequence"`
	Kind         string `json:"kind"`
	// Time of day the route says, in India. Null for a stop that has never been
	// given one, which is why deviation is null too rather than zero.
	ScheduledAt *string `json:"scheduled_at,omitempty"`
	OccurredAt  string  `json:"occurred_at"`
	// Negative is early, positive is late. Computed once when the geofence
	// fired, so this report and the parent's screen cannot disagree.
	DeviationMins *int     `json:"deviation_mins,omitempty"`
	Latitude      *float64 `json:"latitude,omitempty"`
	Longitude     *float64 `json:"longitude,omitempty"`
	Driver        string   `json:"driver,omitempty"`
}

/*
listStopEvents is one query serving two screens.

	The geofenced-arrival log and the delays report are the same rows read with
	a different eye, and building them separately is how two numbers for the
	same late bus end up on two screens. Filtered by trip for "what happened on
	this run" and by date for "how did this morning go".

	Departures are included rather than dropped. A bus that arrived on time and
	sat at the stop for nine minutes is late for everybody after it, and the
	arrival row alone does not show that.
*/
func (s *Server) listStopEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var tripFilter any
	if raw := strings.TrimSpace(q.Get("trip_id")); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "trip_id must be a uuid")
			return
		}
		tripFilter = parsed
	}
	var dateFilter any
	if raw := strings.TrimSpace(q.Get("date")); raw != "" {
		if _, err := time.ParseInLocation("2006-01-02", raw, indiaTZ()); err != nil {
			httpx.BadRequest(w, r, "date must be YYYY-MM-DD")
			return
		}
		dateFilter = raw
	}
	// Neither filter given means today, not the whole year: this table grows
	// with every stop of every run, and an unbounded default is the read that
	// looks fine in September and times out in March.
	if tripFilter == nil && dateFilter == nil {
		dateFilter = nowInIndia().Format("2006-01-02")
	}

	items, err := collect(s, r, `
		SELECT se.id::text, se.trip_id::text, v.registration_no, rt.name,
		       t.direction, rs.name, rs.sequence, se.kind,
		       to_char(CASE WHEN t.direction = 'drop' THEN rs.drop_time
		                    ELSE rs.pickup_time END, 'HH24:MI'),
		       to_char(se.occurred_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD"T"HH24:MI'),
		       se.deviation_mins, se.latitude::float8, se.longitude::float8,
		       COALESCE(concat_ws(' ', e.first_name, e.last_name),'')
		  FROM transport_stop_events se
		  JOIN vehicle_trips t ON t.id = se.trip_id
		  JOIN vehicles v ON v.id = t.vehicle_id
		  JOIN routes rt ON rt.id = t.route_id
		  JOIN route_stops rs ON rs.id = se.stop_id
		  LEFT JOIN employees e ON e.id = v.driver_employee_id
		 WHERE ($1::uuid IS NULL OR se.trip_id = $1)
		   AND ($2::date IS NULL
		        OR (se.occurred_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date)
		 ORDER BY se.occurred_at DESC
		 LIMIT 500`,
		[]any{tripFilter, dateFilter},
		func(rows pgx.Rows) (stopEventRow, error) {
			var v stopEventRow
			return v, rows.Scan(&v.ID, &v.TripID, &v.Registration, &v.Route,
				&v.Direction, &v.Stop, &v.Sequence, &v.Kind, &v.ScheduledAt,
				&v.OccurredAt, &v.DeviationMins, &v.Latitude, &v.Longitude,
				&v.Driver)
		})
	respond(w, r, items, err)
}

/*
mountBusTrackerManage registers the transport office's management routes.

	Reads on transport.read, writes on transport.write, decided here rather than
	by the screen hiding a button. The policy write is the one that matters
	most: parents_may_watch publishes a live vehicle position to several hundred
	families, and it must not be reachable by anybody who merely holds the read
	rung on the transport module.
*/
func (s *Server) mountBusTrackerManage(r chi.Router) {
	read := httpx.RequirePermission(rbac.TransportRead)
	write := httpx.RequirePermission(rbac.TransportWrite)

	r.With(read).Get("/transport/trackers", s.listTrackers)
	r.With(write).Put("/transport/trackers/{id}", s.updateTracker)
	r.With(write).Post("/transport/trackers/{id}/revoke", s.revokeTracker)

	r.With(read).Get("/transport/tracking-policy", s.getTrackingPolicy)
	r.With(write).Put("/transport/tracking-policy", s.saveTrackingPolicy)

	r.With(read).Get("/transport/stop-events", s.listStopEvents)
}
