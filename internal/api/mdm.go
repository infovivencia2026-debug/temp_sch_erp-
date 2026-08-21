package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* institution_admin.mid_day_meal.mid_day_meal_register

   The daily cooked-meal register: the record a school keeps at the kitchen
   door and an inspector asks for by name.

   This is the half that was missing. mdm_registers has existed since 00008 and
   the monthly PM POSHAN utilisation return (getMDMUtilisation, admin_ops.go)
   has aggregated it correctly since 00053 -- meals against enrolment, grain
   against the per-child norm, cooking cost against the allotment, the closing
   balance -- over a table that nothing in the product ever wrote. Every school
   opening that return saw a month of zeroes.

   So this file is written to satisfy that aggregation rather than to invent a
   second shape for the same facts. The return reads on_date, enrolled,
   present, meals_served, rice_kg, cost_paise and menu off the header row, and
   those columns keep exactly the meanings it already gives them. Nothing here
   summarises: the register records the day, the return does the arithmetic,
   and there is one copy of each number.

   What the register adds beyond the countable half, because a register is a
   legal record and not a spreadsheet:

     the cook on duty      an inspector asks who cooked. A name, not an
                           employee id -- the cook-cum-helper is usually not on
                           the staff roll.
     why no meal was served a zero-meal day with no reason is the row an
                           inspection stops on. Closing one is refused.
     closing               a day, once closed, is the figure the school has
                           filed. It stops being freely editable.
     the amendment trail   and if a closed day has to be corrected -- and it
                           does, because a headcount gets transposed -- the
                           correction is a reopen with a reason, a new set of
                           figures, and both versions kept. An overwritten
                           register is one nobody can defend in August.

   Scope. Every read and write resolves the caller's campuses first
   (resolveScope) and refuses a campus the caller is not posted to. RLS bounds
   the institution and would happily let the Ramanthapur clerk file
   Kukatpally's register, because both rows belong to the same tenant.

   Permissions are the ones the four existing /admin-ops/mdm endpoints already
   use, so nothing here offers a button its holder cannot press: admin.reports.read
   to see the register, institution.write to write it. No new permission.
*/

// mountMDM registers the daily register under /mdm-register.
//
// A new prefix on purpose: /admin-ops already carries the monthly return and
// chi panics when a second Route claims a pattern that already has one. The
// two are the same subject seen from opposite ends -- this one is written
// every afternoon by the clerk, that one is read once a month by the head
// teacher -- and they share the table rather than an endpoint.
//
// SPLICE POINT: call s.mountMDM(r) in api.go beside s.mountAdminOps(r).
func (s *Server) mountMDM(r chi.Router) {
	regRead := httpx.RequirePermission(rbac.ReportsRead)
	regWrite := httpx.RequirePermission(rbac.InstitutionWrite)

	r.Route("/mdm-register", func(r chi.Router) {
		r.Use(regRead)
		r.Get("/days", s.listMDMRegisterDays)
		r.Get("/days/{id}", s.getMDMRegisterDay)
		r.Get("/context", s.getMDMRegisterContext)

		r.With(regWrite).Post("/days", s.saveMDMRegisterDay)
		r.With(regWrite).Post("/days/{id}/close", s.closeMDMRegisterDay)
		r.With(regWrite).Post("/days/{id}/reopen", s.reopenMDMRegisterDay)
	})
}

// ================================================================ the scope

/*
campusReach is the caller's campus boundary, as resolved by internal/scope.

	Shared with master_timetable.go, which asks the same question of the same
	person: a vice principal posted to one campus generates that campus's
	timetable and files that campus's meal register, and neither screen may
	quietly widen to the other site.

	AllCampuses is what a role assignment with no campus means, and it is the
	normal case for a head teacher and for every single-campus school. A clerk
	posted to one campus gets that campus and the institution-wide row only if
	they are institution-wide themselves: a NULL campus_id on a register means
	"the whole school", and a person who may write for one campus may not sign
	for all of them.
*/
type campusReach struct {
	All       bool
	CampusIDs []uuid.UUID
}

func (s *Server) campusReach(r *http.Request) (*campusReach, error) {
	sc, err := s.resolveScope(r)
	if err != nil {
		return nil, err
	}
	return &campusReach{All: sc.AllCampuses || sc.PlatformAdmin, CampusIDs: sc.CampusIDs}, nil
}

