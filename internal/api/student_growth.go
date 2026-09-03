package api

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* THE STREAK, THE BADGES AND THE BOARD IN THE FOYER.

   Three of the child's screens that were catalogued and never built. None of
   them invents a record: the streak is counted from days the child opened the
   app and homework handed in on time; the badges are what teachers already
   wrote -- a positive conduct note, an achievement, a commendation -- read
   from the tables they were written into; the hall of fame is the school's own
   entries plus every state-or-better placing the office has already recorded.
   A badge that came from nowhere would be a sticker, and a child knows the
   difference.

   Every read resolves the student through whichChild, so a guardian holding
   the key sees their own child and nobody else's; the catalogue keys on the
   routes are what say the school has switched the screen on for this role. The
   hall of fame is written by whoever publishes announcements, because a name
   on the foyer board is the school speaking, not a teacher's note. */

// Catalogue keys, which the roles are granted as permissions (SeedCatalogRoles).
const (
	featStreak     = "student.learning.gamified_learning_streak_counter"
	featBadges     = "student.learning.gamified_learning_badge_showcase"
	featHallOfFame = "student.campus_life.digital_hall_of_fame"
)

func (s *Server) mountStudentGrowth(r chi.Router) {
	r.With(httpx.RequirePermission(featStreak)).Get("/learning/streak", s.getMyStreak)
	r.With(httpx.RequirePermission(featBadges)).Get("/learning/badges", s.getMyBadges)
	// Staff who keep the board read it through the same route.
	r.With(httpx.RequireAnyPermission(featHallOfFame, rbac.AnnouncementsWrite)).
		Get("/campus/hall-of-fame", s.listHallOfFame)
	r.With(httpx.RequirePermission(rbac.AnnouncementsWrite)).
		Post("/campus/hall-of-fame", s.addHallOfFameEntry)
	r.With(httpx.RequirePermission(rbac.AnnouncementsWrite)).
		Post("/campus/hall-of-fame/{id}/retire", s.retireHallOfFameEntry)
}

// --- streaks -----------------------------------------------------------------

type streakBadge struct {
	Key    string  `json:"key"`
	Title  string  `json:"title"`
	Detail string  `json:"detail"`
	Group  string  `json:"group"`
	Earned bool    `json:"earned"`
	On     *string `json:"on,omitempty"`
}

type streakSummary struct {
	StudentID string `json:"student_id"`
	Today     string `json:"today"`
	// Days in a row the app was opened, counting today or ending yesterday.
	OpenStreak    int  `json:"open_streak"`
	OpenLongest   int  `json:"open_longest"`
	OpenedToday   bool `json:"opened_today"`
	DaysThisMonth int  `json:"days_this_month"`
	// Pieces of homework handed in by their due date, in a row, newest first.
	HomeworkStreak  int `json:"homework_streak"`
	HomeworkOnTime  int `json:"homework_on_time"`
	HomeworkDue     int `json:"homework_due"`
	HomeworkPending int `json:"homework_pending"`
	// The last five weeks, oldest first, one flag per day.
	Recent []streakDay   `json:"recent"`
	Badges []streakBadge `json:"badges"`
}

type streakDay struct {
	Day    string `json:"day"`
	Opened bool   `json:"opened"`
}

// homeworkMark is one piece of homework with a due date, and when it was handed in.
type homeworkMark struct {
	DueOn       time.Time
	SubmittedOn *time.Time
}

// streakOf counts consecutive days ending at today or yesterday, and the longest
// run anywhere in the set. days need not be sorted or unique.
func streakOf(days []time.Time, today time.Time) (current, longest int) {
	set := map[string]bool{}
	for _, d := range days {
		set[d.Format("2006-01-02")] = true
	}
	if len(set) == 0 {
		return 0, 0
	}
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	run := 0
	var prev time.Time
	for i, k := range keys {
		d, _ := time.Parse("2006-01-02", k)
		if i > 0 && d.Sub(prev) == 24*time.Hour {
			run++
		} else {
			run = 1
		}
		if run > longest {
			longest = run
		}
		prev = d
	}
	// The run that reaches today, or reached yesterday: a child who has not
	// opened the app yet this morning has not lost anything.
	t := today.Format("2006-01-02")
	y := today.AddDate(0, 0, -1).Format("2006-01-02")
	start := t
	if !set[t] {
		if !set[y] {
			return 0, longest
		}
		start = y
	}
	d, _ := time.Parse("2006-01-02", start)
	for set[d.Format("2006-01-02")] {
		current++
		d = d.AddDate(0, 0, -1)
	}
	return current, longest
}

