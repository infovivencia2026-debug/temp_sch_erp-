package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A new joining is the principal's to approve, not the desk's.

   The distinction is between OFFERING a place and the child actually joining.
   Offering stays with the desk: it is a conversation, it is reversible, and it
   commits nothing. Joining takes a seat another child cannot have, raises a
   bill and issues a family a login — and that is the act a head wants to see
   the details of first.

   OFF BY DEFAULT, per school. A school that has always let its desk admit is
   not interrupted by an upgrade; one that wants the sign-off turns it on. A
   rule imposed on everybody would stop half of them admitting anybody until
   somebody found the setting to turn it back off.
*/

const admissionApprovalKey = "enrolment_needs_approval"

// admissionApprovalRequired reports whether this school makes the principal
// sign off a joining. Read inside the enrolment transaction so a school that
// switches it on mid-morning is not bypassed by a cached answer.
func admissionApprovalRequired(r *http.Request, tx pgx.Tx) (bool, error) {
	var v *string
	err := tx.QueryRow(r.Context(),
		`SELECT config->>'`+admissionApprovalKey+`' FROM module_settings
		  WHERE module = 'admissions'`).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		// No row is a school that has not been asked. Off, like the default.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return v != nil && *v == "true", nil
}

type admissionApprovalSetting struct {
	Required bool `json:"required"`
}

func (s *Server) getAdmissionApproval(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var required bool
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		required, err = admissionApprovalRequired(r, tx)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, admissionApprovalSetting{Required: required})
}

func (s *Server) setAdmissionApproval(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req admissionApprovalSetting
	if !httpx.Decode(w, r, &req) {
		return
	}
	value := "false"
	if req.Required {
		value = "true"
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO module_settings (institution_id, module, enabled, config)
			VALUES ($1, 'admissions', true,
			        jsonb_build_object('`+admissionApprovalKey+`', $2::text))
			ON CONFLICT (institution_id, module)
			-- Merged: admissions settings are not only ours.
			DO UPDATE SET config = module_settings.config || EXCLUDED.config`,
			id.InstitutionID, value)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, admissionApprovalSetting{Required: req.Required})
}

/* The queue: children offered a place, waiting on the head to let them join.

   Everything the principal needs to decide is here, because the alternative
   is opening the application, the fee structure and the concession list in
   three tabs. What it costs and what has been waived are the two facts that
   make this a decision rather than a rubber stamp.
*/
type pendingAdmission struct {
	ID          string `json:"id"`
	Application string `json:"application_no"`
	Name        string `json:"name"`
	ClassSought string `json:"class_sought"`
	Parent      string `json:"parent_name"`
	Phone       string `json:"phone"`
	OfferedOn   string `json:"offered_on"`
	// What the class costs and what has been asked off it. Nought and none are
	// ordinary answers and are shown as such rather than hidden.
	FeePaise        string `json:"fee_paise"`
	ConcessionKind  string `json:"concession_kind"`
	ConcessionValue string `json:"concession_value"`
	ConcessionState string `json:"concession_status"`
	Approved        bool   `json:"enrolment_approved"`
}

func (s *Server) listPendingAdmissions(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT a.id::text, a.application_no,
		       concat_ws(' ', a.first_name, a.last_name),
		       COALESCE(c.name, ''), COALESCE(a.parent_name, ''),
		       COALESCE(a.parent_phone, ''),
		       COALESCE(to_char(a.decided_at,'YYYY-MM-DD'), ''),
		       /* The class's own structure where it has one, otherwise the
		          school-wide one — the same precedence the demand raise uses,
		          so the figure the principal approves is the figure billed. */
		       COALESCE((
		         SELECT sum(i.amount_paise)::text
		           FROM fee_structure_items i
		          WHERE i.fee_structure_id = (
		            SELECT fs.id FROM fee_structures fs
		             WHERE fs.is_active
		               AND (fs.class_id = a.class_sought OR fs.class_id IS NULL)
		             ORDER BY (fs.class_id = a.class_sought) DESC, fs.created_at DESC
		             LIMIT 1)), '0'),
		       COALESCE((SELECT fc.kind FROM fee_concessions fc
		                  WHERE fc.application_id = a.id
		                  ORDER BY fc.created_at DESC LIMIT 1), ''),
		       COALESCE((SELECT CASE WHEN fc.percent IS NOT NULL
		                             THEN fc.percent::text || '%'
		                             ELSE (fc.amount_paise / 100)::text END
		                   FROM fee_concessions fc
		                  WHERE fc.application_id = a.id
		                  ORDER BY fc.created_at DESC LIMIT 1), ''),
		       COALESCE((SELECT fc.status FROM fee_concessions fc
		                  WHERE fc.application_id = a.id
		                  ORDER BY fc.created_at DESC LIMIT 1), ''),
		       a.enrolment_approved_at IS NOT NULL
		  FROM applications a
		  LEFT JOIN classes c ON c.id = a.class_sought
		 /* AN APPROVED ADMISSION STAYS ON THIS LIST until the child is
		    actually enrolled.

		    It used to drop off the moment the principal signed, which is the
		    moment the desk needs it: approval is not the end of the admission,
		    it is permission to finish it. Whoever approved it watched the
		    applicant vanish and had nowhere to raise the fee. The row leaves
		    when there is a student, not before. */
		 WHERE a.status = 'offered'
		   AND a.student_id IS NULL
		 ORDER BY a.decided_at NULLS LAST, a.application_no`, nil,
		func(rows pgx.Rows) (pendingAdmission, error) {
			var v pendingAdmission
			return v, rows.Scan(&v.ID, &v.Application, &v.Name, &v.ClassSought,
				&v.Parent, &v.Phone, &v.OfferedOn, &v.FeePaise,
				&v.ConcessionKind, &v.ConcessionValue, &v.ConcessionState,
				&v.Approved)
		})
	respond(w, r, items, err)
}

type admissionDecision struct {
	// Approved false sends it back to the desk with the note, rather than
	// rejecting the child: the commonest answer is "not until the fee is
	// settled", which is a delay and not a refusal.
	Approved bool   `json:"approved"`
	Note     string `json:"note,omitempty"`
}

func (s *Server) decideAdmission(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	appID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid application id")
		return
	}
	var req admissionDecision
	if !httpx.Decode(w, r, &req) {
		return
	}
	note := strings.TrimSpace(req.Note)
	if !req.Approved && note == "" {
		/* Sending a joining back with no reason is the one the desk rings
		   about, and the person answering the telephone did not make the
		   decision. */
		httpx.BadRequest(w, r,
			"say what has to happen first — the desk has to tell the family something")
		return
	}

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var by any
		var at string
		if req.Approved {
			by, at = id.UserID, "now()"
		} else {
			// Cleared, so a joining sent back is waiting again rather than
			// looking approved by whoever last touched it.
			by, at = nil, "NULL"
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE applications
			   SET enrolment_approved_by = $2,
			       enrolment_approved_at = `+at+`,
			       enrolment_note = NULLIF($3,''),
			       updated_at = now()
			 WHERE id = $1 AND status = 'offered'`, appID, by, note)
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
		httpx.Error(w, r, http.StatusConflict, "not_pending",
			"that application is not waiting on an admission decision")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"approved": req.Approved})
}
