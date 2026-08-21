package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Approvals, leave, staff attendance and homework.

   These close four holes the audit turned up: leave_requests was readable but
   nothing could write it, staff_attendance had no writer at all (so payroll's
   loss-of-pay was permanently zero and every payslip silently overpaid),
   homework was read once and written never, and the four things a principal
   approves lived at four unrelated endpoints with no queue. */

// --- leave --------------------------------------------------------------------

type leaveApplyRequest struct {
	LeaveTypeID string `json:"leave_type_id,omitempty"`
	FromDate    string `json:"from_date"`
	ToDate      string `json:"to_date"`
	IsHalfDay   bool   `json:"is_half_day"`
	Reason      string `json:"reason"`
	// StudentID lets a guardian apply on a child's behalf. Omitted, the
	// applicant is the signed-in employee.
	StudentID string `json:"student_id,omitempty"`
}

// applyForLeave records a leave request from a staff member or a guardian.
func (s *Server) applyForLeave(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req leaveApplyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	from, err := time.Parse(time.DateOnly, req.FromDate)
	if err != nil {
		httpx.BadRequest(w, r, "from_date must be YYYY-MM-DD")
		return
	}
	to, err := time.Parse(time.DateOnly, req.ToDate)
	if err != nil {
		httpx.BadRequest(w, r, "to_date must be YYYY-MM-DD")
		return
	}
	if to.Before(from) {
		httpx.BadRequest(w, r, "the leave ends before it starts")
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "a reason is required")
		return
	}

	days := to.Sub(from).Hours()/24 + 1
	if req.IsHalfDay {
		days = 0.5
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var employeeID, studentID any

		if req.StudentID != "" {
			sid, perr := uuid.Parse(req.StudentID)
			// A guardian may only apply for their own child.
			if perr != nil || !res.OwnsStudent(sid) {
				return errNotYourChild
			}
			studentID = sid
		} else {
			var eid uuid.UUID
			if err := tx.QueryRow(r.Context(),
				`SELECT id FROM employees WHERE user_id = $1`, id.UserID).Scan(&eid); err != nil {
				return errNotAnEmployee
			}
			employeeID = eid
		}

		// 'staff', not 'employee': the column's check constraint spells it that way.
		kind := "staff"
		if studentID != nil {
			kind = "student"
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO leave_requests (institution_id, leave_type_id, subject_kind,
			                            employee_id, student_id, from_date, to_date,
			                            is_half_day, days, reason, status, applied_by)
			VALUES ($1,$2::uuid,$3,$4,$5,$6::date,$7::date,$8,$9,$10,'pending',$11)
			RETURNING id::text`,
			id.InstitutionID, nullString(req.LeaveTypeID), kind, employeeID, studentID,
			req.FromDate, req.ToDate, req.IsHalfDay, days, req.Reason, id.UserID).Scan(&newID); err != nil {
			return err
		}

		/* Tell the people who can answer it.

		   The request landed in a queue and waited for somebody to open that
		   queue. A member of staff who applies on Friday afternoon has no way
		   to know whether anybody has looked, and the approver has no way to
		   know there is anything to look at — which is how a one-day leave sits
		   pending for a week and gets taken anyway.

		   Everyone who can approve, not one nominated person: a school with no
		   head of department still has a principal, and a request that waits
		   for a desk nobody sits at is never answered. Whoever gets there first
		   decides it, and the others' notification becomes stale rather than
		   wrong — the queue itself is the record. */
		if kind == "staff" {
			var who string
			if err := tx.QueryRow(r.Context(),
				`SELECT full_name FROM users WHERE id = $1`, id.UserID).Scan(&who); err != nil {
				return err
			}
			// The role comes back with the person, because the link has to
			// open in their own workspace: a head of department sent to the
			// principal's URL gets a page they cannot open.
			rows, err := tx.Query(r.Context(), `
				SELECT DISTINCT ON (u.id) u.id, r.key
				  FROM users u
				  JOIN user_roles ur ON ur.user_id = u.id
				  JOIN roles r ON r.id = ur.role_id
				  JOIN role_permissions rp ON rp.role_id = r.id
				 WHERE u.institution_id = $1
				   AND u.status = 'active'
				   AND u.id <> $2
				   AND rp.permission_key = 'hr.leave.approve'
				 ORDER BY u.id, CASE r.key
				                  WHEN 'institution_admin' THEN 0
				                  WHEN 'hod' THEN 1
				                  ELSE 2 END`,
				id.InstitutionID, id.UserID)
			if err != nil {
				return err
			}
			type approver struct {
				id   uuid.UUID
				role string
			}
			var approvers []approver
			for rows.Next() {
				var a approver
				if err := rows.Scan(&a.id, &a.role); err != nil {
					rows.Close()
					return err
				}
				approvers = append(approvers, a)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}

			leaveID, perr := uuid.Parse(newID)
			if perr != nil {
				return perr
			}
			span := req.FromDate
			if req.ToDate != req.FromDate {
				span += " to " + req.ToDate
			}
			for _, to := range approvers {
				if err := notify(r, tx, id.InstitutionID, to.id, nil, "leave_request",
					who+" has applied for leave",
					span+" — "+req.Reason+". Approve or reject it from Approvals.",
					"/"+to.role+"/approvals/approvals",
					"leave_request", &leaveID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if errors.Is(err, errNotYourChild) {
		httpx.NotFound(w, r)
		return
	}
	if errors.Is(err, errNotAnEmployee) {
		httpx.BadRequest(w, r,
			"your account is not linked to an employee record, so it cannot apply for staff leave")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": newID, "days": days, "status": "pending",
	})
}

var (
	errNotYourChild     = errors.New("not your child")
	errSubjectNotTaught = errors.New("subject not taught to this class")
	errNotAnEmployee    = errors.New("not an employee")
)

type decideLeaveRequest struct {
	Decision string `json:"decision"` // approved | rejected
	Note     string `json:"note,omitempty"`
}

// decideLeave approves or rejects, and deducts the balance on approval.
func (s *Server) decideLeave(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	lid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid leave request id")
		return
	}
	var req decideLeaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Decision != "approved" && req.Decision != "rejected" {
		httpx.BadRequest(w, r, "decision must be approved or rejected")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var employeeID *uuid.UUID
		var leaveTypeID *uuid.UUID
		var days float64
		var appliedBy *uuid.UUID
		// Who may answer this one. HR answers anything; a class teacher
		// answers their own students and nothing else. The predicate is part
		// of the UPDATE rather than a check before it, so a request that is
		// not theirs simply matches no row instead of being read first and
		// refused second.
		guard := ` AND (
			$5 OR EXISTS (
				SELECT 1 FROM students st
				  JOIN LATERAL (
				      SELECT e.section_id FROM enrollments e
				       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
				  ) en ON true
				  JOIN sections sec ON sec.id = en.section_id
				 WHERE st.id = leave_requests.student_id AND sec.class_teacher_id = $6
			))`
		if err := tx.QueryRow(r.Context(), `
			UPDATE leave_requests
			   SET status = $2, decided_by = $3, decided_at = now(),
			       decision_note = COALESCE($4, decision_note)
			 WHERE id = $1 AND status = 'pending'`+guard+`
			 RETURNING employee_id, leave_type_id, days, applied_by`,
			lid, req.Decision, id.UserID, nullString(req.Note),
			id.Can(rbac.LeaveApprove), id.UserID).
			Scan(&employeeID, &leaveTypeID, &days, &appliedBy); err != nil {
			return err
		}

		/* Tell the person who asked.

		   A decision that nobody is told about is a decision the applicant
		   discovers by opening the screen again on the off-chance — and the
		   whole point of applying in a system rather than in the corridor is
		   not having to. Approved or rejected: a refusal matters more, because
		   somebody may otherwise not come in.

		   The link goes to their own workspace's leave screen, not the
		   approver's queue, which they cannot open. */
		if appliedBy != nil {
			var role string
			if err := tx.QueryRow(r.Context(), `
				SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
				 WHERE ur.user_id = $1
				 ORDER BY CASE r.key
				            WHEN 'institution_admin' THEN 0
				            WHEN 'hod' THEN 1
				            WHEN 'faculty' THEN 2
				            ELSE 3 END
				 LIMIT 1`, *appliedBy).Scan(&role); err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				role = "faculty"
			}
			title := "Your leave was approved"
			body := "Approved by " + id.FullName + "."
			if req.Decision != "approved" {
				title = "Your leave was not approved"
				body = "Rejected by " + id.FullName + "."
			}
			if strings.TrimSpace(req.Note) != "" {
				body += " " + strings.TrimSpace(req.Note)
			}
			if err := notify(r, tx, id.InstitutionID, *appliedBy, nil, "leave_decided",
				title, body, "/"+role+"/my_profile/leave_self_service",
				"leave_request", &lid); err != nil {
				return err
			}
		}

		if req.Decision != "approved" || employeeID == nil || leaveTypeID == nil {
			return nil
		}
		// Deduct from the balance so the entitlement means something. Without
		// this a teacher could take thirty casual leaves and the counter would
		// still read twelve.
		_, err := tx.Exec(r.Context(), `
			UPDATE leave_balances SET used = used + $3
			 WHERE employee_id = $1 AND leave_type_id = $2`,
			*employeeID, *leaveTypeID, days)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no pending leave request with that id")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": lid.String(), "status": req.Decision})
}

// --- staff attendance -----------------------------------------------------------

type staffAttendanceRequest struct {
	OnDate  string `json:"on_date,omitempty"`
	Entries []struct {
		UserID   string `json:"user_id"`
		Status   string `json:"status"`
		CheckIn  string `json:"check_in,omitempty"`
		CheckOut string `json:"check_out,omitempty"`
	} `json:"entries"`
}

// markStaffAttendance records the staff register.
//
// Nothing could write this table, yet runPayroll derives loss of pay from it —
// so every payslip paid a full month regardless of absence. This is the writer
// that makes the deduction real.
func (s *Server) markStaffAttendance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req staffAttendanceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.OnDate == "" {
		req.OnDate = time.Now().Format(time.DateOnly)
	}
	if _, err := time.Parse(time.DateOnly, req.OnDate); err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	if len(req.Entries) == 0 {
		httpx.BadRequest(w, r, "entries must not be empty")
		return
	}
	// Exactly the set staff_attendance_status_check allows.
	valid := map[string]bool{"present": true, "absent": true, "late": true,
		"half_day": true, "leave": true, "holiday": true, "week_off": true}
	for _, e := range req.Entries {
		if !valid[e.Status] {
			httpx.BadRequest(w, r, "invalid status: "+e.Status)
			return
		}
	}

	written := 0
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		campus, err := ensureCampus(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		for _, e := range req.Entries {
			uid, err := uuid.Parse(e.UserID)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO staff_attendance (institution_id, campus_id, user_id, on_date,
				                              status, check_in, check_out, source, marked_by)
				-- check_in/check_out are timestamptz, not time: the caller sends
				-- a wall-clock "09:05" and it is anchored to the register's date.
				VALUES ($1,$2,$3,$4::date,$5,
				        CASE WHEN $6::text IS NULL THEN NULL
				             ELSE ($4::date + $6::time) AT TIME ZONE COALESCE(
				                  (SELECT timezone FROM institutions LIMIT 1),'UTC') END,
				        CASE WHEN $7::text IS NULL THEN NULL
				             ELSE ($4::date + $7::time) AT TIME ZONE COALESCE(
				                  (SELECT timezone FROM institutions LIMIT 1),'UTC') END,
				        'manual',$8)
				ON CONFLICT (user_id, on_date) DO UPDATE
				   SET status = EXCLUDED.status, check_in = EXCLUDED.check_in,
				       check_out = EXCLUDED.check_out, marked_by = EXCLUDED.marked_by`,
				id.InstitutionID, campus, uid, req.OnDate, e.Status,
				nullString(e.CheckIn), nullString(e.CheckOut), id.UserID); err != nil {
				return err
			}
			written++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"on_date": req.OnDate, "written": written})
}

