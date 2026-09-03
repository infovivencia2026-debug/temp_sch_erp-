package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The children, on the driver's phone.

   Everything in bus_tracker.go is about where the bus is. This file is about
   who is on it: the roster the driver sees stop by stop, the absences parents
   reported before the bus left, the marks the driver makes as children get on
   and off, and the photo that lets a relief driver on an unfamiliar route put
   a face to a name.

   The same rules as the rest of the device protocol apply. Every handler runs
   as platform because the handset has no session, so every query names the
   device's own institution and vehicle explicitly; a handset can read the
   roster of the route its bus is running today and nothing else. */

// legFor maps a trip's direction onto transport_attendance's older vocabulary.
func legFor(direction string) string {
	if direction == "drop" {
		return "afternoon"
	}
	return "morning"
}

/*
tripOfThisBus confirms the trip is this handset's and returns what the roster
needs from it.

	"This handset's" is either of two things. A phone paired to one bus has a
	vehicle and the trip must be on it. The ordinary phone now is registered
	to a driver, its Vehicle is nil and the bus is whatever sticker was
	scanned at the start of the run; for that phone the trip is the one it
	opened, found by tracker_id. Comparing against a nil vehicle alone would
	match nothing and 404 every driver who scanned in.
*/
func tripOfThisBus(r *http.Request, tx pgx.Tx, dev *busTracker, trip uuid.UUID) (route, vehicle uuid.UUID, direction string, open bool, err error) {
	err = tx.QueryRow(r.Context(), `
		SELECT route_id, vehicle_id, direction, ended_at IS NULL
		  FROM vehicle_trips
		 WHERE id = $1 AND institution_id = $2
		   AND (tracker_id = $3 OR vehicle_id = $4)`,
		trip, dev.Institution, dev.ID, dev.Vehicle).Scan(&route, &vehicle, &direction, &open)
	return
}

