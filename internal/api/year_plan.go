package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The year plan, as a timeline rather than a table of months.

   A school keeps this in a spreadsheet: one sheet per subject per grade, a
   row per month, working days and exam days and teaching days, and the
   chapters poured into them with a period count each. It is a good document
   and a rigid one. A chapter runs three periods over, and every month below
   it is wrong; the teacher retypes the sheet or, more often, does not.

   So no month is stored here. What is stored is the order of the chapters and
   what each is expected to cost — syllabus_units.sequence and
   planned_periods, both of which already existed. The months come from the
   calendar, counted the way getCalendarDay counts them so the two can never
   disagree. Pouring the one into the other gives the plan, and gives it
   again, differently, the moment either changes.

   That is the whole design: the spreadsheet's month column becomes a
   computed thing. Edit a chapter's periods, reorder two chapters, declare a
   bandh, pull a Sunday back in — the rest of the year re-flows and nobody
   retypes anything.

   Nothing here writes. Chapters are edited through setSyllabusUnits, which
   already replaces a subject's list whole while refusing to delete a chapter
   some class has already been taught. An import is that same endpoint with
   the rows coming from a file instead of a form, which is deliberate: one
   write path means an imported plan and a typed plan cannot drift apart.
*/

// yearMonth is one month of the ruler the plan is poured into.
type yearMonth struct {
	Month string `json:"month"` // YYYY-MM
	Label string `json:"label"` // MAR
	// Days the school is open at all, then the days lost to exams, then what
	// is left to teach in. The third is the only one the plan spends.
	Working  int `json:"working_days"`
	Exam     int `json:"exam_days"`
	Teaching int `json:"teaching_days"`
}

// yearUnit is a chapter placed on the timeline. Placement is derived; only
// Sequence, Title and Planned are stored.
type yearUnit struct {
	ID       string `json:"id"`
	Sequence int    `json:"sequence"`
	Title    string `json:"title"`
	Planned  int    `json:"planned_periods"`

	// Where the pour puts it. A chapter that spans a month boundary appears
	// once with the whole span and a per-month split, the way the school's own
	// sheet writes "L5: Plants (5P)" in July and "(3P)" in August.
	StartsIn string      `json:"starts_in,omitempty"`
	EndsIn   string      `json:"ends_in,omitempty"`
	Split    []unitSpend `json:"split,omitempty"`

	// Whether a delivered lesson plan covers it. Computed, never stored: a
	// stored percentage is wrong the moment a plan is amended.
	Delivered   bool    `json:"delivered"`
	DeliveredOn *string `json:"delivered_on,omitempty"`

	// True when the year ran out before this chapter did.
	Overflows bool `json:"overflows,omitempty"`
}

type unitSpend struct {
	Month   string `json:"month"`
	Periods int    `json:"periods"`
}