type staffRegisterRow struct {
	UserID   string  `json:"user_id"`
	Code     string  `json:"employee_code"`
	FullName string  `json:"full_name"`
	Status   *string `json:"status,omitempty"`
	CheckIn  *string `json:"check_in,omitempty"`
}

// getStaffRegister returns every employee with today's mark, so the office
// edits a list rather than typing names.
func (s *Server) getStaffRegister(w http.ResponseWriter, r *http.Request) {
	on := r.URL.Query().Get("on_date")
	if on == "" {
		on = time.Now().Format(time.DateOnly)
	}
	items, err := collect(s, r, `
		SELECT u.id::text, e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name),
		       sa.status, to_char(sa.check_in,'HH24:MI')
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN staff_attendance sa
		         ON sa.user_id = u.id AND sa.on_date = $1::date
		 WHERE e.status = 'active'
		 ORDER BY e.employee_code`, []any{on},
		func(rows pgx.Rows) (staffRegisterRow, error) {
			var v staffRegisterRow
			return v, rows.Scan(&v.UserID, &v.Code, &v.FullName, &v.Status, &v.CheckIn)
		})
	respond(w, r, items, err)
}

// --- approvals inbox -------------------------------------------------------------

type approvalItem struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Detail    string  `json:"detail"`
	Requester *string `json:"requested_by,omitempty"`
	RaisedAt  string  `json:"raised_at"`
	DecideURL string  `json:"decide_url"`
	Amount    *int64  `json:"amount_paise,omitempty"`
}

