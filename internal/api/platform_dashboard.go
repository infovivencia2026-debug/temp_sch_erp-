package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The platform cockpit.

   A trust running six campuses had no screen that showed six campuses. The
   principal's dashboard is scoped to one institution by design, so the person
   above them was reading six of those in six tabs and adding the numbers up by
   hand — which is how a month-end report ends up wrong.

   Everything here reads across tenants and is therefore platform-only. It is
   deliberately aggregate: a campus card carries counts and money, never a
   child's name. Someone who needs a name uses the acting-institution switch
   and enters that school properly, where the audit trail records it. */

type campusCard struct {
	InstitutionID string  `json:"institution_id"`
	School        string  `json:"school"`
	Campus        string  `json:"campus"`
	District      *string `json:"district,omitempty"`
	Students      int     `json:"students"`
	Staff         int     `json:"staff"`
	// Attendance today, as a percentage of the register actually marked. A
	// campus that has not marked anything reports null rather than zero —
	// "nobody came" and "nobody has taken the register" are different
	// emergencies.
	AttendancePct    *int  `json:"attendance_pct,omitempty"`
	MarkedToday      int   `json:"marked_today"`
	CollectedPaise   int64 `json:"collected_paise"`
	OutstandingPaise int64 `json:"outstanding_paise"`
	Defaulters       int   `json:"defaulters"`
}

type platformAlert struct {
	Severity string  `json:"severity"`
	Kind     string  `json:"kind"`
	School   *string `json:"school,omitempty"`
	Message  string  `json:"message"`
}

type platformDashboard struct {
	Range dateRange `json:"range"`

	Schools  int `json:"schools"`
	Campuses int `json:"campuses"`
	Students int `json:"students"`
	Staff    int `json:"staff"`

	CollectedPaise   int64 `json:"collected_paise"`
	OutstandingPaise int64 `json:"outstanding_paise"`

	// The admission funnel, end to end, across every school.
	Enquiries    int `json:"enquiries"`
	Applications int `json:"applications"`
	Offered      int `json:"offered"`
	Enrolled     int `json:"enrolled"`

	Cards  []campusCard    `json:"campuses_detail"`
	Alerts []platformAlert `json:"alerts"`
	// Attendance by day across the whole platform, for the heatmap.
	Attendance []attendanceDay `json:"attendance_trend"`
}

type attendanceDay struct {
	Date    string `json:"date"`
	Percent int    `json:"percent"`
	Marked  int    `json:"marked"`
}

