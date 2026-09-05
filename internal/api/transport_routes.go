package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE ROUTE, AND THE STOPS ON IT.

   routes and route_stops are read by the live map, the driver's app, the
   student allocation screen, the fee calculation and the attendance scanner,
   and were written by nothing at all. Same shape as vehicles this morning: a
   table every query joins to and no way to put a row in it, so a school
   completing every screen the product offers still ends with a bus that has
   nowhere to go.

   The stops are the part that matters and the part a school gets wrong. A
   route with no stops still tracks -- the parents watch the bus move -- but
   nothing can be said about where it has reached, so the arrival alerts, the
   attendance scan and "has it passed us yet" all go quiet. That is why the
   stops are written here with the route rather than on a second screen nobody
   opens.
*/

type routeStopRequest struct {
	ID         string  `json:"id,omitempty"`
	Name       string  `json:"name"`
	Sequence   int     `json:"sequence"`
	PickupTime string  `json:"pickup_time,omitempty"`
	DropTime   string  `json:"drop_time,omitempty"`
	Latitude   *string `json:"latitude,omitempty"`
	Longitude  *string `json:"longitude,omitempty"`
	FarePaise  *int64  `json:"fare_paise,omitempty"`
	/* How near counts as "the bus is here", in metres.

	   Every stop in the product carried a null, so arrival was decided
	   entirely by the school-wide default and no office could widen the circle
	   for the one stop on a dual carriageway where the bus pulls in fifty
	   metres past the shelter. Absent still means "use the default" -- this is
	   the exception, not a field every stop must carry. */
	GeofenceM *int `json:"geofence_m,omitempty"`
}

type routeRequest struct {
	CampusID   string             `json:"campus_id,omitempty"`
	Name       string             `json:"name"`
	Code       string             `json:"code,omitempty"`
	VehicleID  string             `json:"vehicle_id,omitempty"`
	DistanceKm string             `json:"distance_km,omitempty"`
	IsActive   *bool              `json:"is_active,omitempty"`
	Stops      []routeStopRequest `json:"stops,omitempty"`
}

var errRouteNoName = errors.New("a route needs a name")

