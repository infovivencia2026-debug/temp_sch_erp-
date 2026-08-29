package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Remarks about staff, as opposed to remarks about children.

   The catalogue carried four entries — Remarks, Class Teacher Remarks, Staff
   remarks, Teacher remarks — and every one of them opened a screen reading
   student_remarks. So a head of department who opened "Teacher remarks"
   expecting to write about a teacher was shown what teachers had written about
   children, and there was no way at all to record the other direction.

   Three authors, three different reasons:

     A head of department writes about their own staff. The ordinary case.

     The principal writes about anybody, because somebody has to be able to
     write the remark whose subject is the head of department.

     A parent writes about a teacher who teaches their child. A school that
     takes praise and complaints only by telephone has a record of neither, and
     the teacher never hears the praise at all.

   The subject always reads it, and there is no private variant. A record about
   somebody they cannot see is a file kept on them, which is a different thing
   from feedback and not what this is. That is the one place this deliberately
   differs from student_remarks, where a teacher's working note about a child
   is genuinely their own.
*/

type staffRemarkRequest struct {
	SubjectUserID string `json:"subject_user_id"`
	Kind          string `json:"kind,omitempty"`
	Body          string `json:"body"`
	// StudentID is which child this concerns, when a parent writes it. Ignored
	// from any other author: a HOD's appraisal note is not about one child.
	StudentID string `json:"student_id,omitempty"`
}

type staffRemarkRow struct {
	ID          string `json:"id"`
	SubjectID   string `json:"subject_user_id"`
	SubjectName string `json:"subject_name"`
	AuthorName  string `json:"author_name"`
	AuthorRole  string `json:"author_role"`
	Kind        string `json:"kind"`
	Body        string `json:"body"`
	ObservedOn  string `json:"observed_on"`
	// When it was written down. A remark about Tuesday typed on Friday is a
	// different fact from one typed the same afternoon, and the person it is
	// about is entitled to know which.
	RecordedAt  string  `json:"recorded_at"`
	StudentName *string `json:"student_name,omitempty"`
	// Mine marks a remark written by the caller, so the author's own list can
	// show what they said without a second query.
	Mine bool `json:"mine"`
}

var errNotYoursToRemarkOn = errors.New(
	"you may write about your own department's staff, or about a teacher who teaches your child")

/*
createStaffRemark records one remark and tells its subject.

	The author's role is worked out here rather than taken from the request.
	A client that names its own authority is a client that can claim to be the
	principal, and the row is the school's record of who said what.
*/
func (s *Server) createStaffRemark(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var req staffRemarkRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	subject, err := uuid.Parse(req.SubjectUserID)
	if err != nil {
		httpx.BadRequest(w, r, "subject_user_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		httpx.BadRequest(w, r, "a remark with no words in it says nothing")
		return
	}
	if subject == id.UserID {
		httpx.BadRequest(w, r, "you cannot write a remark about yourself")
		return
	}
	if req.Kind == "" {
		req.Kind = "feedback"
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Which hat the author is wearing, most authoritative first.

	   A principal who also heads a department writes as the principal, which
	   is the wider licence and the one that does not have to be checked
	   against a department. */
	role := ""
	switch {
	case id.Can(rbac.EmployeesWrite) || id.Can(rbac.UsersWrite):
		role = "principal"
	case id.Can(rbac.LeaveApprove) || id.Can(rbac.TimetableWrite):
		role = "hod"
	case len(res.StudentIDs) > 0:
		role = "parent"
	default:
		httpx.Forbidden(w, r, "writing remarks about staff")
		return
	}

	var newID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// A parent may write only about somebody who actually teaches one of
		// their children. Without this the portal becomes a way of filing a
		// complaint against any member of staff in the school by guessing an
		// id.
		var student any
		if role == "parent" {
			var teaches bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				  SELECT 1
				    FROM enrollments e
				    JOIN sections sec ON sec.id = e.section_id
				   WHERE e.student_id = ANY($1) AND e.status = 'active'
				     AND (sec.class_teacher_id = $2
				          OR EXISTS (SELECT 1 FROM section_subject_teachers sst
				                      WHERE sst.section_id = sec.id
				                        AND sst.teacher_user_id = $2)
				          OR EXISTS (SELECT 1 FROM timetable_entries te
				                      WHERE te.section_id = sec.id
				                        AND te.teacher_user_id = $2)))`,
				res.StudentIDs, subject).Scan(&teaches); err != nil {
				return err
			}
			if !teaches {
				return errNotYoursToRemarkOn
			}
			if req.StudentID != "" {
				sid, perr := uuid.Parse(req.StudentID)
				if perr != nil || !res.OwnsStudent(sid) {
					return errNotYoursToRemarkOn
				}
				student = sid
			}
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO staff_remarks (institution_id, subject_user_id, author_user_id,
			                           author_role, student_id, kind, body)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id`,
			id.InstitutionID, subject, id.UserID, role, student,
			req.Kind, strings.TrimSpace(req.Body)).Scan(&newID); err != nil {
			return err
		}

		// The subject is told. A remark somebody has to go looking for is one
		// they find at their appraisal, which is the wrong moment for both the
		// praise and the concern.
		var author string
		if err := tx.QueryRow(r.Context(),
			`SELECT full_name FROM users WHERE id = $1`, id.UserID).Scan(&author); err != nil {
			return err
		}
		body := strings.TrimSpace(req.Body)
		if len(body) > 240 {
			body = body[:237] + "…"
		}
		return notify(r, tx, id.InstitutionID, subject, nil, "staff_remark",
			"A remark about your work", body+" - "+author,
			"/faculty/my_profile/remarks_about_me", "staff_remark", &newID)
	})
	switch {
	case errors.Is(err, errNotYoursToRemarkOn):
		httpx.Forbidden(w, r, errNotYoursToRemarkOn.Error())
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID.String(), "author_role": role})
}