/*
vehicleForTracker is the bus this handset is on, for the calls that have no
trip id to go by: a photo, a notice, an OK.

	The paired-to-a-bus phone answers from its own row. A driver's phone
	answers from its trips: the open one if there is one, otherwise the most
	recent one that ended in the last twelve hours, because "run cancelled,
	come back" has to reach a driver who pressed End two minutes ago, and a
	photo request in flight as the run ends must not 404. A phone with no run
	today is on no bus, and gets nothing.
*/
func vehicleForTracker(ctx context.Context, tx pgx.Tx, dev *busTracker) (uuid.UUID, bool) {
	if dev.Vehicle != nil {
		return *dev.Vehicle, true
	}
	var v uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT vehicle_id
		  FROM vehicle_trips
		 WHERE tracker_id = $1 AND institution_id = $2
		   AND (ended_at IS NULL OR ended_at > now() - interval '12 hours')
		 ORDER BY (ended_at IS NULL) DESC, started_at DESC
		 LIMIT 1`, dev.ID, dev.Institution).Scan(&v)
	return v, err == nil
}

type rosterStudent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	AdmissionNo string `json:"admission_no"`
	Class       string `json:"class"`
	// The stop this child uses on this leg. Empty when the allocation names a
	// route but no stop yet; the phone shows those under "No stop set".
	StopID   string `json:"stop_id"`
	HasPhoto bool   `json:"has_photo"`
	// Reported absent before the run, by a parent or by the class register.
	// The driver did not decide this and cannot undo it from the bus.
	Absent       bool   `json:"absent"`
	AbsentReason string `json:"absent_reason,omitempty"`
	// The driver's own mark for this leg today: boarded, alighted, absent, or
	// empty for none yet.
	Status   string `json:"status"`
	MarkedAt string `json:"marked_at,omitempty"`
}

/*
getBusTrackerRoster is every child expected on this trip, with what is
already known about them today.

	Built from the allocation, not from the attendance table, for the same
	reason as the office's register: the child who was never marked is the one
	the driver has to be shown.
*/
func (s *Server) getBusTrackerRoster(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	tripID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	students := []rosterStudent{}
	var direction string
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		route, _, dir, _, err := tripOfThisBus(r, tx, dev, tripID)
		if err != nil {
			return err
		}
		direction = dir
		rows, err := tx.Query(r.Context(), `
			SELECT st.id::text,
			       concat_ws(' ', st.first_name, st.last_name),
			       COALESCE(st.admission_no, ''),
			       COALESCE(concat_ws(' ', cl.name, sec.name), ''),
			       COALESCE(CASE WHEN $2 = 'drop' THEN ta.drop_stop_id ELSE ta.pickup_stop_id END::text, ''),
			       st.photo_file_id IS NOT NULL,
			       EXISTS (SELECT 1 FROM leave_requests lr
			                WHERE lr.student_id = st.id AND lr.subject_kind = 'student'
			                  AND lr.status IN ('pending','approved')
			                  AND (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN lr.from_date AND lr.to_date),
			       EXISTS (SELECT 1 FROM student_attendance sa
			                WHERE sa.student_id = st.id AND sa.period_id IS NULL
			                  AND sa.on_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
			                  AND sa.status IN ('absent','leave')),
			       COALESCE(att.status, ''),
			       COALESCE(to_char(COALESCE(att.alighted_at, att.boarded_at) AT TIME ZONE 'Asia/Kolkata', 'HH24:MI'), '')
			  FROM transport_allocations ta
			  JOIN students st ON st.id = ta.student_id AND st.status = 'active'
			  LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
			  LEFT JOIN sections sec ON sec.id = en.section_id
			  LEFT JOIN classes cl ON cl.id = sec.class_id
			  LEFT JOIN transport_attendance att
			         ON att.student_id = st.id
			        AND att.on_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
			        AND att.leg = $3
			 WHERE ta.route_id = $1 AND ta.institution_id = $4
			   AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)
			 ORDER BY st.first_name, st.last_name
			 LIMIT 400`, route, dir, legFor(dir), dev.Institution)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v rosterStudent
			var onLeave, absentInClass bool
			if err := rows.Scan(&v.ID, &v.Name, &v.AdmissionNo, &v.Class, &v.StopID,
				&v.HasPhoto, &onLeave, &absentInClass, &v.Status, &v.MarkedAt); err != nil {
				return err
			}
			switch {
			case onLeave:
				v.Absent, v.AbsentReason = true, "Parent reported absent"
			case absentInClass:
				v.Absent, v.AbsentReason = true, "Marked absent in class"
			}
			// The driver's own "absent" is a mark, and it is reported as one.
			// Only somebody else's word greys the card.
			students = append(students, v)
		}
		return rows.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "no_such_trip", "that run is not this bus's")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"trip_id":   tripID.String(),
		"direction": direction,
		"leg":       legFor(direction),
		"students":  students,
	})
}

type boardingMark struct {
	StudentID string `json:"student_id"`
	// boarded | alighted | absent
	Status string `json:"status"`
	// When the driver tapped, RFC 3339. The mark may arrive an hour later
	// from a dead zone and is still the mark made at the stop.
	At string `json:"at"`
}

type boardingRequest struct {
	Marks []boardingMark `json:"marks"`
}

/*
markBusTrackerBoarding records what the driver saw at the stop.

	A batch, so a phone coming out of a dead zone can hand over the whole
	stop in one call. Each mark lands or is refused on its own; the response
	names the ones stored so the phone deletes exactly those, the same
	bargain the positions push makes.

	Idempotent on (student, day, leg): tapping "On" twice is one boarding, and
	a mark replayed after a lost response changes nothing.

	Newest tap wins, not last write. A phone replaying its outbox after a dead
	zone may hand over "boarded 07:40" a minute after the office's screen, or
	its own later batch, recorded "alighted 08:15". The tap time is kept in
	remarks as RFC 3339 text -- the table has no column for it and one more
	migration for one timestamp is not worth the churn -- and an update only
	lands when its tap is no older than the one stored. Remarks the office
	writes by hand are not timestamps, and a row carrying one of those is
	treated as never tapped. A stale mark is still reported accepted: the
	phone's job was to hand it over, and it did.

	The tap time is also what dates the mark, so a boarding at 23:50 lands on
	the day it happened. A clock that is more than twelve hours out -- a phone
	that has been off for a week and not yet synced -- would file the mark on
	some other day's register, so its mark is taken as now.
*/
func (s *Server) markBusTrackerBoarding(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	sess := staffSessionFrom(r.Context())
	tripID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req boardingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Marks) == 0 || len(req.Marks) > 200 {
		httpx.Error(w, r, http.StatusBadRequest, "bad_marks", "send between 1 and 200 marks")
		return
	}
	var markedBy *uuid.UUID
	if sess != nil {
		markedBy = &sess.UserID
	}

	accepted := []string{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		route, _, dir, _, err := tripOfThisBus(r, tx, dev, tripID)
		if err != nil {
			return err
		}
		leg := legFor(dir)
		for _, m := range req.Marks {
			student, err := uuid.Parse(m.StudentID)
			if err != nil || !oneOfStr(m.Status, "boarded", "alighted", "absent") {
				continue
			}
			now := time.Now()
			at := now
			if t, err := time.Parse(time.RFC3339, m.At); err == nil {
				at = t
			}
			if d := at.Sub(now); d > 12*time.Hour || d < -12*time.Hour {
				at = now
			}
			tap := at.UTC().Format(time.RFC3339)
			var onRoute bool
			err = tx.QueryRow(r.Context(), `
				WITH alloc AS (
				  SELECT ta.student_id, ta.route_id,
				         CASE WHEN $4 = 'drop' THEN ta.drop_stop_id ELSE ta.pickup_stop_id END AS stop_id
				    FROM transport_allocations ta
				   WHERE ta.student_id = $2 AND ta.route_id = $3 AND ta.institution_id = $1
				     AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)
				   LIMIT 1
				), ins AS (
				  INSERT INTO transport_attendance
				      (institution_id, student_id, route_id, stop_id, on_date, leg,
				       status, source, marked_by, boarded_at, alighted_at, remarks)
				  SELECT $1, student_id, route_id, stop_id,
				         ($5::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, $6,
				         $7, 'manual', $8,
				         CASE WHEN $7 = 'boarded'  THEN $5::timestamptz END,
				         CASE WHEN $7 = 'alighted' THEN $5::timestamptz END,
				         $9
				    FROM alloc
				  ON CONFLICT (student_id, on_date, leg)
				  DO UPDATE SET status = EXCLUDED.status,
				                source = EXCLUDED.source,
				                marked_by = COALESCE(EXCLUDED.marked_by, transport_attendance.marked_by),
				                boarded_at = COALESCE(transport_attendance.boarded_at, EXCLUDED.boarded_at),
				                alighted_at = COALESCE(EXCLUDED.alighted_at, transport_attendance.alighted_at),
				                remarks = EXCLUDED.remarks
				        WHERE $5::timestamptz >= CASE
				                WHEN transport_attendance.remarks ~ '^\d{4}-\d{2}-\d{2}T'
				                THEN transport_attendance.remarks::timestamptz
				                ELSE 'epoch'::timestamptz END
				  RETURNING 1
				)
				SELECT EXISTS (SELECT 1 FROM alloc)`,
				dev.Institution, student, route, dir, at, leg, m.Status, markedBy, tap).Scan(&onRoute)
			if err != nil {
				return err
			}
			// Not on this route means not this bus's mark to make, and not
			// worth failing the batch over.
			if onRoute {
				accepted = append(accepted, m.StudentID)
			}
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "no_such_trip", "that run is not this bus's")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"accepted": accepted})
}

/*
getBusTrackerStudentPhoto streams a child's photo to the handset.

	The ordinary file route needs a person's session and this phone has none,
	so the check here is the narrowest one that answers the question: is this
	child currently allocated to a route this bus is running, either the
	route the office put on the vehicle or the one of its open trip? Anything
	else is 404, and nothing but the bytes of the image ever leaves.
*/
func (s *Server) getBusTrackerStudentPhoto(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	studentID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	dir := s.storeDir()
	if dir == "" {
		httpx.NotFound(w, r)
		return
	}
	var key, contentType string
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		vehicle, ok := vehicleForTracker(r.Context(), tx, dev)
		if !ok {
			return pgx.ErrNoRows
		}
		return tx.QueryRow(r.Context(), `
			SELECT f.object_key, f.content_type
			  FROM students st
			  JOIN files f ON f.id = st.photo_file_id AND f.deleted_at IS NULL
			 WHERE st.id = $1 AND st.institution_id = $2
			   AND EXISTS (
			     SELECT 1 FROM transport_allocations ta
			      WHERE ta.student_id = st.id
			        AND (ta.valid_to IS NULL OR ta.valid_to >= current_date)
			        AND (ta.route_id IN (SELECT id FROM routes WHERE vehicle_id = $3)
			          OR ta.route_id IN (SELECT route_id FROM vehicle_trips
			                              WHERE vehicle_id = $3 AND ended_at IS NULL)))`,
			studentID, dev.Institution, vehicle).Scan(&key, &contentType)
	})
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	full := filepath.Join(dir, filepath.FromSlash(filepath.Clean("/"+key)))
	if !strings.HasPrefix(full, filepath.Clean(dir)+string(filepath.Separator)) {
		httpx.NotFound(w, r)
		return
	}
	if !strings.HasPrefix(contentType, "image/") {
		httpx.NotFound(w, r)
		return
	}
	f, err := os.Open(full)
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "photo", info.ModTime(), f)
}

// --- notices -----------------------------------------------------------------

type driverNotice struct {
	ID     string `json:"id"`
	Body   string `json:"body"`
	SentAt string `json:"sent_at"`
}

// pendingDriverNotices is what the heartbeat carries down: everything sent to
// this bus that nobody has tapped OK on and that has not gone stale.
func pendingDriverNotices(r *http.Request, tx pgx.Tx, dev *busTracker) ([]driverNotice, error) {
	vehicle, ok := vehicleForTracker(r.Context(), tx, dev)
	if !ok {
		return []driverNotice{}, nil
	}
	rows, err := tx.Query(r.Context(), `
		SELECT id::text, body, to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		  FROM driver_notices
		 WHERE vehicle_id = $1 AND institution_id = $2
		   AND acknowledged_at IS NULL AND expires_at > now()
		 ORDER BY sent_at
		 LIMIT 10`, vehicle, dev.Institution)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []driverNotice{}
	for rows.Next() {
		var n driverNotice
		if err := rows.Scan(&n.ID, &n.Body, &n.SentAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// acknowledgeDriverNotice is the driver's one tap. Who tapped is recorded when
// a session is present and the notice is closed either way: an OK from the
// bus is an OK whoever is signed in.
func (s *Server) acknowledgeDriverNotice(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	sess := staffSessionFrom(r.Context())
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var by *uuid.UUID
	if sess != nil {
		by = &sess.UserID
	}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		vehicle, ok := vehicleForTracker(r.Context(), tx, dev)
		if !ok {
			return pgx.ErrNoRows
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE driver_notices
			   SET acknowledged_at = COALESCE(acknowledged_at, now()),
			       acknowledged_by = COALESCE(acknowledged_by, $3)
			 WHERE id = $1 AND vehicle_id = $2 AND institution_id = $4`, id, vehicle, by, dev.Institution)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "no_such_notice", "that notice is not this bus's")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"acknowledged": true})
}