// getApprovals is the single queue of everything waiting on this user.
//
// Leave, attendance corrections and fee concessions were three unrelated
// endpoints, so a principal had to remember to visit three screens to find out
// whether anything needed them. One inbox is the difference between approvals
// happening the same day and piling up for a fortnight.
func (s *Server) getApprovals(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	out := []approvalItem{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if id.Can("hr.leave.approve") || id.Can("access.users.write") {
			/* Whoever runs the school rather than one department: the
			   principal, HR and the office. A HOD holds leave approval and
			   not these, which is what separates the two lists. */
			schoolWide := id.Can(rbac.EmployeesWrite) || id.Can(rbac.UsersWrite)
			if err := scanInto(r.Context(), tx, `
				SELECT lr.id::text,
				       -- NULLIF matters: concat_ws returns '' (not NULL) when all
				       -- its arguments are NULL, so without it the empty employee
				       -- name wins the COALESCE and a student's leave shows blank.
				       COALESCE(NULLIF(concat_ws(' ', e.first_name, e.last_name), ''),
				                NULLIF(concat_ws(' ', st.first_name, st.last_name), ''),
				                'Someone'),
				       COALESCE(lt.name,'Leave'),
				       to_char(lr.from_date,'DD Mon') || ' to ' || to_char(lr.to_date,'DD Mon')
				         || ' (' || lr.days || ' day' || CASE WHEN lr.days = 1 THEN '' ELSE 's' END || ')',
				       lr.reason, u.full_name,
				       to_char(lr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
				  FROM leave_requests lr
				  LEFT JOIN employees e ON e.id = lr.employee_id
				  LEFT JOIN students st ON st.id = lr.student_id
				  LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
				  LEFT JOIN users u ON u.id = lr.applied_by
				 WHERE lr.status = 'pending'
				   /* A head of department sees their own department; anybody
				      who runs the school sees all of it.

				      Every approver saw every request, so a HOD of six people
				      read the whole school's leave to find the two rows that
				      were theirs — and the principal and the HOD were looking
				      at the same undifferentiated list.

				      Either may approve, and the first to do so decides it.
				      A two-step gate would be tidier on a diagram and wrong
				      in practice: plenty of schools have no HOD at all, and a
				      request that must pass a desk nobody sits at never gets
				      approved. Long leave is flagged for the principal rather
				      than held for them.

				      A staff member with no department, and every student
				      request, stays visible to whoever can approve at all —
				      the narrowing must not make a request invisible to
				      everybody. */
				   AND ($1::bool
				        OR lr.subject_kind <> 'staff'
				        OR e.department_id IS NULL
				        OR EXISTS (SELECT 1 FROM departments d
				                    WHERE d.id = e.department_id
				                      AND d.head_user_id = $2))
				 ORDER BY lr.days DESC, lr.created_at`,
				func(rows pgx.Rows) error {
					var lid, who, kind, span, reason, raised string
					var by *string
					if err := rows.Scan(&lid, &who, &kind, &span, &reason, &by, &raised); err != nil {
						return err
					}
					out = append(out, approvalItem{
						ID: lid, Kind: "leave",
						Title:     who + " — " + kind,
						Detail:    span + ". " + reason,
						Requester: by, RaisedAt: raised,
						DecideURL: "/api/v1/workflow/leave/" + lid + "/decide",
					})
					return nil
				}, schoolWide, id.UserID); err != nil {
				return err
			}
		}

		/* A child's leave belongs to their class teacher.

		   Every pending request — a teacher's casual leave and a six-year-old's
		   fever — went to whoever holds hr.leave.approve, and nowhere else. So
		   the person who marks that child's register, notices the empty chair
		   and has to decide whether it is explained never saw the note their
		   parent sent. HR did, which is the wrong desk: HR does not know
		   whether the child was in school yesterday.

		   Staff leave still goes to HR alone, because that is an employment
		   decision with a balance behind it. Student leave now reaches both:
		   the class teacher because it is theirs to act on, and HR because the
		   attendance return is theirs to answer for. */
		if !id.Can("hr.leave.approve") {
			if err := scanInto(r.Context(), tx, `
				SELECT lr.id::text,
				       concat_ws(' ', st.first_name, st.last_name),
				       COALESCE(lt.name,'Leave'),
				       to_char(lr.from_date,'DD Mon') || ' to ' || to_char(lr.to_date,'DD Mon')
				         || ' (' || lr.days || ' day' || CASE WHEN lr.days = 1 THEN '' ELSE 's' END || ')',
				       lr.reason, u.full_name,
				       to_char(lr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
				  FROM leave_requests lr
				  JOIN students st ON st.id = lr.student_id
				  JOIN LATERAL (
				      SELECT e.section_id FROM enrollments e
				       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
				  ) en ON true
				  JOIN sections sec ON sec.id = en.section_id AND sec.class_teacher_id = $1
				  LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
				  LEFT JOIN users u ON u.id = lr.applied_by
				 WHERE lr.status = 'pending' AND lr.subject_kind = 'student'
				 ORDER BY lr.created_at`,
				func(rows pgx.Rows) error {
					var lid, who, kind, span, reason, raised string
					var by *string
					if err := rows.Scan(&lid, &who, &kind, &span, &reason, &by, &raised); err != nil {
						return err
					}
					out = append(out, approvalItem{
						ID: lid, Kind: "leave",
						Title:     who + " — " + kind,
						Detail:    span + ". " + reason,
						Requester: by, RaisedAt: raised,
						DecideURL: "/api/v1/workflow/leave/" + lid + "/decide",
					})
					return nil
				}, id.UserID); err != nil {
				return err
			}
		}

		if id.Can("academics.attendance.read.all") || id.Can("hr.leave.approve") {
			if err := scanInto(r.Context(), tx, `
				SELECT ac.id::text,
				       concat_ws(' ', st.first_name, st.last_name),
				       to_char(sa.on_date,'DD Mon'), ac.from_status, ac.to_status,
				       ac.reason, u.full_name,
				       to_char(ac.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
				  FROM attendance_corrections ac
				  JOIN student_attendance sa ON sa.id = ac.attendance_id
				  JOIN students st ON st.id = sa.student_id
				  LEFT JOIN users u ON u.id = ac.requested_by
				 WHERE ac.status = 'pending'
				 ORDER BY ac.created_at`,
				func(rows pgx.Rows) error {
					var cid, who, on, from, to, reason, raised string
					var by *string
					if err := rows.Scan(&cid, &who, &on, &from, &to, &reason, &by, &raised); err != nil {
						return err
					}
					out = append(out, approvalItem{
						ID: cid, Kind: "attendance_correction",
						Title:     who + " — attendance on " + on,
						Detail:    from + " to " + to + ". " + reason,
						Requester: by, RaisedAt: raised,
						DecideURL: "/api/v1/attendance-workflow/corrections/" + cid + "/decide",
					})
					return nil
				}); err != nil {
				return err
			}
		}

		if id.Can("finance.fees.write") {
			// A concession with no approver is money the school has decided not
			// to collect, so it belongs in the same queue as everything else.
			return scanInto(r.Context(), tx, `
				SELECT fc.id::text,
				       concat_ws(' ', st.first_name, st.last_name),
				       fc.kind, COALESCE(fc.reason,''), fc.amount_paise,
				       to_char(fc.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
				  FROM fee_concessions fc
				  JOIN students st ON st.id = fc.student_id
				 WHERE fc.approved_at IS NULL
				 ORDER BY fc.created_at`,
				func(rows pgx.Rows) error {
					var cid, who, kind, reason, raised string
					var amount *int64
					if err := rows.Scan(&cid, &who, &kind, &reason, &amount, &raised); err != nil {
						return err
					}
					out = append(out, approvalItem{
						ID: cid, Kind: "fee_concession",
						Title:    who + " — " + kind + " concession",
						Detail:   reason,
						RaisedAt: raised, Amount: amount,
						DecideURL: "/api/v1/workflow/concessions/" + cid + "/decide",
					})
					return nil
				})
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	byKind := map[string]int{}
	for _, a := range out {
		byKind[a.Kind]++
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": out, "total": len(out), "by_kind": byKind,
	})
}

// decideConcession approves or rejects a fee waiver.
func (s *Server) decideConcession(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid concession id")
		return
	}
	var req decideLeaveRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.Decision == "rejected" {
			tag, err := tx.Exec(r.Context(),
				`DELETE FROM fee_concessions WHERE id = $1 AND approved_at IS NULL`, cid)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			return nil
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE fee_concessions SET approved_by = $2, approved_at = now()
			 WHERE id = $1 AND approved_at IS NULL`, cid, id.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, r, http.StatusNotFound, "not_found", "no pending concession with that id")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": cid.String(), "status": req.Decision})
}

// --- homework -------------------------------------------------------------------

type homeworkRequest struct {
	SectionID      string `json:"section_id"`
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	// SubjectID is what a teacher actually knows. class_subject_id is an
	// internal join row; requiring it would mean the caller has to look up
	// the class-subject link before it can set a maths exercise.
	SubjectID    string `json:"subject_id,omitempty"`
	Kind         string `json:"kind,omitempty"`
	Title        string `json:"title"`
	Instructions string `json:"instructions,omitempty"`
	DueOn        string `json:"due_on,omitempty"`
	MaxMarks     *int   `json:"max_marks,omitempty"`
	// Pointer so an omitted field can default to true. Homework a student
	// cannot turn in is the less useful default, and the flag is easy to
	// forget; an explicit false still switches submissions off.
	AllowSubmission *bool `json:"allow_submission,omitempty"`
}

// publishHomework sets homework for a section.
//
// Homework is the feature parents open the app for — every competitor leads
// with it — and it was the one table read but never written.
func (s *Server) publishHomework(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req homeworkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sectionID, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "a title is required")
		return
	}
	if req.Kind == "" {
		req.Kind = "homework"
	}

	// Same rule as marking a register: a teacher may only set work for a
	// section they actually teach.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !res.CanMarkSection(sectionID) {
		httpx.Forbidden(w, r, "homework for this section")
		return
	}

	allow := true
	if req.AllowSubmission != nil {
		allow = *req.AllowSubmission
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		classSubject := nullString(req.ClassSubjectID)
		if req.ClassSubjectID == "" && req.SubjectID != "" {
			var csID string
			err := tx.QueryRow(r.Context(), `
				SELECT cs.id::text
				  FROM class_subjects cs
				  JOIN sections sec ON sec.class_id = cs.class_id
				 WHERE sec.id = $1 AND cs.subject_id = $2::uuid
				 LIMIT 1`, sectionID, req.SubjectID).Scan(&csID)
			if errors.Is(err, pgx.ErrNoRows) {
				return errSubjectNotTaught
			}
			if err != nil {
				return err
			}
			classSubject = &csID
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO homework (institution_id, section_id, class_subject_id, kind,
			                      title, instructions, assigned_on, due_on, max_marks,
			                      is_published, allow_submission, created_by)
			VALUES ($1,$2,$3::uuid,$4,$5,$6, CURRENT_DATE,$7::date,$8,true,$9,$10)
			RETURNING id::text`,
			id.InstitutionID, sectionID, classSubject, req.Kind,
			req.Title, nullString(req.Instructions), nullString(req.DueOn),
			req.MaxMarks, allow, id.UserID).Scan(&newID)
	})
	if errors.Is(err, errSubjectNotTaught) {
		httpx.BadRequest(w, r, "that subject is not on this class's timetable")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "title": req.Title})
}

