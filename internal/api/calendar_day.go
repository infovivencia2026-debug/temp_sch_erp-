package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* One day, read as a day.

   The three things a teacher opens in the morning already existed, on three
   screens: the timetable said which periods, the lesson plan said what to
   teach in them, and the calendar said whether the school was open at all.
   Nobody joined them, so the answer to "what am I doing today" took three
   navigations and a mental merge.

   Nothing here is new data. timetable_entries carries the weekday, periods
   carries the bell, lesson_plans carries week_of and an optional teaching_day,
   substitutions carries the swap, and holidays already distinguishes a
   vacation from a working_day pulled back in. This file is the join those
   tables were always shaped for.

   The lesson-plan match deserves a note, because it is the one join that is
   not an equality. A plan is unique on (section, class_subject, week_of) — one
   plan per subject per week — so a Wednesday period matches the plan whose
   week contains that Wednesday, which is the `week_of BETWEEN d-6 AND d`
   convention admin_rollups.go already uses. teaching_day, when the teacher has
   set it, narrows further: a plan written for Friday does not describe the
   Wednesday lesson. When it is null the plan covers the week, and every period
   in that week shows it.
*/

type dayPeriod struct {
	PeriodID string `json:"period_id"`
	Name     string `json:"name"`
	Sequence int    `json:"sequence"`
	StartsAt string `json:"starts_at"`
	EndsAt   string `json:"ends_at"`
	IsBreak  bool   `json:"is_break"`

	// Null on a break: the bell rings for everyone, but nothing is taught.
	EntryID *string `json:"entry_id,omitempty"`
	Class   *string `json:"class,omitempty"`
	Section *string `json:"section,omitempty"`
	Subject *string `json:"subject,omitempty"`
	Teacher *string `json:"teacher,omitempty"`
	Room    *string `json:"room,omitempty"`

	// Set only when somebody else is standing in on this date. The scheduled
	// teacher stays in Teacher: who was meant to be there is half the point of
	// recording who actually is.
	Substitute       *string `json:"substitute,omitempty"`
	SubstituteReason *string `json:"substitute_reason,omitempty"`

	// The lesson plan for this period, when one has been written. A null here
	// is a real answer — it means nobody planned this lesson — so the shape is
	// nullable rather than an empty object.
	Lesson *dayLesson `json:"lesson,omitempty"`
}

type dayLesson struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	// Also nullable for the same reason, and for the same rows.
	WeekOf      *string `json:"week_of,omitempty"`
	TeachingDay *int    `json:"teaching_day,omitempty"`
	Objectives  *string `json:"objectives,omitempty"`
	Activities  *string `json:"activities,omitempty"`
	Resources   *string `json:"resources,omitempty"`
	Homework    *string `json:"homework,omitempty"`
	DeliveredOn *string `json:"delivered_on,omitempty"`
	FileID      *string `json:"file_id,omitempty"`
}

