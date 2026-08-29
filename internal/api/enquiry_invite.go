package api

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* THE APPLICATION LINK, PUT IN THE PARENT'S HAND.

   A front-office clerk takes a call, writes down a child's name and a mobile
   number, and the family goes away with nothing. Whether they ever apply then
   depends on somebody remembering to ring them back, which is the step this
   product had no answer for: enquiries sat at 'new' and the funnel showed a
   conversion rate nobody could move.

   The link costs the school nothing and is the one thing worth sending while a
   parent is still thinking about the school. So the moment an enquiry records a
   phone number, the form goes to it.

   ---------------------------------------------------------------------------
   ALL THREE CHANNELS, AND WHY

   WhatsApp first, because it is what a Telangana parent actually reads. SMS
   because it is the only one that arrives on a feature phone and needs no data.
   Email only when one was given, which is a minority of enquiries and never the
   only address.

   Sent as three separate messages rather than one with a fallback chain. A
   fallback needs delivery receipts to know it failed, and this product has no
   inbound webhook for WhatsApp - so "did it arrive" is unanswerable, and
   choosing on the basis of an answer it does not have would mean the commonest
   case, WhatsApp silently not delivering, ends in nothing being sent at all.

   The recipient allowlist still stands in front of all three: on a school still
   in testing these are recorded and held, not sent, which is what stops a
   demo from texting real families.

   ---------------------------------------------------------------------------
   WHAT MAKES IT SKIP

   No open form, no link, no message. A school that has not published an
   application form has nothing to send anybody to, and inventing a URL that
   404s is worse than staying quiet. The enquiry is still created either way:
   this is a courtesy on top of the record, never a condition of it.
*/

// enquiryInviteChannels is the order they are queued in, which is the order the
// dispatcher will attempt them. WhatsApp leads because it is what gets read.
var enquiryInviteChannels = []string{"whatsapp", "sms", "email"}

/*
sendEnquiryApplicationLink queues the application form to a new enquiry's contacts.

	Runs inside the caller's transaction on purpose, like every other
	QueueMessage caller: an enquiry that rolls back must not leave a message
	promising a parent a form for a child the school has no record of.

	Never returns an error that fails the enquiry. A courtesy message that
	cannot be queued is worth a log line, not a lost enquiry - the clerk has
	the parent on the phone and re-typing the whole thing because the SMS
	provider is unconfigured would be absurd.
*/
func (s *Server) sendEnquiryApplicationLink(
	ctx context.Context, tx pgx.Tx, inst uuid.UUID, enquiryID uuid.UUID,
	studentName, parentName, phone, email string,
) {
	phone = strings.TrimSpace(phone)
	email = strings.TrimSpace(email)
	if phone == "" && email == "" {
		return
	}

	/* The form to send them to.

	   The most recently opened form that is actually open and has a published
	   version. `is_open` alone is not enough: a form somebody opened before
	   publishing a version renders as an empty page, which is a worse first
	   impression than no link at all. */
	var slug, schoolName string
	err := tx.QueryRow(ctx, `
		SELECT f.slug, i.name
		  FROM admission_forms f
		  JOIN institutions i ON i.id = f.institution_id
		 WHERE f.institution_id = $1
		   AND f.is_open
		   AND (f.opens_on  IS NULL OR f.opens_on  <= CURRENT_DATE)
		   AND (f.closes_on IS NULL OR f.closes_on >= CURRENT_DATE)
		   AND EXISTS (SELECT 1 FROM admission_form_versions v
		                WHERE v.form_id = f.id AND v.status = 'published')
		 ORDER BY f.updated_at DESC
		 LIMIT 1`, inst).Scan(&slug, &schoolName)
	if err != nil {
		// pgx.ErrNoRows is the ordinary case for a school that has not opened
		// admissions yet, and is not worth a log line every time a walk-in is
		// recorded.
		return
	}

	url := strings.TrimSuffix(s.BaseURL, "/") + "/admissions/apply/" + slug
	vars := map[string]any{
		"school_name":  schoolName,
		"student_name": studentName,
		// A form addressed to nobody reads worse than one addressed to a
		// stranger, and the clerk often has only the child's name.
		"parent_name": firstNonEmpty(parentName, "Sir/Madam"),
		"apply_url":   url,
	}

	for _, channel := range enquiryInviteChannels {
		to := phone
		if channel == "email" {
			to = email
		}
		if to == "" {
			continue
		}
		/* OccurrenceKey makes this idempotent per enquiry per channel. An
		   enquiry edited twice, or a clerk who presses save again because the
		   page was slow, must not text the same family three times - which is
		   how a school's number gets reported as spam. */
		if _, err := s.QueueMessage(ctx, tx, inst, SendRequest{
			Channel:       channel,
			TemplateCode:  "admissions.enquiry_link",
			Vars:          vars,
			Recipient:     to,
			SourceKind:    "enquiry",
			SourceID:      &enquiryID,
			OccurrenceKey: "apply_link:" + channel,
		}); err != nil {
			// Swallowed, never returned: see the doc comment. A courtesy
			// message that cannot be queued is not worth losing an enquiry a
			// clerk has a parent on the phone for.
			_ = err
		}
	}
}
