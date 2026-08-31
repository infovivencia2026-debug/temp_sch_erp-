package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/school-erp/erp/internal/httpx"
)

/* WHAT BECAME OF MY APPLICATION.

   A family's admission was visible to everyone except the family. The office
   could see the enquiry, the application, which documents were still missing
   and whether a seat had been offered; the parent could see none of it, and so
   rang to ask -- which during a season is most of what a front desk does, and
   the answer given is read off a screen the parent could have read themselves.

   This is that screen. It is the enquiry the parent was given a login for, the
   application that grew out of it, and the steps between the two stated as
   done, waiting or not yet reached.

   ---------------------------------------------------------------------------
   NOT A CHILD SCREEN

   Every other portal route resolves a student first, because every other
   portal route is about a pupil. This one cannot: at enquiry there is no
   student and there may never be one. It resolves the caller's own user id
   against enquiries.user_id instead, which is the only claim this page needs
   and a narrower one than the rest of the portal makes.

   ---------------------------------------------------------------------------
   WHAT IT WILL NOT SAY

   No internal remarks, no assigned counsellor, no lead source, no waitlist
   position. Those are the school's working notes on a family, and a decision
   that has not been given yet is not made better by the family watching it
   being argued about. The steps, their dates, and the documents still wanted --
   which is the part the family can actually act on.
*/

// admissionStep is one row of the tracker. Status is done | current | pending,
// so the client renders the same three states everywhere rather than each
// screen inventing its own reading of a status string.
type admissionStep struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Status string `json:"status"`
	// Empty where the step has not happened. A date on a pending step would
	// be a promise about when it will.
	On   string `json:"on,omitempty"`
	Note string `json:"note,omitempty"`
}

type admissionDoc struct {
	DocType  string `json:"doc_type"`
	Required bool   `json:"required"`
	Uploaded bool   `json:"uploaded"`
	Verified bool   `json:"verified"`
}

type portalAdmission struct {
	EnquiryID   string `json:"enquiry_id"`
	StudentName string `json:"student_name"`
	ClassSought string `json:"class_sought,omitempty"`
	EnquiredOn  string `json:"enquired_on"`

	ApplicationNo string `json:"application_no,omitempty"`
	// The raw application status, for a client that wants to say something
	// specific about 'waitlisted'. Steps below are the general rendering.
	Status string `json:"status"`
	// Where the family should go next, in one sentence, or empty when the ball
	// is with the school. This is the whole reason the page exists.
	NextAction string `json:"next_action,omitempty"`
	// The published form, so "apply now" is a link and not an instruction to
	// visit the office. Empty when the school has not opened admissions.
	ApplyURL string `json:"apply_url,omitempty"`

	Steps     []admissionStep `json:"steps"`
	Documents []admissionDoc  `json:"documents"`
}

func (s *Server) mountPortalAdmission(r chi.Router) {
	// Read-only, and there is no write here on purpose: an application is
	// edited through the published admission form, which already validates a
	// school's own field set. A second writer would be the one the form
	// disagrees with.
	r.Get("/admission", s.getPortalAdmission)
}

