package api

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/*
The school is the last stop of every route, and the product keeps it so.

	The office types a route's stops and most end at the last child's kerb.
	The bus then drives to the school and the run has no end it can name: the
	geofence walk has nothing to arrive at, the driver's list has no last
	line, and the message a parent waits for on a pickup morning -- "the bus
	has reached school" -- has no moment to be sent from.

	So the school is a stop. A real row in route_stops flagged is_school, with
	the position and the gate's radius from the tracking policy, pinned after
	every other stop. Real rather than virtual because everything downstream
	is keyed on a stop row: the stop events, the roster's grouping, the
	parent's map. The afternoon run reads the sequence backwards, so the same
	row is the origin of a drop and nothing has to know the difference.

	Pinned, not asked for: the office sets the school's position once on the
	tracker screen and every route gets its gate; a route saved afterwards
	gets it too. A school that has not set a position gets nothing, and the
	tracker screen says so.
*/
func ensureSchoolStops(ctx context.Context, tx pgx.Tx, inst uuid.UUID, policy *trackingPolicy, route *uuid.UUID) error {
	if policy.SchoolLat == nil || policy.SchoolLon == nil {
		return nil
	}
	rows, err := tx.Query(ctx, `
		SELECT id FROM routes
		 WHERE institution_id = $1 AND ($2::uuid IS NULL OR id = $2)`, inst, route)
	if err != nil {
		return err
	}
	var routes []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		routes = append(routes, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, rid := range routes {
		/* One statement per route. The partial unique index on (route_id)
		   WHERE is_school is what the ON CONFLICT names, so a route with a
		   school stop has it moved to the end and re-positioned, and a route
		   without one gets it. The sequence is one past the highest of the
		   other stops, which is what "last" means after the office's own
		   save has renumbered them 1..n. */
		if _, err := tx.Exec(ctx, `
			INSERT INTO route_stops (institution_id, route_id, name, sequence,
			                         latitude, longitude, geofence_m, is_school)
			SELECT $1, $2, 'School',
			       COALESCE((SELECT MAX(sequence) FROM route_stops WHERE route_id = $2), 0) + 1,
			       $3, $4, $5, true
			ON CONFLICT (route_id) WHERE is_school DO UPDATE
			   SET latitude   = EXCLUDED.latitude,
			       longitude  = EXCLUDED.longitude,
			       geofence_m = EXCLUDED.geofence_m,
			       sequence   = (SELECT COALESCE(MAX(x.sequence), 0) + 1
			                       FROM route_stops x
			                      WHERE x.route_id = route_stops.route_id AND NOT x.is_school)`,
			inst, rid, *policy.SchoolLat, *policy.SchoolLon, policy.SchoolGeofenceM); err != nil {
			return err
		}
	}
	return nil
}

/*
notifyArrived tells a family the bus is where they were waiting for it to be.

	Two moments, one message each, both raised by the geofence walk the
	instant it records the arrival, so the notice and the event cannot
	disagree about when.

	On a pickup run, the school gate: every guardian of a child on the run is
	told the bus has reached school. The children told about are the ones the
	driver marked on; if the driver marked nobody, everyone allocated to the
	route, because an unmarked roster is a driver who did not tap, not a bus
	that carried nobody.

	On a drop run, the child's own stop: the guardians of the children who
	alight there are told the bus is at the stop. That is the moment to be at
	the gate, and it is a different sentence from "nearly there", which the
	approach notice has already sent.

	Once per child per run, keyed on the trip and the student, and in-app
	only, like its siblings. Failures are logged and swallowed: the arrival is
	already recorded, and a notice that could not be queued is not a reason
	to roll back the position batch that carried it.
*/
func (s *Server) notifyArrived(ctx context.Context, tx pgx.Tx, inst, trip, route, stop uuid.UUID,
	direction string, isSchool bool) {

	type target struct {
		user    uuid.UUID
		student uuid.UUID
		name    string
	}
	var (
		rows     pgx.Rows
		err      error
		template string
		key      string
	)
	switch {
	case isSchool && direction != "drop":
		template = "transport.bus_reached_school"
		key = "reached_school"
		rows, err = tx.Query(ctx, `
			WITH on_run AS (
			    SELECT ta.student_id
			      FROM transport_allocations ta
			      LEFT JOIN transport_attendance att
			             ON att.student_id = ta.student_id
			            AND att.on_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
			            AND att.leg = 'morning'
			     WHERE ta.institution_id = $1 AND ta.route_id = $2
			       AND ta.valid_from <= CURRENT_DATE
			       AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE)
			       -- The marked-on children if the driver marked anybody;
			       -- everyone on the route if he did not.
			       AND (att.status = 'boarded'
			            OR NOT EXISTS (SELECT 1 FROM transport_attendance a2
			                             JOIN transport_allocations t2 ON t2.student_id = a2.student_id
			                            WHERE t2.route_id = $2
			                              AND a2.on_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
			                              AND a2.leg = 'morning' AND a2.status = 'boarded'))
			)
			SELECT g.user_id, st.id,
			       COALESCE(NULLIF(TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')),''), 'Your child')
			  FROM on_run
			  JOIN students st ON st.id = on_run.student_id AND st.status = 'active'
			  JOIN student_guardians sg ON sg.student_id = st.id
			  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL`,
			inst, route)
	case !isSchool && direction == "drop":
		template = "transport.bus_at_stop"
		key = "at_stop"
		rows, err = tx.Query(ctx, `
			SELECT g.user_id, st.id,
			       COALESCE(NULLIF(TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')),''), 'Your child')
			  FROM transport_allocations ta
			  JOIN students st ON st.id = ta.student_id AND st.status = 'active'
			  JOIN student_guardians sg ON sg.student_id = st.id
			  JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
			 WHERE ta.institution_id = $1 AND ta.route_id = $2 AND ta.drop_stop_id = $3
			   AND ta.valid_from <= CURRENT_DATE
			   AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE)`,
			inst, route, stop)
	default:
		return
	}
	if err != nil {
		slog.Error("arrival notice: read guardians", "error", err, "trip", trip)
		return
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.user, &t.student, &t.name); err != nil {
			rows.Close()
			slog.Error("arrival notice: scan guardian", "error", err, "trip", trip)
			return
		}
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("arrival notice: read guardians", "error", err, "trip", trip)
		return
	}
	if len(targets) == 0 {
		return
	}

	var stopName, schoolName string
	_ = tx.QueryRow(ctx, `SELECT name FROM route_stops WHERE id = $1`, stop).Scan(&stopName)
	_ = tx.QueryRow(ctx, `SELECT name FROM institutions WHERE id = $1`, inst).Scan(&schoolName)

	set, err := s.loadProviders(ctx, tx, inst)
	if err != nil {
		slog.Warn("arrival notice: providers", "error", err, "trip", trip)
		return
	}
	for _, t := range targets {
		student, user := t.student, t.user
		if _, err := s.queueWith(ctx, tx, inst, set, SendRequest{
			Channel:      "in_app",
			TemplateCode: template,
			ToUserID:     &user,
			StudentID:    &student,
			Vars: map[string]any{
				"student_name": t.name,
				"stop_name":    stopName,
				"school_name":  schoolName,
			},
			SourceKind:    "transport_trip",
			SourceID:      &trip,
			OccurrenceKey: fmt.Sprintf("%s:%s:%s", key, trip, student),
		}); err != nil {
			slog.Warn("arrival notice not queued", "error", err, "trip", trip, "student", student)
		}
	}
}
