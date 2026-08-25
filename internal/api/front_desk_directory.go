package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Who they are here to see.

   The visitor form asks for a host, and the host list was fetched from
   /hr/employees — which is gated on hr.employees.read, the permission that
   also opens payroll, staff documents and the HR dashboard. Neither the
   receptionist nor the admissions clerk holds it, and neither should. So the
   request came back 403, the dropdown came back empty, and the one question
   every visitor is asked at the gate had no answer in it.

   The fix is not to widen the gate. A desk needs a list of names to point at,
   which is a smaller thing than a staff record: name, designation, and the
   employee code that tells two Ganesh Guptas apart. Nothing about pay, nothing
   about documents, nobody who has left.

   Gated on reading the front desk registers, because that is exactly who has
   to ask the question. */

type deskPerson struct {
	ID          string  `json:"id"`
	Name        string  `json:"full_name"`
	Code        *string `json:"employee_code,omitempty"`
	Designation *string `json:"designation,omitempty"`
}

// listDeskStaff is the host list on the visitor and appointment forms.
func (s *Server) listDeskStaff(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT u.id::text, u.full_name, e.employee_code, e.designation
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		 WHERE e.status IN ('active','on_leave')
		 ORDER BY u.full_name`,
		nil,
		func(rows pgx.Rows) (deskPerson, error) {
			var v deskPerson
			err := rows.Scan(&v.ID, &v.Name, &v.Code, &v.Designation)
			return v, err
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
