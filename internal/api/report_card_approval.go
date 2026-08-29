package api

import (
	"net/http"
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

		/* The child and their guardians, per card.

		   One alert each here rather than one for the batch: this one is about
		   a particular child and lands in a particular family's app, and a
		   family has exactly one of them to read. */
		for _, d := range cards {
			card := d.card
			people, err := tx.Query(r.Context(), `
				SELECT g.user_id FROM student_guardians sg
				  JOIN guardians g ON g.id = sg.guardian_id
				 WHERE sg.student_id = $1 AND g.user_id IS NOT NULL
				UNION
				SELECT st.user_id FROM students st
				 WHERE st.id = $1 AND st.user_id IS NOT NULL`, d.student)
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
	httpx.JSON(w, http.StatusOK, map[string]any{"published": released})
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