// getPlatformDashboard aggregates every school on the installation.
func (s *Server) getPlatformDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil || !id.PlatformAdmin {
		httpx.Denied(w, r, "only platform staff can see across schools")
		return
	}
	out := platformDashboard{
		Range: resolveRange(r), Cards: []campusCard{},
		Alerts: []platformAlert{}, Attendance: []attendanceDay{},
	}

	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*) FROM institutions WHERE status = 'active')::int,
			       (SELECT count(*) FROM campuses)::int,
			       (SELECT count(*) FROM students  WHERE status = 'active')::int,
			       (SELECT count(*) FROM employees WHERE status = 'active')::int,
			       COALESCE((SELECT sum(amount_paise) FROM payments
			                  WHERE status = 'success'
			                    AND paid_on BETWEEN $1 AND $2), 0),
			       COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
			                  WHERE status IN ('unpaid','partial','overdue')), 0),
			       (SELECT count(*) FROM enquiries
			         WHERE created_at::date BETWEEN $1 AND $2)::int,
			       (SELECT count(*) FROM applications
			         WHERE created_at::date BETWEEN $1 AND $2)::int,
			       (SELECT count(*) FROM applications
			         WHERE status = 'offered'
			           AND created_at::date BETWEEN $1 AND $2)::int,
			       (SELECT count(*) FROM applications
			         WHERE status = 'accepted'
			           AND created_at::date BETWEEN $1 AND $2)::int`,
			out.Range.From, out.Range.To).
			Scan(&out.Schools, &out.Campuses, &out.Students, &out.Staff,
				&out.CollectedPaise, &out.OutstandingPaise,
				&out.Enquiries, &out.Applications, &out.Offered, &out.Enrolled); err != nil {
			return err
		}

		// One card per campus. The trust's own unit of management is the
		// campus, not the legal institution — a group with three campuses
		// under one registration still runs three sets of registers.
		rows, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.name, c.name, i.district,
			       (SELECT count(*) FROM students st
			         WHERE st.campus_id = c.id AND st.status = 'active')::int,
			       (SELECT count(*) FROM employees e
			         WHERE e.campus_id = c.id AND e.status = 'active')::int,
			       (SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
			                     / NULLIF(count(*),0))::int
			          FROM student_attendance sa
			          JOIN students st2 ON st2.id = sa.student_id
			         WHERE st2.campus_id = c.id AND sa.on_date = CURRENT_DATE),
			       (SELECT count(*) FROM student_attendance sa
			          JOIN students st3 ON st3.id = sa.student_id
			         WHERE st3.campus_id = c.id AND sa.on_date = CURRENT_DATE)::int,
			       COALESCE((SELECT sum(p.amount_paise) FROM payments p
			                  WHERE p.campus_id = c.id AND p.status = 'success'
			                    AND p.paid_on BETWEEN $1 AND $2), 0),
			       COALESCE((SELECT sum(v.net_paise - v.paid_paise) FROM invoices v
			                  WHERE v.campus_id = c.id
			                    AND v.status IN ('unpaid','partial','overdue')), 0),
			       (SELECT count(DISTINCT v2.student_id) FROM invoices v2
			         WHERE v2.campus_id = c.id
			           AND v2.status IN ('unpaid','partial','overdue')
			           AND v2.due_on IS NOT NULL AND v2.due_on < CURRENT_DATE)::int
			  FROM campuses c
			  JOIN institutions i ON i.id = c.institution_id
			 ORDER BY i.name, c.name`, out.Range.From, out.Range.To)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v campusCard
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.Campus, &v.District,
				&v.Students, &v.Staff, &v.AttendancePct, &v.MarkedToday,
				&v.CollectedPaise, &v.OutstandingPaise, &v.Defaulters); err != nil {
				return err
			}
			out.Cards = append(out.Cards, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// Attendance across the platform, day by day.
		arows, err := tx.Query(r.Context(), `
			SELECT to_char(on_date,'YYYY-MM-DD'),
			       round(100.0 * count(*) FILTER (WHERE status IN ('present','late'))
			             / NULLIF(count(*),0))::int,
			       count(*)::int
			  FROM student_attendance
			 WHERE on_date BETWEEN $1 AND $2
			 GROUP BY on_date ORDER BY on_date`, out.Range.From, out.Range.To)
		if err != nil {
			return err
		}
		defer arows.Close()
		for arows.Next() {
			var d attendanceDay
			if err := arows.Scan(&d.Date, &d.Percent, &d.Marked); err != nil {
				return err
			}
			out.Attendance = append(out.Attendance, d)
		}
		return arows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Alerts are derived, not stored.

	   A stored alert needs someone to clear it, and an alert list nobody
	   clears becomes wallpaper. These are recomputed every time the screen
	   opens, so an alert disappears the moment the thing it describes is
	   fixed — which is the only way anyone keeps trusting them. */
	for i := range out.Cards {
		c := out.Cards[i]
		school := c.School + " · " + c.Campus
		switch {
		case c.Students > 0 && c.MarkedToday == 0:
			out.Alerts = append(out.Alerts, platformAlert{
				Severity: "high", Kind: "attendance", School: &school,
				Message: "No register marked today across " +
					itoa(c.Students) + " students",
			})
		case c.AttendancePct != nil && *c.AttendancePct < 75:
			out.Alerts = append(out.Alerts, platformAlert{
				Severity: "medium", Kind: "attendance", School: &school,
				Message: "Attendance at " + itoa(*c.AttendancePct) +
					"% today, below the 75% board threshold",
			})
		}
		if c.Defaulters > 0 && c.Students > 0 && c.Defaulters*100/c.Students > 25 {
			out.Alerts = append(out.Alerts, platformAlert{
				Severity: "medium", Kind: "fees", School: &school,
				Message: itoa(c.Defaulters) + " of " + itoa(c.Students) +
					" students are overdue on fees",
			})
		}
		if c.Students == 0 {
			out.Alerts = append(out.Alerts, platformAlert{
				Severity: "low", Kind: "setup", School: &school,
				Message: "No students enrolled. Setup may be unfinished",
			})
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}
