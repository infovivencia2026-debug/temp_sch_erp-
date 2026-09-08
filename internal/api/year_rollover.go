package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The year rollover: what April used to rebuild by hand.

   Sections, the fee structure, the bus allocations and the timetable are all
   keyed on an academic year, and the product had no way to carry any of them
   into the next one. Every April an office recreated 8-A to 8-D with the same
   capacities, re-keyed the fee heads, re-entered every child's bus stop and
   drew the timetable again. This copies each of them, once, into a year that
   already exists and is not yet current.

   Two things it deliberately does not do.

   It does not promote children. Promotion is its own step with its own
   screen (Students > Class Promotion, /lifecycle/promote), because it is a
   decision per section on the results, and a copy that also moved every
   child up would be wrong for the two who are repeating.

   It does not copy what is not per-year. Routes and their stops, hostel rooms
   and their beds, and the subject-to-class map have no academic_year_id: a
   bus route is the same route in both years and would only be duplicated.
   Those items are reported as shared so the screen can say so, and the
   per-year things that hang off them -- the transport allocations -- are what
   actually get carried. */

const (
	rolloverSections  = "sections"
	rolloverFees      = "fee_structure"
	rolloverTransport = "transport"
	rolloverHostel    = "hostel"
	rolloverTimetable = "timetable"
	rolloverSubjects  = "subjects"
)

// The order matters: the timetable is copied onto the new sections, so they
// must exist first within the same transaction.
var rolloverOrder = []string{
	rolloverSections, rolloverFees, rolloverTransport, rolloverHostel,
	rolloverTimetable, rolloverSubjects,
}

type rolloverRequest struct {
	TargetYearID string `json:"target_year_id"`
	Sections     bool   `json:"sections"`
	FeeStructure bool   `json:"fee_structure"`
	Transport    bool   `json:"transport"`
	Hostel       bool   `json:"hostel"`
	Timetable    bool   `json:"timetable"`
	Subjects     bool   `json:"subjects"`
}

func (q rolloverRequest) wants(item string) bool {
	switch item {
	case rolloverSections:
		return q.Sections
	case rolloverFees:
		return q.FeeStructure
	case rolloverTransport:
		return q.Transport
	case rolloverHostel:
		return q.Hostel
	case rolloverTimetable:
		return q.Timetable
	case rolloverSubjects:
		return q.Subjects
	}
	return false
}

type rolloverItem struct {
	Requested bool `json:"requested"`
	// Rows this run wrote (or, on a preview, would write).
	Copied int `json:"copied"`
	// Rows the source year holds, so the screen can show "12 of 12" or
	// "0 of 12 -- already rolled".
	InSource int `json:"in_source"`
	// A rollover_log row already exists: the item was carried in an earlier
	// run and this one left it alone.
	AlreadyRolled bool   `json:"already_rolled,omitempty"`
	RolledAt      string `json:"rolled_at,omitempty"`
	// Not per-year, so nothing to copy; both years already see it.
	Shared bool   `json:"shared,omitempty"`
	Note   string `json:"note,omitempty"`
}

type rolloverYear struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	StartsOn  string `json:"starts_on"`
	IsCurrent bool   `json:"is_current"`
}

type rolloverResult struct {
	Source  rolloverYear             `json:"source"`
	Target  rolloverYear             `json:"target"`
	Preview bool                     `json:"preview"`
	Items   map[string]*rolloverItem `json:"items"`
	// Where the children go: the step this endpoint does not do.
	PromotionPath string `json:"promotion_path"`
}

// The preview runs every copy and then rolls it back, so its counts are the
// real ones rather than a second query that could drift from the insert.
var errRolloverPreview = errors.New("rollover preview")

func (s *Server) previewYearRollover(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	on := func(k string) bool { v := q.Get(k); return v == "1" || v == "true" }
	s.runYearRollover(w, r, rolloverRequest{
		TargetYearID: q.Get("target_year_id"),
		Sections:     on("sections"),
		FeeStructure: on("fee_structure"),
		Transport:    on("transport"),
		Hostel:       on("hostel"),
		Timetable:    on("timetable"),
		Subjects:     on("subjects"),
	}, true)
}

func (s *Server) postYearRollover(w http.ResponseWriter, r *http.Request) {
	var req rolloverRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	s.runYearRollover(w, r, req, false)
}

