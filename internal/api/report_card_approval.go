package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Report cards go up before they go out.

   Generating one used to publish it in the same call, so a class teacher
   pressing a button put results in front of every family in the section. No
   school works that way: a head signs the results off before they leave the
   building, because a wrong mark reaching a parent cannot be recalled and
   because the principal's remark is written after reading them.

   Three verbs, all of them acting on a set:

     submit   the class teacher sends a section up
     publish  the head approves and releases, to the child and the guardians
     return   the head sends it back with a reason

   Every one takes a list of ids, and the screen decides what goes in it — the
   whole section, the ones somebody ticked, or a single card. A separate
   "approve all" endpoint would be the same query with the selection made on
   the server instead of by the person who can see the marks.
*/

type reportCardAction struct {
	// The cards to act on. Named explicitly rather than by section, so what
	// the head ticked is what the head gets — a section that gained a child
	// between rendering and pressing must not be silently included.
	IDs []string `json:"ids"`
	/* Whole sections, for the head who is releasing a term's results.

	   Naming every card works while somebody is looking at one section; it
	   does not when eleven sections are waiting and the answer to all of them
	   is yes. Listing each section's cards on the client first would be a
	   round trip per section and a list that is already stale by the time the
	   button is pressed.

	   The two combine: ids and section_ids are unioned, and every card is
	   still filtered by the state the verb requires, so a section named here
	   releases exactly what was submitted from it and nothing else. */
	SectionIDs []string `json:"section_ids,omitempty"`
	// Why it went back. Required for a return and refused on the others.
	Note string `json:"note,omitempty"`

	/* Who is told, and how — the head's decision at the moment of release.

	   A school does not always tell both: a board class is told through the
	   child, a primary class through the parents, and a school running a
	   parents' evening tells the parents only because the child is being given
	   the card by hand. Defaulting to both is right; taking the choice away is
	   not.

	   The in-app alert always goes, to whoever is named here, because it costs
	   nothing and it is the copy that is still there in a week. The other
	   three cost money per message and are opt-in per publish. */
	To       string   `json:"to,omitempty"`       // students | parents | both
	Channels []string `json:"channels,omitempty"` // sms, whatsapp, email
}

// audience answers who a published card is announced to.
func (a reportCardAction) audience() (students, parents bool) {
	switch strings.TrimSpace(a.To) {
	case "students":
		return true, false
	case "parents":
		return false, true
	default:
		return true, true
	}
}

func (a reportCardAction) sections(w http.ResponseWriter, r *http.Request) ([]uuid.UUID, bool) {
	out := make([]uuid.UUID, 0, len(a.SectionIDs))
	for _, raw := range a.SectionIDs {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			httpx.BadRequest(w, r, "every section_id must be a uuid")
			return nil, false
		}
		out = append(out, id)
	}
	return out, true
}

func (a reportCardAction) ids(w http.ResponseWriter, r *http.Request) ([]uuid.UUID, bool) {
	if len(a.IDs) == 0 && len(a.SectionIDs) == 0 {
		httpx.BadRequest(w, r, "choose at least one report card")
		return nil, false
	}
	if len(a.IDs) == 0 {
		// Sections carry the whole selection; the id list is legitimately
		// empty and the SQL reads it as "match nothing extra".
		return []uuid.UUID{}, true
	}
	if len(a.IDs) > 2000 {
		// A section is sixty and a school is a few thousand. The cap is a
		// runaway guard, not a policy: nobody legitimately acts on more.
		httpx.BadRequest(w, r, "that is more report cards than one action should carry")
		return nil, false
	}
	out := make([]uuid.UUID, 0, len(a.IDs))
	for _, raw := range a.IDs {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			httpx.BadRequest(w, r, "every id must be a uuid")
			return nil, false
		}
		out = append(out, id)
	}
	return out, true
}