/*
saveRoute creates or replaces one route and the stops on it.

	The stops are replaced wholesale rather than diffed. A route's stop list is
	short, it is edited as a list, and a diff would need the client to track
	ids it has no reason to hold -- while a replace makes "delete the third
	stop" work without a second endpoint. The ordering column is rewritten from
	the array's own order, so a stop cannot end up at sequence 4 of three.
*/
func (s *Server) saveRoute(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req routeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, errRouteNoName.Error())
		return
	}

	var routeID *uuid.UUID
	if raw := strings.TrimSpace(chiURLParam(r, "id")); raw != "" {
		v, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "invalid route id")
			return
		}
		routeID = &v
	}

	var vehicle *uuid.UUID
	if v := strings.TrimSpace(req.VehicleID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "vehicle_id must be a uuid")
			return
		}
		vehicle = &parsed
	}
	var campus *uuid.UUID
	if v := strings.TrimSpace(req.CampusID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "campus_id must be a uuid")
			return
		}
		campus = &parsed
	}

	/* An omitted is_active means "leave it alone", not "make it active".

	   Edit is the only screen that touches a route, so a form that does not
	   show the flag would have brought every retired route back the moment
	   somebody corrected a stop time. New routes still start active, which is
	   the only sensible default for a thing somebody is creating. */
	var active *bool
	if req.IsActive != nil {
		active = req.IsActive
	}

	var out struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Stops int    `json:"stops"`
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if campus != nil {
			// Same reasoning as a vehicle's: the FK to campuses is checked
			// with RLS bypassed, so a campus id from another school satisfies
			// it and routes' own policy only constrains institution_id.
			if err := campusBelongs(r, tx, campus); err != nil {
				return err
			}
		}
		if vehicle != nil {
			var ok bool
			if err := tx.QueryRow(r.Context(),
				`SELECT EXISTS (SELECT 1 FROM vehicles WHERE id = $1)`, *vehicle).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return errors.New("that bus is not on this school's register")
			}
		}

		if routeID == nil {
			/* campus_id is NOT NULL, and most schools run one campus, so an
			   absent one takes the founding campus rather than refusing a
			   route over a field the office was never shown. */
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO routes (institution_id, campus_id, name, code, vehicle_id,
				                    distance_km, is_active)
				VALUES ($1,
				        COALESCE($2::uuid, (SELECT id FROM campuses
				                             WHERE institution_id = $1
				                             ORDER BY created_at LIMIT 1)),
				        $3, NULLIF($4,''), $5, NULLIF($6,'')::numeric, COALESCE($7, true))
				RETURNING id::text, name`,
				id.InstitutionID, campus, req.Name, req.Code, vehicle,
				req.DistanceKm, active).Scan(&out.ID, &out.Name); err != nil {
				return err
			}
		} else {
			if err := tx.QueryRow(r.Context(), `
				UPDATE routes
				   SET name = $2, code = NULLIF($3,''), vehicle_id = $4,
				       distance_km = NULLIF($5,'')::numeric,
				       is_active = COALESCE($6, is_active),
				       campus_id = COALESCE($7::uuid, campus_id)
				 WHERE id = $1
				RETURNING id::text, name`,
				*routeID, req.Name, req.Code, vehicle, req.DistanceKm, active,
				campus).Scan(&out.ID, &out.Name); err != nil {
				return err
			}
		}

		rid := uuid.MustParse(out.ID)

		/* ONE BUS, ONE ROUTE AT A TIME.

		   routes.vehicle_id is what the driver's sign-in reads to decide which
		   routes to offer. Two routes pointing at one bus is not wrong in the
		   schema and is wrong on the phone: the driver is handed a list and
		   picks whichever, and half the parents are watching the other one. */
		if vehicle != nil {
			if _, err := tx.Exec(r.Context(), `
				UPDATE routes SET vehicle_id = NULL
				 WHERE vehicle_id = $1 AND id <> $2`, *vehicle, rid); err != nil {
				return err
			}
		}

		/* MATCHED BY ID, NOT REPLACED WHOLESALE.

		   This deleted every stop and inserted the list again, which is the
		   obvious way to save an edited list and quietly destroys two things.

		   transport_allocations.pickup_stop_id and drop_stop_id are ON DELETE
		   SET NULL, so re-minting the ids detaches every rider from the stop
		   they board at. A school with four hundred children on buses would
		   correct a stop's time and lose the lot, with nothing to say it had
		   happened.

		   And a stop's fare survives an edit only if the client sends it back.
		   A form that does not show fares would blank them all. Keeping the
		   row means an omitted field keeps what it had, which is what an
		   office expects of a field it was never shown.

		   So: a stop carrying an id is updated in place, one without an id is
		   new, and only the stops missing from the list are removed. */
		if req.Stops != nil {
			/* Positions are unique per route, and the list is saved in its new
			   order one row at a time. A stop added above the first one took
			   position 1 while the old first stop still held it, and the save
			   died on that constraint — reported, wrongly, as a duplicate route
			   code. Park every existing position out of the way first, so the
			   pass below only ever writes into empty positions. */
			if _, err := tx.Exec(r.Context(),
				`UPDATE route_stops SET sequence = sequence + 1000000 WHERE route_id = $1`, rid); err != nil {
				return err
			}
			kept := make([]uuid.UUID, 0, len(req.Stops))
			for i, st := range req.Stops {
				name := strings.TrimSpace(st.Name)
				if name == "" {
					continue
				}
				// Sequence from the array's own order, never from the client's
				// number: a list edited in place sends whatever it last had,
				// and a gap or a duplicate there puts a stop out of order on
				// the driver's screen.
				seq := i + 1
				lat := derefOrEmpty(st.Latitude)
				lon := derefOrEmpty(st.Longitude)

				if existing, perr := uuid.Parse(strings.TrimSpace(st.ID)); perr == nil {
					var got uuid.UUID
					// COALESCE on fare: absent means unchanged, not zero.
					if err := tx.QueryRow(r.Context(), `
						UPDATE route_stops
						   SET name = $3, sequence = $4,
						       pickup_time = NULLIF($5,'')::time,
						       drop_time   = NULLIF($6,'')::time,
						       latitude    = NULLIF($7,'')::numeric,
						       longitude   = NULLIF($8,'')::numeric,
						       fare_paise  = COALESCE($9, fare_paise),
						       geofence_m  = COALESCE($10, geofence_m)
						 WHERE id = $1 AND route_id = $2
						RETURNING id`,
						existing, rid, name, seq, st.PickupTime, st.DropTime,
						lat, lon, st.FarePaise, st.GeofenceM).Scan(&got); err == nil {
						kept = append(kept, got)
						out.Stops++
						continue
					} else if !errors.Is(err, pgx.ErrNoRows) {
						return err
					}
					// No such stop on this route: fall through and insert it,
					// rather than failing a save over an id the client held
					// from a route it was looking at earlier.
				}

				var made uuid.UUID
				if err := tx.QueryRow(r.Context(), `
					INSERT INTO route_stops (institution_id, route_id, name, sequence,
					                         pickup_time, drop_time, latitude, longitude,
					                         fare_paise, geofence_m)
					VALUES ($1,$2,$3,$4,
					        NULLIF($5,'')::time, NULLIF($6,'')::time,
					        NULLIF($7,'')::numeric, NULLIF($8,'')::numeric, $9, $10)
					RETURNING id`,
					id.InstitutionID, rid, name, seq,
					st.PickupTime, st.DropTime, lat, lon, st.FarePaise,
					st.GeofenceM).Scan(&made); err != nil {
					return err
				}
				kept = append(kept, made)
				out.Stops++
			}
			if _, err := tx.Exec(r.Context(),
				`DELETE FROM route_stops WHERE route_id = $1 AND id <> ALL($2)`,
				rid, kept); err != nil {
				return err
			}
		} else {
			if err := tx.QueryRow(r.Context(),
				`SELECT count(*) FROM route_stops WHERE route_id = $1`, rid).
				Scan(&out.Stops); err != nil {
				return err
			}
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case errors.Is(err, errNotOurCampus):
		httpx.BadRequest(w, r, err.Error())
		return
	case err != nil:
		if isUniqueViolation(err) {
			if strings.Contains(err.Error(), "route_stops") {
				httpx.Error(w, r, http.StatusConflict, "duplicate_stop",
					"two stops landed on the same position; reorder them and save again")
				return
			}
			httpx.Error(w, r, http.StatusConflict, "duplicate_route",
				"a route with that name already exists on this campus")
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}

	status := http.StatusOK
	if routeID == nil {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, out)
}

func derefOrEmpty(v *string) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(*v)
}

// deleteRoute retires a route rather than dropping it: a trip already driven
// names the route it ran, and deleting the row would orphan that history.
func (s *Server) deleteRoute(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	routeID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid route id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`UPDATE routes SET is_active = false, vehicle_id = NULL WHERE id = $1`, routeID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": routeID.String(), "retired": true})
}
