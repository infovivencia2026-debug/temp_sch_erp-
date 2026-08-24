package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Making the published timetable agree with who actually teaches.

   Faculty allocation and the timetable are two tables, and they drift. The
   allocation screen even has a flag for it — timetable_differs, "the timetable
   puts somebody else in front of this class" — and nothing anywhere could act
   on it. So a school that reassigns a subject in September has an allocation
   saying one thing and a printed timetable saying another, and every screen
   that reads periods rather than allocations keeps naming the old teacher.

   The damage is not cosmetic. The substitution board finds who is absent by
   walking timetable rows, and the duty roster checks clashes the same way, so a
   teacher who was allocated three subjects but never written into the timetable
   is invisible to both: their approved leave leaves no gap to cover, and a duty
   in the middle of their teaching hour clashes with nothing. That is how a
   school ends up told "nobody is absent" on a morning somebody is away.

   One action, and it moves the timetable to match the allocation rather than
   the other way round. The allocation is what a human decided this week; the
   timetable is a generated artefact of an earlier decision, and when the two
   disagree the human is right.

   Periods are not created — only reassigned. Writing new periods would be
   inventing a timetable, which is the generator's job and needs to reason
   about rooms and clashes. This answers the narrower question: for the periods
   that already exist, is the right teacher's name on them?
*/

type allocationApplyResult struct {
	// Periods whose teacher was wrong and is now right.
	Moved int `json:"periods_reassigned"`
	// Allocations with no period to attach to. Worth reporting rather than
	// hiding: it means the timetable was never generated for that subject, and
	// nobody can be given a period that does not exist.
	WithoutPeriods int `json:"allocations_with_no_period"`
}

// applyAllocationToTimetable puts the allocated teacher's name on the periods
// that already exist.
func (s *Server) applyAllocationToTimetable(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var out allocationApplyResult
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Every period whose section and subject has an allocation naming
		   somebody else. Matched on the pair, because a period belongs to one
		   section and one class_subject and so does an allocation. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE timetable_entries te
			   SET teacher_user_id = t.teacher_user_id
			  FROM section_subject_teachers t
			 WHERE t.section_id       = te.section_id
			   AND t.class_subject_id = te.class_subject_id
			   AND te.teacher_user_id IS DISTINCT FROM t.teacher_user_id`)
		if err != nil {
			return err
		}
		out.Moved = int(tag.RowsAffected())

		return tx.QueryRow(r.Context(), `
			SELECT count(*)::int
			  FROM section_subject_teachers t
			 WHERE NOT EXISTS (
			         SELECT 1 FROM timetable_entries te
			          WHERE te.section_id = t.section_id
			            AND te.class_subject_id = t.class_subject_id)`).
			Scan(&out.WithoutPeriods)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
