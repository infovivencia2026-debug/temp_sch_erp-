package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The stops the office map draws underneath the buses.

   There is no basemap and no tile server here, so a lone dot moving on empty
   white tells the office nothing: without the stops around it, a bus two
   kilometres off its route looks exactly like a bus sitting at one. The stop
   list is the only ground truth the plot has, which is why it is fetched even
   though the live feed already carries the vehicles.

   The route list endpoint already in mod_ops.go returns stops without
   coordinates — it feeds a timetable, not a plot — and is left alone rather
   than widened, so nothing that reads it has to change shape. */

type mapStopPoint struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	RouteID   string  `json:"route_id"`
	Route     string  `json:"route"`
	Sequence  int     `json:"sequence"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	// Nil where the stop has never had a radius set: the arrival geofence is
	// optional per stop and an absent one is not a zero-metre one.
	GeofenceM *int `json:"geofence_m,omitempty"`
}

// listTransportMapStops returns only stops that have been geocoded. A stop with
// no coordinates cannot be plotted, and returning it as (0,0) would drag the
// map's bounding box to the Gulf of Guinea and shrink every real position to a
// single pixel.
func (s *Server) listTransportMapStops(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT rs.id::text, rs.name, rs.route_id::text, rt.name, rs.sequence,
		       rs.latitude::float8, rs.longitude::float8, rs.geofence_m
		  FROM route_stops rs
		  JOIN routes rt ON rt.id = rs.route_id
		 WHERE rs.latitude IS NOT NULL AND rs.longitude IS NOT NULL
		 ORDER BY rt.name, rs.sequence`, nil,
		func(rows pgx.Rows) (mapStopPoint, error) {
			var v mapStopPoint
			return v, rows.Scan(&v.ID, &v.Name, &v.RouteID, &v.Route, &v.Sequence,
				&v.Latitude, &v.Longitude, &v.GeofenceM)
		})
	respond(w, r, items, err)
}

func (s *Server) mountTransportLiveMap(r chi.Router) {
	r.With(httpx.RequirePermission(rbac.TransportRead)).
		Get("/transport/map-stops", s.listTransportMapStops)
}