// onTimeStreak counts, newest due date first, how many pieces of homework in a
// row were handed in by their due date. The first late or missing one ends it.
// Homework not yet due is skipped rather than counted against the child.
func onTimeStreak(marks []homeworkMark, today time.Time) (streak, onTime, due int) {
	sorted := append([]homeworkMark(nil), marks...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].DueOn.After(sorted[j].DueOn) })
	alive := true
	for _, m := range sorted {
		if m.DueOn.After(today) {
			continue
		}
		due++
		ok := m.SubmittedOn != nil && !m.SubmittedOn.After(m.DueOn)
		if ok {
			onTime++
		}
		if alive {
			if ok {
				streak++
			} else {
				alive = false
			}
		}
	}
	return streak, onTime, due
}

// Milestones. A badge is earned by the longest run ever, not the current one:
// a streak broken at day nine still earned the week.
var openMilestones = []int{3, 7, 14, 30, 60, 100}
var homeworkMilestones = []int{5, 10, 25, 50}

func streakBadges(openLongest, homeworkStreak int) []streakBadge {
	out := []streakBadge{}
	for _, m := range openMilestones {
		out = append(out, streakBadge{
			Key:    "open_" + strconv.Itoa(m),
			Title:  strconv.Itoa(m) + " days in a row",
			Detail: "Opened the app every day for " + strconv.Itoa(m) + " days",
			Group:  "streaks",
			Earned: openLongest >= m,
		})
	}
	for _, m := range homeworkMilestones {
		out = append(out, streakBadge{
			Key:    "homework_" + strconv.Itoa(m),
			Title:  strconv.Itoa(m) + " on time",
			Detail: strconv.Itoa(m) + " pieces of homework handed in by the due date, in a row",
			Group:  "streaks",
			Earned: homeworkStreak >= m,
		})
	}
	return out
}