type homeworkRow struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Kind         string  `json:"kind"`
	Subject      *string `json:"subject,omitempty"`
	ClassName    *string `json:"class_name,omitempty"`
	SectionName  *string `json:"section_name,omitempty"`
	AssignedOn   string  `json:"assigned_on"`
	DueOn        *string `json:"due_on,omitempty"`
	Instructions *string `json:"instructions,omitempty"`
	Overdue      bool    `json:"overdue"`
	Submissions  int     `json:"submissions"`
	Strength     int     `json:"strength"`
	// Submitted answers the only question a student has about a task they
	// can see: have I turned this in? Always false for staff, who are asked
	// the different question of how many of the class have.
	Submitted bool    `json:"submitted"`
	Teacher   *string `json:"teacher,omitempty"`
}

// listHomework serves teachers, students and guardians from one query.
//
// A teacher sees what they set for their sections; a student or guardian sees
// what was set for the sections their children are enrolled in. The scope
// resolver already knows which of the two the caller is.
func (s *Server) listHomework(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// mine is the set of students the caller *is* or is guardian to; it drives
	// the "have I submitted" flag and is empty for staff.
	var mine any
	if len(res.StudentIDs) > 0 {
		mine = res.StudentIDs
	}

	args := []any{mine}
	var where string
	switch {
	case len(res.StudentIDs) > 0:
		// A child's homework is whatever was set for the section they are in.
		where = `h.section_id IN (SELECT e.section_id FROM enrollments e
		                           WHERE e.student_id = ANY($2) AND e.status='active')`
		args = append(args, res.StudentIDs)
	case res.AllAttendance:
		where = `TRUE` // office and principal see everything
	case len(res.SectionIDs) > 0:
		where = `h.section_id = ANY($2)`
		args = append(args, res.SectionIDs)
	default:
		where = `FALSE`
	}

	/* Filters, because a diary is only useful narrowed.

	   A teacher with five sections and three subjects sets a few hundred
	   tasks a term, and the screen showed the most recent hundred of all of
	   them at once. Every one of these is optional and absent means "all",
	   so the unfiltered call behaves exactly as it did.

	   Applied as SQL rather than in the browser on purpose: the LIMIT is
	   here, so filtering after the fact would filter a page that had already
	   dropped the rows being looked for. */
	q := r.URL.Query()
	filter := func(clause, value string) {
		if strings.TrimSpace(value) == "" {
			return
		}
		args = append(args, value)
		where += fmt.Sprintf(" AND "+clause, len(args))
	}
	filter("h.section_id = $%d::uuid", q.Get("section_id"))
	filter("sec.class_id = $%d::uuid", q.Get("class_id"))
	filter("cs.subject_id = $%d::uuid", q.Get("subject_id"))
	filter("h.kind = $%d", q.Get("kind"))
	filter("h.assigned_on >= $%d::date", q.Get("from"))
	filter("h.assigned_on <= $%d::date", q.Get("to"))

	items, err := collect(s, r, `
		SELECT h.id::text, h.title, h.kind, sub.name, c.name, sec.name,
		       to_char(h.assigned_on,'YYYY-MM-DD'), to_char(h.due_on,'YYYY-MM-DD'),
		       h.instructions,
		       h.due_on IS NOT NULL AND h.due_on < CURRENT_DATE,
		       (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id)::int,
		       (SELECT count(*) FROM enrollments e
		         WHERE e.section_id = h.section_id AND e.status = 'active')::int,
		       EXISTS (SELECT 1 FROM homework_submissions hs
		                WHERE hs.homework_id = h.id AND hs.student_id = ANY($1::uuid[])),
		       u.full_name
		  FROM homework h
		  JOIN sections sec ON sec.id = h.section_id
		  JOIN classes  c   ON c.id = sec.class_id
		  LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id
		  LEFT JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN users u ON u.id = h.created_by
		 WHERE h.is_published AND `+where+`
		 ORDER BY h.assigned_on DESC, h.due_on NULLS LAST
		 LIMIT 100`, args,
		func(rows pgx.Rows) (homeworkRow, error) {
			var v homeworkRow
			return v, rows.Scan(&v.ID, &v.Title, &v.Kind, &v.Subject, &v.ClassName,
				&v.SectionName, &v.AssignedOn, &v.DueOn, &v.Instructions,
				&v.Overdue, &v.Submissions, &v.Strength, &v.Submitted, &v.Teacher)
		})
	respond(w, r, items, err)
}