/*
getPortalAdmission is the family's view of their own admission in progress.

	Returns an empty list rather than 404 for a parent with no enquiry against
	their login -- an enrolled family reaching this page is the ordinary case,
	not an error, and a 404 would render as something having gone wrong.
*/
func (s *Server) getPortalAdmission(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []portalAdmission{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* The enquiries this login was issued for.

		   Joined to the application rather than read separately: the
		   application is what carries the outcome past 'applied', which is as
		   far as the enquiry vocabulary goes. LEFT, because the commonest
		   state on the day the login arrives is an enquiry with no application
		   behind it yet -- and that family is exactly who this page is for. */
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text,
			       e.student_name,
			       COALESCE(c.name, ''),
			       to_char(e.created_at,'YYYY-MM-DD'),
			       COALESCE(a.id::text, ''),
			       COALESCE(a.application_no, ''),
			       COALESCE(a.status, ''),
			       to_char(a.created_at,'YYYY-MM-DD'),
			       to_char(a.decided_at,'YYYY-MM-DD'),
			       a.student_id IS NOT NULL
			  FROM enquiries e
			  LEFT JOIN classes c ON c.id = e.class_sought
			  LEFT JOIN LATERAL (
			      SELECT ap.* FROM applications ap
			       WHERE ap.enquiry_id = e.id
			       ORDER BY ap.created_at DESC LIMIT 1
			  ) a ON true
			 WHERE e.user_id = $1
			 ORDER BY e.created_at DESC`, id.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()

		type row struct {
			v     portalAdmission
			appID string
			// Separated from the enquiry's own date because the two are weeks
			// apart and the tracker shows both.
			appliedOn, decidedOn *string
			admitted             bool
		}
		var found []row
		for rows.Next() {
			var rec row
			if err := rows.Scan(&rec.v.EnquiryID, &rec.v.StudentName, &rec.v.ClassSought,
				&rec.v.EnquiredOn, &rec.appID, &rec.v.ApplicationNo, &rec.v.Status,
				&rec.appliedOn, &rec.decidedOn, &rec.admitted); err != nil {
				return err
			}
			found = append(found, rec)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// The form to point them at, read once rather than per enquiry: a
		// school has one open form and most families here have one enquiry.
		var applyURL string
		var slug string
		if err := tx.QueryRow(r.Context(), `
			SELECT f.slug FROM admission_forms f
			 WHERE f.is_open
			   AND (f.opens_on  IS NULL OR f.opens_on  <= CURRENT_DATE)
			   AND (f.closes_on IS NULL OR f.closes_on >= CURRENT_DATE)
			   AND EXISTS (SELECT 1 FROM admission_form_versions v
			                WHERE v.form_id = f.id AND v.status = 'published')
			 ORDER BY f.updated_at DESC LIMIT 1`).Scan(&slug); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		} else {
			applyURL = strings.TrimSuffix(s.BaseURL, "/") + "/admissions/apply/" + slug
		}

		for _, rec := range found {
			v := rec.v
			if rec.appID != "" {
				docs, err := portalAdmissionDocs(r, tx, rec.appID)
				if err != nil {
					return err
				}
				v.Documents = docs
			} else {
				v.Documents = []admissionDoc{}
			}
			v.Steps, v.NextAction = admissionSteps(
				v.EnquiredOn, rec.appliedOn, rec.decidedOn, v.Status, rec.admitted, v.Documents)
			if v.Status == "" || v.Status == "draft" {
				// The only state where the link is an instruction the family
				// can act on. Offering it after they have applied invites a
				// second application for the same child.
				v.ApplyURL = applyURL
			}
			out = append(out, v)
		}
		return nil
	})
	respond(w, r, out, err)
}

// portalAdmissionDocs is the checklist as the family can see it: what is
// wanted, what arrived, what was accepted. Never the verifier's name -- who in
// the office checked a birth certificate is not the family's business.
func portalAdmissionDocs(r *http.Request, tx pgx.Tx, appID string) ([]admissionDoc, error) {
	rows, err := tx.Query(r.Context(), `
		SELECT doc_type, is_required, file_id IS NOT NULL, verified_at IS NOT NULL
		  FROM application_documents
		 WHERE application_id = $1::uuid
		 ORDER BY is_required DESC, doc_type`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []admissionDoc{}
	for rows.Next() {
		var d admissionDoc
		if err := rows.Scan(&d.DocType, &d.Required, &d.Uploaded, &d.Verified); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

/*
admissionSteps turns a status into the five steps a family understands.

	The application vocabulary has eleven states and a parent has one question:
	where is this, and is it my turn. Eleven states rendered literally is a
	screen that needs explaining; five steps with one of them marked current is
	not.

	Also returns the next action, which is empty whenever the ball is with the
	school. Inventing something for the family to do while they wait -- "check
	back regularly" -- is how a status page becomes noise.
*/
func admissionSteps(
	enquiredOn string, appliedOn, decidedOn *string,
	status string, admitted bool, docs []admissionDoc,
) ([]admissionStep, string) {
	at := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}

	// Rank orders the vocabulary by how far along it is, which is the only
	// thing the tracker needs from it. Terminal states are handled separately
	// below: a rejection is not step four of five.
	rank := map[string]int{
		"draft": 0, "submitted": 1, "under_review": 1, "documents_pending": 1,
		"test_scheduled": 2, "interviewed": 2,
		"offered": 3, "waitlisted": 3, "rejected": 3, "withdrawn": 3,
		"accepted": 4,
	}
	reached := 0
	if status != "" {
		reached = rank[status]
	}
	if admitted {
		reached = 4
	}

	missing := 0
	for _, d := range docs {
		if d.Required && !d.Uploaded {
			missing++
		}
	}

	steps := []admissionStep{
		{Key: "enquiry", Label: "Enquiry received", On: enquiredOn},
		{Key: "application", Label: "Application submitted", On: at(appliedOn)},
		{Key: "documents", Label: "Documents checked"},
		{Key: "decision", Label: "Decision", On: at(decidedOn)},
		{Key: "admitted", Label: "Admitted"},
	}
	for i := range steps {
		switch {
		case i <= reached-1:
			steps[i].Status = "done"
		case i == reached:
			steps[i].Status = "current"
		default:
			steps[i].Status = "pending"
		}
	}
	// The enquiry is always done: the family is reading this because it
	// happened.
	steps[0].Status = "done"

	next := ""
	switch {
	case status == "" || status == "draft":
		steps[1].Status = "current"
		next = "Fill in the application form to continue."
	case status == "rejected":
		steps[3].Status = "done"
		steps[3].Note = "A seat could not be offered this year."
		steps[4].Status = "pending"
	case status == "withdrawn":
		steps[3].Status = "done"
		steps[3].Note = "This application was withdrawn."
		steps[4].Status = "pending"
	case status == "waitlisted":
		steps[3].Status = "current"
		steps[3].Note = "On the waiting list. The school will be in touch if a seat opens."
	case status == "offered":
		steps[3].Status = "done"
		steps[3].Note = "A seat has been offered."
		steps[4].Status = "current"
		next = "A seat has been offered. Please contact the office to confirm admission."
	case missing > 0:
		steps[2].Status = "current"
		next = "Some required documents are still to be submitted."
	}
	if admitted {
		next = ""
	}
	return steps, next
}