// loadStreak records today and gathers everything the streak and the badges are
// counted from. Shared by both screens so they never disagree about a number.
func (s *Server) loadStreak(r *http.Request, student uuid.UUID) (streakSummary, error) {
	id := httpx.IdentityFrom(r.Context())
	out := streakSummary{StudentID: student.String(), Recent: []streakDay{}}
	var days []time.Time
	var marks []homeworkMark
	var today time.Time
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `SELECT CURRENT_DATE`).Scan(&today); err != nil {
			return err
		}
		/* Today is written by the read. Only a signed-in child (or their
		   guardian) reaches this, and the row is "this child's app was opened
		   today", which is exactly what just happened. */
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO student_activity_days (institution_id, student_id, day)
			VALUES ($1, $2, CURRENT_DATE)
			ON CONFLICT DO NOTHING`, id.InstitutionID, student); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT day FROM student_activity_days WHERE student_id = $1
			UNION
			SELECT (se.created_at AT TIME ZONE 'UTC')::date
			  FROM sessions se
			  JOIN students st ON st.user_id = se.user_id
			 WHERE st.id = $1`, student)
		if err != nil {
			return err
		}
		for rows.Next() {
			var d time.Time
			if err := rows.Scan(&d); err != nil {
				rows.Close()
				return err
			}
			days = append(days, d)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		/* Every published piece of homework with a due date for a section the
		   child is enrolled in, and the day they handed it in. A child moved
		   between sections keeps the record of both. */
		rows, err = tx.Query(r.Context(), `
			SELECT h.due_on,
			       (SELECT min(hs.submitted_at)::date FROM homework_submissions hs
			         WHERE hs.homework_id = h.id AND hs.student_id = $1
			           AND hs.submitted_at IS NOT NULL)
			  FROM homework h
			 WHERE h.is_published AND h.due_on IS NOT NULL
			   AND h.section_id IN (SELECT e.section_id FROM enrollments e WHERE e.student_id = $1)
			   AND h.assigned_on >= CURRENT_DATE - interval '365 days'`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m homeworkMark
			if err := rows.Scan(&m.DueOn, &m.SubmittedOn); err != nil {
				return err
			}
			marks = append(marks, m)
		}
		return rows.Err()
	})
	if err != nil {
		return out, err
	}
	today = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	out.Today = today.Format("2006-01-02")
	out.OpenStreak, out.OpenLongest = streakOf(days, today)
	out.HomeworkStreak, out.HomeworkOnTime, out.HomeworkDue = onTimeStreak(marks, today)
	set := map[string]bool{}
	for _, d := range days {
		set[d.Format("2006-01-02")] = true
	}
	out.OpenedToday = set[out.Today]
	for d := today.AddDate(0, 0, -34); !d.After(today); d = d.AddDate(0, 0, 1) {
		k := d.Format("2006-01-02")
		out.Recent = append(out.Recent, streakDay{Day: k, Opened: set[k]})
		if d.Month() == today.Month() && set[k] {
			out.DaysThisMonth++
		}
	}
	for _, m := range marks {
		if !m.DueOn.After(today) || m.SubmittedOn != nil {
			continue
		}
		out.HomeworkPending++
	}
	out.Badges = streakBadges(out.OpenLongest, out.HomeworkStreak)
	return out, nil
}

