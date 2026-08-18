package api

import (
	"net/http"
	"time"

	"github.com/school-erp/erp/internal/httpx"
)

/* The period a metric covers.

   Dashboards had their periods baked into the SQL — attendance was always
   today, collection always this calendar month — so "how did we do last term"
   meant exporting to a spreadsheet. Every metric now takes a range.

   The distinction that matters, and the reason this is not simply a WHERE
   clause everywhere: some numbers are flows and some are levels. Fees
   collected is a flow and belongs to a period. Outstanding balance is a level
   — it is true at an instant, and "outstanding between June and August" is not
   a smaller number, it is a meaningless one. Levels are always reported as of
   now and labelled that way, so nobody reads a balance as a period figure.

   Presets are the ones an Indian school actually asks for. The academic year
   runs June to April, which is not the financial year and not the calendar
   year, so all three are offered rather than assumed. */

type dateRange struct {
	From time.Time `json:"-"`
	To   time.Time `json:"-"`
	// What the client should print above the numbers.
	Label  string `json:"label"`
	Period string `json:"period"`
	FromS  string `json:"from"`
	ToS    string `json:"to"`
}

// rangeOption is one entry in the picker. Published by the API so the client
// does not carry a second, drifting copy of the list.
type rangeOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Group string `json:"group"`
}

var rangePresets = []rangeOption{
	{"today", "Today", "Recent"},
	{"yesterday", "Yesterday", "Recent"},
	{"last_7", "Last 7 days", "Recent"},
	{"last_30", "Last 30 days", "Recent"},
	{"this_week", "This week", "Calendar"},
	{"this_month", "This month", "Calendar"},
	{"last_month", "Last month", "Calendar"},
	{"this_quarter", "This quarter", "Calendar"},
	{"this_term", "This term", "School"},
	{"this_year", "This academic year", "School"},
	{"last_year", "Last academic year", "School"},
	{"fin_year", "This financial year (Apr–Mar)", "School"},
	{"custom", "Custom range…", "Custom"},
}

func (s *Server) listRangePresets(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": rangePresets, "default": "this_month"})
}

// academicYearStart is the 1 June on or before the given day. Telangana and
// most of India run June to April; the financial year is a separate question
// and has its own preset.
func academicYearStart(now time.Time) time.Time {
	year := now.Year()
	if int(now.Month()) < int(time.June) {
		year--
	}
	return time.Date(year, time.June, 1, 0, 0, 0, 0, now.Location())
}

func financialYearStart(now time.Time) time.Time {
	year := now.Year()
	if int(now.Month()) < int(time.April) {
		year--
	}
	return time.Date(year, time.April, 1, 0, 0, 0, 0, now.Location())
}

/*
nowInIndia is the current moment in the only timezone this product has.

	A box running UTC rolls into tomorrow at half past five in the evening
	local, so "today" went blank every evening — a bug three separate files
	had each fixed for themselves before this existed.
*/
func nowInIndia() time.Time {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		// A container without tzdata should not make dates wrong by five and a
		// half hours in silence; the fixed offset is India's and does not
		// change with the season.
		loc = time.FixedZone("IST", 5*3600+1800)
	}
	return time.Now().In(loc)
}

// resolveRange reads ?period= or ?from=&to= and works out the bounds.
//
// Dates are resolved in Asia/Kolkata rather than the server's clock. A box in
// UTC rolls into tomorrow at 05:30 local, so "today's attendance" went blank
// every evening — the same bug the teacher's timetable already had to fix.
func resolveRange(r *http.Request) dateRange {
	now := nowInIndia()
	loc := now.Location()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)

	q := r.URL.Query()
	period := q.Get("period")

	// An explicit pair always wins; the client sends it for "custom".
	if f, t := q.Get("from"), q.Get("to"); f != "" && t != "" {
		from, e1 := time.ParseInLocation(time.DateOnly, f, loc)
		to, e2 := time.ParseInLocation(time.DateOnly, t, loc)
		if e1 == nil && e2 == nil {
			if to.Before(from) {
				from, to = to, from
			}
			return dateRange{From: from, To: to, Period: "custom",
				Label: from.Format("2 Jan 2006") + " to " + to.Format("2 Jan 2006"),
				FromS: from.Format(time.DateOnly), ToS: to.Format(time.DateOnly)}
		}
	}

	mk := func(from, to time.Time, label, p string) dateRange {
		return dateRange{From: from, To: to, Label: label, Period: p,
			FromS: from.Format(time.DateOnly), ToS: to.Format(time.DateOnly)}
	}

	switch period {
	case "today", "":
		if period == "" {
			period = "this_month"
			break
		}
		return mk(today, today, "Today", "today")
	case "yesterday":
		y := today.AddDate(0, 0, -1)
		return mk(y, y, "Yesterday", period)
	case "last_7":
		return mk(today.AddDate(0, 0, -6), today, "Last 7 days", period)
	case "last_30":
		return mk(today.AddDate(0, 0, -29), today, "Last 30 days", period)
	case "this_week":
		// Monday-first, which is how a school timetable is written.
		off := (int(today.Weekday()) + 6) % 7
		return mk(today.AddDate(0, 0, -off), today, "This week", period)
	case "last_month":
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc).AddDate(0, -1, 0)
		return mk(first, first.AddDate(0, 1, -1), "Last month — "+first.Format("January 2006"), period)
	case "this_quarter":
		q := (int(now.Month()) - 1) / 3
		first := time.Date(now.Year(), time.Month(q*3+1), 1, 0, 0, 0, 0, loc)
		return mk(first, today, "This quarter", period)
	case "this_term":
		// Falls back to the academic year when no term is configured; a school
		// that has not set terms up should still get a sensible answer.
		return mk(academicYearStart(now), today, "This term", period)
	case "this_year":
		s := academicYearStart(now)
		return mk(s, today, "This academic year — "+s.Format("2006")+"-"+
			s.AddDate(1, 0, 0).Format("06"), period)
	case "last_year":
		s := academicYearStart(now).AddDate(-1, 0, 0)
		return mk(s, s.AddDate(1, 0, -1), "Last academic year — "+s.Format("2006")+"-"+
			s.AddDate(1, 0, 0).Format("06"), period)
	case "fin_year":
		s := financialYearStart(now)
		return mk(s, today, "Financial year "+s.Format("2006")+"-"+
			s.AddDate(1, 0, 0).Format("06"), period)
	}

	first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
	return mk(first, today, "This month — "+first.Format("January 2006"), "this_month")
}
