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
THE REGISTER ON THE BUS.

	transport_attendance had exactly one writer: a screen in the office, typed
	up afterwards from whatever the driver remembered. So the table sat empty
	against sixteen hundred position fixes, and the question a parent actually
	rings about -- did my child get on -- was the one question the product
	could not answer, while it knew the bus's location to the metre.

	The two handlers below put the register where the children are. The list is
	the driver's stop-by-stop roll for the open run; the mark is one tap
	against one child.
*/

type rollChild struct {
	StudentID string `json:"student_id"`
	Name      string `json:"name"`
	StopID    string `json:"stop_id,omitempty"`
	StopName  string `json:"stop_name,omitempty"`
	Sequence  int    `json:"sequence"`
	Status    string `json:"status"`
}

/*
busTrackerRoll lists the children due on this run, in the order the bus reaches
them.

	Ordered by stop sequence rather than by name, because the driver is not
	looking anybody up: he is at a stop and wants the two or three names that
	belong to it. A child whose allocation names no stop still appears, at the
	end, rather than being dropped from the run they are on.

	Device-authenticated, and narrowed to the open trip's own route, so a
	handset cannot read another route's children by asking.
*/
func (s *Server) busTrackerRoll(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	tripID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}

	items := []rollChild{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var route uuid.UUID
		var direction string
		if err := tx.QueryRow(r.Context(), `
			SELECT route_id, direction FROM vehicle_trips
			 WHERE id = $1 AND institution_id = $2`,
			tripID, dev.Institution).Scan(&route, &direction); err != nil {
			return err
		}
		leg := legForDirection(direction)

		rows, err := tx.Query(r.Context(), `
			SELECT st.id::text,
			       COALESCE(NULLIF(TRIM(st.first_name || ' ' ||
			                            COALESCE(st.last_name,'')),''), 'Unnamed'),
			       COALESCE(rs.id::text,''), COALESCE(rs.name,''),
			       COALESCE(rs.sequence, 9999),
			       COALESCE(att.status, 'not_marked')
			  FROM transport_allocations ta
			  JOIN students st ON st.id = ta.student_id
			  LEFT JOIN route_stops rs
			         ON rs.id = CASE WHEN $3 = 'drop' THEN ta.drop_stop_id
			                         ELSE ta.pickup_stop_id END
			  LEFT JOIN transport_attendance att
			         ON att.student_id = st.id
			        AND att.on_date = current_date
			        AND att.leg = $4
			 WHERE ta.institution_id = $1
			   AND ta.route_id = $2
			   AND ta.valid_from <= current_date
			   AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)
			 ORDER BY COALESCE(rs.sequence, 9999), st.first_name
			 LIMIT 200`, dev.Institution, route, direction, leg)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c rollChild
			if err := rows.Scan(&c.StudentID, &c.Name, &c.StopID, &c.StopName,
				&c.Sequence, &c.Status); err != nil {
				return err
			}
			items = append(items, c)
		}
		return rows.Err()
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
	httpx.JSON(w, http.StatusOK, map[string]any{"children": items})
}

type rollMarkRequest struct {
	StudentID string `json:"student_id"`
	Status    string `json:"status"`
}

/*
busTrackerMarkChild records one child boarding or getting off, from the bus.

	Driver-authenticated as well as device-authenticated: this row says a named
	adult saw a named child get on, and it is the record a school stands behind
	when a family asks. marked_by is the driver's own user, exactly as the
	office screen writes the clerk's.

	'absent' is offered because it is the answer that matters most at a stop
	the bus waited at: nobody came out. A run with three absents recorded is
	worth more to an office at nine o'clock than a run with three blanks.

	The upsert is the office screen's, deliberately, including its rule that
	alighting never erases the record of having boarded.
*/
func (s *Server) busTrackerMarkChild(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	driver := staffSessionFrom(r.Context())
	tripID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req rollMarkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "bad_student_id",
			"student_id must be a uuid")
		return
	}
	if !oneOfStr(req.Status, "boarded", "alighted", "absent") {
		httpx.Error(w, r, http.StatusBadRequest, "bad_status",
			"status must be boarded, alighted or absent")
		return
	}

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var route uuid.UUID
		var direction string
		if err := tx.QueryRow(r.Context(), `
			SELECT route_id, direction FROM vehicle_trips
			 WHERE id = $1 AND institution_id = $2 AND ended_at IS NULL`,
			tripID, dev.Institution).Scan(&route, &direction); err != nil {
			return err
		}

		/* The child has to be on this run's route.

		   Everything here runs as platform, so RLS is not standing behind it
		   and student_id arrived from a handset. Without this check a paired
		   phone could mark any child in the school -- or in another school --
		   as having boarded a bus they were nowhere near. */
		var allocated bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			    SELECT 1 FROM transport_allocations
			     WHERE institution_id = $1 AND student_id = $2 AND route_id = $3
			       AND valid_from <= current_date
			       AND (valid_to IS NULL OR valid_to >= current_date))`,
			dev.Institution, student, route).Scan(&allocated); err != nil {
			return err
		}
		if !allocated {
			return pgx.ErrNoRows
		}

		_, err := tx.Exec(r.Context(), `
			INSERT INTO transport_attendance
			    (institution_id, student_id, route_id, stop_id, on_date, leg,
			     status, source, marked_by, boarded_at, alighted_at)
			SELECT $1, $2, $3,
			       CASE WHEN $4 = 'drop' THEN ta.drop_stop_id
			            ELSE ta.pickup_stop_id END,
			       current_date, $5, $6, 'driver', $7,
			       CASE WHEN $6 = 'boarded' THEN now() END,
			       CASE WHEN $6 = 'alighted' THEN now() END
			  FROM transport_allocations ta
			 WHERE ta.institution_id = $1 AND ta.student_id = $2
			   /* THE ROUTE THIS MARK IS FOR, not whichever allocation sorted
			      first. A child on a morning route and an afternoon shuttle
			      has two rows, and without this the stop written against an
			      afternoon mark was the morning route's pickup -- a register
			      showing a child at a stop that is not on the run they were
			      marked on. The guard above already narrows to $3; this is the
			      same narrowing, on the row actually read. */
			   AND ta.route_id = $3
			   AND ta.valid_from <= current_date
			   AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)
			 LIMIT 1
			ON CONFLICT (student_id, on_date, leg)
			DO UPDATE SET status = EXCLUDED.status,
			              source = EXCLUDED.source,
			              marked_by = EXCLUDED.marked_by,
			              boarded_at = COALESCE(transport_attendance.boarded_at,
			                                    EXCLUDED.boarded_at),
			              alighted_at = COALESCE(EXCLUDED.alighted_at,
			                                     transport_attendance.alighted_at)`,
			dev.Institution, student, route, direction,
			legForDirection(direction), req.Status, driver.UserID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "not_on_this_run",
			"that child is not on this route today")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"marked": req.Status})
}

/*
legForDirection names the half of the day a run belongs to.

	transport_attendance is keyed on (student, date, leg) so that a child can
	be marked once on the way in and once on the way home. The office screen
	spells these 'morning' and 'afternoon'; a trip spells its direction
	'pickup' and 'drop'. Translated in one place so the two screens cannot
	disagree about which row they are looking at.
*/
func legForDirection(direction string) string {
	if direction == "drop" {
		return "afternoon"
	}
	return "morning"
}