// allows reports whether the caller may see or write this register's campus.
// A nil campus is the institution-wide register and needs institution-wide
// reach.
func (re *campusReach) allows(campus *uuid.UUID) bool {
	if re.All {
		return true
	}
	if campus == nil {
		return false
	}
	for _, c := range re.CampusIDs {
		if c == *campus {
			return true
		}
	}
	return false
}

// filter is the SQL predicate for a listing, binding at $n.
//
// An empty reach yields FALSE rather than an omitted clause, for the reason
// internal/scope states: "this person is posted nowhere" must mean no rows,
// not every row.
func (re *campusReach) filter(column string, argN int) (string, []any) {
	if re.All {
		return "TRUE", nil
	}
	if len(re.CampusIDs) == 0 {
		return "FALSE", nil
	}
	return fmt.Sprintf("%s = ANY($%d)", column, argN), []any{re.CampusIDs}
}

// ================================================================ the shapes

// mdmRegisterRow is one day of the register, as the list and the day view both
// return it. Rice is kilograms and cost is paise, in separate fields all the
// way down: a schema that put grain in a money column would eventually report
// 100 g as a rupee value.
type mdmRegisterRow struct {
	ID           string            `json:"id"`
	Date         string            `json:"on_date"`
	CampusID     *string           `json:"campus_id,omitempty"`
	CampusName   *string           `json:"campus_name,omitempty"`
	Enrolled     int               `json:"enrolled"`
	Present      int               `json:"present"`
	MealsServed  int               `json:"meals_served"`
	RiceKg       *float64          `json:"rice_kg,omitempty"`
	CostPaise    int64             `json:"cost_paise"`
	Menu         *string           `json:"menu,omitempty"`
	CookName     *string           `json:"cook_name,omitempty"`
	NotServed    *string           `json:"not_served_reason,omitempty"`
	Status       string            `json:"status"`
	ClosedAt     *string           `json:"closed_at,omitempty"`
	ClosedBy     *string           `json:"closed_by,omitempty"`
	RecordedBy   *string           `json:"recorded_by,omitempty"`
	Lines        int               `json:"line_count"`
	Amendments   int               `json:"amendment_count"`
	Issues       []string          `json:"issues"`
	LinesDetail  []mdmLineRow      `json:"lines,omitempty"`
	AmendmentLog []mdmAmendmentRow `json:"amendments,omitempty"`
}

type mdmLineRow struct {
	SectionID   string `json:"section_id"`
	SectionName string `json:"section_name"`
	ClassName   string `json:"class_name"`
	Present     int    `json:"present"`
	MealsServed int    `json:"meals_served"`
}

type mdmAmendmentRow struct {
	Action string  `json:"action"`
	Reason string  `json:"reason"`
	By     *string `json:"amended_by,omitempty"`
	At     string  `json:"amended_at"`
	Before *string `json:"before,omitempty"`
	After  *string `json:"after,omitempty"`
}

/*
mdmDayIssues is the same arithmetic the utilisation return runs, applied to one
day at the moment it is entered.

	Deliberately the same four checks as getMDMUtilisation rather than a
	second, subtly different set: the point of showing them here is that the
	clerk sees on Tuesday what the head teacher would otherwise discover on the
	first of next month, and two screens disagreeing about whether a day is
	sound is worse than neither checking.
*/
func mdmDayIssues(row *mdmRegisterRow) []string {
	out := []string{}
	if row.MealsServed > row.Present && row.Present > 0 {
		out = append(out, "more meals served than children present")
	}
	if row.MealsServed > row.Enrolled && row.Enrolled > 0 {
		out = append(out, "more meals served than children on roll")
	}
	if row.MealsServed > 0 && row.CostPaise == 0 {
		out = append(out, "meals served with no cooking cost recorded")
	}
	if row.MealsServed > 0 && (row.RiceKg == nil || *row.RiceKg == 0) {
		out = append(out, "meals served with no foodgrain recorded")
	}
	if row.MealsServed == 0 && (row.NotServed == nil || strings.TrimSpace(*row.NotServed) == "") {
		out = append(out, "no meal served and no reason recorded")
	}
	return out
}

