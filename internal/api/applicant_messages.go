package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Telling a family what is happening to their application.

   An applicant is not a student, and every message the product could send was
   aimed at a guardian of one: the two standing plans are a fee reminder and an
   absence alert. So a school could record an offer, a missing birth
   certificate and a test date, and had no way to tell the family any of it —
   all three happen on somebody's personal WhatsApp, outside the record.

   The sharpest case is the one this module made itself. Rejecting a document
   asks for a reason, because the whole value of a rejection is telling the
   parent what to bring back, and that reason reached nobody.

   Nothing new is built for the sending. QueueMessage already resolves the
   provider, renders the template, dedupes by source and leaves it for the
   dispatcher; this chooses who and what, and hands over.
*/

// applicantNote is one thing a school says to an applicant's family.
//
// Deliberately a short fixed list rather than free text with a template
// picker. These are the four moments an admissions office actually writes
// about, and a school that can write anything writes nothing consistently.
type applicantNote struct {
	Kind    string
	Subject string
	Body    string
}

/* THE FOUR NOTES ARE ALSO THE FOUR TEMPLATES.

   This screen sent TemplateCode "admissions." + kind — admissions.offer,
   .documents, .test, .regret — and not one of those existed. The built-in list
   carried admissions.offered, .documents_pending, .test_scheduled and
   .rejected: four templates for the same four moments, under four different
   names, written for a different set of variables ({{student_name}} against
   this screen's {{child}}). So every send from here failed with

       0 sent, 1 not sent: ... no template "admissions.offer" for sms

   and the office was told to fix something it had no way to fix.

   The wording it needs is already right here, in applicantNotes, with the
   right variables. Registering that as the built-in is therefore not new copy,
   it is the removal of a second source of truth: the note a clerk previews and
   the template that goes out are now the same object, and cannot drift into
   disagreeing about what the school said.

   Registered for every channel, because resolveTemplate falls back to the
   built-in whatever the channel is, and a school that has written its own
   admissions.offer row still overrides this — the database is checked first. */
func init() {
	for kind, note := range applicantNotes() {
		builtinTemplates["admissions."+kind] = builtinTemplate{
			Subject: note.Subject,
			Body:    note.Body,
		}
	}
}

func applicantNotes() map[string]applicantNote {
	return map[string]applicantNote{
		"offer": {
			Kind:    "offer",
			Subject: "A place has been offered",
			Body: "Dear {{parent}}, we are glad to offer {{child}} a place in {{class}} " +
				"at {{school}}. Application {{application_no}}. Please confirm by paying " +
				"the admission fee at the school office.",
		},
		"documents": {
			Kind:    "documents",
			Subject: "Documents still needed",
			Body: "Dear {{parent}}, application {{application_no}} for {{child}} is waiting " +
				"on paperwork: {{detail}}. Please bring the originals to the school office.",
		},
		"test": {
			Kind:    "test",
			Subject: "Entrance test",
			Body: "Dear {{parent}}, {{child}} is due to sit the entrance test for {{class}}. " +
				"{{detail}} Please arrive fifteen minutes early with application " +
				"{{application_no}}.",
		},
		"regret": {
			Kind:    "regret",
			Subject: "About your application",
			Body: "Dear {{parent}}, thank you for applying to {{school}} for {{child}}. " +
				"We are not able to offer a place in {{class}} this session. " +
				"{{detail}}",
		},
	}
}

type applicantMessageRequest struct {
	// Which applications to write to. Empty is refused rather than treated as
	// "everybody": a message to every applicant on the roll is not something
	// anybody means to send by leaving a box blank.
	ApplicationIDs []string `json:"application_ids"`
	Kind           string   `json:"kind"`
	// Fills {{detail}} — which documents, when the test is, why not. Required
	// for the two that are meaningless without it.
	Detail  string `json:"detail,omitempty"`
	Channel string `json:"channel,omitempty"`
}

type applicantMessageResult struct {
	Sent    int      `json:"sent"`
	Skipped []string `json:"skipped,omitempty"`
}

// sendApplicantMessages writes to the families behind a set of applications.
func (s *Server) sendApplicantMessages(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req applicantMessageRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.ApplicationIDs) == 0 {
		httpx.BadRequest(w, r, "choose at least one applicant to write to")
		return
	}
	note, ok := applicantNotes()[req.Kind]
	if !ok {
		httpx.BadRequest(w, r, "that is not one of the messages this office sends")
		return
	}
	/* Two of the four say nothing without the detail. "Documents still needed"
	   with no list is the message that sends a parent to the office to ask
	   what is missing, which is the errand it was supposed to save. */
	if (req.Kind == "documents" || req.Kind == "test") && strings.TrimSpace(req.Detail) == "" {
		httpx.BadRequest(w, r,
			"say which documents, or when the test is. Without it the message "+
				"only tells the family to come and ask")
		return
	}
	channel := strings.TrimSpace(req.Channel)
	if channel == "" {
		channel = "sms"
	}

	out := applicantMessageResult{Skipped: []string{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var school string
		_ = tx.QueryRow(r.Context(), `SELECT name FROM institutions LIMIT 1`).Scan(&school)

		rows, err := tx.Query(r.Context(), `
			SELECT a.id::text, a.application_no,
			       concat_ws(' ', a.first_name, a.last_name),
			       a.parent_name, a.parent_phone, coalesce(a.parent_email::text, ''),
			       coalesce(c.name, '')
			  FROM applications a
			  LEFT JOIN classes c ON c.id = a.class_sought
			 WHERE a.id = ANY($1::uuid[])`, req.ApplicationIDs)
		if err != nil {
			return err
		}
		type target struct {
			id, no, child, parent, phone, email, class string
		}
		var list []target
		for rows.Next() {
			var t target
			if err := rows.Scan(&t.id, &t.no, &t.child, &t.parent, &t.phone,
				&t.email, &t.class); err != nil {
				rows.Close()
				return err
			}
			list = append(list, t)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, t := range list {
			to := t.phone
			if channel == "email" {
				to = t.email
			}
			if strings.TrimSpace(to) == "" {
				/* Named, not counted. "3 skipped" tells the office a number;
				   what they need is which three, because each one is a family
				   who will not hear and has to be rung instead. */
				out.Skipped = append(out.Skipped,
					t.no+" "+t.child+", no "+channelNoun(channel)+" on the application")
				continue
			}
			appID, err := uuid.Parse(t.id)
			if err != nil {
				return err
			}
			res, err := s.QueueMessage(r.Context(), tx, id.InstitutionID, SendRequest{
				Channel:      channel,
				TemplateCode: "admissions." + note.Kind,
				Vars: map[string]any{
					"parent":         t.parent,
					"child":          t.child,
					"class":          t.class,
					"school":         school,
					"application_no": t.no,
					"detail":         strings.TrimSpace(req.Detail),
				},
				Recipient: to,
				/* Keyed on the application and the kind, so pressing the button
				   twice does not tell a family twice that they have a place.
				   The detail is part of the key: a second document reminder
				   listing something different is a different message. */
				SourceKind:    "admission_" + note.Kind,
				SourceID:      &appID,
				OccurrenceKey: strings.TrimSpace(req.Detail),
			})
			if err != nil {
				out.Skipped = append(out.Skipped, t.no+" "+t.child+" - "+err.Error())
				continue
			}
			if res.Duplicate {
				out.Skipped = append(out.Skipped,
					t.no+" "+t.child+", already told this")
				continue
			}
			out.Sent++
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func channelNoun(ch string) string {
	if ch == "email" {
		return "email address"
	}
	return "phone number"
}
