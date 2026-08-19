package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* institution_admin.academics.master_timetable_generation

   The whole school's timetable, from generate to published.

   The machinery underneath is not new and is deliberately not rewritten. The
   solver (internal/timetable), the draft model (00050) and the publish path
   (timetable_ops.go) already exist and are good: generation produces a draft
   and never touches the live grid, publish is a separate deliberate act that
   replaces only the draft's own sections, refuses a draft with unmet
   requirements unless the reviewer acknowledges them, and returns 409 rather
   than dropping periods when the live grid has moved underneath. This file
   adds none of that and calls none of it into question.

   What was missing was the desk the whole thing sits on. The optimizer screen
   looks at one draft at a time; the person responsible for the master
   timetable has a different question, and it is a whole-school one:

     which sections have a timetable at all, and which are still empty
     which of them a draft currently speaks for, and how well
     what publishing this draft will overwrite, before they press it
     and -- the one thing that was simply not possible -- moving a single
     period by hand before publishing, because the vice principal knows
     something the solver does not and always will.

   The hand edit is the reason this file has writes. A draft that can only be
   accepted or regenerated is a draft that gets exported to a spreadsheet, and
   the spreadsheet becomes the timetable. So a period can be moved, staffed or
   removed here -- and every move is re-checked against the same constraints
   the solver honoured, on the server:

     a section cannot hold two subjects in one slot   (draft unique index)
     a teacher cannot be in two rooms at once         (draft unique index, and
                                                       the live grid outside
                                                       this draft's sections)
     a teacher's declared unavailable slots           (teacher_unavailability)
     a teacher's periods-a-day and periods-a-week cap (teacher_load_rules)
     a lesson cannot be placed in a break

   A UI that greys out the wrong cell is not a constraint. Each of those is
   checked here, in the transaction, and the refusal names which one bound.

   Scope and permission. Reads are academics.timetable.read, writes are
   academics.timetable.write -- the pair timetable_ops.go already uses, so
   nothing here offers a button its holder cannot press. Campus is resolved
   from internal/scope (campusReach, mdm.go) and a draft belonging to a campus
   the caller is not posted to is refused, because RLS bounds the institution
   and both campuses are inside it.

   Publishing is not re-implemented. The screen calls the existing
   POST /timetable-optimizer/drafts/{id}/publish, which is the only writer of
   the live grid and already carries the acknowledgement and the 409. This file
   only tells the reviewer, beforehand, exactly what that call will overwrite.
*/

// mountMasterTimetable hangs the whole-school timetable desk off the caller's
// router.
//
// A new prefix: /timetable, /timetable-admin, /timetable-optimizer and
// /timetable-cover are all routed already and chi panics on a repeated
// pattern.
//
// SPLICE POINT: call s.mountMasterTimetable(r) in api.go beside
// s.mountTimetableOps(r).
func (s *Server) mountMasterTimetable(r chi.Router) {
	ttRead := httpx.RequirePermission(rbac.TimetableRead)
	ttWrite := httpx.RequirePermission(rbac.TimetableWrite)

	r.Route("/master-timetable", func(r chi.Router) {
		r.Use(ttRead)
		r.Get("/overview", s.getMasterTimetableOverview)
		r.Get("/drafts/{id}/publish-preview", s.previewMasterPublish)

		// Hand-editing a draft. Never the live grid: the live grid changes in
		// exactly one place, and that is publish.
		r.With(ttWrite).Post("/drafts/{id}/entries", s.placeMasterDraftPeriod)
		r.With(ttWrite).Put("/drafts/{id}/entries/{entryID}", s.moveMasterDraftPeriod)
		r.With(ttWrite).Delete("/drafts/{id}/entries/{entryID}", s.clearMasterDraftPeriod)
	})
}

// =============================================================== the overview

// masterSectionRow is one section's standing: what it needs, what it has live,
// and what the draft in front of the reviewer would give it.
type masterSectionRow struct {
	SectionID   string  `json:"section_id"`
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	Level       int     `json:"level"`
	CampusID    *string `json:"campus_id,omitempty"`

	Required     int `json:"required_periods"`
	LivePeriods  int `json:"live_periods"`
	DraftPeriods int `json:"draft_periods"`
	// Unstaffed counts periods placed with nobody to teach them. A real state
	// — the school has allocated Sanskrit and not yet hired for it — and the
	// number a principal wants before publishing, not after.
	LiveUnstaffed  int `json:"live_unstaffed"`
	DraftUnstaffed int `json:"draft_unstaffed"`

	// The draft that currently speaks for this section, if any.
	DraftID   *string `json:"draft_id,omitempty"`
	DraftName *string `json:"draft_name,omitempty"`
}

/*
getMasterTimetableOverview is the whole school on one page.

	Every section of the year with its requirement, its live grid and whichever
	open draft covers it — which is the view the optimizer screen cannot give,
	because it is built around one draft and a school runs forty sections
	across several drafts generated on different afternoons.

	The three numbers that matter are stated per section rather than totalled:
	a school with 96% of its periods placed still has one Class 9 with no
	Chemistry, and a total hides exactly that.
*/
func (s *Server) getMasterTimetableOverview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var (
		yearID   uuid.UUID
		yearName string
		sections []masterSectionRow
		drafts   []draftRow
		periods  []gridPeriod
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		if yearID, err = resolveYear(r.Context(), tx, q.Get("academic_year_id")); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(),
			`SELECT name FROM academic_years WHERE id = $1`, yearID).Scan(&yearName); err != nil {
			return err
		}
		if periods, err = loadPeriods(r.Context(), tx); err != nil {
			return err
		}

		// Only drafts still open. A published one is history and a discarded
		// one is noise; both are on the optimizer screen if anybody wants
		// them, and neither is something this page asks you to act on.
		drows, err := tx.Query(r.Context(), `
			SELECT d.id::text, d.name, d.status, d.seed,
			       d.academic_year_id::text, ay.name,
			       d.periods_required, d.periods_placed, d.blocking_issues, d.warning_issues,
			       gu.full_name, to_char(d.generated_at,'YYYY-MM-DD"T"HH24:MI:SSOF:00'),
			       pu.full_name, to_char(d.published_at,'YYYY-MM-DD"T"HH24:MI:SSOF:00'),
			       (SELECT count(DISTINCT de.section_id)::int FROM timetable_draft_entries de
			         WHERE de.draft_id = d.id)
			  FROM timetable_drafts d
			  JOIN academic_years ay ON ay.id = d.academic_year_id
			  LEFT JOIN users gu ON gu.id = d.generated_by
			  LEFT JOIN users pu ON pu.id = d.published_by
			 WHERE d.academic_year_id = $1 AND d.status = 'draft'
			 ORDER BY d.generated_at DESC`, yearID)
		if err != nil {
			return err
		}
		drafts = []draftRow{}
		for drows.Next() {
			var v draftRow
			if err := drows.Scan(&v.ID, &v.Name, &v.Status, &v.Seed, &v.YearID, &v.YearName,
				&v.Required, &v.Placed, &v.Blocking, &v.Warnings,
				&v.GeneratedBy, &v.GeneratedAt, &v.PublishedBy, &v.PublishedAt,
				&v.Sections); err != nil {
				drows.Close()
				return err
			}
			drafts = append(drafts, v)
		}
		drows.Close()
		if err := drows.Err(); err != nil {
			return err
		}

		// One row per section. The draft columns name the most recently
		// generated open draft that covers the section, because that is the
		// one the reviewer is looking at; an older draft for the same section
		// is still listed above and can be opened deliberately.
		rows, err := tx.Query(r.Context(), `
			SELECT sec.id::text, sec.name, c.name, c.level, sec.campus_id::text,
			       COALESCE((SELECT sum(cs.periods_per_week)::int FROM class_subjects cs
			                  WHERE cs.class_id = sec.class_id), 0),
			       (SELECT count(*)::int FROM timetable_entries te
			         WHERE te.section_id = sec.id AND te.academic_year_id = $1),
			       (SELECT count(*)::int FROM timetable_entries te
			         WHERE te.section_id = sec.id AND te.academic_year_id = $1
			           AND te.teacher_user_id IS NULL),
			       lat.draft_id::text, lat.draft_name,
			       COALESCE(lat.placed, 0), COALESCE(lat.unstaffed, 0)
			  FROM sections sec
			  JOIN classes c ON c.id = sec.class_id
			  LEFT JOIN LATERAL (
			      SELECT d.id AS draft_id, d.name AS draft_name,
			             count(*)::int AS placed,
			             count(*) FILTER (WHERE de.teacher_user_id IS NULL)::int AS unstaffed
			        FROM timetable_draft_entries de
			        JOIN timetable_drafts d ON d.id = de.draft_id
			       WHERE de.section_id = sec.id AND d.status = 'draft'
			         AND d.academic_year_id = $1
			       GROUP BY d.id, d.name, d.generated_at
			       ORDER BY d.generated_at DESC
			       LIMIT 1) lat ON TRUE
			 WHERE sec.academic_year_id = $1
			 ORDER BY c.level, sec.name`, yearID)
		if err != nil {
			return err
		}
		defer rows.Close()
		sections = []masterSectionRow{}
		for rows.Next() {
			var v masterSectionRow
			if err := rows.Scan(&v.SectionID, &v.SectionName, &v.ClassName, &v.Level,
				&v.CampusID, &v.Required, &v.LivePeriods, &v.LiveUnstaffed,
				&v.DraftID, &v.DraftName, &v.DraftPeriods, &v.DraftUnstaffed); err != nil {
				return err
			}
			// A section on a campus this caller is not posted to is not their
			// business, and RLS will not say so — it is the same tenant.
			if !re.allows(parseOptionalUUID(v.CampusID)) && v.CampusID != nil {
				continue
			}
			sections = append(sections, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	teaching := 0
	for _, p := range periods {
		if !p.IsBreak {
			teaching++
		}
	}
	var required, live, draftPlaced, noGrid, unstaffed int
	for _, sec := range sections {
		required += sec.Required
		live += sec.LivePeriods
		draftPlaced += sec.DraftPeriods
		unstaffed += sec.LiveUnstaffed
		if sec.LivePeriods == 0 {
			noGrid++
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"academic_year_id": yearID.String(),
		"academic_year":    yearName,
		"weekdays":         teachingWeekdays,
		"periods":          periods,
		"sections":         sections,
		"open_drafts":      drafts,
		"may_edit":         id.Can(rbac.TimetableWrite),
		"cells_a_week":     teaching * len(teachingWeekdays),
		"summary": map[string]any{
			"sections":                   len(sections),
			"sections_without_timetable": noGrid,
			"required_periods":           required,
			"live_periods":               live,
			"live_unstaffed":             unstaffed,
			"draft_periods":              draftPlaced,
			"open_drafts":                len(drafts),
		},
	})
}

// ========================================================= the publish preview

// masterPublishImpact is one section publishing would touch.
type masterPublishImpact struct {
	SectionID   string `json:"section_id"`
	SectionName string `json:"section_name"`
	ClassName   string `json:"class_name"`
	LiveNow     int    `json:"live_periods_now"`
	FromDraft   int    `json:"draft_periods"`
	Unstaffed   int    `json:"draft_unstaffed"`
}

/*
previewMasterPublish is the account of what publishing will overwrite.

	Publish deletes every live period of the draft's sections in the draft's
	year and writes the draft's own in their place. That is the right
	behaviour and it is not changed here — but it is stated in a handler
	comment, and a reviewer pressing the button was being asked to take it on
	trust. This answers, before the fact:

	  - which sections lose their current grid, and how many periods each
	  - which sections keep theirs untouched, because the draft is silent
	    about them, which is the half people assume wrongly in both directions
	  - whether the draft would collide with a live period belonging to a
	    section it does NOT cover — a teacher double-booked across the boundary
	    of the run. Publish already refuses this with a 409 rather than
	    dropping periods; seeing it here means not discovering it at the
	    moment of publishing.
	  - what remains unmet, in the solver's own words, because Result.Issues
	    is the real output of a generator and the sentence names the binding
	    constraint.
*/
func (s *Server) previewMasterPublish(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	draftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	type clashRow struct {
		TeacherName string `json:"teacher_name"`
		Weekday     int    `json:"weekday"`
		PeriodName  string `json:"period_name"`
		DraftClass  string `json:"draft_section"`
		LiveClass   string `json:"live_section"`
	}
	var (
		status, name string
		blocking     int
		found        bool
		impact       []masterPublishImpact
		untouched    int
		clashes      []clashRow
		issues       []draftIssueRow
	)

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var yearID uuid.UUID
		var campus *uuid.UUID
		switch err := tx.QueryRow(r.Context(), `
			SELECT name, status, academic_year_id, campus_id, blocking_issues
			  FROM timetable_drafts WHERE id = $1`, draftID).
			Scan(&name, &status, &yearID, &campus, &blocking); {
		case errors.Is(err, pgx.ErrNoRows):
			return nil
		case err != nil:
			return err
		}
		found = true
		if !re.allows(campus) && campus != nil {
			return errMDMOutOfReach
		}

		rows, err := tx.Query(r.Context(), `
			SELECT sec.id::text, sec.name, c.name,
			       (SELECT count(*)::int FROM timetable_entries te
			         WHERE te.section_id = sec.id AND te.academic_year_id = $2),
			       count(*)::int,
			       count(*) FILTER (WHERE de.teacher_user_id IS NULL)::int
			  FROM timetable_draft_entries de
			  JOIN sections sec ON sec.id = de.section_id
			  JOIN classes c    ON c.id = sec.class_id
			 WHERE de.draft_id = $1
			 GROUP BY sec.id, sec.name, c.name, c.level
			 ORDER BY c.level, sec.name`, draftID, yearID)
		if err != nil {
			return err
		}
		impact = []masterPublishImpact{}
		for rows.Next() {
			var v masterPublishImpact
			if err := rows.Scan(&v.SectionID, &v.SectionName, &v.ClassName,
				&v.LiveNow, &v.FromDraft, &v.Unstaffed); err != nil {
				rows.Close()
				return err
			}
			impact = append(impact, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT count(DISTINCT te.section_id)::int
			  FROM timetable_entries te
			 WHERE te.academic_year_id = $2
			   AND te.section_id NOT IN (
			       SELECT section_id FROM timetable_draft_entries WHERE draft_id = $1)`,
			draftID, yearID).Scan(&untouched); err != nil {
			return err
		}

		// The teacher clash publish would hit: a draft period whose teacher is
		// already committed in that slot to a section this draft does not
		// speak for, and which therefore survives the replace.
		crows, err := tx.Query(r.Context(), `
			SELECT u.full_name, de.weekday, p.name, dsec.name, lsec.name
			  FROM timetable_draft_entries de
			  JOIN periods p     ON p.id = de.period_id
			  JOIN sections dsec ON dsec.id = de.section_id
			  JOIN users u       ON u.id = de.teacher_user_id
			  JOIN timetable_entries te
			    ON te.academic_year_id = $2
			   AND te.teacher_user_id = de.teacher_user_id
			   AND te.weekday = de.weekday AND te.period_id = de.period_id
			   AND te.section_id NOT IN (
			       SELECT section_id FROM timetable_draft_entries WHERE draft_id = $1)
			  JOIN sections lsec ON lsec.id = te.section_id
			 WHERE de.draft_id = $1 AND de.teacher_user_id IS NOT NULL
			 ORDER BY u.full_name, de.weekday, p.sequence`, draftID, yearID)
		if err != nil {
			return err
		}
		clashes = []clashRow{}
		for crows.Next() {
			var v clashRow
			if err := crows.Scan(&v.TeacherName, &v.Weekday, &v.PeriodName,
				&v.DraftClass, &v.LiveClass); err != nil {
				crows.Close()
				return err
			}
			clashes = append(clashes, v)
		}
		crows.Close()
		if err := crows.Err(); err != nil {
			return err
		}

		irows, err := tx.Query(r.Context(), `
			SELECT i.kind, i.severity, sec.name, sub.name, u.full_name,
			       i.periods_required, i.periods_placed, i.detail
			  FROM timetable_draft_issues i
			  LEFT JOIN sections sec ON sec.id = i.section_id
			  LEFT JOIN class_subjects cs ON cs.id = i.class_subject_id
			  LEFT JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN users u ON u.id = i.teacher_user_id
			 WHERE i.draft_id = $1
			 ORDER BY (i.severity = 'blocking') DESC, sec.name NULLS FIRST, sub.name`, draftID)
		if err != nil {
			return err
		}
		defer irows.Close()
		issues = []draftIssueRow{}
		for irows.Next() {
			var v draftIssueRow
			if err := irows.Scan(&v.Kind, &v.Severity, &v.SectionName, &v.SubjectName,
				&v.TeacherName, &v.Required, &v.Placed, &v.Detail); err != nil {
				return err
			}
			issues = append(issues, v)
		}
		return irows.Err()
	})
	switch {
	case errors.Is(err, errMDMOutOfReach):
		httpx.Denied(w, r, "this draft belongs to a campus you are not posted to")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	case !found:
		httpx.NotFound(w, r)
		return
	}

	replaced, writing := 0, 0
	for _, i := range impact {
		replaced += i.LiveNow
		writing += i.FromDraft
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"draft_id":        draftID.String(),
		"draft_name":      name,
		"status":          status,
		"publishable":     status == "draft",
		"sections":        impact,
		"issues":          issues,
		"blocking_issues": blocking,
		// Publishing with blocking issues is allowed, deliberately and on the
		// record: the existing publish endpoint requires acknowledge_unmet in
		// the body. The screen must ask before sending it.
		"requires_acknowledgement": blocking > 0,
		"periods_to_replace":       replaced,
		"periods_to_write":         writing,
		"sections_untouched":       untouched,
		"teacher_clashes":          clashes,
	})
}

// ============================================================ the hand edit

var (
	errDraftClosedHere   = errors.New("master timetable: draft is not open")
	errSlotIsBreak       = errors.New("master timetable: that period is a break")
	errSectionBusy       = errors.New("master timetable: the section is already taught then")
	errTeacherBusy       = errors.New("master timetable: the teacher is already teaching then")
	errTeacherUnavail    = errors.New("master timetable: the teacher is unavailable then")
	errTeacherDayCap     = errors.New("master timetable: that would exceed the teacher's daily cap")
	errTeacherWeekCap    = errors.New("master timetable: that would exceed the teacher's weekly cap")
	errSubjectNotOffered = errors.New("master timetable: that subject is not offered to this class")
)

// masterEntryRequest is one cell: place it here, staffed by them.
//
// Weekday and PeriodID are pointers on the move so that "leave it where it is
// and only change the teacher" is expressible without the screen having to
// resend the slot it did not touch — and, more to the point, without a blank
// field silently meaning Monday.
type masterEntryRequest struct {
	SectionID      string  `json:"section_id,omitempty"`
	ClassSubjectID string  `json:"class_subject_id,omitempty"`
	Weekday        *int    `json:"weekday,omitempty"`
	PeriodID       *string `json:"period_id,omitempty"`
	// TeacherID: absent leaves the teacher alone, an explicit empty string
	// unstaffs the period. An unstaffed period is a real state the draft model
	// already allows, so clearing one must be possible.
	TeacherID *string `json:"teacher_id,omitempty"`
	Room      *string `json:"room,omitempty"`
}

/*
placeMasterDraftPeriod adds a period to a draft by hand.

	The reviewer filling in what the generator could not place, usually
	immediately after reading the issue that says why. Same rules as the
	solver, checked here.
*/
func (s *Server) placeMasterDraftPeriod(w http.ResponseWriter, r *http.Request) {
	s.editMasterDraft(w, r, uuid.Nil)
}

// moveMasterDraftPeriod moves, restaffs or re-rooms an existing draft period.
func (s *Server) moveMasterDraftPeriod(w http.ResponseWriter, r *http.Request) {
	entryID, err := uuid.Parse(chi.URLParam(r, "entryID"))
	if err != nil {
		httpx.BadRequest(w, r, "entryID must be a uuid")
		return
	}
	s.editMasterDraft(w, r, entryID)
}

/*
editMasterDraft is the one path that changes a draft cell, whether the cell is
new or being moved.

	Written once rather than twice because the checks are the checks: a period
	arriving in a slot has to satisfy the same five constraints whether it came
	from nowhere or from Tuesday. Two copies of this would drift, and the copy
	that drifted would be the one that let a teacher be in two rooms at once.
*/
func (s *Server) editMasterDraft(w http.ResponseWriter, r *http.Request, entryID uuid.UUID) {
	id := httpx.IdentityFrom(r.Context())
	draftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req masterEntryRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var out draftEntryRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			status string
			yearID uuid.UUID
			campus *uuid.UUID
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT status, academic_year_id, campus_id
			  FROM timetable_drafts WHERE id = $1 FOR UPDATE`, draftID).
			Scan(&status, &yearID, &campus); err != nil {
			return err
		}
		if !re.allows(campus) && campus != nil {
			return errMDMOutOfReach
		}
		if status != "draft" {
			return errDraftClosedHere
		}

		// The cell as it stands, so an absent field means "unchanged" rather
		// than "cleared".
		var (
			sectionID, classSubjectID uuid.UUID
			weekday                   int
			periodID                  uuid.UUID
			teacher                   *uuid.UUID
			room                      *string
		)
		if entryID != uuid.Nil {
			if err := tx.QueryRow(r.Context(), `
				SELECT section_id, class_subject_id, weekday, period_id,
				       teacher_user_id, room
				  FROM timetable_draft_entries
				 WHERE id = $1 AND draft_id = $2 FOR UPDATE`, entryID, draftID).
				Scan(&sectionID, &classSubjectID, &weekday, &periodID, &teacher, &room); err != nil {
				return err
			}
		} else {
			if sectionID, err = uuid.Parse(strings.TrimSpace(req.SectionID)); err != nil {
				return refusal("section_id must be a uuid")
			}
			if classSubjectID, err = uuid.Parse(strings.TrimSpace(req.ClassSubjectID)); err != nil {
				return refusal("class_subject_id must be a uuid")
			}
			if req.Weekday == nil || req.PeriodID == nil {
				return refusal("a new period needs a weekday and a period")
			}
		}

		if req.Weekday != nil {
			weekday = *req.Weekday
		}
		if req.PeriodID != nil {
			if periodID, err = uuid.Parse(strings.TrimSpace(*req.PeriodID)); err != nil {
				return refusal("period_id must be a uuid")
			}
		}
		if req.TeacherID != nil {
			v := strings.TrimSpace(*req.TeacherID)
			if v == "" {
				teacher = nil
			} else {
				t, perr := uuid.Parse(v)
				if perr != nil {
					return refusal("teacher_id must be a uuid")
				}
				teacher = &t
			}
		}
		if req.Room != nil {
			room = mdmText(req.Room, room)
		}

		if !containsInt(teachingWeekdays, weekday) {
			return refusal("weekday must be 1 (Monday) to 6 (Saturday)")
		}

		// --- the constraints, in the order a reviewer would ask them -------

		// The subject has to belong to the section's class. Without this a
		// drag onto the wrong row silently teaches Class 6 the Class 9
		// syllabus, and the grid looks perfectly well-formed.
		var offered bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM class_subjects cs
			                JOIN sections sec ON sec.class_id = cs.class_id
			               WHERE cs.id = $1 AND sec.id = $2)`,
			classSubjectID, sectionID).Scan(&offered); err != nil {
			return err
		}
		if !offered {
			return errSubjectNotOffered
		}

		var isBreak bool
		if err := tx.QueryRow(r.Context(),
			`SELECT is_break FROM periods WHERE id = $1`, periodID).Scan(&isBreak); err != nil {
			return err
		}
		if isBreak {
			return errSlotIsBreak
		}

		// The section, in this draft. The unique index would catch it too;
		// checking first turns a constraint name into a sentence.
		var busy bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM timetable_draft_entries
			                WHERE draft_id = $1 AND section_id = $2
			                  AND weekday = $3 AND period_id = $4 AND id <> $5)`,
			draftID, sectionID, weekday, periodID, entryID).Scan(&busy); err != nil {
			return err
		}
		if busy {
			return errSectionBusy
		}

		if teacher != nil {
			// In this draft.
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM timetable_draft_entries
				                WHERE draft_id = $1 AND teacher_user_id = $2
				                  AND weekday = $3 AND period_id = $4 AND id <> $5)`,
				draftID, *teacher, weekday, periodID, entryID).Scan(&busy); err != nil {
				return err
			}
			if busy {
				return errTeacherBusy
			}
			// And in the live grid, for sections this draft does not speak
			// for. Exactly the committed load the solver was given, so a hand
			// edit cannot create the clash the run was careful to avoid.
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM timetable_entries te
				                WHERE te.academic_year_id = $1 AND te.teacher_user_id = $2
				                  AND te.weekday = $3 AND te.period_id = $4
				                  AND te.section_id NOT IN (
				                      SELECT section_id FROM timetable_draft_entries
				                       WHERE draft_id = $5))`,
				yearID, *teacher, weekday, periodID, draftID).Scan(&busy); err != nil {
				return err
			}
			if busy {
				return errTeacherBusy
			}

			var unavailable bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (SELECT 1 FROM teacher_unavailability
				                WHERE teacher_user_id = $1 AND weekday = $2
				                  AND (period_id IS NULL OR period_id = $3))`,
				*teacher, weekday, periodID).Scan(&unavailable); err != nil {
				return err
			}
			if unavailable {
				return errTeacherUnavail
			}

			// The caps. Absent rules mean "uncapped as far as the generator is
			// concerned", which is what 00050 documents, so the defaults here
			// are the same defaults loadOptimizerTeachers uses.
			var maxDay, maxWeek, onDay, onWeek int
			if err := tx.QueryRow(r.Context(), `
				SELECT COALESCE(lr.max_periods_per_day, 6),
				       COALESCE(lr.max_periods_per_week, 35)
				  FROM users u
				  LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
				 WHERE u.id = $1`, *teacher).Scan(&maxDay, &maxWeek); err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*) FILTER (WHERE weekday = $3)::int, count(*)::int
				  FROM (
				      SELECT de.weekday FROM timetable_draft_entries de
				       WHERE de.draft_id = $1 AND de.teacher_user_id = $2 AND de.id <> $4
				      UNION ALL
				      SELECT te.weekday FROM timetable_entries te
				       WHERE te.academic_year_id = $5 AND te.teacher_user_id = $2
				         AND te.section_id NOT IN (
				             SELECT section_id FROM timetable_draft_entries WHERE draft_id = $1)
				  ) load`,
				draftID, *teacher, weekday, entryID, yearID).Scan(&onDay, &onWeek); err != nil {
				return err
			}
			if onDay+1 > maxDay {
				return errTeacherDayCap
			}
			if onWeek+1 > maxWeek {
				return errTeacherWeekCap
			}
		}

		// --- the write -----------------------------------------------------

		if entryID == uuid.Nil {
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO timetable_draft_entries (institution_id, draft_id, section_id,
				        period_id, weekday, class_subject_id, teacher_user_id, room)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
				id.InstitutionID, draftID, sectionID, periodID, weekday,
				classSubjectID, teacher, room).Scan(&entryID); err != nil {
				return masterClashError(err)
			}
		} else {
			if _, err := tx.Exec(r.Context(), `
				UPDATE timetable_draft_entries
				   SET weekday = $2, period_id = $3, teacher_user_id = $4, room = $5
				 WHERE id = $1`, entryID, weekday, periodID, teacher, room); err != nil {
				return masterClashError(err)
			}
		}

		if err := markDraftHandEdited(r.Context(), tx, draftID, id.UserID); err != nil {
			return err
		}
		out, err = readDraftEntry(r.Context(), tx, entryID)
		return err
	})
	if !masterRespondError(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/*
clearMasterDraftPeriod removes a period from a draft.

	Emptying a cell needs no clash check — nothing can conflict with an absence
	— but it does need the draft to still be open, and it is still a hand edit
	the reviewer should see recorded. A published draft is history; deleting a
	period out of one would rewrite what was published without touching the
	live grid, which is the most confusing possible outcome.
*/
func (s *Server) clearMasterDraftPeriod(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	draftID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	entryID, err := uuid.Parse(chi.URLParam(r, "entryID"))
	if err != nil {
		httpx.BadRequest(w, r, "entryID must be a uuid")
		return
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var campus *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT status, campus_id FROM timetable_drafts WHERE id = $1 FOR UPDATE`,
			draftID).Scan(&status, &campus); err != nil {
			return err
		}
		if !re.allows(campus) && campus != nil {
			return errMDMOutOfReach
		}
		if status != "draft" {
			return errDraftClosedHere
		}
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM timetable_draft_entries WHERE id = $1 AND draft_id = $2`,
			entryID, draftID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return markDraftHandEdited(r.Context(), tx, draftID, id.UserID)
	})
	if !masterRespondError(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": true})
}

// ================================================================== helpers

/*
markDraftHandEdited records that a human moved something.

	Deliberately does NOT touch periods_placed, blocking_issues or the rest of
	the summary. 00050 documents those as describing the run that produced the
	draft — "a later edit to the requirements does not retroactively change
	what this run managed" — and the same holds for an edit to the grid. The
	reviewer needs both facts: what the generator achieved, and that the grid
	in front of them is no longer only that.
*/
func markDraftHandEdited(ctx context.Context, tx pgx.Tx, draftID, userID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		UPDATE timetable_drafts
		   SET hand_edits = hand_edits + 1, last_edited_at = now(), last_edited_by = $2
		 WHERE id = $1`, draftID, userID)
	return err
}

func readDraftEntry(ctx context.Context, tx pgx.Tx, entryID uuid.UUID) (draftEntryRow, error) {
	var v draftEntryRow
	err := tx.QueryRow(ctx, `
		SELECT de.id::text, de.section_id::text, sec.name, c.name,
		       de.period_id::text, p.name, de.weekday, sub.name, sub.code,
		       de.teacher_user_id::text, u.full_name, de.room
		  FROM timetable_draft_entries de
		  JOIN sections sec ON sec.id = de.section_id
		  JOIN classes c ON c.id = sec.class_id
		  JOIN periods p ON p.id = de.period_id
		  JOIN class_subjects cs ON cs.id = de.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN users u ON u.id = de.teacher_user_id
		 WHERE de.id = $1`, entryID).Scan(
		&v.ID, &v.SectionID, &v.SectionName, &v.ClassName, &v.PeriodID, &v.PeriodName,
		&v.Weekday, &v.SubjectName, &v.SubjectCode, &v.TeacherID, &v.TeacherName, &v.Room)
	return v, err
}

// The clash checks above exclude `id <> entryID` so that moving a period does
// not collide with itself. On a new period entryID is the zero uuid, which
// matches no row, so the new one is checked against every existing one.

func containsInt(list []int, want int) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// masterClashError translates the two draft unique indexes, which are the last
// line of defence behind the checks above and would otherwise surface as a 500
// naming an index.
func masterClashError(err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "23505" {
		return err
	}
	if strings.Contains(pg.ConstraintName, "teacher_slot") {
		return errTeacherBusy
	}
	return errSectionBusy
}

func masterRespondError(w http.ResponseWriter, r *http.Request, err error) bool {
	var ref refusal
	switch {
	case err == nil:
		return true
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errMDMOutOfReach):
		httpx.Denied(w, r, "this draft belongs to a campus you are not posted to")
	case errors.Is(err, errDraftClosedHere):
		httpx.Error(w, r, http.StatusConflict, "draft_closed",
			"this draft has been published or discarded and can no longer be edited")
	case errors.Is(err, errSectionBusy):
		httpx.Error(w, r, http.StatusConflict, "section_busy",
			"that class is already being taught something else in that period")
	case errors.Is(err, errTeacherBusy):
		httpx.Error(w, r, http.StatusConflict, "teacher_busy",
			"that teacher is already teaching in that period, here or in a section this draft does not cover")
	case errors.Is(err, errTeacherUnavail):
		httpx.Error(w, r, http.StatusConflict, "teacher_unavailable",
			"that teacher is marked unavailable in that slot every week")
	case errors.Is(err, errTeacherDayCap):
		httpx.Error(w, r, http.StatusConflict, "teacher_day_cap",
			"that would put the teacher over their maximum periods for the day")
	case errors.Is(err, errTeacherWeekCap):
		httpx.Error(w, r, http.StatusConflict, "teacher_week_cap",
			"that would put the teacher over their maximum periods for the week")
	case errors.Is(err, errSlotIsBreak):
		httpx.BadRequest(w, r, "that period is a break, not a teaching period")
	case errors.Is(err, errSubjectNotOffered):
		httpx.BadRequest(w, r, "that subject is not offered to this class")
	case errors.As(err, &ref):
		httpx.BadRequest(w, r, string(ref))
	default:
		httpx.Internal(w, r, err)
	}
	return false
}
