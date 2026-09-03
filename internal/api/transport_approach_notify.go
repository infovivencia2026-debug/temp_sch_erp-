package api

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/*
The distance used for a guardian who has never opened the settings screen.

	The same 800 m getChildBus hands the map, so the number a parent is shown
	before they touch anything is the number that actually decides when they are
	told. Two different defaults for the same setting is how a parent ends up
	sure the alert is broken.
*/
const defaultApproachProximityM = 800

/*
notifyApproaching tells the guardians whose child boards at a stop the bus is
nearly at.

	THE MESSAGE THIS PRODUCT EXISTED TO SEND AND NEVER SENT. Parents could set
	an alert distance and switch the alert on, transport_watch_prefs stored
	both faithfully, and no line of server code ever read notify_approach. The
	alert fired in the browser, on the live map screen, which is the one place
	a parent is not at ten past seven in the morning: they are getting a child
	into a coat. The setting was real, the map was real, and the promise behind
	them was not kept.

	Deliberately once per child per run. The idempotency is the message
	queue's, through OccurrenceKey -- a bus crawling towards a stop in traffic
	crosses the same radius on twenty consecutive fixes, and twenty messages is
	how a school turns this off in week two. The key is the trip and the
	student, so the next run tells them again.

	Only guardians who asked. notify_approach defaults false in the schema:
	this sends to the ones who switched it on, at the distance they chose,
	rather than deciding for a family how near is near enough.

	Failures here are logged and swallowed. A school with no email or SMS
	provider configured must still have its bus tracked -- dropping the whole
	position batch because a notification could not be queued would take the
	bus off the map to complain about the post.
*/
func (s *Server) notifyApproaching(ctx context.Context, tx pgx.Tx, dev *busTracker,
	trip, route uuid.UUID, direction string, points []point) {

	if len(points) == 0 {
		return
	}
	// The last fix only. The earlier ones in a flushed buffer are where the
	// bus was, and telling a parent about a position from twenty minutes ago
	// is worse than telling them nothing.
	p := points[len(points)-1]

	type target struct {
		user     uuid.UUID
		student  uuid.UUID
		name     string
		stop     string
		stopLat  float64
		stopLon  float64
		distance int
	}

	rows, qerr := tx.Query(ctx, `
		SELECT g.user_id, ta.student_id,
		       COALESCE(NULLIF(TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')),''),
		                'Your child'),
		       rs.name, rs.latitude::float8, rs.longitude::float8,
		       COALESCE(wp.proximity_m, wpall.proximity_m, $3)
		  FROM transport_allocations ta
		  JOIN route_stops rs
		    ON rs.id = CASE WHEN $4 = 'drop' THEN ta.drop_stop_id
		                    ELSE ta.pickup_stop_id END
		  JOIN students st ON st.id = ta.student_id
		  JOIN student_guardians sg ON sg.student_id = ta.student_id
		  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
		  LEFT JOIN transport_watch_prefs wp
		         ON wp.user_id = g.user_id AND wp.student_id = ta.student_id
		  LEFT JOIN transport_watch_prefs wpall
		         ON wpall.user_id = g.user_id AND wpall.student_id IS NULL
		 WHERE ta.institution_id = $1
		   AND ta.route_id = $2
		   AND ta.valid_from <= CURRENT_DATE
		   AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE)
		   AND rs.latitude IS NOT NULL AND rs.longitude IS NOT NULL
		   -- The narrower row wins: a preference set for this child overrides
		   -- the family-wide one, which is the same precedence getChildBus
		   -- reads the distance with.
		   AND COALESCE(wp.notify_approach, wpall.notify_approach, false)`,
		dev.Institution, route, defaultApproachProximityM, direction)
	if qerr != nil {
		slog.Error("approach notice: read watchers", "error", qerr, "trip", trip)
		return
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.user, &t.student, &t.name, &t.stop,
			&t.stopLat, &t.stopLon, &t.distance); err != nil {
			rows.Close()
			slog.Error("approach notice: scan watcher", "error", err, "trip", trip)
			return
		}
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("approach notice: read watchers", "error", err, "trip", trip)
		return
	}

	/* IN RANGE, AND NOT ALREADY TOLD.

	   Both filters run before any messaging work, because the expensive part
	   is not the insert -- it is everything QueueMessage does to get there.
	   The occurrence index would suppress the duplicate ROW, but only at the
	   final ON CONFLICT, after the provider set, the address lookup and the
	   template render had all been done again. A bus that reaches the last
	   stop with forty children inside the radius pings every twenty seconds
	   for the rest of the run, and each ping was redoing that work for eighty
	   guardians who had already been told. */
	due := make([]target, 0, len(targets))
	for _, t := range targets {
		if metresBetween(p.Lat, p.Lon, t.stopLat, t.stopLon) <= float64(t.distance) {
			due = append(due, t)
		}
	}
	if len(due) == 0 {
		return
	}

	/* The provider set, read ONCE.

	   QueueMessage re-reads integrations for every recipient; queueWith exists
	   for exactly this fan-out and takes the set already loaded. With eighty
	   targets that is eighty reads of the same three rows, inside the
	   transaction that is holding up the position batch. */
	set, err := s.loadProviders(ctx, tx, dev.Institution)
	if err != nil {
		slog.Warn("approach notice: providers", "error", err, "trip", trip)
		return
	}

	for _, t := range due {
		away := metresBetween(p.Lat, p.Lon, t.stopLat, t.stopLon)
		student := t.student
		user := t.user
		/* Crow-flies, and the message says so by giving the distance rather
		   than a time. The road distance is longer and the honest thing to
		   hand a parent is the number this actually measured, not a minutes
		   figure invented from it. */
		if _, err := s.queueWith(ctx, tx, dev.Institution, set, SendRequest{
			Channel:      "in_app",
			TemplateCode: "transport.bus_approaching",
			ToUserID:     &user,
			StudentID:    &student,
			Vars: map[string]any{
				"student_name": t.name,
				"stop_name":    t.stop,
				"distance_m":   int(away),
			},
			SourceKind: "transport_trip",
			SourceID:   &trip,
			// One per child per run. See the function comment.
			OccurrenceKey: fmt.Sprintf("approach:%s:%s", trip, student),
		}); err != nil {
			// Logged, not returned: see the function comment. A school with no
			// provider set up still gets its bus tracked.
			slog.Warn("approach notice not queued", "error", err,
				"trip", trip, "student", student)
		}
	}
}

