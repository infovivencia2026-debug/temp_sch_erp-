package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
busTrackerRoutesForBus answers "which lines does this bus run".

	Needed because a handset is no longer paired to a bus. The driver holds the
	phone account; the bus is chosen at the top of each run by scanning the
	sticker on the windscreen. So the route list can no longer be handed over
	with the pairing or the sign-in the way it used to be -- at those moments
	nobody knows yet which vehicle this is. Without this call the run screen
	showed "no route has been put on this bus yet" for a bus that had one, and
	the only way forward was typing a uuid off a piece of paper.

	Device-authenticated, and resolved strictly inside the device's own
	institution, so a code from another school matches nothing. Unknown codes
	answer 404 rather than an empty list: "that sticker is not one of ours" and
	"that bus has no route yet" are different things to a driver at the depot.
*/
func (s *Server) busTrackerRoutesForBus(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	code := normaliseBusCode(r.URL.Query().Get("bus"))
	if code == "" {
		httpx.Error(w, r, http.StatusBadRequest, "bad_bus_code",
			"bus is required")
		return
	}

	type routeRow struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Code string `json:"code,omitempty"`
	}
	var registration string
	routes := []routeRow{}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// Both spellings, for the same reason the trip and the enrolment take
		// both: the sticker carries bus_code, and a driver reading the plate
		// off the back of the bus types the registration.
		var vehicle uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT id, registration_no FROM vehicles
			 WHERE institution_id = $1
			   AND (upper(regexp_replace(bus_code,'[^A-Za-z0-9]','','g')) = $2
			        OR upper(regexp_replace(registration_no,'[^A-Za-z0-9]','','g')) = $2)
			   AND status <> 'retired'
			 LIMIT 1`, dev.Institution, code).Scan(&vehicle, &registration); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errBusNotFound
			}
			return err
		}

		/* Routes fixed to this bus, and routes fixed to no bus at all.

		   The second half matters: a relief vehicle covering a line whose own
		   bus is off the road is exactly the case this screen exists for, and
		   startBusTrackerTrip already accepts a route with a null vehicle_id.
		   Offering less here than the trip will accept would leave the driver
		   back at typing a uuid. */
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, name, COALESCE(code,'')
			  FROM routes
			 WHERE institution_id = $1
			   AND (vehicle_id = $2 OR vehicle_id IS NULL)
			 ORDER BY vehicle_id IS NULL, name`, dev.Institution, vehicle)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var rr routeRow
			if err := rows.Scan(&rr.ID, &rr.Name, &rr.Code); err != nil {
				return err
			}
			routes = append(routes, rr)
		}
		return rows.Err()
	})
	if errors.Is(err, errBusNotFound) {
		httpx.Error(w, r, http.StatusNotFound, "bus_not_found",
			"no bus in this school carries that code")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"registration_no": registration,
		"routes":          routes,
	})
}