// submitReportCards sends a set up to whoever signs results off.
//
// Only from draft or returned: a card already waiting on the head is not sent
// twice, and one already published is not unpublished by re-submitting it.
func (s *Server) submitReportCards(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reportCardAction
	if !httpx.Decode(w, r, &req) {
		return
	}
	ids, ok := req.ids(w, r)
	if !ok {
		return
	}

	sections, ok := req.sections(w, r)
	if !ok {
		return
	}

	var moved int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE report_cards rc
			   SET status = 'submitted', submitted_at = now(), submitted_by = $2,
			       return_note = NULL
			  FROM enrollments e
			 WHERE e.id = rc.enrollment_id
			   AND (rc.id = ANY($1) OR e.section_id = ANY($3))
			   AND rc.status IN ('draft','returned')`,
			ids, id.UserID, sections)
		if err != nil {
			return err
		}
		moved = tag.RowsAffected()
		if moved == 0 {
			return nil
		}

		/* Tell whoever has to act on it.

		   A queue nobody is told about is one that fills up until somebody
		   asks why the results are late. Everyone holding the release right
		   is told once for the batch rather than once per card — thirty
		   notifications for one section is how a person learns to ignore the
		   bell. */
		var section string
		_ = tx.QueryRow(r.Context(), `
			SELECT COALESCE(c.name || '-' || sec.name, 'a section')
			  FROM report_cards rc
			  JOIN enrollments e ON e.id = rc.enrollment_id
			  JOIN sections sec ON sec.id = e.section_id
			  JOIN classes c ON c.id = sec.class_id
			 WHERE rc.id = ANY($1) LIMIT 1`, ids).Scan(&section)

		var from string
		_ = tx.QueryRow(r.Context(),
			`SELECT full_name FROM users WHERE id = $1`, id.UserID).Scan(&from)

		heads, err := tx.Query(r.Context(), `
			SELECT DISTINCT ur.user_id
			  FROM user_roles ur
			  JOIN role_permissions rp ON rp.role_id = ur.role_id
			 WHERE rp.permission_key = $1`, rbac.ReportCardsPublish)
		if err != nil {
			return err
		}
		var to []uuid.UUID
		for heads.Next() {
			var u uuid.UUID
			if err := heads.Scan(&u); err != nil {
				heads.Close()
				return err
			}
			to = append(to, u)
		}
		heads.Close()
		if err := heads.Err(); err != nil {
			return err
		}

		// The key that keeps one batch to one alert. Sections may carry the
		// whole selection, in which case there is no id to key on.
		var batch *uuid.UUID
		if len(ids) > 0 {
			batch = &ids[0]
		}
		for _, u := range to {
			if u == id.UserID {
				continue
			}
			if err := notify(r, tx, id.InstitutionID, u, nil, "report_cards_submitted",
				section+" report cards are ready to sign off",
				itoa(int(moved))+" cards sent up by "+from,
				"/go/report_cards", "report_card_batch", batch); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"submitted": moved})
}

// publishReportCards approves a set and releases it to the family.
func (s *Server) publishReportCards(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reportCardAction
	if !httpx.Decode(w, r, &req) {
		return
	}
	ids, ok := req.ids(w, r)
	if !ok {
		return
	}

	sections, ok := req.sections(w, r)
	if !ok {
		return
	}

	var released int64
	var publishedIDs []uuid.UUID
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Only what was actually sent up.

		   Publishing a draft would let a head release a card the class teacher
		   is still working on — the queue only ever shows submitted ones, and
		   this makes that a rule rather than a property of the screen. */
		rows, err := tx.Query(r.Context(), `
			UPDATE report_cards rc
			   SET status = 'published', is_published = true, published_at = now(),
			       decided_at = now(), decided_by = $2, return_note = NULL
			  FROM enrollments e
			 WHERE e.id = rc.enrollment_id
			   AND (rc.id = ANY($1) OR e.section_id = ANY($3))
			   AND rc.status = 'submitted'
			 RETURNING rc.id, rc.student_id`, ids, id.UserID, sections)
		if err != nil {
			return err
		}
		type done struct{ card, student uuid.UUID }
		var cards []done
		for rows.Next() {
			var d done
			if err := rows.Scan(&d.card, &d.student); err != nil {
				rows.Close()
				return err
			}
			cards = append(cards, d)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		released = int64(len(cards))
		for _, d := range cards {
			publishedIDs = append(publishedIDs, d.card)
		}

		/* The child and their guardians, per card.

		   One alert each here rather than one for the batch: this one is about
		   a particular child and lands in a particular family's app, and a
		   family has exactly one of them to read. */
		toStudents, toParents := req.audience()
		for _, d := range cards {
			card := d.card
			people, err := tx.Query(r.Context(), `
				SELECT g.user_id FROM student_guardians sg
				  JOIN guardians g ON g.id = sg.guardian_id
				 WHERE sg.student_id = $1 AND g.user_id IS NOT NULL AND $2
				UNION
				SELECT st.user_id FROM students st
				 WHERE st.id = $1 AND st.user_id IS NOT NULL AND $3`,
				d.student, toParents, toStudents)
			if err != nil {
				return err
			}
			var to []uuid.UUID
			for people.Next() {
				var u uuid.UUID
				if err := people.Scan(&u); err != nil {
					people.Close()
					return err
				}
				to = append(to, u)
			}
			people.Close()
			if err := people.Err(); err != nil {
				return err
			}
			student := d.student
			// What the head chose, kept with the card. "The parents were told"
			// is a claim a school has to stand behind in November when a family
			// says they never heard.
			if _, err := tx.Exec(r.Context(), `
				UPDATE report_cards SET published_to = $2, published_channels = $3
				 WHERE id = $1`, card, audienceLabel(toStudents, toParents),
				strings.Join(cleanChannels(req.Channels), ",")); err != nil {
				return err
			}
			for _, u := range to {
				if err := notify(r, tx, id.InstitutionID, u, &student, "report_card",
					"The report card is out",
					"Results have been published. Open it to see the subject breakdown.",
					"/go/results_report_cards", "report_card", &card); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Outside the transaction, deliberately.

	   The cards are published; a gateway being slow must not undo that, and a
	   dispatcher run holding a write transaction open across an HTTP call to
	   a provider is how one slow send blocks a table. */
	toStudents, toParents := req.audience()
	channels := cleanChannels(req.Channels)
	queued, qErr := s.announceReportCards(r, publishedIDs, toStudents, toParents, channels)
	if queued > 0 {
		// Hand them to the dispatcher now rather than waiting for the
		// five-minute sweep: results are read within the hour or not at all.
		go func() {
			_, _, _ = s.DispatchMessages(context.WithoutCancel(r.Context()),
				id.InstitutionID, false, 200)
		}()
	}
	out := map[string]any{
		"published": released, "messages_queued": queued,
		"to": audienceLabel(toStudents, toParents), "channels": channels,
	}
	if qErr != nil {
		// The release stands; say plainly that the sending half did not.
		out["delivery_error"] = qErr.Error()
	}
	httpx.JSON(w, http.StatusOK, out)
}

// returnReportCards sends a set back to the class teacher, with the reason.
func (s *Server) returnReportCards(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reportCardAction
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r,
			"say what needs changing — a card sent back without a reason is one "+
				"the class teacher has to come and ask about")
		return
	}
	ids, ok := req.ids(w, r)
	if !ok {
		return
	}

	sections, ok := req.sections(w, r)
	if !ok {
		return
	}

	var sent int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var submitters []uuid.UUID
		rows, err := tx.Query(r.Context(), `
			UPDATE report_cards rc
			   SET status = 'returned', return_note = btrim($3),
			       decided_at = now(), decided_by = $2
			  FROM enrollments e
			 WHERE e.id = rc.enrollment_id
			   AND (rc.id = ANY($1) OR e.section_id = ANY($4))
			   AND rc.status = 'submitted'
			 RETURNING rc.submitted_by`, ids, id.UserID, req.Note, sections)
		if err != nil {
			return err
		}
		seen := map[uuid.UUID]bool{}
		for rows.Next() {
			var u *uuid.UUID
			if err := rows.Scan(&u); err != nil {
				rows.Close()
				return err
			}
			sent++
			if u != nil && !seen[*u] {
				seen[*u] = true
				submitters = append(submitters, *u)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// One alert per class teacher, not per card: they are about to open
		// the same screen either way.
		var batch *uuid.UUID
		if len(ids) > 0 {
			batch = &ids[0]
		}
		for _, u := range submitters {
			if u == id.UserID {
				continue
			}
			if err := notify(r, tx, id.InstitutionID, u, nil, "report_cards_returned",
				"Report cards sent back", strings.TrimSpace(req.Note),
				"/go/report_cards", "report_card_batch", batch); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"returned": sent})
}

/*
What is waiting on the head, across the whole school.

	The screen shows one section at a time, which is right for reading thirty
	cards and wrong for the afternoon a term's results are released: eleven
	sections are waiting and the answer to all of them is yes. This is the list
	that makes the one button possible, and it is per section rather than per
	card because that is the unit a head signs off — a class teacher submits a
	section, and the head accepts or returns one.
*/
type pendingReportCards struct {
	SectionID   string  `json:"section_id"`
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	Cards       int     `json:"cards"`
	SubmittedBy *string `json:"submitted_by,omitempty"`
	// When the earliest of them was sent up. A section waiting since Tuesday
	// is the one to look at first, and "3 days" is the fact that says so.
	SubmittedAt *string `json:"submitted_at,omitempty"`
}

func (s *Server) listPendingReportCards(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT sec.id::text, sec.name, c.name, count(*)::int,
		       max(u.full_name),
		       to_char(min(rc.submitted_at), 'YYYY-MM-DD"T"HH24:MI')
		  FROM report_cards rc
		  JOIN enrollments e ON e.id = rc.enrollment_id
		  JOIN sections sec  ON sec.id = e.section_id
		  JOIN classes c     ON c.id = sec.class_id
		  LEFT JOIN users u  ON u.id = rc.submitted_by
		 WHERE rc.status = 'submitted'
		 GROUP BY sec.id, sec.name, c.name, c.level
		 ORDER BY c.level, sec.name`, nil,
		func(rows pgx.Rows) (pendingReportCards, error) {
			var v pendingReportCards
			return v, rows.Scan(&v.SectionID, &v.SectionName, &v.ClassName,
				&v.Cards, &v.SubmittedBy, &v.SubmittedAt)
		})
	respond(w, r, items, err)
}