/*
getCalendarDay answers "what happens on this date", for one section, one
teacher, or whoever is asking.

	Scope: an explicit section_id or teacher_user_id filters; with neither, the
	day is the caller's own teaching day. That default is why this endpoint
	needs no permission beyond the group's academics.read — a teacher reading
	their own periods is reading what the timetable already shows them. Asking
	for a section is equally open, for the same reason the calendar itself is:
	every member of staff is entitled to know when a class meets.
*/
func (s *Server) getCalendarDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()

	date := strings.TrimSpace(q.Get("date"))
	if date == "" {
		date = nowInIndia().Format(time.DateOnly)
	}
	if _, err := time.Parse(time.DateOnly, date); err != nil {
		httpx.BadRequest(w, r, "date must be YYYY-MM-DD")
		return
	}

	section := nullString(strings.TrimSpace(q.Get("section_id")))
	teacher := nullString(strings.TrimSpace(q.Get("teacher_user_id")))
	// No scope named: show the caller their own day. A school-wide day is
	// hundreds of periods and nobody reads it as a day.
	if section == nil && teacher == nil {
		self := id.UserID.String()
		teacher = &self
	}

	periods, err := collect(s, r, `
		SELECT p.id::text, p.name, p.sequence,
		       to_char(p.starts_at,'HH24:MI'), to_char(p.ends_at,'HH24:MI'), p.is_break,
		       te.id::text, c.name, sec.name, sub.name, tu.full_name, te.room,
		       su.full_name, sb.reason,
		       /* COALESCED, because the LATERAL is a LEFT JOIN: every period
		          with no lesson plan against it — which is most of them, and
		          all of the breaks — returns NULL here, and Status is a plain
		          string. The whole day failed with "cannot scan NULL into
		          *string" for any teacher whose periods had no plans. */
		       lp.id::text, COALESCE(lp.status,''),
		       to_char(lp.week_of,'YYYY-MM-DD'), lp.teaching_day,
		       lp.objectives, lp.activities, lp.resources, lp.homework,
		       to_char(lp.delivered_on,'YYYY-MM-DD'), lp.file_id::text
		  FROM periods p
		  -- The bell is the spine: a free period is a row with nothing taught
		  -- in it, which is what a teacher wants to see, so the timetable
		  -- joins onto the bell and not the other way round.
		  LEFT JOIN timetable_entries te
		         ON te.period_id = p.id
		        AND te.weekday = extract(isodow FROM $1::date)::int
		        AND ($2::uuid IS NULL OR te.section_id = $2)
		        AND ($3::uuid IS NULL OR te.teacher_user_id = $3)
		  LEFT JOIN sections sec       ON sec.id = te.section_id
		  LEFT JOIN classes c          ON c.id = sec.class_id
		  LEFT JOIN class_subjects cs  ON cs.id = te.class_subject_id
		  LEFT JOIN subjects sub       ON sub.id = cs.subject_id
		  LEFT JOIN users tu           ON tu.id = te.teacher_user_id
		  LEFT JOIN substitutions sb    ON sb.timetable_entry_id = te.id AND sb.on_date = $1::date
		  LEFT JOIN users su           ON su.id = sb.substitute_user_id
		  LEFT JOIN LATERAL (
		      SELECT l.* FROM lesson_plans l
		       WHERE l.section_id = te.section_id
		         AND l.class_subject_id = te.class_subject_id
		         AND l.week_of BETWEEN $1::date - 6 AND $1::date
		         AND (l.teaching_day IS NULL
		              OR l.teaching_day = extract(isodow FROM $1::date)::int)
		       ORDER BY l.week_of DESC, l.teaching_day NULLS LAST
		       LIMIT 1
		  ) lp ON true
		 WHERE p.is_break OR te.id IS NOT NULL
		 ORDER BY p.sequence, c.name, sec.name`,
		[]any{date, section, teacher},
		func(rows pgx.Rows) (dayPeriod, error) {
			var v dayPeriod
			var l dayLesson
			var lessonID *string
			err := rows.Scan(&v.PeriodID, &v.Name, &v.Sequence, &v.StartsAt, &v.EndsAt,
				&v.IsBreak, &v.EntryID, &v.Class, &v.Section, &v.Subject, &v.Teacher,
				&v.Room, &v.Substitute, &v.SubstituteReason,
				&lessonID, &l.Status, &l.WeekOf, &l.TeachingDay, &l.Objectives,
				&l.Activities, &l.Resources, &l.Homework, &l.DeliveredOn, &l.FileID)
			if err == nil && lessonID != nil {
				l.ID = *lessonID
				v.Lesson = &l
			}
			return v, err
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The almanac, narrowed to this one date: the terms it falls in, the exams
	// running, the holiday that shuts it. Same three sources the year view
	// unions, so a day never disagrees with the year above it.
	entries, err := collect(s, r, `
		SELECT h.id::text, 'calendar', h.name,
		       to_char(h.on_date,'YYYY-MM-DD'),
		       to_char(COALESCE(h.to_date, h.on_date),'YYYY-MM-DD'),
		       h.kind, h.applies_to, h.description, NULL::text,
		       (COALESCE(h.to_date, h.on_date) - h.on_date + 1)::int
		  FROM holidays h
		 WHERE $1::date BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date)
		UNION ALL
		SELECT e.id::text, 'exam', e.name,
		       to_char(e.starts_on,'YYYY-MM-DD'),
		       to_char(COALESCE(e.ends_on, e.starts_on),'YYYY-MM-DD'),
		       'exam', 'students', NULL, NULL,
		       (COALESCE(e.ends_on, e.starts_on) - e.starts_on + 1)::int
		  FROM exams e
		 WHERE e.starts_on IS NOT NULL
		   AND $1::date BETWEEN e.starts_on AND COALESCE(e.ends_on, e.starts_on)
		UNION ALL
		SELECT t.id::text, 'term', t.name,
		       to_char(t.starts_on,'YYYY-MM-DD'), to_char(t.ends_on,'YYYY-MM-DD'),
		       'term', 'all', NULL, NULL, (t.ends_on - t.starts_on + 1)::int
		  FROM terms t
		 WHERE $1::date BETWEEN t.starts_on AND t.ends_on
		 ORDER BY 2, 3`,
		[]any{date},
		func(rows pgx.Rows) (schoolCalendarEntry, error) {
			var v schoolCalendarEntry
			return v, rows.Scan(&v.ID, &v.Source, &v.Name, &v.StartsOn, &v.EndsOn,
				&v.Kind, &v.AppliesTo, &v.Description, &v.Campus, &v.Days)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Whether the school is open, decided the same way the year view counts
	   instructional days: a holiday or vacation shuts it, an explicit
	   working_day pulls it back in whatever else it is, and a Sunday is shut
	   unless pulled back. Deciding it here rather than in the browser is what
	   stops the day view and the working-day count from disagreeing. */
	shut, working := false, false
	var reason *string
	for i := range entries {
		e := entries[i]
		switch {
		case e.Source != "calendar":
		case e.Kind == "working_day":
			working = true
		case (e.Kind == "holiday" || e.Kind == "vacation") &&
			(e.AppliesTo == "all" || e.AppliesTo == "students"):
			shut = true
			if reason == nil {
				name := e.Name
				reason = &name
			}
		}
	}
	d, _ := time.Parse(time.DateOnly, date)
	sunday := d.Weekday() == time.Sunday
	if sunday && reason == nil && !working {
		sun := "Sunday"
		reason = &sun
	}
	open := working || (!sunday && !shut)
	if open {
		reason = nil
	}

	taught, planned := 0, 0
	for _, p := range periods {
		if p.EntryID == nil {
			continue
		}
		taught++
		if p.Lesson != nil {
			planned++
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"date":    date,
		"weekday": int(d.Weekday()),
		"open":    open,
		"reason":  reason,
		"almanac": entries,
		"periods": periods,
		"summary": map[string]any{
			"periods_taught":  taught,
			"periods_planned": planned,
		},
	})
}
