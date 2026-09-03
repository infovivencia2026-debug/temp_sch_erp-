package api

import (
	"errors"
	"net/http"
	"regexp"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* THE MORNING GRACE WINDOW.

   A reader records the minute somebody's finger touched it; the school
   decides what that minute means. The rule lives in leave_policy beside the
   rest of the leave rules — shift start, minutes of grace, when late becomes
   a half day, how many late marks cost a day — and staff_lop_register applies
   it when payroll runs. This is the same four columns on their own, with the
   one thing the leave-rules page cannot show: the punches of the last two
   weeks that the current setting would mark late. Change the number and the
   list changes, before anybody's salary does.

   Nothing here rewrites an attendance row. The rollup from the reader records
   check-in and check-out; late is a judgement the register makes at month end
   from the policy in force, so changing the policy today corrects the whole
   month rather than only the days after the change. */

type punchGrace struct {
	ShiftStartsAt   string `json:"shift_starts_at"`
	GraceMinutes    int    `json:"grace_minutes"`
	LateHalfDayMins *int   `json:"late_half_day_after_minutes,omitempty"`
	LateMarksPerDay int    `json:"late_marks_per_lop_day"`
}

type latePunch struct {
	Employee    string `json:"employee"`
	OnDate      string `json:"on_date"`
	CheckIn     string `json:"check_in"` // HH:MM, school time
	MinutesLate int    `json:"minutes_late"`
	HalfDay     bool   `json:"half_day"`
}

type punchGraceResponse struct {
	punchGrace
	Recent    []latePunch `json:"recent"`
	DevicesOn int         `json:"devices_on"`
}

var hhmm = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// validatePunchGrace says what is wrong with a setting in the words the
// screen shows. The bounds are the table's own CHECKs, refused here so the
// person gets a sentence rather than a constraint name.
func validatePunchGrace(g punchGrace) error {
	if !hhmm.MatchString(g.ShiftStartsAt) {
		return errors.New("shift start must be a time like 09:00")
	}
	if g.GraceMinutes < 0 || g.GraceMinutes > 240 {
		return errors.New("grace must be between 0 and 240 minutes")
	}
	if g.LateHalfDayMins != nil && *g.LateHalfDayMins <= g.GraceMinutes {
		return errors.New("the half-day threshold must be later than the grace window")
	}
	if g.LateMarksPerDay <= 0 {
		return errors.New("say how many late marks make a day; zero would charge a day for every one")
	}
	return nil
}

func (s *Server) mountPunchGrace(r chi.Router) {
	r.With(httpx.RequirePermission(rbac.EmployeesRead)).Get("/punch-grace", s.getPunchGrace)
	r.With(httpx.RequirePermission(rbac.EmployeesWrite)).Put("/punch-grace", s.savePunchGrace)
}

const punchGraceColumns = `to_char(shift_starts_at,'HH24:MI'), grace_minutes,
	late_half_day_after_minutes, late_marks_per_lop_day`

func (s *Server) getPunchGrace(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := punchGraceResponse{Recent: []latePunch{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		scan := func() error {
			return tx.QueryRow(r.Context(),
				`SELECT `+punchGraceColumns+` FROM leave_policy WHERE institution_id = $1`,
				id.InstitutionID).Scan(&out.ShiftStartsAt, &out.GraceMinutes,
				&out.LateHalfDayMins, &out.LateMarksPerDay)
		}
		// Created on first read with the table's defaults, the way the leave
		// rules page does, so the two never disagree about what "unset" means.
		if err := scan(); errors.Is(err, pgx.ErrNoRows) {
			if _, err := tx.Exec(r.Context(),
				`INSERT INTO leave_policy (institution_id) VALUES ($1) ON CONFLICT DO NOTHING`,
				id.InstitutionID); err != nil {
				return err
			}
			if err := scan(); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(),
			`SELECT count(*)::int FROM biometric_devices WHERE is_active`).Scan(&out.DevicesOn); err != nil {
			return err
		}

		// The same arithmetic staff_lop_register uses, so the preview and the
		// payroll agree to the minute.
		rows, err := tx.Query(r.Context(), `
			SELECT trim(concat_ws(' ', e.first_name, e.last_name)),
			       to_char(sa.on_date, 'YYYY-MM-DD'),
			       to_char(sa.check_in AT TIME ZONE 'Asia/Kolkata', 'HH24:MI'),
			       GREATEST(0, (EXTRACT(epoch FROM
			           (sa.check_in AT TIME ZONE 'Asia/Kolkata')::time - pol.shift_starts_at) / 60)::integer),
			       pol.late_half_day_after_minutes
			  FROM staff_attendance sa
			  JOIN employees e ON e.user_id = sa.user_id
			  JOIN leave_policy pol ON pol.institution_id = sa.institution_id
			 WHERE sa.source = 'device' AND sa.check_in IS NOT NULL
			   AND sa.on_date >= CURRENT_DATE - 14
			   AND (sa.check_in AT TIME ZONE 'Asia/Kolkata')::time
			       > pol.shift_starts_at + make_interval(mins => pol.grace_minutes)
			 ORDER BY sa.on_date DESC, 4 DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var p latePunch
			var half *int
			if err := rows.Scan(&p.Employee, &p.OnDate, &p.CheckIn, &p.MinutesLate, &half); err != nil {
				return err
			}
			p.HalfDay = half != nil && p.MinutesLate >= *half
			out.Recent = append(out.Recent, p)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) savePunchGrace(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req punchGrace
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.ShiftStartsAt == "" {
		req.ShiftStartsAt = "09:00"
	}
	if err := validatePunchGrace(req); err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Only these four columns move. The rest of the policy row belongs to
		// the leave-rules page and keeps whatever it was set to there.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO leave_policy (institution_id, shift_starts_at, grace_minutes,
			    late_half_day_after_minutes, late_marks_per_lop_day)
			VALUES ($1, $2::time, $3, $4, $5)
			ON CONFLICT (institution_id) DO UPDATE SET
			    shift_starts_at = EXCLUDED.shift_starts_at,
			    grace_minutes = EXCLUDED.grace_minutes,
			    late_half_day_after_minutes = EXCLUDED.late_half_day_after_minutes,
			    late_marks_per_lop_day = EXCLUDED.late_marks_per_lop_day`,
			id.InstitutionID, req.ShiftStartsAt, req.GraceMinutes, req.LateHalfDayMins, req.LateMarksPerDay)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, req)
}
