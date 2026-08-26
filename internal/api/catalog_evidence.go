package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/scope"
)

/* A few entries earn their place only when there is something behind them.

   The rule everywhere else is the opposite, and deliberately so: a menu entry
   is hidden only by permission and by scope, never by "you have no rows yet",
   because a HOD at a school that has not created departments and a teacher
   before anybody assigns them a class are both mid-setup, and hiding their menu
   makes the product look broken at exactly the moment somebody is building it.
   "Not yet" is not "never".

   This is the handful where absence is permanent rather than temporary. A
   support plan exists for the few children who need one; for every other child
   there will never be one, and the parent opens an entry that says so and can
   do nothing about it. That is not a setup gap the school will close — it is
   the normal state, and a menu entry for it is a promise to almost everybody
   that pays out nothing.

   Kept as an explicit short list rather than a general "hide what is empty"
   rule, because the general rule is the one that breaks setup. Anything added
   here has to be a fact that either exists or never will.
*/

// evidenceFor reports whether a feature that requires a fact has one.
//
// Returns true for every key not in the list, so a feature nobody has thought
// about behaves exactly as it did.
func (s *Server) evidenceFor(r *http.Request, sc *scope.Resolved, key string) bool {
	switch key {
	case "parent.my_childs_bus.live_bus_tracking":
		/* Only a parent whose child actually travels by bus.

		   Most children walk or are dropped off. For them the entry opened on
		   "no child of yours is on a school bus" — a permanent state, not a
		   setup gap, and one the parent cannot do anything about from there. */
		return s.anyRow(r, `
			SELECT EXISTS (
			  SELECT 1 FROM transport_allocations ta
			   WHERE ta.student_id = ANY($1)
			     AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE))`,
			sc.StudentIDs)

	case "institution_admin.hostel.hostel_rooms",
		"institution_admin.hostel.outpasses_mess",
		"institution_admin.hostel.night_study_attendance",
		"institution_admin.hostel.room_inventory_checklists",
		"institution_admin.hostel.hostel_visitor_log",
		"institution_admin.hostel.boarder_laundry":
		/* Only a school that boards children.

		   A room is the fact, not an allocation: a school that has built its
		   hostel and not yet put anybody in it still needs these screens —
		   that is precisely when it needs them. A school with no rooms has no
		   hostel, which is a permanent state and not a setup step. */
		return s.anyRow(r, `SELECT EXISTS (SELECT 1 FROM hostel_rooms)`)

	case "parent.academics.iep_progress_goal_tracker":
		/* Only a parent whose child actually has a support plan.

		   The plan is written with the parent, so the one who needs this
		   already knows it exists; the other parent is not going to discover
		   their child's needs from a menu entry that says there are none. */
		return s.anyRow(r, `
			SELECT EXISTS (
			  SELECT 1 FROM student_support_plans p
			   WHERE p.student_id = ANY($1))`, sc.StudentIDs)
	}
	return true
}

// anyRow answers one EXISTS question inside the caller's tenant, and treats a
// failure as "no" — a catalogue that 500s because one probe stumbled would cost
// somebody their whole menu over an entry they may not even want.
func (s *Server) anyRow(r *http.Request, sql string, args ...any) bool {
	id := httpx.IdentityFrom(r.Context())
	var ok bool
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), sql, args...).Scan(&ok)
	}); err != nil {
		return false
	}
	return ok
}

/*
evidenceKeys is the list itself, so the catalogue only pays for a probe on

	the features that need one. Every other entry costs nothing.
*/
var evidenceKeys = map[string]bool{
	"parent.academics.iep_progress_goal_tracker": true,
	"parent.my_childs_bus.live_bus_tracking":     true,

	/* A boarding menu at a day school.

	   Most schools on this installation have no hostel and never will, and six
	   entries standing permanently empty is what makes a product feel like
	   somebody else's. Two schools have twenty-four rooms each and could not
	   reach any of these screens at all, which is the other half of the same
	   fault. */
	"institution_admin.hostel.hostel_rooms":              true,
	"institution_admin.hostel.outpasses_mess":            true,
	"institution_admin.hostel.night_study_attendance":    true,
	"institution_admin.hostel.room_inventory_checklists": true,
	"institution_admin.hostel.hostel_visitor_log":        true,
	"institution_admin.hostel.boarder_laundry":           true,
}
