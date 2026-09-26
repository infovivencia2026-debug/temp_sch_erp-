package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE DAY'S REGISTER, EVERY SECTION, ONE FILE.

   The register screen exported one section at a time -- the one on screen
   -- so a school that wanted the day's attendance for the inspector, or for
   the transport desk, exported eleven files and stitched them. The header's
   other export was the opposite extreme: ninety days of the whole school,
   and behind a permission a class teacher does not hold.

   This is the middle: one date, every section the caller can see, every
   child on those rolls -- marked or not. "Not marked" is a row, because a
   register that silently omits the children nobody marked is the register
   that hides the half-done section. Scoped exactly as the register itself
   is (Resolved.AttendancePredicate): a class teacher gets their sections, a
   head their department, the office the school. */
func (s *Server) exportAttendanceDay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	on := strings.TrimSpace(r.URL.Query().Get("on_date"))
	if on == "" {
		on = time.Now().Format(time.DateOnly)
	}
	if _, err := time.Parse(time.DateOnly, on); err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// The roll is read through enrollments, which carry the same section_id
	// and student_id columns the predicate names, so the reach is identical
	// to the register's.
	pred, scopeArgs := res.AttendancePredicate("e", 2)
	args := append([]any{on}, scopeArgs...)

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="attendance-%s-all-sections.csv"`, on))
	// Excel reads UTF-8 as ANSI without a BOM; names in Telugu would break.
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"Date", "Class", "Section", "Roll no", "Admission no", "Student", "Status", "Minutes late", "Remarks"})

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT COALESCE(c.name,''), COALESCE(sec.name,''),
			       COALESCE(e.roll_no::text,''), st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       COALESCE(sa.status, 'not marked'),
			       COALESCE(sa.minutes_late::text, ''), COALESCE(sa.remarks, '')
			  FROM enrollments e
			  JOIN students st ON st.id = e.student_id
			  JOIN sections sec ON sec.id = e.section_id
			  LEFT JOIN classes c ON c.id = sec.class_id
			  LEFT JOIN student_attendance sa
			         ON sa.student_id = e.student_id AND sa.section_id = e.section_id
			        AND sa.on_date = $1::date AND sa.period_id IS NULL
			 WHERE e.status = 'active' AND st.status = 'active'
			   AND `+pred+`
			 ORDER BY c.level NULLS LAST, sec.name, e.roll_no NULLS LAST, st.admission_no`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var class, section, roll, adm, name, status, late, remarks string
			if err := rows.Scan(&class, &section, &roll, &adm, &name, &status, &late, &remarks); err != nil {
				return err
			}
			if err := cw.Write([]string{on, class, section, roll, adm, name, status, late, remarks}); err != nil {
				return err
			}
		}
		return rows.Err()
	})
	cw.Flush()
	if err != nil {
		// Headers are gone; the honest signal left is a marker row.
		_ = cw.Write([]string{"ERROR", err.Error()})
		cw.Flush()
	}
}