/*
listStaffRemarks returns the remarks the caller is entitled to read.

	Three narrowings and no fourth. You read what was written about you; you
	read what you wrote; and whoever may write about the school's staff at
	large may read those too, because a head of department who cannot see the
	remark a parent left has no way to act on it.

	subject_user_id narrows to one person, for the screen where a HOD is
	looking at one member of their department.
*/
func (s *Server) listStaffRemarks(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	broad := id.Can(rbac.EmployeesWrite) || id.Can(rbac.UsersWrite) || id.Can(rbac.LeaveApprove)

	args := []any{id.UserID, nullString(r.URL.Query().Get("subject_user_id"))}
	where := "(sr.subject_user_id = $1 OR sr.author_user_id = $1)"
	if broad {
		where = "TRUE"
	}

	items, err := collect(s, r, `
		SELECT sr.id::text, sr.subject_user_id::text, su.full_name, au.full_name,
		       sr.author_role, sr.kind, sr.body,
		       to_char(sr.observed_on,'YYYY-MM-DD'),
		       to_char(sr.created_at,'YYYY-MM-DD"T"HH24:MI'),
		       trim(st.first_name || ' ' || COALESCE(st.last_name,'')),
		       sr.author_user_id = $1
		  FROM staff_remarks sr
		  JOIN users su ON su.id = sr.subject_user_id
		  JOIN users au ON au.id = sr.author_user_id
		  LEFT JOIN students st ON st.id = sr.student_id
		 WHERE ($2::uuid IS NULL OR sr.subject_user_id = $2)
		   AND `+where+`
		 ORDER BY sr.observed_on DESC, sr.created_at DESC
		 LIMIT 200`, args,
		func(rows pgx.Rows) (staffRemarkRow, error) {
			var v staffRemarkRow
			return v, rows.Scan(&v.ID, &v.SubjectID, &v.SubjectName, &v.AuthorName,
				&v.AuthorRole, &v.Kind, &v.Body, &v.ObservedOn, &v.RecordedAt,
				&v.StudentName, &v.Mine)
		})
	respond(w, r, items, err)
}

type remarkableTeacher struct {
	UserID   string  `json:"user_id"`
	FullName string  `json:"full_name"`
	Subject  *string `json:"subject,omitempty"`
	Relation string  `json:"relation"`
}

/*
listRemarkableTeachers is the address book for the form above.

	A parent gets the people who actually teach their child — the class teacher
	first, then whoever is timetabled to the section. Bounded for the same
	reason the message channel is: an unbounded list turns a remark box into a
	way of naming any employee of the school.

	Staff who may write broadly get the teaching staff. The server checks the
	same boundary again on write, so this list is a convenience and not the
	control.
*/
func (s *Server) listRemarkableTeachers(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	if id.Can(rbac.EmployeesWrite) || id.Can(rbac.UsersWrite) || id.Can(rbac.LeaveApprove) {
		items, err := collect(s, r, `
			SELECT u.id::text, u.full_name, NULL::text, 'staff'
			  FROM employees e
			  JOIN users u ON u.id = e.user_id
			 WHERE e.status = 'active' AND u.id <> $1
			 ORDER BY u.full_name`, []any{id.UserID},
			func(rows pgx.Rows) (remarkableTeacher, error) {
				var v remarkableTeacher
				return v, rows.Scan(&v.UserID, &v.FullName, &v.Subject, &v.Relation)
			})
		respond(w, r, items, err)
		return
	}

	if len(res.StudentIDs) == 0 {
		httpx.Forbidden(w, r, "the list of teachers you may write about")
		return
	}

	items, err := collect(s, r, `
		SELECT DISTINCT ON (u.id) u.id::text, u.full_name, sub.name,
		       CASE WHEN sec.class_teacher_id = u.id THEN 'class teacher'
		            ELSE 'subject teacher' END
		  FROM enrollments e
		  JOIN sections sec ON sec.id = e.section_id
		  JOIN users u ON u.id = sec.class_teacher_id
		  LEFT JOIN subjects sub ON false
		 WHERE e.student_id = ANY($1) AND e.status = 'active'
		UNION
		SELECT DISTINCT ON (u.id) u.id::text, u.full_name, sub.name,
		       'subject teacher'
		  FROM enrollments e
		  JOIN timetable_entries te ON te.section_id = e.section_id
		  JOIN users u ON u.id = te.teacher_user_id
		  JOIN class_subjects cs ON cs.id = te.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		 WHERE e.student_id = ANY($1) AND e.status = 'active'`,
		[]any{res.StudentIDs},
		func(rows pgx.Rows) (remarkableTeacher, error) {
			var v remarkableTeacher
			return v, rows.Scan(&v.UserID, &v.FullName, &v.Subject, &v.Relation)
		})
	respond(w, r, items, err)
}