// --- the office's half -------------------------------------------------------

type sendNoticeRequest struct {
	Body string `json:"body"`
}

func (s *Server) sendDriverNotice(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	vehicle, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req sendNoticeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" || len(body) > 500 {
		httpx.BadRequest(w, r, "body must be 1 to 500 characters")
		return
	}
	var noticeID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO driver_notices (institution_id, vehicle_id, body, sent_by)
			SELECT $1, v.id, $3, $4 FROM vehicles v WHERE v.id = $2
			RETURNING id::text`, id.InstitutionID, vehicle, body, id.UserID).Scan(&noticeID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": noticeID})
}

type driverNoticeRow struct {
	ID             string  `json:"id"`
	Body           string  `json:"body"`
	SentAt         string  `json:"sent_at"`
	SentBy         *string `json:"sent_by,omitempty"`
	AcknowledgedAt *string `json:"acknowledged_at,omitempty"`
	AcknowledgedBy *string `json:"acknowledged_by,omitempty"`
	Expired        bool    `json:"expired"`
}

func (s *Server) listDriverNotices(w http.ResponseWriter, r *http.Request) {
	vehicle, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	items, err := collect(s, r, `
		SELECT n.id::text, n.body,
		       to_char(n.sent_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'),
		       (SELECT full_name FROM users WHERE id = n.sent_by),
		       to_char(n.acknowledged_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'),
		       (SELECT full_name FROM users WHERE id = n.acknowledged_by),
		       n.acknowledged_at IS NULL AND n.expires_at <= now()
		  FROM driver_notices n
		 WHERE n.vehicle_id = $1
		 ORDER BY n.sent_at DESC
		 LIMIT 30`, []any{vehicle},
		func(rows pgx.Rows) (driverNoticeRow, error) {
			var v driverNoticeRow
			return v, rows.Scan(&v.ID, &v.Body, &v.SentAt, &v.SentBy, &v.AcknowledgedAt,
				&v.AcknowledgedBy, &v.Expired)
		})
	respond(w, r, items, err)
}

func (s *Server) mountDriverNoticeAdmin(r chi.Router) {
	r.With(httpx.RequirePermission(rbac.TransportRead)).Get("/transport/vehicles/{id}/notices", s.listDriverNotices)
	r.With(httpx.RequirePermission(rbac.TransportWrite)).Post("/transport/vehicles/{id}/notices", s.sendDriverNotice)
}