type submitHomeworkRequest struct {
	StudentID  string `json:"student_id,omitempty"`
	TextAnswer string `json:"text_answer,omitempty"`
}

// submitHomework records a student's submission.
func (s *Server) submitHomework(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	hid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid homework id")
		return
	}
	var req submitHomeworkRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.BadRequest(w, r, "only a student or their guardian can submit homework")
		return
	}
	target := res.StudentIDs[0]
	if req.StudentID != "" {
		sid, perr := uuid.Parse(req.StudentID)
		if perr != nil || !res.OwnsStudent(sid) {
			httpx.NotFound(w, r)
			return
		}
		target = sid
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO homework_submissions (institution_id, homework_id, student_id,
			                                  submitted_at, text_answer, status)
			VALUES ($1,$2,$3, now(), $4, 'submitted')
			ON CONFLICT (homework_id, student_id)
			DO UPDATE SET submitted_at = now(), text_answer = EXCLUDED.text_answer,
			              status = 'submitted'`,
			id.InstitutionID, hid, target, nullString(req.TextAnswer)); err != nil {
			return err
		}

		/* Tell the teacher who set it.

		   A submission that only increments a counter is a submission the
		   teacher finds by going to look. The child pressed a button because
		   they wanted somebody to know; this is the somebody.

		   Keyed on the homework and the child, so the alert survives a
		   resubmission without becoming two alerts — notify's ON CONFLICT
		   does that, and source_id has to be the task rather than the
		   submission row for it to work, because a resubmit writes the same
		   submission row again. */
		var (
			teacher *uuid.UUID
			title   string
			child   string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT h.created_by, h.title,
			       trim(st.first_name || ' ' || COALESCE(st.last_name,''))
			  FROM homework h, students st
			 WHERE h.id = $1 AND st.id = $2`, hid, target).Scan(&teacher, &title, &child); err != nil {
			return err
		}
		if teacher == nil || *teacher == id.UserID {
			return nil
		}
		return notify(r, tx, id.InstitutionID, *teacher, &target, "homework_submitted",
			child+" turned in "+title,
			"Submitted "+time.Now().Format("2 January")+". Open the diary to mark it.",
			"/faculty/teaching/homework_classwork", "homework", &hid)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"submitted": true})
}