// =============================================================== 1. reading

const mdmRegisterSelect = `
	SELECT m.id::text, to_char(m.on_date,'YYYY-MM-DD'), m.campus_id::text, cp.name,
	       m.enrolled, m.present, m.meals_served, m.rice_kg, m.cost_paise, m.menu,
	       m.cook_name, m.not_served_reason, m.status,
	       to_char(m.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z', cu.full_name, ru.full_name,
	       (SELECT count(*)::int FROM mdm_register_lines l WHERE l.register_id = m.id),
	       (SELECT count(*)::int FROM mdm_register_amendments a WHERE a.register_id = m.id)
	  FROM mdm_registers m
	  LEFT JOIN campuses cp ON cp.id = m.campus_id
	  LEFT JOIN users cu    ON cu.id = m.closed_by
	  LEFT JOIN users ru    ON ru.id = m.recorded_by`

func scanMDMRegister(rows pgx.Rows) (mdmRegisterRow, error) {
	var v mdmRegisterRow
	err := rows.Scan(&v.ID, &v.Date, &v.CampusID, &v.CampusName,
		&v.Enrolled, &v.Present, &v.MealsServed, &v.RiceKg, &v.CostPaise, &v.Menu,
		&v.CookName, &v.NotServed, &v.Status, &v.ClosedAt, &v.ClosedBy, &v.RecordedBy,
		&v.Lines, &v.Amendments)
	v.Issues = mdmDayIssues(&v)
	return v, err
}

/*
listMDMRegisterDays returns a month of the register, newest day first.

	Defaults to the current month rather than to everything: the register is
	read one month at a time because that is the unit the return is filed in,
	and an unbounded list of every day a school has ever cooked is a page
	nobody scrolls to the bottom of.
*/
func (s *Server) listMDMRegisterDays(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	first, last, merr := aoMonth(r.URL.Query().Get("month"))
	if merr != nil {
		httpx.BadRequest(w, r, merr.Error())
		return
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := re.filter("m.campus_id", 3)
	all := append([]any{first, last}, args...)

	items := []mdmRegisterRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), mdmRegisterSelect+`
			 WHERE m.on_date BETWEEN $1 AND $2 AND (`+pred+`)
			 ORDER BY m.on_date DESC`, all...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			v, err := scanMDMRegister(rows)
			if err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The month's own totals, so the clerk can see the figure the return will
	// carry without opening the return. Summed from the rows already loaded —
	// a second query over the same days is a second chance to disagree.
	var meals, present, enrolled, served int
	var rice float64
	var cost int64
	for _, d := range items {
		meals += d.MealsServed
		present += d.Present
		enrolled += d.Enrolled
		cost += d.CostPaise
		if d.RiceKg != nil {
			rice += *d.RiceKg
		}
		if d.MealsServed > 0 {
			served++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"month": first.Format("2006-01"),
		"days":  items,
		"totals": map[string]any{
			"days_recorded":      len(items),
			"days_meals_served":  served,
			"meals_served":       meals,
			"present":            present,
			"enrolled":           enrolled,
			"rice_kg":            rice,
			"cooking_cost_paise": cost,
		},
	})
}

// getMDMRegisterDay returns one day with its section lines and, if it has been
// corrected, the full amendment trail.
func (s *Server) getMDMRegisterDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	dayID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var (
		row   mdmRegisterRow
		found bool
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), mdmRegisterSelect+` WHERE m.id = $1`, dayID)
		if err != nil {
			return err
		}
		if rows.Next() {
			if row, err = scanMDMRegister(rows); err != nil {
				rows.Close()
				return err
			}
			found = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if !found {
			return nil
		}
		if !re.allows(parseOptionalUUID(row.CampusID)) {
			return errMDMOutOfReach
		}

		if row.LinesDetail, err = loadMDMLines(r.Context(), tx, dayID); err != nil {
			return err
		}

		arows, err := tx.Query(r.Context(), `
			SELECT a.action, a.reason, u.full_name,
			       to_char(a.amended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       a.before::text, a.after::text
			  FROM mdm_register_amendments a
			  LEFT JOIN users u ON u.id = a.amended_by
			 WHERE a.register_id = $1
			 ORDER BY a.amended_at DESC`, dayID)
		if err != nil {
			return err
		}
		defer arows.Close()
		row.AmendmentLog = []mdmAmendmentRow{}
		for arows.Next() {
			var a mdmAmendmentRow
			if err := arows.Scan(&a.Action, &a.Reason, &a.By, &a.At, &a.Before, &a.After); err != nil {
				return err
			}
			row.AmendmentLog = append(row.AmendmentLog, a)
		}
		return arows.Err()
	})
	switch {
	case errors.Is(err, errMDMOutOfReach):
		httpx.Denied(w, r, "this register belongs to a campus you are not posted to")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	case !found:
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, row)
}

