package api

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* THE BUS, DECIDED WHERE THE FAMILY IS ASKING FOR IT.

   Enrolment already accepted a services list naming 'transport', and all that
   did was bill for a bus. The child was not put on one: that needed somebody
   in the transport office to open a second screen later, find the student
   again, and pick a route and a stop.

   So the ordinary outcome of admitting a child whose parent asked for the bus
   was an invoice for transport and no seat on it, which is the worst of the
   two possible mistakes: the family has paid, the office believes it is
   arranged, and the first anybody knows is a child standing at a stop the
   driver has no reason to call at.

   The desk is also the only place the fact exists. A parent says "we live at
   Subedari and he will use the bus" while filling in the form; nobody writes
   it down, and a week later somebody has to ring and ask again.
*/

// admissionTransport is the part of an enrolment that puts a child on a bus.
type admissionTransport struct {
	RouteID      string `json:"route_id,omitempty"`
	PickupStopID string `json:"pickup_stop_id,omitempty"`
	DropStopID   string `json:"drop_stop_id,omitempty"`
}

// wanted reports whether the desk actually asked for a bus.
func (t admissionTransport) wanted() bool {
	return strings.TrimSpace(t.RouteID) != "" && strings.TrimSpace(t.PickupStopID) != ""
}

/*
allocateAtAdmission puts the new student on a route, inside the enrolment.

	In the same transaction as the admission on purpose. A seat recorded
	against a student whose enrolment was rolled back is a child on a bus that
	nobody is expecting, and the reverse -- an admission that survives while the
	seat is lost -- is the invoice-without-a-seat this exists to prevent.

	The stop is checked against the route, which is the mistake a desk actually
	makes: two routes pass Subedari and the clerk picks the stop from the wrong
	one, so the child waits at a corner the bus does not turn.
*/
func allocateAtAdmission(
	ctx context.Context, tx pgx.Tx, inst uuid.UUID, student uuid.UUID, t admissionTransport,
) error {
	route, err := uuid.Parse(strings.TrimSpace(t.RouteID))
	if err != nil {
		return errBadTransportRef
	}
	pickup, err := uuid.Parse(strings.TrimSpace(t.PickupStopID))
	if err != nil {
		return errBadTransportRef
	}
	drop := pickup
	if raw := strings.TrimSpace(t.DropStopID); raw != "" {
		if drop, err = uuid.Parse(raw); err != nil {
			return errBadTransportRef
		}
	}

	// Both stops, one statement. A drop on another route is the same mistake
	// as a pickup on another route and deserves the same refusal.
	var ok bool
	if err := tx.QueryRow(ctx, `
		SELECT count(*) = 2
		  FROM route_stops
		 WHERE route_id = $1 AND id IN ($2, $3)`,
		route, pickup, drop).Scan(&ok); err != nil {
		return err
	}
	if !ok && pickup == drop {
		// One stop used for both: the count above can only reach one.
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM route_stops WHERE route_id = $1 AND id = $2)`,
			route, pickup).Scan(&ok); err != nil {
			return err
		}
	}
	if !ok {
		return errStopNotOnRoute
	}

	/* Any allocation this child already had is ended rather than deleted, the
	   same rule the transport office's own screen follows: a child who moved
	   stop in October was on the old one until then, and a fee already raised
	   against it has to stay explicable. On a fresh admission there is nothing
	   to end, and this costs one statement. */
	if _, err := tx.Exec(ctx, `
		UPDATE transport_allocations
		   SET valid_to = current_date - 1
		 WHERE student_id = $1 AND (valid_to IS NULL OR valid_to >= current_date)`,
		student); err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO transport_allocations
		    (institution_id, student_id, academic_year_id, route_id,
		     pickup_stop_id, drop_stop_id, valid_from)
		VALUES ($1, $2,
		        (SELECT id FROM academic_years WHERE is_current
		          ORDER BY starts_on DESC LIMIT 1),
		        $3, $4, $5, current_date)`,
		inst, student, route, pickup, drop)
	return err
}