// --- who has turned it in -------------------------------------------------

type homeworkSubmitterRow struct {
	StudentID   string  `json:"student_id"`
	RollNo      *string `json:"roll_no,omitempty"`
	FullName    string  `json:"full_name"`
	Status      string  `json:"status"`
	SubmittedAt *string `json:"submitted_at,omitempty"`
	TextAnswer  *string `json:"text_answer,omitempty"`
}

/*
listHomeworkSubmissions names the class against one task.

	"14/32 submitted" tells a teacher that eighteen children have not done
	their homework and nothing about which eighteen, which is the only form of
	the fact they can act on. This is the register: every child enrolled in the
	section, in roll order, with what they did or did not turn in.

	A LEFT JOIN from enrollments rather than a list of submissions, for exactly
	that reason — the children who are missing from the submissions table are
	the ones being looked for, and a query over submissions cannot return a row
	that does not exist.
*/
func (s *Server) listHomeworkSubmissions(w http.ResponseWriter, r *http.Request) {
	hid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid homework id")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The same boundary that governs setting the work governs reading who did
	// it: a teacher may see the register for a section they teach, and the
	// office may see any. A guardian gets 403 here rather than a filtered list,
	// because there is no version of this list that is theirs to read.
	var sectionID uuid.UUID
	if err := s.DB.InTenant(r.Context(), tenantScope(httpx.IdentityFrom(r.Context())),
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT section_id FROM homework WHERE id = $1`, hid).Scan(&sectionID)
		}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	if !res.AllAttendance && !res.CanMarkSection(sectionID) {
		httpx.Forbidden(w, r, "the submission register for this section")
		return
	}

	items, err := collect(s, r, `
		SELECT st.id::text, e.roll_no,
		       trim(st.first_name || ' ' || COALESCE(st.last_name,'')),
		       COALESCE(hs.status, 'pending'),
		       to_char(hs.submitted_at, 'YYYY-MM-DD"T"HH24:MI'),
		       hs.text_answer
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id
		  LEFT JOIN homework_submissions hs
		         ON hs.homework_id = $1 AND hs.student_id = st.id
		 WHERE e.section_id = $2 AND e.status = 'active'
		 ORDER BY e.roll_no NULLS LAST, st.first_name`,
		[]any{hid, sectionID},
		func(rows pgx.Rows) (homeworkSubmitterRow, error) {
			var v homeworkSubmitterRow
			return v, rows.Scan(&v.StudentID, &v.RollNo, &v.FullName, &v.Status,
				&v.SubmittedAt, &v.TextAnswer)
		})
	respond(w, r, items, err)
}
