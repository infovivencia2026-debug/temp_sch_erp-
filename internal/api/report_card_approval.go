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
	// Why it went back. Required for a return and refused on the others.
	Note string `json:"note,omitempty"`
}

func (a reportCardAction) ids(w http.ResponseWriter, r *http.Request) ([]uuid.UUID, bool) {
	if len(a.IDs) == 0 {
		httpx.BadRequest(w, r, "choose at least one report card")
		return nil, false
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

	var moved int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE report_cards
			   SET status = 'submitted', submitted_at = now(), submitted_by = $2,
			       return_note = NULL
			 WHERE id = ANY($1) AND status IN ('draft','returned')`,
			ids, id.UserID)
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

		batch := ids[0] // the key that keeps one batch to one alert
		for _, u := range to {
			if u == id.UserID {
				continue
			}
			if err := notify(r, tx, id.InstitutionID, u, nil, "report_cards_submitted",
				section+" report cards are ready to sign off",
				itoa(int(moved))+" cards sent up by "+from,
				"/go/report_cards", "report_card_batch", &batch); err != nil {
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

	var released int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Only what was actually sent up.

		   Publishing a draft would let a head release a card the class teacher
		   is still working on — the queue only ever shows submitted ones, and
		   this makes that a rule rather than a property of the screen. */
		rows, err := tx.Query(r.Context(), `
			UPDATE report_cards
			   SET status = 'published', is_published = true, published_at = now(),
			       decided_at = now(), decided_by = $2, return_note = NULL
			 WHERE id = ANY($1) AND status = 'submitted'
			 RETURNING id, student_id`, ids, id.UserID)
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

	var sent int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var submitters []uuid.UUID
		rows, err := tx.Query(r.Context(), `
			UPDATE report_cards
			   SET status = 'returned', return_note = btrim($3),
			       decided_at = now(), decided_by = $2
			 WHERE id = ANY($1) AND status = 'submitted'
			 RETURNING submitted_by`, ids, id.UserID, req.Note)
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
		batch := ids[0]
		for _, u := range submitters {
			if u == id.UserID {
				continue
			}
			if err := notify(r, tx, id.InstitutionID, u, nil, "report_cards_returned",
				"Report cards sent back", strings.TrimSpace(req.Note),
				"/go/report_cards", "report_card_batch", &batch); err != nil {
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