/*
notifyTripStarted tells the guardians on a route that the bus has set off.

	The moment the driver starts the run, before the bus has moved. The
	approach notice above answers "it is nearly here"; this answers the
	question a parent asks an hour earlier -- "has it left yet" -- so they can
	get a child to the stop instead of watching a map that has not started
	moving. Sent to every guardian on the route who has an account, not only
	the ones who set an approach distance: leaving is a fact about the run, not
	a proximity a family tuned.

	Once per child per run, keyed on the trip and the student, and in-app only
	like its sibling -- there is no push wired here, and an SMS per child per
	run is a bill a school did not agree to. Failures are logged and swallowed:
	the run is already recorded, and a courtesy notice that could not be queued
	is not a reason to fail the driver's start.
*/
func (s *Server) notifyTripStarted(ctx context.Context, tx pgx.Tx, inst,
	trip, route uuid.UUID, direction string) {

	dirWord := "pickup"
	if direction == "drop" {
		dirWord = "drop-off"
	}

	var schoolName, routeName string
	_ = tx.QueryRow(ctx, `SELECT name FROM institutions WHERE id = $1`, inst).Scan(&schoolName)
	if err := tx.QueryRow(ctx, `SELECT name FROM routes WHERE id = $1`, route).Scan(&routeName); err != nil {
		slog.Warn("trip-start notice: route name", "error", err, "trip", trip)
		return
	}

	type target struct {
		user    uuid.UUID
		student uuid.UUID
		name    string
		stop    string
	}
	rows, qerr := tx.Query(ctx, `
		SELECT g.user_id, ta.student_id,
		       COALESCE(NULLIF(TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')),''),
		                'Your child'),
		       COALESCE(rs.name, 'the stop')
		  FROM transport_allocations ta
		  JOIN students st ON st.id = ta.student_id
		  JOIN student_guardians sg ON sg.student_id = ta.student_id
		  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
		  LEFT JOIN route_stops rs
		         ON rs.id = CASE WHEN $3 = 'drop' THEN ta.drop_stop_id
		                         ELSE ta.pickup_stop_id END
		 WHERE ta.institution_id = $1
		   AND ta.route_id = $2
		   AND ta.valid_from <= CURRENT_DATE
		   AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE)
		   AND st.status = 'active'`,
		inst, route, direction)
	if qerr != nil {
		slog.Error("trip-start notice: read guardians", "error", qerr, "trip", trip)
		return
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.user, &t.student, &t.name, &t.stop); err != nil {
			rows.Close()
			slog.Error("trip-start notice: scan guardian", "error", err, "trip", trip)
			return
		}
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("trip-start notice: read guardians", "error", err, "trip", trip)
		return
	}
	if len(targets) == 0 {
		return
	}

	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		slog.Warn("trip-start notice: providers", "error", err, "trip", trip)
		return
	}

	for _, t := range targets {
		student := t.student
		user := t.user
		if _, err := s.queueWith(ctx, tx, inst, set, SendRequest{
			Channel:      "in_app",
			TemplateCode: "transport.trip_started",
			ToUserID:     &user,
			StudentID:    &student,
			Vars: map[string]any{
				"student_name": t.name,
				"route_name":   routeName,
				"direction":    dirWord,
				"stop_name":    t.stop,
				"school_name":  schoolName,
			},
			SourceKind: "transport_trip",
			SourceID:   &trip,
			// One per child per run; the next run tells them again.
			OccurrenceKey: fmt.Sprintf("started:%s:%s", trip, student),
		}); err != nil {
			slog.Warn("trip-start notice not queued", "error", err,
				"trip", trip, "student", student)
		}
	}
}