func (s *Server) getMyStreak(w http.ResponseWriter, r *http.Request) {
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	out, err := s.loadStreak(r, student)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- badges ------------------------------------------------------------------

type badgeShowcase struct {
	StudentID string        `json:"student_id"`
	Earned    int           `json:"earned"`
	Badges    []streakBadge `json:"badges"`
}

// getMyBadges is every badge a child holds, from wherever an adult wrote it.
func (s *Server) getMyBadges(w http.ResponseWriter, r *http.Request) {
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	badges := []streakBadge{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT 'conduct_' || dr.id::text, dr.category, dr.description, 'behaviour',
			       to_char(dr.occurred_on, 'YYYY-MM-DD')
			  FROM discipline_records dr
			 WHERE dr.student_id = $1 AND dr.is_positive AND dr.visible_to_student
			UNION ALL
			SELECT 'achievement_' || sa.id::text, sa.title,
			       concat_ws(' · ', nullif(sa.level, ''), nullif(sa."position", ''), sa.description),
			       CASE WHEN sa.kind IN ('sport', 'club', 'activity') THEN 'activities' ELSE 'academic' END,
			       to_char(coalesce(sa.awarded_on, sa.created_at::date), 'YYYY-MM-DD')
			  FROM student_achievements sa
			 WHERE sa.student_id = $1
			UNION ALL
			SELECT 'remark_' || sr.id::text, 'Commended', sr.body, 'academic',
			       to_char(sr.observed_on, 'YYYY-MM-DD')
			  FROM student_remarks sr
			 WHERE sr.student_id = $1 AND sr.kind = 'achievement' AND sr.visible_to_family
			ORDER BY 5 DESC`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			b := streakBadge{Earned: true}
			var on string
			if err := rows.Scan(&b.Key, &b.Title, &b.Detail, &b.Group, &on); err != nil {
				return err
			}
			b.On = &on
			badges = append(badges, b)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	streak, err := s.loadStreak(r, student)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	badges = append(badges, streak.Badges...)
	out := badgeShowcase{StudentID: student.String(), Badges: badges}
	for _, b := range badges {
		if b.Earned {
			out.Earned++
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- hall of fame ------------------------------------------------------------

type hallOfFameEntry struct {
	ID       string  `json:"id"`
	Category string  `json:"category"`
	Title    string  `json:"title"`
	Holder   string  `json:"holder"`
	Year     *int    `json:"year,omitempty"`
	Detail   *string `json:"detail,omitempty"`
	// "board" for an entry kept here; "achievement" for a placing read from
	// the student's own record, which is retired from that screen, not this.
	Source string `json:"source"`
}

func (s *Server) listHallOfFame(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT e.id::text, e.category, e.title, e.holder, e.year, e.detail, 'board'
		  FROM hall_of_fame_entries e
		 WHERE e.retired_at IS NULL
		UNION ALL
		SELECT sa.id::text,
		       CASE WHEN sa.kind IN ('sport') THEN 'sports'
		            WHEN sa.kind IN ('club', 'activity') THEN 'arts'
		            ELSE 'academic' END,
		       sa.title,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       extract(year FROM coalesce(sa.awarded_on, sa.created_at))::int,
		       concat_ws(' · ', initcap(sa.level), nullif(sa."position", ''), sa.description),
		       'achievement'
		  FROM student_achievements sa
		  JOIN students st ON st.id = sa.student_id
		 WHERE sa.level IN ('state', 'national', 'international')
		 ORDER BY 5 DESC NULLS LAST, 3`, nil,
		func(rows pgx.Rows) (hallOfFameEntry, error) {
			var e hallOfFameEntry
			err := rows.Scan(&e.ID, &e.Category, &e.Title, &e.Holder, &e.Year, &e.Detail, &e.Source)
			return e, err
		})
	respond(w, r, items, err)
}

type hallOfFameRequest struct {
	Category  string `json:"category"`
	Title     string `json:"title"`
	Holder    string `json:"holder"`
	Year      *int   `json:"year,omitempty"`
	Detail    string `json:"detail,omitempty"`
	StudentID string `json:"student_id,omitempty"`
	CampusID  string `json:"campus_id,omitempty"`
}

var hallOfFameCategories = map[string]bool{
	"academic": true, "sports": true, "arts": true, "service": true, "other": true,
}

func (s *Server) addHallOfFameEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req hallOfFameRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Category = strings.TrimSpace(strings.ToLower(req.Category))
	if req.Category == "" {
		req.Category = "academic"
	}
	if !hallOfFameCategories[req.Category] {
		httpx.BadRequest(w, r, "category must be academic, sports, arts, service or other")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Holder = strings.TrimSpace(req.Holder)
	if req.Title == "" || len(req.Title) > 160 {
		httpx.BadRequest(w, r, "title is required, up to 160 characters")
		return
	}
	if req.Holder == "" || len(req.Holder) > 160 {
		httpx.BadRequest(w, r, "say whose it is, up to 160 characters")
		return
	}
	if req.Year != nil && (*req.Year < 1800 || *req.Year > 2200) {
		httpx.BadRequest(w, r, "year must be a four-digit year")
		return
	}
	req.Detail = strings.TrimSpace(req.Detail)
	if len(req.Detail) > 1000 {
		httpx.BadRequest(w, r, "keep the detail under 1000 characters")
		return
	}
	var studentID, campusID *uuid.UUID
	if v := strings.TrimSpace(req.StudentID); v != "" {
		u, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "student_id must be a uuid")
			return
		}
		studentID = &u
	}
	if v := strings.TrimSpace(req.CampusID); v != "" {
		u, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "campus_id must be a uuid")
			return
		}
		campusID = &u
	}
	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO hall_of_fame_entries
			    (institution_id, campus_id, category, title, holder, student_id, year, detail, added_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, nullif($8, ''), $9)
			RETURNING id::text`,
			id.InstitutionID, campusID, req.Category, req.Title, req.Holder,
			studentID, req.Year, req.Detail, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

func (s *Server) retireHallOfFameEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.NotFound(w, r)
		return
	}
	var n int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE hall_of_fame_entries SET retired_at = now()
			 WHERE id = $1 AND retired_at IS NULL`, entry)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if n == 0 {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": entry.String(), "retired": true})
}
