package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

/* EVERY CHILD THIS FAMILY HAS, WHICHEVER SCHOOL HOLDS THEM.

   A parent with a child at two schools on this installation had two accounts,
   two passwords and two sessions, and no screen that could show both children
   at once. That is not an unusual family — a number written on two admission
   forms is the same number — and the portal exists to answer "how is my child",
   not "how is my child at the school whose session you happen to be holding".

   WHY THIS CANNOT BE ONE QUERY. Every tenant table is behind row-level security
   keyed on the institution in the session, and a scope naming no institution
   routes to the control shard, where a tenant's rows do not live. So there is
   no privileged connection that can see two schools' students at once, and
   there should not be: that is the guarantee that keeps one school out of
   another's data.

   What is safe is asking each school in turn, under its own scope, for the
   children of an account that school itself issued. Every row returned has
   already passed that school's own policy. The fan-out is small — the number of
   schools one family belongs to, which is one for almost everybody and two for
   the rest — and it is done once per portal load.

   HOW THE OTHER ACCOUNTS ARE FOUND. By the contact the family gave: the same
   email address, or the same mobile. Not by name, which repeats, and not by
   guardian record, which is per school. The account must be active, at an
   active school, and hold the parent role — the same three conditions sign-in
   applies, so this can never surface a school a person could not sign in to.
*/

// portalChildEverywhere is a child plus the school that holds them. The school
// is not decoration: two children at two schools may share a class name, and a
// parent acting on the wrong one is the failure this screen exists to prevent.
type portalChildEverywhere struct {
	portalChild
	InstitutionID   string `json:"institution_id"`
	InstitutionName string `json:"institution_name"`
	// Mine marks the school whose session is currently held. Everything else is
	// readable here and acted on after switching, which the client says plainly
	// rather than letting a button fail.
	Mine bool `json:"mine"`
}

// listMyChildrenEverywhere answers the parent's own question: all of them.
func (s *Server) listMyChildrenEverywhere(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil || id.UserID == uuid.Nil {
		respond(w, r, []portalChildEverywhere{}, nil)
		return
	}

	type account struct {
		userID uuid.UUID
		inst   uuid.UUID
		name   string
	}
	var accounts []account

	/* The sibling accounts, found on the control shard.

	   users and institutions are readable under a platform scope; students are
	   not, and are not asked for here. This step decides only WHICH schools to
	   ask, never what they hold. */
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			WITH me AS (
			    SELECT email, phone FROM users WHERE id = $1
			)
			SELECT DISTINCT u.id, u.institution_id, i.name
			  FROM users u
			  JOIN institutions i ON i.id = u.institution_id
			  JOIN user_roles ur ON ur.user_id = u.id
			  JOIN roles ro ON ro.id = ur.role_id
			  CROSS JOIN me
			 WHERE u.status = 'active'
			   AND i.status = 'active'
			   AND ro.key = 'parent'
			   AND (
			         (me.email IS NOT NULL AND u.email = me.email)
			      OR (me.phone IS NOT NULL AND u.phone = me.phone)
			      OR u.id = $1
			   )
			 ORDER BY i.name`, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a account
			if err := rows.Scan(&a.userID, &a.inst, &a.name); err != nil {
				return err
			}
			accounts = append(accounts, a)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out := []portalChildEverywhere{}
	for _, a := range accounts {
		/* Asked under the school's own scope, so its policies decide what comes
		   back. A school that errors is skipped rather than failing the whole
		   screen: one unreachable shard must not hide the children of the
		   school that is answering. */
		var got []portalChild
		_ = s.DB.InTenant(r.Context(), database.Scope{InstitutionID: a.inst}, func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT st.id::text, st.admission_no,
				       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
				       c.name, sec.name, en.roll_no, g.relation
				  FROM students st
				  JOIN student_guardians sg ON sg.student_id = st.id
				  JOIN guardians g ON g.id = sg.guardian_id
				  LEFT JOIN LATERAL (
				      SELECT e.class_id, e.section_id, e.roll_no FROM enrollments e
				       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
				  ) en ON true
				  LEFT JOIN classes  c   ON c.id = en.class_id
				  LEFT JOIN sections sec ON sec.id = en.section_id
				 WHERE g.user_id = $1
				 ORDER BY st.first_name`, a.userID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var v portalChild
				if err := rows.Scan(&v.StudentID, &v.AdmissionNo, &v.FullName,
					&v.ClassName, &v.SectionName, &v.RollNo, &v.Relation); err != nil {
					return err
				}
				got = append(got, v)
			}
			return rows.Err()
		})
		for _, c := range got {
			out = append(out, portalChildEverywhere{
				portalChild:     c,
				InstitutionID:   a.inst.String(),
				InstitutionName: a.name,
				Mine:            a.inst == id.InstitutionID,
			})
		}
	}
	respond(w, r, out, nil)
}
