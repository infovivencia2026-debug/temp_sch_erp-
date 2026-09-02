package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type trackerCheckRequest struct {
	BusCode    string   `json:"bus_code,omitempty"`
	RouteID    string   `json:"route_id,omitempty"`
	Direction  string   `json:"direction,omitempty"`
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
busTrackerRecordCheck is the pre-trip safety check, signed off by the driver on
the bus.

	trip_checks had been in the schema, with a screen in the office, and not
	one row in it. That is the expected outcome of the arrangement: the checks
	are of the brakes, the tyres, the doors and the extinguisher on a vehicle
	standing in a depot, and the only person standing next to it is the driver,
	who had no way to record any of it. A safety register that can only be
	filled in by somebody who cannot see the bus is a safety register that
	stays empty.

	cleared is derived here and never accepted from the request, exactly as the
	office handler derives it. This is the one row in the product a court would
	read, and a handset must not be able to assert a pass over a failed brake
	check.

	It does not block the run. A driver who finds a fault at twenty to seven
	with forty children waiting needs the fault recorded, not an app that
	refuses to work; the office sees an uncleared check against a run that
	went ahead, which is the fact worth having.
*/
func (s *Server) busTrackerRecordCheck(w http.ResponseWriter, r *http.Request) {
	dev := busTrackerFrom(r.Context())
	driver := staffSessionFrom(r.Context())
	var req trackerCheckRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	cleared := req.Brakes && req.Tyres && req.Lights && req.FirstAid &&
		req.Extinguish && req.Doors && (req.Breath == nil || *req.Breath == 0)

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// The bus for this check is the one being driven: the scanned code
		// when there is one, otherwise whatever the handset is still paired
		// to. Resolved the same way a trip resolves it, so the check and the
		// run it belongs to cannot end up against different vehicles.
		vehicle, err := resolveTripVehicle(r.Context(), tx, dev, req.BusCode)
		if err != nil {
			return err
		}

		_, err = tx.Exec(r.Context(), `
			INSERT INTO trip_checks
			    (institution_id, vehicle_id, route_id, on_date, leg,
			     driver_employee_id, brakes_ok, tyres_ok, lights_ok,
			     first_aid_ok, extinguisher_ok, doors_ok, breathalyser,
			     cleared, remarks, checked_by)
			VALUES ($1,$2,NULLIF($3,'')::uuid,current_date,$4,
			        (SELECT id FROM employees WHERE user_id = $5
			          AND institution_id = $1 LIMIT 1),
			        $6,$7,$8,$9,$10,$11,$12,$13,NULLIF($14,''),$5)
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
			              checked_at = now()`,
			dev.Institution, vehicle, req.RouteID,
			legForDirection(req.Direction), driver.UserID,
			req.Brakes, req.Tyres, req.Lights, req.FirstAid, req.Extinguish,
			req.Doors, req.Breath, cleared, req.Remarks)
		return err
	})
	if errors.Is(err, errBusNotFound) {
		httpx.Error(w, r, http.StatusNotFound, "bus_not_found",
			"no bus in this school carries that code")
		return
	}
	if errors.Is(err, errNoBusForTrip) {
		httpx.Error(w, r, http.StatusBadRequest, "no_bus",
			"scan the bus before signing off its check")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"cleared": cleared})
}

/*
resolveTripVehicle turns "the bus this handset is driving" into a row.

	The scanned code wins over the pairing, and resolves inside the device's
	own institution so a sticker from another school matches nothing. Lifted
	out of startBusTrackerTrip so the safety check and the trip cannot disagree
	about which bus is being driven -- a check filed against yesterday's paired
	vehicle while the run goes out on a relief bus is worse than no check.
*/
func resolveTripVehicle(ctx context.Context, tx pgx.Tx, dev *busTracker,
	busCode string) (uuid.UUID, error) {

	code := normaliseBusCode(busCode)
	if code == "" {
		if dev.Vehicle == nil {
			return uuid.Nil, errNoBusForTrip
		}
		return *dev.Vehicle, nil
	}
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `
		SELECT id FROM vehicles
		 WHERE institution_id = $1
		   AND (upper(bus_code) = $2
		        OR upper(regexp_replace(registration_no,'[^A-Za-z0-9]','','g')) = $2)
		   AND status <> 'retired'
		 LIMIT 1`, dev.Institution, code).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, errBusNotFound
		}
		return uuid.Nil, err
	}
	return id, nil
}

// normaliseBusCode is how a sticker and a typed registration are made
// comparable: upper case, and punctuation dropped from the plate. "TS36UB0001"
// and "TS 36 UB 0001" are the same bus, and a driver typing the second must
// not be told it is not one of ours.
func normaliseBusCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}