/*
getYearPlan returns the ruler, the chapters, and the pour of one into the other.

	Read-only, and left on the group's academics.read: a teacher is entitled to
	see the plan for the subject they teach, and a head of department to see
	the plan they are meant to be checking.
*/
func (s *Server) getYearPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	classSubject := strings.TrimSpace(q.Get("class_subject_id"))
	if classSubject == "" {
		httpx.BadRequest(w, r, "class_subject_id is required — a year plan is a plan for one subject in one class")
		return
	}

	// The year's own dates, not a hardcoded June: Yajur's year runs March to
	// February, and academicYearStart assumes June. The declared row wins;
	// the helper is only the fallback for a school that has not set one up.
	var from, to time.Time
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		yearID := strings.TrimSpace(q.Get("academic_year_id"))
		row := tx.QueryRow(r.Context(), `
			SELECT starts_on, ends_on FROM academic_years
			 WHERE ($1::uuid IS NULL OR id = $1::uuid)
			   AND ($1::uuid IS NOT NULL OR is_current)
			 ORDER BY starts_on DESC LIMIT 1`, nullString(yearID))
		return row.Scan(&from, &to)
	})
	if err != nil {
		start := academicYearStart(nowInIndia())
		from, to = start, start.AddDate(1, 0, -1)
	}

	/* The ruler. Teaching days are counted, not declared, by the rule the
	   calendar already states once: a day counts unless it is a Sunday or is
	   shut by a holiday or vacation, and a day marked 'working_day' counts
	   whatever else it is. Exam days are counted separately because the
	   school's own sheet separates them — they are working days that teach
	   nothing. */
	months, err := collect(s, r, `
		WITH days AS (
		  SELECT d::date AS on_date
		    FROM generate_series($1::date, $2::date, interval '1 day') d
		), marked AS (
		  SELECT d.on_date,
		         EXISTS (SELECT 1 FROM holidays h
		                  WHERE h.kind IN ('holiday','vacation')
		                    AND h.applies_to IN ('all','students')
		                    AND d.on_date BETWEEN h.on_date
		                                      AND COALESCE(h.to_date, h.on_date)) AS shut,
		         EXISTS (SELECT 1 FROM holidays h
		                  WHERE h.kind = 'working_day'
		                    AND d.on_date BETWEEN h.on_date
		                                      AND COALESCE(h.to_date, h.on_date)) AS working,
		         EXISTS (SELECT 1 FROM exams e
		                  WHERE e.starts_on IS NOT NULL
		                    AND d.on_date BETWEEN e.starts_on
		                                      AND COALESCE(e.ends_on, e.starts_on)) AS examined
		    FROM days d
		)
		SELECT to_char(on_date,'YYYY-MM'), upper(to_char(on_date,'MON')),
		       count(*) FILTER (WHERE open)::int,
		       count(*) FILTER (WHERE open AND examined)::int,
		       count(*) FILTER (WHERE open AND NOT examined)::int
		  FROM (SELECT on_date, examined,
		               (working OR (extract(isodow FROM on_date) <> 7 AND NOT shut)) AS open
		          FROM marked) m
		 GROUP BY 1, 2
		 ORDER BY 1`,
		[]any{from.Format(time.DateOnly), to.Format(time.DateOnly)},
		func(rows pgx.Rows) (yearMonth, error) {
			var v yearMonth
			return v, rows.Scan(&v.Month, &v.Label, &v.Working, &v.Exam, &v.Teaching)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The chapters, in their stored order. planned_periods is what the pour
	// spends; delivery is read through lesson_plan_units, the same join the
	// department rollup uses.
	units, err := collect(s, r, `
		SELECT u.id::text, u.sequence, u.title, u.planned_periods,
		       EXISTS (SELECT 1 FROM lesson_plan_units lpu
		                 JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
		                WHERE lpu.syllabus_unit_id = u.id
		                  AND lp.delivered_on IS NOT NULL),
		       (SELECT to_char(max(lp.delivered_on),'YYYY-MM-DD')
		          FROM lesson_plan_units lpu
		          JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
		         WHERE lpu.syllabus_unit_id = u.id
		           AND lp.delivered_on IS NOT NULL)
		  FROM syllabus_units u
		 WHERE u.class_subject_id = $1::uuid AND u.is_active
		 ORDER BY u.sequence, u.title`,
		[]any{classSubject},
		func(rows pgx.Rows) (yearUnit, error) {
			var v yearUnit
			return v, rows.Scan(&v.ID, &v.Sequence, &v.Title, &v.Planned,
				&v.Delivered, &v.DeliveredOn)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* The pour. Chapters are laid end to end into the teaching days as they
	   come, splitting across a month boundary rather than being pushed whole
	   into the next one — a chapter that needs eight periods and finds three
	   left in August takes those three and finishes in September, which is
	   what the school's own sheet records and what actually happens in a
	   classroom.

	   A chapter that finds no room at all is marked rather than dropped. The
	   year being too short for the syllabus is the single most useful thing
	   this endpoint can tell a head of department, and it is exactly the thing
	   a spreadsheet hides. */
	mi, left := 0, 0
	if len(months) > 0 {
		left = months[0].Teaching
	}
	var planned, capacity int
	for _, m := range months {
		capacity += m.Teaching
	}
	for i := range units {
		u := &units[i]
		planned += u.Planned
		need := u.Planned
		for need > 0 && mi < len(months) {
			if left == 0 {
				mi++
				if mi >= len(months) {
					break
				}
				left = months[mi].Teaching
				continue
			}
			take := need
			if take > left {
				take = left
			}
			u.Split = append(u.Split, unitSpend{Month: months[mi].Month, Periods: take})
			if u.StartsIn == "" {
				u.StartsIn = months[mi].Month
			}
			u.EndsIn = months[mi].Month
			need -= take
			left -= take
		}
		u.Overflows = need > 0
	}

	delivered := 0
	for _, u := range units {
		if u.Delivered {
			delivered++
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"from":   from.Format(time.DateOnly),
		"to":     to.Format(time.DateOnly),
		"months": months,
		"units":  units,
		"summary": map[string]any{
			"teaching_days":   capacity,
			"planned_periods": planned,
			// Negative is the interesting sign: the syllabus does not fit the
			// year. Reported rather than clamped, because the school has to
			// decide what gives, and a clamped zero would hide the question.
			"spare_periods":   capacity - planned,
			"units":           len(units),
			"units_delivered": delivered,
		},
	})
}
