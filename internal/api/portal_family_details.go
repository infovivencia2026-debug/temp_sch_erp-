package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Update my details: the family corrects its own record.

	Every alert this product sends — the absentee call, the fee reminder, the
	bus-is-near message — goes to the phone on the guardian row. That row was
	written once, in the admission form, and only the office could touch it
	afterwards, so a changed number reached the school by word of mouth or not
	at all. The absentee follow-up list is exactly where that shows: a row with
	a number nobody answers any more.

	This is the parent's view of what Student 360 holds about their child and
	their household, and the handful of fields they are the authority on: the
	home address, the child's blood group, and each guardian's own name, phone,
	email and occupation. It writes the same students / guardians rows the
	office reads, so Student 360 shows the correction the moment it is saved.

	NOT editable here, on purpose: the child's name, date of birth, admission
	number, class — those are the school's record and change through the
	office, with the paperwork that goes with them. A parent sees them, so a
	mistake is spotted, and the screen says whom to tell.
*/

type familyGuardian struct {
	ID          string  `json:"id"`
	FullName    string  `json:"full_name"`
	Relation    string  `json:"relation"`
	Phone       string  `json:"phone"`
	Email       *string `json:"email"`
	Occupation  *string `json:"occupation"`
	IsPrimary   bool    `json:"is_primary"`
	IsEmergency bool    `json:"is_emergency"`
	// Mine is true for the guardian row that belongs to the signed-in user —
	// the screen labels it "you".
	Mine bool `json:"mine"`
}

type familyDetails struct {
	StudentID    string           `json:"student_id"`
	FullName     string           `json:"full_name"`
	AdmissionNo  string           `json:"admission_no"`
	ClassName    *string          `json:"class_name"`
	SectionName  *string          `json:"section_name"`
	DateOfBirth  *string          `json:"date_of_birth"`
	Gender       *string          `json:"gender"`
	BloodGroup   *string          `json:"blood_group"`
	AddressLine1 *string          `json:"address_line1"`
	AddressLine2 *string          `json:"address_line2"`
	City         *string          `json:"city"`
	State        *string          `json:"state"`
	Pincode      *string          `json:"pincode"`
	Guardians    []familyGuardian `json:"guardians"`
}

// getFamilyDetails is what the family may see of one child's record, with the
// guardians linked to that child.
func (s *Server) getFamilyDetails(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	var d familyDetails
	d.Guardians = []familyGuardian{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT st.id::text, concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.admission_no, c.name, sec.name,
			       to_char(st.date_of_birth, 'YYYY-MM-DD'), st.gender, st.blood_group,
			       st.address_line1, st.address_line2, st.city, st.state, st.pincode
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE st.id = $1`, sid).Scan(
			&d.StudentID, &d.FullName, &d.AdmissionNo, &d.ClassName, &d.SectionName,
			&d.DateOfBirth, &d.Gender, &d.BloodGroup,
			&d.AddressLine1, &d.AddressLine2, &d.City, &d.State, &d.Pincode); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT g.id::text, g.full_name, g.relation, g.phone, g.email, g.occupation,
			       sg.is_primary, sg.is_emergency, g.user_id = $2
			  FROM student_guardians sg
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = $1
			 ORDER BY sg.is_primary DESC, g.relation, g.full_name`, sid, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var g familyGuardian
			var mine *bool
			if err := rows.Scan(&g.ID, &g.FullName, &g.Relation, &g.Phone, &g.Email,
				&g.Occupation, &g.IsPrimary, &g.IsEmergency, &mine); err != nil {
				return err
			}
			g.Mine = mine != nil && *mine
			d.Guardians = append(d.Guardians, g)
		}
		return rows.Err()
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, d)
}

type familyDetailsUpdate struct {
	StudentID    string `json:"student_id"`
	BloodGroup   string `json:"blood_group"`
	AddressLine1 string `json:"address_line1"`
	AddressLine2 string `json:"address_line2"`
	City         string `json:"city"`
	State        string `json:"state"`
	Pincode      string `json:"pincode"`
	Guardians    []struct {
		ID         string `json:"id"`
		FullName   string `json:"full_name"`
		Phone      string `json:"phone"`
		Email      string `json:"email"`
		Occupation string `json:"occupation"`
	} `json:"guardians"`
}

// updateFamilyDetails writes the fields the family owns. The child must be
// one of the caller's own (whichChild), and each guardian row must be linked
// to that child — a guardian id from somebody else's family is refused, not
// silently skipped, because a silent skip would look like a saved change.
func (s *Server) updateFamilyDetails(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req familyDetailsUpdate
	if !httpx.Decode(w, r, &req) {
		return
	}
	// whichChild reads student_id from the query; carry the body's over.
	q := r.URL.Query()
	q.Set("student_id", req.StudentID)
	r.URL.RawQuery = q.Encode()
	sid, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	for i, g := range req.Guardians {
		if _, err := uuid.Parse(g.ID); err != nil {
			httpx.BadRequest(w, r, "guardian id must be a uuid")
			return
		}
		if strings.TrimSpace(g.FullName) == "" {
			httpx.BadRequest(w, r, "a guardian needs a name")
			return
		}
		if strings.TrimSpace(g.Phone) == "" {
			httpx.BadRequest(w, r, "a guardian needs a phone number, it is where the school's alerts go")
			return
		}
		req.Guardians[i].FullName = strings.TrimSpace(g.FullName)
		req.Guardians[i].Phone = strings.TrimSpace(g.Phone)
		req.Guardians[i].Email = strings.TrimSpace(g.Email)
		req.Guardians[i].Occupation = strings.TrimSpace(g.Occupation)
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			UPDATE students
			   SET blood_group   = NULLIF($2, ''),
			       address_line1 = NULLIF($3, ''),
			       address_line2 = NULLIF($4, ''),
			       city          = NULLIF($5, ''),
			       state         = NULLIF($6, ''),
			       pincode       = NULLIF($7, ''),
			       updated_at    = now()
			 WHERE id = $1`,
			sid, strings.TrimSpace(req.BloodGroup), strings.TrimSpace(req.AddressLine1),
			strings.TrimSpace(req.AddressLine2), strings.TrimSpace(req.City),
			strings.TrimSpace(req.State), strings.TrimSpace(req.Pincode)); err != nil {
			return err
		}
		for _, g := range req.Guardians {
			tag, err := tx.Exec(r.Context(), `
				UPDATE guardians g
				   SET full_name  = $3,
				       phone      = $4,
				       email      = NULLIF($5, ''),
				       occupation = NULLIF($6, '')
				  FROM student_guardians sg
				 WHERE g.id = $2 AND sg.guardian_id = g.id AND sg.student_id = $1`,
				sid, g.ID, g.FullName, g.Phone, g.Email, g.Occupation)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errAbsenceOutOfScope
			}
		}
		return nil
	})
	if err == errAbsenceOutOfScope {
		httpx.Forbidden(w, r, "a guardian of this child")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