// audienceLabel names the choice for the record.
func audienceLabel(students, parents bool) string {
	switch {
	case students && parents:
		return "both"
	case students:
		return "students"
	case parents:
		return "parents"
	}
	return "nobody"
}

/*
cleanChannels keeps the three this product can actually send on.

	Anything else is dropped rather than refused: a client sending "app" means
	the in-app alert, which always goes and is not a queued message, and failing
	the whole publish over a word in a list would hold up a term's results.
*/
func cleanChannels(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range in {
		c = strings.ToLower(strings.TrimSpace(c))
		if (c == "sms" || c == "whatsapp" || c == "email") && !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	return out
}

/*
announceReportCards sends the card out on the channels the head chose.

	Queued rather than sent inline, and after the transaction that published
	them: a gateway that is slow or down must not roll back a release the school
	has already decided on, and the dispatcher retries on its own schedule.

	One message per person per card. Deduplication is the recipient address, so
	a mother listed against two children gets two messages — which is right,
	because they are about two children.
*/
func (s *Server) announceReportCards(r *http.Request, cards []uuid.UUID,
	toStudents, toParents bool, channels []string) (int, error) {
	if len(channels) == 0 || len(cards) == 0 {
		return 0, nil
	}
	id := httpx.IdentityFrom(r.Context())
	queued := 0
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT concat_ws(' ', st.first_name, st.last_name),
			       COALESCE(c.name,'') || '-' || COALESCE(sec.name,''),
			       COALESCE(rc.percentage, 0), COALESCE(rc.grade, ''),
			       who.phone, who.email
			  FROM report_cards rc
			  JOIN students st   ON st.id = rc.student_id
			  JOIN enrollments e ON e.id = rc.enrollment_id
			  LEFT JOIN sections sec ON sec.id = e.section_id
			  LEFT JOIN classes c    ON c.id = sec.class_id
			  JOIN LATERAL (
			        SELECT g.phone, g.email::text FROM student_guardians sg
			          JOIN guardians g ON g.id = sg.guardian_id
			         WHERE sg.student_id = rc.student_id AND $2
			        UNION ALL
			        /* The child's own contact details are their login's: a
			           student row holds no phone, because a child who has one
			           has an account and a child who has neither is reached
			           through a guardian. */
			        SELECT u.phone, u.email::text FROM students st2
			          JOIN users u ON u.id = st2.user_id
			         WHERE st2.id = rc.student_id AND $3
			  ) who ON TRUE
			 WHERE rc.id = ANY($1)`, cards, toParents, toStudents)
		if err != nil {
			return err
		}
		type note struct{ name, section, phone, email, text string }
		var notes []note
		for rows.Next() {
			var n note
			var pct float64
			var grade string
			var phone, email *string
			if err := rows.Scan(&n.name, &n.section, &pct, &grade, &phone, &email); err != nil {
				rows.Close()
				return err
			}
			if phone != nil {
				n.phone = strings.TrimSpace(*phone)
			}
			if email != nil {
				n.email = strings.TrimSpace(*email)
			}
			/* Marks in the message itself, not a link to go and find them.

			   A result read on a phone at the school gate is the whole point;
			   a link that needs a password first is a message that gets opened
			   the following evening, if at all. The card itself stays in the
			   app for anyone who wants the subject breakdown. */
			n.text = n.name + " (" + n.section + "): report card published — " +
				strconv.FormatFloat(pct, 'f', 1, 64) + "%"
			if grade != "" {
				n.text += ", grade " + grade
			}
			n.text += ". Open the app for the subject-wise marks."
			notes = append(notes, n)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, n := range notes {
			for _, ch := range channels {
				to := n.phone
				if ch == "email" {
					to = n.email
				}
				if to == "" {
					// No number or no address on file. Skipped rather than
					// failed: the in-app alert has already reached them, and a
					// publish must not stop because one family has no mobile.
					continue
				}
				if _, err := s.QueueMessage(r.Context(), tx, id.InstitutionID, SendRequest{
					Channel:      ch,
					TemplateCode: "messaging.direct",
					Vars: map[string]any{
						"text": n.text, "subject": "Report card published",
					},
					Recipient: to,
				}); err != nil {
					/* A gateway that is not configured is the school's setting
					   to fix, not a reason to fail a release that has already
					   happened. Counted as not queued and reported back. */
					continue
				}
				queued++
			}
		}
		return nil
	})
	return queued, err
}

/*
Taking a published set back.

	Results go out wrong: a subject teacher had a paper unmarked, a section was
	released before it was ready, the head approved the wrong Grade 6. Without
	this the only remedy is a card standing published and wrong while somebody
	regenerates it, with the families already reading it.

	Back to draft, with the class teacher, exactly as it was before it was sent
	up — so the ordinary route is the route back out: fix it, send it for
	approval, and the head releases it again.

	The families are NOT told. A "your child's report card has been withdrawn"
	alert on a phone is worse than the quiet correction it announces, and the
	alert they already have points at a card they can no longer open. Only the
	class teacher is told, because they are the one who has to act.
*/
func (s *Server) withdrawReportCards(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reportCardAction
	if !httpx.Decode(w, r, &req) {
		return
	}
	ids, ok := req.ids(w, r)
	if !ok {
		return
	}
	sections, ok := req.sections(w, r)
	if !ok {
		return
	}

	var pulled int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			UPDATE report_cards rc
			   SET status = 'draft', is_published = false, published_at = NULL,
			       submitted_at = NULL, decided_at = NULL, decided_by = NULL,
			       return_note = NULL, published_to = NULL, published_channels = NULL
			  FROM enrollments e
			 WHERE e.id = rc.enrollment_id
			   AND (rc.id = ANY($1) OR e.section_id = ANY($2))
			   AND rc.status = 'published'
			 RETURNING rc.submitted_by`, ids, sections)
		if err != nil {
			return err
		}
		seen := map[uuid.UUID]bool{}
		var teachers []uuid.UUID
		for rows.Next() {
			var u *uuid.UUID
			if err := rows.Scan(&u); err != nil {
				rows.Close()
				return err
			}
			pulled++
			if u != nil && !seen[*u] {
				seen[*u] = true
				teachers = append(teachers, *u)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		/* submitted_at is cleared above, which is what puts the card back in
		   the class teacher's hands rather than in the head's queue. The
		   notification is the only thing that tells them it happened. */
		var batch *uuid.UUID
		if len(ids) > 0 {
			batch = &ids[0]
		}
		for _, u := range teachers {
			if u == id.UserID {
				continue
			}
			if err := notify(r, tx, id.InstitutionID, u, nil, "report_cards_withdrawn",
				"Report cards taken back",
				"They are drafts again and the families can no longer open them. "+
					"Correct them and send them for approval when they are right.",
				"/go/report_cards", "report_card_batch", batch); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"withdrawn": pulled})
}
