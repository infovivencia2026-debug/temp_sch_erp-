package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* One member of staff, and what they actually do here.

   The staff directory was a list. Everything about a person past their name
   and department lived somewhere else — what they teach in the allocation
   grid, which section they are class teacher of in the section record, their
   qualifications in the service book — so the question a head of department
   asks daily, "what does she teach and can she take another class", was
   answered by opening three screens and holding the answer in your head.

   WHAT THEY TEACH IS THE POINT. section_subject_teachers has existed since the
   baseline and is written from one direction only: the allocation grid, which
   asks "who teaches 7-A Maths". Nothing ever asked the reverse — "what does
   Anand teach" — although that is the question a timetable clash, a
   substitution and a workload conversation all start from.
*/

func (s *Server) getStaffDetail(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}

	out := map[string]any{}
	teaching := []map[string]any{}
	classTeacherOf := []map[string]any{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			code, first                              string
			last, phone, email, qualification        *string
			dept, desig, deptID, desigID, empType    *string
			status, joined                           string
			confirmed, relieved, address, photo      *string
			experience                               *int
			userID                                   *string
			emgName, emgPhone, pan, bankAcct, bankIF *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT e.employee_code, e.first_name, e.last_name, e.phone,
			       e.email::text, e.qualification,
			       d.name, dg.name, e.department_id::text, e.designation_id::text,
			       e.employment_type, e.status,
			       to_char(e.joined_on,'YYYY-MM-DD'),
			       to_char(e.confirmed_on,'YYYY-MM-DD'),
			       to_char(e.relieved_on,'YYYY-MM-DD'),
			       e.address, e.photo_file_id::text, e.experience_years,
			       e.user_id::text,
			       e.emergency_contact_name, e.emergency_contact_phone,
			       e.pan, e.bank_account, e.bank_ifsc
			  FROM employees e
			  LEFT JOIN departments d ON d.id = e.department_id
			  LEFT JOIN designations dg ON dg.id = e.designation_id
			 WHERE e.id = $1`, eid).
			Scan(&code, &first, &last, &phone, &email, &qualification,
				&dept, &desig, &deptID, &desigID, &empType, &status, &joined,
				&confirmed, &relieved, &address, &photo, &experience, &userID,
				&emgName, &emgPhone, &pan, &bankAcct, &bankIF); err != nil {
			return err
		}
		out["id"] = eid.String()
		out["employee_code"] = code
		out["full_name"] = strings.TrimSpace(first + " " + deref(last))
		out["first_name"] = first
		out["last_name"] = last
		out["phone"] = phone
		out["email"] = email
		out["qualification"] = qualification
		out["department"] = dept
		out["designation"] = desig
		out["department_id"] = deptID
		out["designation_id"] = desigID
		out["employment_type"] = empType
		out["status"] = status
		out["joined_on"] = joined
		out["confirmed_on"] = confirmed
		out["relieved_on"] = relieved
		out["address"] = address
		out["photo_file_id"] = photo
		out["experience_years"] = experience
		out["user_id"] = userID
		out["emergency_contact_name"] = emgName
		out["emergency_contact_phone"] = emgPhone
		out["pan"] = pan
		out["bank_account"] = bankAcct
		out["bank_ifsc"] = bankIF

		/* WHAT THEY TEACH, read from the allocation the timetable already uses.

		   Not a second list. A staff record with its own idea of who teaches
		   what is a staff record that disagrees with the timetable, and the
		   day they disagree is the day somebody is sent to the wrong room. */
		if userID != nil {
			if err := scanInto(r.Context(), tx, `
				SELECT sst.id::text, c.name, sec.name, sub.name,
				       sec.id::text, cs.id::text
				  FROM section_subject_teachers sst
				  JOIN sections sec ON sec.id = sst.section_id
				  JOIN classes c ON c.id = sec.class_id
				  JOIN class_subjects cs ON cs.id = sst.class_subject_id
				  JOIN subjects sub ON sub.id = cs.subject_id
				 WHERE sst.teacher_user_id = $1
				 ORDER BY c.level, sec.name, sub.name`,
				func(rows pgx.Rows) error {
					var aid, class, section, subject, secID, csID string
					if err := rows.Scan(&aid, &class, &section, &subject,
						&secID, &csID); err != nil {
						return err
					}
					teaching = append(teaching, map[string]any{
						"id": aid, "class": class, "section": section,
						"subject": subject, "section_id": secID,
						"class_subject_id": csID,
					})
					return nil
				}, *userID); err != nil {
				return err
			}

			// Being a class teacher is a different job from teaching a subject
			// — the register, the report cards and the parents are theirs — so
			// it is listed separately rather than mixed into the subjects.
			if err := scanInto(r.Context(), tx, `
				SELECT sec.id::text, c.name, sec.name,
				       (SELECT count(*)::text FROM enrollments en
				         WHERE en.section_id = sec.id AND en.status = 'active')
				  FROM sections sec
				  JOIN classes c ON c.id = sec.class_id
				 WHERE sec.class_teacher_id = $1
				 ORDER BY c.level, sec.name`,
				func(rows pgx.Rows) error {
					var sid, class, section, count string
					if err := rows.Scan(&sid, &class, &section, &count); err != nil {
						return err
					}
					classTeacherOf = append(classTeacherOf, map[string]any{
						"section_id": sid, "class": class, "section": section,
						"students": count,
					})
					return nil
				}, *userID); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out["teaching"] = teaching
	out["class_teacher_of"] = classTeacherOf
	httpx.JSON(w, http.StatusOK, out)
}

/* Giving a teacher a subject, or taking one away, from their own record.

   The allocation grid asks "who teaches 7-A Maths" and is right for building a
   timetable from nothing. This asks "what does Anand teach" and is right for
   the other half of the job: a teacher arrives in March and picks up four
   classes, somebody goes on leave and their subjects are shared out, a head of
   department is balancing a workload.

   Both write the same row. A staff record with its own idea of who teaches
   what would be a record that disagrees with the timetable, and the day they
   disagree is the day somebody is sent to the wrong room.
*/
type staffSubjectRequest struct {
	SectionID      string `json:"section_id"`
	ClassSubjectID string `json:"class_subject_id"`
}

func (s *Server) assignStaffSubject(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	var req staffSubjectRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sec, err := uuid.Parse(strings.TrimSpace(req.SectionID))
	if err != nil {
		httpx.BadRequest(w, r, "choose a section")
		return
	}
	cs, err := uuid.Parse(strings.TrimSpace(req.ClassSubjectID))
	if err != nil {
		httpx.BadRequest(w, r, "choose a subject")
		return
	}

	var replaced string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var userID *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT user_id FROM employees WHERE id = $1`, eid).Scan(&userID); err != nil {
			return err
		}
		if userID == nil {
			/* Allocation is keyed on the USER, because that is what the
			   timetable, the register and the substitution board all carry. A
			   member of staff with no login cannot be allocated a class — and
			   saying so is better than writing a row nothing can read. */
			return errNoStaffLogin
		}

		/* WHO HELD IT BEFORE, so the answer can say. One section's subject has
		   one teacher — the unique index says so — and assigning it silently
		   takes it off whoever had it, which is a thing the person doing the
		   assigning should be told rather than discover. */
		_ = tx.QueryRow(r.Context(), `
			SELECT u.full_name FROM section_subject_teachers sst
			  JOIN users u ON u.id = sst.teacher_user_id
			 WHERE sst.section_id = $1 AND sst.class_subject_id = $2
			   AND sst.teacher_user_id <> $3`, sec, cs, *userID).Scan(&replaced)

		_, err := tx.Exec(r.Context(), `
			INSERT INTO section_subject_teachers (institution_id, section_id,
			                                      class_subject_id, teacher_user_id)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (section_id, class_subject_id)
			DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
			id.InstitutionID, sec, cs, *userID)
		return err
	})
	switch {
	case errors.Is(err, errNoStaffLogin):
		httpx.BadRequest(w, r,
			"give this member of staff a login first — the timetable and the "+
				"register identify a teacher by their account, not by their "+
				"employee record")
		return
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"assigned": true,
		// Named rather than left for somebody to notice next term.
		"taken_from": replaced,
	})
}

var errNoStaffLogin = errors.New("staff member has no login")

func (s *Server) removeStaffSubject(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	aid, err := uuid.Parse(chiURLParam(r, "allocID"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid allocation id")
		return
	}

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Only an allocation that is actually THIS person's. Without the join
		   back to the employee, any allocation id in the school could be
		   deleted from any staff record. */
		tag, err := tx.Exec(r.Context(), `
			DELETE FROM section_subject_teachers sst
			 WHERE sst.id = $1
			   AND sst.teacher_user_id = (SELECT user_id FROM employees WHERE id = $2)`,
			aid, eid)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.Error(w, r, http.StatusConflict, "not_theirs",
			"that class is not allocated to this member of staff")
		return
	}
	/* The period stays on the timetable with nobody against it, which is
	   correct and is what the grid already shows as "no teacher". Deleting the
	   period instead would take the lesson off the children's week because a
	   teacher left. */
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": true})
}