func loadMDMLines(ctx context.Context, tx pgx.Tx, dayID uuid.UUID) ([]mdmLineRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT l.section_id::text, sec.name, c.name, l.present, l.meals_served
		  FROM mdm_register_lines l
		  JOIN sections sec ON sec.id = l.section_id
		  JOIN classes c    ON c.id = sec.class_id
		 WHERE l.register_id = $1
		 ORDER BY c.level, sec.name`, dayID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []mdmLineRow{}
	for rows.Next() {
		var v mdmLineRow
		if err := rows.Scan(&v.SectionID, &v.SectionName, &v.ClassName,
			&v.Present, &v.MealsServed); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

/*
getMDMRegisterContext is what the entry form needs before it can be filled: the
campuses this caller may file for, and the sections they may break the day
down by.

	Served rather than left to the screen to assemble from three other
	endpoints, because the campus list here is the authoritative one — it is
	the caller's actual reach, not every campus the institution has — and a
	form built from a wider list offers a choice the save will refuse.
*/
func (s *Server) getMDMRegisterContext(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := re.filter("cp.id", 1)

	type campusOpt struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	type sectionOpt struct {
		ID        string  `json:"id"`
		Name      string  `json:"name"`
		ClassName string  `json:"class_name"`
		CampusID  *string `json:"campus_id,omitempty"`
		Strength  int     `json:"strength"`
	}
	campuses := []campusOpt{}
	sections := []sectionOpt{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(),
			`SELECT id::text, name FROM campuses cp WHERE `+pred+` ORDER BY name`, args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var c campusOpt
			if err := rows.Scan(&c.ID, &c.Name); err != nil {
				rows.Close()
				return err
			}
			campuses = append(campuses, c)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// The current year's sections, with the roll each one carries. The
		// strength is what makes the per-section entry quick: a clerk types
		// the absentees, not the whole roll, and a line that claims more meals
		// than children is refused by the table.
		srows, err := tx.Query(r.Context(), `
			SELECT sec.id::text, sec.name, c.name, sec.campus_id::text,
			       (SELECT count(*)::int FROM enrollments e
			         WHERE e.section_id = sec.id AND e.status = 'active')
			  FROM sections sec
			  JOIN classes c        ON c.id = sec.class_id
			  JOIN academic_years y ON y.id = sec.academic_year_id
			 WHERE y.is_current
			 ORDER BY c.level, sec.name`)
		if err != nil {
			return err
		}
		defer srows.Close()
		for srows.Next() {
			var v sectionOpt
			if err := srows.Scan(&v.ID, &v.Name, &v.ClassName, &v.CampusID, &v.Strength); err != nil {
				return err
			}
			if !re.allows(parseOptionalUUID(v.CampusID)) && v.CampusID != nil {
				continue
			}
			sections = append(sections, v)
		}
		return srows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"campuses": campuses,
		"sections": sections,
		// Whether this caller may file the institution-wide register at all.
		// The screen uses it to decide if "all campuses" is even an option;
		// the save checks it again regardless.
		"may_file_institution_wide": re.All,
	})
}

// =============================================================== 2. writing

var (
	errMDMOutOfReach = errors.New("mdm: campus outside the caller's reach")
	errMDMClosed     = errors.New("mdm: day is closed")
	errMDMNotClosed  = errors.New("mdm: day is not closed")
	errMDMNoReason   = errors.New("mdm: no meal served and no reason given")
	errMDMLineSum    = errors.New("mdm: lines do not add up to the day")
)

/*
mdmDayRequest is one day as the form submits it.

	Every countable field is a pointer. An empty numeric box is not zero — a
	clerk who has not yet counted the rice has not told us there was none —
	and a request that turned a blank into 0 would file a day claiming meals
	were cooked without foodgrain. Absent means absent: on a new day it is
	refused, and on an existing one it leaves the stored figure alone.
*/
type mdmDayRequest struct {
	ID       string `json:"id,omitempty"`
	Date     string `json:"on_date"`
	CampusID string `json:"campus_id,omitempty"`

	Enrolled    *int     `json:"enrolled"`
	Present     *int     `json:"present"`
	MealsServed *int     `json:"meals_served"`
	RiceKg      *float64 `json:"rice_kg"`
	CostPaise   *int64   `json:"cost_paise"`

	Menu      *string `json:"menu"`
	CookName  *string `json:"cook_name"`
	NotServed *string `json:"not_served_reason"`

	// Lines are the per-section breakdown. Absent means "not broken down" and
	// leaves any stored lines alone; an explicit empty array clears them.
	Lines *[]mdmLineInput `json:"lines,omitempty"`

	// Reason is required when the day being written has already been amended
	// once — see saveMDMRegisterDay.
	Reason string `json:"reason,omitempty"`
}

type mdmLineInput struct {
	SectionID   string `json:"section_id"`
	Present     *int   `json:"present"`
	MealsServed *int   `json:"meals_served"`
}

/*
saveMDMRegisterDay creates or updates one day of the register.

	Upsert on (institution, campus, date), which is the key the new index in
	00087 finally enforces. It could not before: the UNIQUE in 00008 named a
	nullable campus_id bare, so for a single-campus school — most schools —
	the same day could be, and would eventually be, entered twice, and the
	utilisation return summed both.

	A closed day is not editable here. Correcting one is reopen-with-a-reason
	followed by a save, and the save then records what the day said before
	against what it says now. That is the only path, and it is why the register
	is worth anything as a record.

	When lines are supplied the header is recomputed from them. The header is
	the figure of record — the monthly return reads it and knows nothing about
	the lines — so letting the two be typed independently would guarantee they
	eventually disagree.
*/
func (s *Server) saveMDMRegisterDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req mdmDayRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	onDate, err := time.Parse("2006-01-02", strings.TrimSpace(req.Date))
	if err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	// A register is written on the day or shortly after. A future day has not
	// happened yet and is always a typo in the date box.
	if onDate.After(nowInIndia().AddDate(0, 0, 1)) {
		httpx.BadRequest(w, r, "a register cannot be written for a future date")
		return
	}
	var campus *uuid.UUID
	if v := strings.TrimSpace(req.CampusID); v != "" {
		c, perr := uuid.Parse(v)
		if perr != nil {
			httpx.BadRequest(w, r, "campus_id must be a uuid")
			return
		}
		campus = &c
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !re.allows(campus) {
		httpx.Denied(w, r, "you are not posted to that campus")
		return
	}

	var out mdmRegisterRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The existing day, locked, so two clerks saving the same afternoon
		// cannot interleave a read and a write.
		var (
			existing                       *uuid.UUID
			status                         string
			amendments                     int
			curEnrol, curPresent, curMeals int
			curRice                        *float64
			curCost                        int64
			curMenu, curCook, curNotServed *string
		)
		row := tx.QueryRow(r.Context(), `
			SELECT id, status, enrolled, present, meals_served, rice_kg, cost_paise,
			       menu, cook_name, not_served_reason,
			       (SELECT count(*)::int FROM mdm_register_amendments a WHERE a.register_id = m.id)
			  FROM mdm_registers m
			 WHERE on_date = $1
			   AND COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid)
			     = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
			 FOR UPDATE`, onDate, campus)
		var found uuid.UUID
		switch err := row.Scan(&found, &status, &curEnrol, &curPresent, &curMeals,
			&curRice, &curCost, &curMenu, &curCook, &curNotServed, &amendments); {
		case errors.Is(err, pgx.ErrNoRows):
		case err != nil:
			return err
		default:
			existing = &found
		}

		if existing != nil && status == "closed" {
			return errMDMClosed
		}
		// A day that has been reopened is being corrected, and a correction
		// without a reason is the one nobody can explain later.
		amending := existing != nil && amendments > 0
		if amending && strings.TrimSpace(req.Reason) == "" {
			return errMDMNoReason
		}

		// Resolve the figures: supplied wins, absent keeps what is stored, and
		// absent on a brand-new day is a refusal rather than a zero.
		enrolled, err := mdmInt(req.Enrolled, curEnrol, existing != nil, "enrolled")
		if err != nil {
			return err
		}
		present, err := mdmInt(req.Present, curPresent, existing != nil, "present")
		if err != nil {
			return err
		}
		meals, err := mdmInt(req.MealsServed, curMeals, existing != nil, "meals_served")
		if err != nil {
			return err
		}
		cost := curCost
		if req.CostPaise != nil {
			cost = *req.CostPaise
		}
		rice := curRice
		if req.RiceKg != nil {
			rice = req.RiceKg
		}
		menu := mdmText(req.Menu, curMenu)
		cook := mdmText(req.CookName, curCook)
		notServed := mdmText(req.NotServed, curNotServed)

		if enrolled < 0 || present < 0 || meals < 0 || cost < 0 {
			return refusal("counts and cost cannot be negative")
		}
		if rice != nil && *rice < 0 {
			return refusal("foodgrain cannot be negative")
		}

		// Lines, if given, decide the header.
		var lines []mdmLineInput
		if req.Lines != nil {
			lines = *req.Lines
			sumPresent, sumMeals := 0, 0
			seen := map[string]bool{}
			for _, l := range lines {
				if _, perr := uuid.Parse(strings.TrimSpace(l.SectionID)); perr != nil {
					return refusal("every line needs a section")
				}
				if seen[l.SectionID] {
					return refusal("the same section appears twice")
				}
				seen[l.SectionID] = true
				if l.Present == nil || l.MealsServed == nil {
					return refusal("every line needs both a headcount and a meal count")
				}
				if *l.Present < 0 || *l.MealsServed < 0 {
					return refusal("a line cannot be negative")
				}
				if *l.MealsServed > *l.Present {
					return errMDMLineSum
				}
				sumPresent += *l.Present
				sumMeals += *l.MealsServed
			}
			if len(lines) > 0 {
				present, meals = sumPresent, sumMeals
			}
		} else if existing != nil {
			// No lines in the request, but the day may already be broken down.
			// The header is then still the lines' total: a later save that
			// edited only the cook's name must not be able to leave the header
			// saying 100 meals over lines that add to 12. Absent means "do not
			// touch the breakdown", not "the breakdown no longer counts".
			var lineCount, sumPresent, sumMeals int
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*)::int, COALESCE(sum(present),0)::int,
				       COALESCE(sum(meals_served),0)::int
				  FROM mdm_register_lines WHERE register_id = $1`, *existing).
				Scan(&lineCount, &sumPresent, &sumMeals); err != nil {
				return err
			}
			if lineCount > 0 {
				present, meals = sumPresent, sumMeals
			}
		}

		before := mdmSnapshot(curEnrol, curPresent, curMeals, curRice, curCost,
			curMenu, curCook, curNotServed)

		var dayID uuid.UUID
		if existing == nil {
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO mdm_registers (institution_id, campus_id, on_date,
				        enrolled, present, meals_served, rice_kg, cost_paise, menu,
				        cook_name, not_served_reason, recorded_by, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
				RETURNING id`,
				id.InstitutionID, campus, onDate, enrolled, present, meals, rice, cost,
				menu, cook, notServed, id.UserID).Scan(&dayID); err != nil {
				return mdmPgError(err)
			}
		} else {
			dayID = *existing
			if _, err := tx.Exec(r.Context(), `
				UPDATE mdm_registers
				   SET enrolled = $2, present = $3, meals_served = $4, rice_kg = $5,
				       cost_paise = $6, menu = $7, cook_name = $8,
				       not_served_reason = $9, recorded_by = $10, updated_at = now()
				 WHERE id = $1`,
				dayID, enrolled, present, meals, rice, cost, menu, cook, notServed,
				id.UserID); err != nil {
				return mdmPgError(err)
			}
		}

		if req.Lines != nil {
			if _, err := tx.Exec(r.Context(),
				`DELETE FROM mdm_register_lines WHERE register_id = $1`, dayID); err != nil {
				return err
			}
			for _, l := range lines {
				if _, err := tx.Exec(r.Context(), `
					INSERT INTO mdm_register_lines (institution_id, register_id,
					        section_id, present, meals_served)
					VALUES ($1, $2, $3, $4, $5)`,
					id.InstitutionID, dayID, l.SectionID, *l.Present, *l.MealsServed); err != nil {
					return mdmPgError(err)
				}
			}
		}

		if amending {
			after := mdmSnapshot(enrolled, present, meals, rice, cost, menu, cook, notServed)
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO mdm_register_amendments (institution_id, register_id,
				        action, reason, before, after, amended_by)
				VALUES ($1, $2, 'amend', $3, $4, $5, $6)`,
				id.InstitutionID, dayID, strings.TrimSpace(req.Reason),
				before, after, id.UserID); err != nil {
				return err
			}
		}

		out, err = readMDMRegister(r.Context(), tx, dayID)
		return err
	})
	if !mdmRespondError(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/*
closeMDMRegisterDay signs the day off.

	The act that makes the register a record rather than a working sheet. It
	refuses a zero-meal day with no reason, because that is precisely the row
	an inspection stops on and the moment to ask is now, while somebody still
	remembers why the kitchen did not cook.
*/
func (s *Server) closeMDMRegisterDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	dayID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var out mdmRegisterRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			status    string
			campus    *uuid.UUID
			meals     int
			notServed *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT status, campus_id, meals_served, not_served_reason
			  FROM mdm_registers WHERE id = $1 FOR UPDATE`, dayID).
			Scan(&status, &campus, &meals, &notServed); err != nil {
			return err
		}
		if !re.allows(campus) {
			return errMDMOutOfReach
		}
		if status == "closed" {
			return errMDMClosed
		}
		if meals == 0 && (notServed == nil || strings.TrimSpace(*notServed) == "") {
			return errMDMNoReason
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE mdm_registers
			   SET status = 'closed', closed_at = now(), closed_by = $2, updated_at = now()
			 WHERE id = $1`, dayID, id.UserID); err != nil {
			return err
		}
		out, err = readMDMRegister(r.Context(), tx, dayID)
		return err
	})
	if !mdmRespondError(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// mdmDayReopenRequest is named apart from mdmReopenRequest in admin_ops.go,
// which reopens a finalised *monthly return*. Two different acts on two
// different records, and one of them was here first.
type mdmDayReopenRequest struct {
	Reason string `json:"reason"`
}

/*
reopenMDMRegisterDay unlocks a closed day for correction, on the record.

	Not an undo. The day stays exactly as it was filed until somebody saves new
	figures over it, and both the unlocking and the new figures land in
	mdm_register_amendments with a name and a reason against each. A register
	that could be quietly reopened and rewritten would be no better than one
	that was never closed.
*/
func (s *Server) reopenMDMRegisterDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	dayID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	var req mdmDayReopenRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say why this day is being reopened")
		return
	}
	re, err := s.campusReach(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var out mdmRegisterRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			status                string
			campus                *uuid.UUID
			enrol, present, meals int
			rice                  *float64
			cost                  int64
			menu, cook, notServed *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT status, campus_id, enrolled, present, meals_served, rice_kg,
			       cost_paise, menu, cook_name, not_served_reason
			  FROM mdm_registers WHERE id = $1 FOR UPDATE`, dayID).
			Scan(&status, &campus, &enrol, &present, &meals, &rice, &cost,
				&menu, &cook, &notServed); err != nil {
			return err
		}
		if !re.allows(campus) {
			return errMDMOutOfReach
		}
		if status != "closed" {
			return errMDMNotClosed
		}
		snap := mdmSnapshot(enrol, present, meals, rice, cost, menu, cook, notServed)
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO mdm_register_amendments (institution_id, register_id,
			        action, reason, before, amended_by)
			VALUES ($1, $2, 'reopen', $3, $4, $5)`,
			id.InstitutionID, dayID, strings.TrimSpace(req.Reason), snap, id.UserID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE mdm_registers
			   SET status = 'open', closed_at = NULL, closed_by = NULL, updated_at = now()
			 WHERE id = $1`, dayID); err != nil {
			return err
		}
		out, err = readMDMRegister(r.Context(), tx, dayID)
		return err
	})
	if !mdmRespondError(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// ================================================================== helpers

func readMDMRegister(ctx context.Context, tx pgx.Tx, dayID uuid.UUID) (mdmRegisterRow, error) {
	var out mdmRegisterRow
	rows, err := tx.Query(ctx, mdmRegisterSelect+` WHERE m.id = $1`, dayID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	if rows.Next() {
		if out, err = scanMDMRegister(rows); err != nil {
			return out, err
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows.Close()
	out.LinesDetail, err = loadMDMLines(ctx, tx, dayID)
	return out, err
}

// mdmInt resolves one countable field. Absent keeps what is stored on an
// existing day and is refused on a new one, which is the difference between
// "I have not counted the rice" and "there was none".
func mdmInt(supplied *int, current int, exists bool, field string) (int, error) {
	if supplied != nil {
		return *supplied, nil
	}
	if exists {
		return current, nil
	}
	return 0, refusal(field + " is required")
}

// mdmText treats an explicit empty string as clearing the field and an absent
// one as leaving it alone.
func mdmText(supplied *string, current *string) *string {
	if supplied == nil {
		return current
	}
	v := strings.TrimSpace(*supplied)
	if v == "" {
		return nil
	}
	return &v
}

// mdmSnapshot is the day as jsonb for the amendment trail.
func mdmSnapshot(enrolled, present, meals int, rice *float64, cost int64,
	menu, cook, notServed *string) []byte {
	b, _ := json.Marshal(map[string]any{
		"enrolled": enrolled, "present": present, "meals_served": meals,
		"rice_kg": rice, "cost_paise": cost, "menu": menu,
		"cook_name": cook, "not_served_reason": notServed,
	})
	return b
}

// mdmPgError turns the two constraints a clerk can actually hit into sentences
// rather than a 500 naming an index.
func mdmPgError(err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return err
	}
	switch {
	case pg.Code == "23505" && strings.Contains(pg.ConstraintName, "mdm_registers_one_per_day"):
		return refusal("this day is already in the register for that campus")
	case pg.Code == "23505" && strings.Contains(pg.ConstraintName, "mdm_register_lines_one_per_section"):
		return refusal("the same section appears twice")
	case pg.Code == "23514" && strings.Contains(pg.ConstraintName, "not_more_meals_than_children"):
		return errMDMLineSum
	case pg.Code == "23514" && strings.Contains(pg.ConstraintName, "mdm_registers_counts_check"):
		return refusal("counts cannot be negative")
	}
	return err
}

// mdmRespondError writes the refusal for the errors these handlers raise and
// reports whether the caller should carry on and write a body.
func mdmRespondError(w http.ResponseWriter, r *http.Request, err error) bool {
	var ref refusal
	switch {
	case err == nil:
		return true
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errMDMOutOfReach):
		httpx.Denied(w, r, "this register belongs to a campus you are not posted to")
	case errors.Is(err, errMDMClosed):
		httpx.Error(w, r, http.StatusConflict, "register_closed",
			"this day has been closed; reopen it with a reason before correcting it")
	case errors.Is(err, errMDMNotClosed):
		httpx.Error(w, r, http.StatusConflict, "register_open",
			"this day is not closed")
	case errors.Is(err, errMDMNoReason):
		httpx.Error(w, r, http.StatusConflict, "reason_required",
			"say why no meal was served, or why this day is being corrected")
	case errors.Is(err, errMDMLineSum):
		httpx.BadRequest(w, r, "a section cannot be served more meals than it had children present")
	case errors.As(err, &ref):
		httpx.BadRequest(w, r, string(ref))
	default:
		httpx.Internal(w, r, err)
	}
	return false
}

// parseOptionalUUID turns the text campus id the row carries back into a uuid
// for the reach check. A malformed one cannot occur — it came out of a uuid
// column — and is treated as institution-wide, which is the stricter reading.
func parseOptionalUUID(s *string) *uuid.UUID {
	if s == nil {
		return nil
	}
	id, err := uuid.Parse(*s)
	if err != nil {
		return nil
	}
	return &id
}

// compile-time assurance that the scope package is the one consulted for the
// campus boundary rather than a second, hand-rolled idea of it.
var _ = func(r *scope.Resolved) []uuid.UUID { return r.CampusIDs }