func (s *Server) runYearRollover(w http.ResponseWriter, r *http.Request, req rolloverRequest, preview bool) {
	id := httpx.IdentityFrom(r.Context())
	sourceID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid academic year id")
		return
	}
	targetID, err := uuid.Parse(strings.TrimSpace(req.TargetYearID))
	if err != nil {
		httpx.BadRequest(w, r, "target_year_id must be a uuid — create the new year first, then roll into it")
		return
	}
	if targetID == sourceID {
		httpx.BadRequest(w, r, "a year cannot be rolled into itself")
		return
	}

	res := rolloverResult{
		Preview:       preview,
		Items:         map[string]*rolloverItem{},
		PromotionPath: "/lifecycle/promote",
	}
	ctx := r.Context()
	err = s.DB.InTenant(ctx, tenantScope(id), func(tx pgx.Tx) error {
		years := map[uuid.UUID]*rolloverYear{sourceID: &res.Source, targetID: &res.Target}
		rows, err := tx.Query(ctx, `
			SELECT id, name, to_char(starts_on,'YYYY-MM-DD'), is_current
			  FROM academic_years WHERE id = ANY($1)`, []uuid.UUID{sourceID, targetID})
		if err != nil {
			return err
		}
		found := 0
		for rows.Next() {
			var yid uuid.UUID
			var y rolloverYear
			if err := rows.Scan(&yid, &y.Name, &y.StartsOn, &y.IsCurrent); err != nil {
				rows.Close()
				return err
			}
			y.ID = yid.String()
			*years[yid] = y
			found++
		}
		rows.Close()
		if found != 2 {
			return refusal("both years must exist in this school. Create the new year under School setup first")
		}
		/* The current year is what the school is running on today. Copying
		   into it would double the sections children are already enrolled in,
		   which is the exact defect this endpoint exists to end. */
		if res.Target.IsCurrent {
			return refusal("the target is the current year. Roll into the year that has not started yet")
		}

		// Two clicks on the button, or two people at once, must not both copy.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`,
			targetID.String()+"rollover"); err != nil {
			return err
		}

		for _, item := range rolloverOrder {
			it := &rolloverItem{Requested: req.wants(item)}
			res.Items[item] = it
			if err := s.rolloverCount(ctx, tx, item, sourceID, targetID, it); err != nil {
				return err
			}
			if it.Shared || !it.Requested {
				continue
			}
			var rolledAt string
			switch err := tx.QueryRow(ctx, `
				SELECT to_char(run_at, 'YYYY-MM-DD HH24:MI')
				  FROM rollover_log WHERE target_year_id = $1 AND item = $2`,
				targetID, item).Scan(&rolledAt); {
			case err == nil:
				it.AlreadyRolled, it.RolledAt = true, rolledAt
				continue
			case errors.Is(err, pgx.ErrNoRows):
			default:
				return err
			}
			n, err := s.rolloverCopy(ctx, tx, item, id.InstitutionID, id.UserID, sourceID, targetID, res)
			if err != nil {
				return err
			}
			it.Copied = n
			if _, err := tx.Exec(ctx, `
				INSERT INTO rollover_log (institution_id, source_year_id, target_year_id, item, copied, run_by)
				VALUES ($1, $2, $3, $4, $5, $6)`,
				id.InstitutionID, sourceID, targetID, item, n, id.UserID); err != nil {
				return err
			}
		}
		if preview {
			return errRolloverPreview
		}
		return nil
	})
	if err != nil && !errors.Is(err, errRolloverPreview) {
		var ref refusal
		if errors.As(err, &ref) {
			httpx.BadRequest(w, r, string(ref))
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// rolloverCount fills in what the source year holds for an item, and marks
// the ones that are not per-year as shared.
func (s *Server) rolloverCount(ctx context.Context, tx pgx.Tx, item string, source, target uuid.UUID, it *rolloverItem) error {
	var sql string
	switch item {
	case rolloverSections:
		sql = `SELECT count(*) FROM sections WHERE academic_year_id = $1`
	case rolloverFees:
		sql = `SELECT count(*) FROM fee_structures WHERE academic_year_id = $1 AND is_active`
	case rolloverTransport:
		// Open allocations whose child will be there next year: the ones
		// that can be carried. A leaver's allocation ends with the year.
		sql = `SELECT count(*) FROM transport_allocations ta
		        WHERE ta.academic_year_id = $1 AND ta.valid_to IS NULL
		          AND EXISTS (SELECT 1 FROM enrollments e
		                       WHERE e.student_id = ta.student_id
		                         AND e.academic_year_id = $2 AND e.status = 'active')`
	case rolloverTimetable:
		sql = `SELECT count(*) FROM timetable_entries WHERE academic_year_id = $1`
	case rolloverHostel:
		it.Shared = true
		it.Note = "Hostel rooms and beds are not per year. A boarder keeps the bed until vacated, so there is nothing to copy."
		sql = `SELECT count(*) FROM hostel_allocations WHERE vacated_on IS NULL`
	case rolloverSubjects:
		it.Shared = true
		it.Note = "The subjects each class takes are not per year. Both years already read the same map."
		sql = `SELECT count(*) FROM class_subjects`
	default:
		return fmt.Errorf("unknown rollover item %q", item)
	}
	args := []any{source}
	if item == rolloverTransport {
		args = append(args, target)
	}
	return tx.QueryRow(ctx, sql, args...).Scan(&it.InSource)
}

// rolloverCopy carries one item and returns how many rows it wrote.
func (s *Server) rolloverCopy(ctx context.Context, tx pgx.Tx, item string, inst, user, source, target uuid.UUID, res rolloverResult) (int, error) {
	switch item {
	case rolloverSections:
		/* Same names and capacity, and the room, because the room is the
		   building's and does not change with the year. Not the class
		   teacher: that is next year's staffing decision, and carrying it
		   would quietly reappoint everybody. ON CONFLICT so a section the
		   office already made by hand is kept, not clobbered. */
		tag, err := tx.Exec(ctx, `
			INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id,
			                      name, capacity, room)
			SELECT institution_id, campus_id, class_id, $2, name, capacity, room
			  FROM sections WHERE academic_year_id = $1
			ON CONFLICT (class_id, academic_year_id, name) DO NOTHING`, source, target)
		if err != nil {
			return 0, err
		}
		return int(tag.RowsAffected()), nil

	case rolloverFees:
		return s.rolloverFeeStructures(ctx, tx, inst, user, source, target, res)

	case rolloverTransport:
		/* A child's stop is the same stop next year until the family moves.
		   The source row is closed on the last day of its year and a new one
		   opened on the first day of the next, because one open allocation
		   per child is the rule (transport_allocations_one_current) and the
		   old row has to survive for the fee raised against it. Only children
		   enrolled in the target year: promote first, then roll transport.

		   Two statements, not one CTE: the sub-statements of a WITH run
		   concurrently, so the insert could land before the update had
		   closed the old row and trip the one-open-row index. */
		if _, err := tx.Exec(ctx, `
			UPDATE transport_allocations ta
			   SET valid_to = (SELECT ends_on FROM academic_years WHERE id = $1)
			 WHERE ta.academic_year_id = $1 AND ta.valid_to IS NULL
			   AND EXISTS (SELECT 1 FROM enrollments e
			                WHERE e.student_id = ta.student_id
			                  AND e.academic_year_id = $2 AND e.status = 'active')`,
			source, target); err != nil {
			return 0, err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO transport_allocations
			    (institution_id, student_id, academic_year_id, route_id,
			     pickup_stop_id, drop_stop_id, valid_from)
			SELECT DISTINCT ON (ta.student_id)
			       $3, ta.student_id, $2, ta.route_id, ta.pickup_stop_id, ta.drop_stop_id,
			       (SELECT starts_on FROM academic_years WHERE id = $2)
			  FROM transport_allocations ta
			 WHERE ta.academic_year_id = $1
			   AND ta.valid_to = (SELECT ends_on FROM academic_years WHERE id = $1)
			   AND EXISTS (SELECT 1 FROM enrollments e
			                WHERE e.student_id = ta.student_id
			                  AND e.academic_year_id = $2 AND e.status = 'active')
			   AND NOT EXISTS (SELECT 1 FROM transport_allocations t2
			                    WHERE t2.student_id = ta.student_id
			                      AND t2.academic_year_id = $2)
			 ORDER BY ta.student_id, ta.valid_from DESC`, source, target, inst)
		if err != nil {
			return 0, err
		}
		return int(tag.RowsAffected()), nil

	case rolloverTimetable:
		/* The grid without the people. Which subject sits in which period
		   for 8-A is a template a school keeps for years; who teaches it is
		   decided afresh, so teacher_user_id is left empty for Teacher
		   Assignment to fill. Matched onto the new year's sections by class
		   and name, which is why sections are copied first. */
		tag, err := tx.Exec(ctx, `
			INSERT INTO timetable_entries
			    (institution_id, academic_year_id, section_id, period_id, weekday,
			     class_subject_id, teacher_user_id, room)
			SELECT te.institution_id, $2, ns.id, te.period_id, te.weekday,
			       te.class_subject_id, NULL, te.room
			  FROM timetable_entries te
			  JOIN sections os ON os.id = te.section_id
			  JOIN sections ns ON ns.class_id = os.class_id AND ns.name = os.name
			                  AND ns.academic_year_id = $2
			 WHERE te.academic_year_id = $1
			ON CONFLICT (section_id, weekday, period_id) DO NOTHING`, source, target)
		if err != nil {
			return 0, err
		}
		return int(tag.RowsAffected()), nil
	}
	return 0, nil
}

/*
rolloverFeeStructures copies each active structure of the source year into

	the target year as a fresh structure with one draft version.

	A draft, never active: the new year's fee is a decision the management
	takes, usually with a rise, and an active copy would let April's invoice
	run bill last year's amounts before anybody looked. The draft's lines come
	from the source's active version when there is one -- that is what parents
	were actually charged -- and from the live items otherwise. Due dates move
	forward by the gap between the two years' start dates, so "10 April" stays
	"10 April". A structure the office already made by hand under the same
	name and class is left alone.
*/
func (s *Server) rolloverFeeStructures(ctx context.Context, tx pgx.Tx, inst, user, source, target uuid.UUID, res rolloverResult) (int, error) {
	type structure struct {
		id, campus uuid.UUID
		class      *uuid.UUID
		name       string
		appliesTo  *string
		activeVer  *uuid.UUID
	}
	rows, err := tx.Query(ctx, `
		SELECT fs.id, fs.campus_id, fs.class_id, fs.name, fs.applies_to,
		       (SELECT v.id FROM fee_structure_versions v
		         WHERE v.fee_structure_id = fs.id AND v.status = 'active'
		         ORDER BY v.effective_from DESC LIMIT 1)
		  FROM fee_structures fs
		 WHERE fs.academic_year_id = $1 AND fs.is_active
		   AND NOT EXISTS (SELECT 1 FROM fee_structures t
		                    WHERE t.academic_year_id = $2 AND t.name = fs.name
		                      AND t.class_id IS NOT DISTINCT FROM fs.class_id)
		 ORDER BY fs.name`, source, target)
	if err != nil {
		return 0, err
	}
	var todo []structure
	for rows.Next() {
		var st structure
		if err := rows.Scan(&st.id, &st.campus, &st.class, &st.name, &st.appliesTo, &st.activeVer); err != nil {
			rows.Close()
			return 0, err
		}
		todo = append(todo, st)
	}
	rows.Close()

	// "10 April" next year, whatever the calendar gap between the two years.
	const shift = `($1::date + (due_on - (SELECT starts_on FROM academic_years WHERE id = $2)))`
	for _, st := range todo {
		var newID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO fee_structures (institution_id, campus_id, academic_year_id, class_id, name, applies_to, is_active)
			VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
			inst, st.campus, target, st.class, st.name, st.appliesTo).Scan(&newID); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO fee_structure_items (institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise, due_on)
			SELECT $3, $4, fee_head_id, instalment_no, amount_paise, `+shift+`
			  FROM fee_structure_items WHERE fee_structure_id = $5`,
			res.Target.StartsOn, source, inst, newID, st.id); err != nil {
			return 0, err
		}
		var verID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO fee_structure_versions
			    (institution_id, fee_structure_id, version_no, status, effective_from, revision_note, created_by)
			VALUES ($1, $2, 1, 'draft', $3::date, $4, $5) RETURNING id`,
			inst, newID, res.Target.StartsOn,
			"Rolled over from "+res.Source.Name+". Review the amounts and activate.", user).Scan(&verID); err != nil {
			return 0, err
		}
		if st.activeVer != nil {
			_, err = tx.Exec(ctx, `
				INSERT INTO fee_structure_version_items (institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
				SELECT $3, $4, fee_head_id, instalment_no, amount_paise, `+shift+`
				  FROM fee_structure_version_items WHERE version_id = $5`,
				res.Target.StartsOn, source, inst, verID, *st.activeVer)
		} else {
			_, err = tx.Exec(ctx, `
				INSERT INTO fee_structure_version_items (institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
				SELECT $3, $4, fee_head_id, instalment_no, amount_paise, `+shift+`
				  FROM fee_structure_items WHERE fee_structure_id = $5`,
				res.Target.StartsOn, source, inst, verID, st.id)
		}
		if err != nil {
			return 0, err
		}
	}
	return len(todo), nil
}
