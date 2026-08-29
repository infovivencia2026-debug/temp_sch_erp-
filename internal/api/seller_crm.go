package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE SALES PIPELINE, made workable.

   purchase_enquiries has carried a five-stage status since migration 00013 --
   new, contacted, demo_booked, won, lost -- with a CHECK constraint enforcing
   it. The public buy form writes rows (buy.go:215) and listSalesEnquiries
   reads them. Nothing anywhere ran UPDATE purchase_enquiries, and no screen
   fetched the endpoint, so every lead this product has received is still 'new'
   and always would have been.

   This file is the missing half: move a lead, own it, say what happened, and
   see what is due today.

   ---------------------------------------------------------------------------
   WHY THE STAGE MOVE WRITES A NOTE

   A pipeline that shows only the current stage cannot answer the question the
   next call needs, which is what was said on the last one. Every move writes a
   'stage' row into purchase_enquiry_notes alongside whatever the person typed,
   so one query returns the lead's whole history in order -- rather than a
   status column and a notes list that somebody has to interleave by eye.

   ---------------------------------------------------------------------------
   WHY THE TRANSITIONS ARE GUARDED IN SQL

   Two salespeople opening the same lead on a Monday morning is ordinary, not
   exceptional. The UPDATE carries the expected current status in its WHERE and
   0 rows affected is a 409 -- the second person is told the lead moved under
   them rather than silently overwriting the first. Read-then-write in Go would
   lose that race every time and look correct in every test that runs one
   request at a time. */

// leadStages is the CHECK constraint, restated where the handler can use it.
// If the constraint changes this must change with it -- Postgres would refuse
// the write anyway, but a 500 from a constraint is a worse answer than a 400
// that names the stages.
var leadStages = map[string]bool{
	"new": true, "contacted": true, "demo_booked": true, "won": true, "lost": true,
}

/* Which moves are legal.

   Not every pair: a lead cannot go straight from 'new' to 'won' without
   somebody having spoken to the school, and a stage board that permits it
   produces a pipeline nobody believes. Won and lost are terminal in the
   forward direction and reopenable backwards, because a school that said no in
   March genuinely does ring back in June -- that is the single commonest
   real event in school sales and refusing it would send people to the
   database. */
var leadMoves = map[string][]string{
	"new":         {"contacted", "lost"},
	"contacted":   {"demo_booked", "won", "lost"},
	"demo_booked": {"won", "lost", "contacted"},
	"won":         {"contacted"},
	"lost":        {"new", "contacted"},
}

func canMove(from, to string) bool {
	for _, s := range leadMoves[from] {
		if s == to {
			return true
		}
	}
	return false
}

var (
	errLeadStageUnknown = errors.New("unknown stage")
	errLeadMoveIllegal  = errors.New("illegal stage move")
	errLeadRaced        = errors.New("the lead moved under this request")
	errLostNeedsReason  = errors.New("a lost lead needs a reason")
)

type leadUpdateRequest struct {
	// From is the stage the caller believes the lead is in. Required for a
	// move, and what makes the guard possible.
	From         string  `json:"from,omitempty"`
	Status       string  `json:"status,omitempty"`
	OwnerUserID  *string `json:"owner_user_id,omitempty"`
	NextFollowUp *string `json:"next_follow_up,omitempty"`
	LostReason   string  `json:"lost_reason,omitempty"`
	ValuePaise   *int64  `json:"value_paise,omitempty"`
	// Note is what the person typed while making the change. Optional, and
	// almost always the most valuable part of the request.
	Note string `json:"note,omitempty"`
}

// updateSalesEnquiry moves a lead and records why.
func (s *Server) updateSalesEnquiry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	leadID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid lead id")
		return
	}
	var req leadUpdateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	req.Status = strings.TrimSpace(req.Status)
	req.From = strings.TrimSpace(req.From)
	moving := req.Status != "" && req.Status != req.From

	if moving {
		if !leadStages[req.Status] || (req.From != "" && !leadStages[req.From]) {
			httpx.BadRequest(w, r,
				"stage must be one of new, contacted, demo_booked, won, lost")
			return
		}
		if req.From == "" {
			httpx.BadRequest(w, r, "from is required when changing the stage")
			return
		}
		if !canMove(req.From, req.Status) {
			httpx.BadRequest(w, r, "a lead cannot go from "+req.From+" to "+req.Status)
			return
		}
		/* A lost lead with no reason is the whole loss report gone. This is the
		   one field worth refusing the request over: nobody ever comes back to
		   fill it in, and six months later the question "why do we lose
		   schools" has no answer. */
		if req.Status == "lost" && strings.TrimSpace(req.LostReason) == "" &&
			strings.TrimSpace(req.Note) == "" {
			httpx.BadRequest(w, r, "say why it was lost -- a reason or a note")
			return
		}
	}

	var owner *uuid.UUID
	if req.OwnerUserID != nil && strings.TrimSpace(*req.OwnerUserID) != "" {
		u, perr := uuid.Parse(strings.TrimSpace(*req.OwnerUserID))
		if perr != nil {
			httpx.BadRequest(w, r, "owner_user_id must be a uuid")
			return
		}
		owner = &u
	}

	var follow *time.Time
	if req.NextFollowUp != nil && strings.TrimSpace(*req.NextFollowUp) != "" {
		d, perr := time.Parse("2006-01-02", strings.TrimSpace(*req.NextFollowUp))
		if perr != nil {
			httpx.BadRequest(w, r, "next_follow_up must be YYYY-MM-DD")
			return
		}
		follow = &d
	}

	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if moving {
			/* The guard. status = $2 in the WHERE is what makes two people
			   pressing at once safe: the second one matches no row. */
			tag, uerr := tx.Exec(r.Context(), `
				UPDATE purchase_enquiries
				   SET status = $3,
				       lost_reason = CASE WHEN $3 = 'lost'
				                          THEN NULLIF($4, '') ELSE lost_reason END,
				       updated_at = now()
				 WHERE id = $1 AND status = $2`,
				leadID, req.From, req.Status, strings.TrimSpace(req.LostReason))
			if uerr != nil {
				return uerr
			}
			if tag.RowsAffected() == 0 {
				return errLeadRaced
			}
			// The move, in the same list as the notes, so the history reads in
			// one order.
			if _, nerr := tx.Exec(r.Context(), `
				INSERT INTO purchase_enquiry_notes (enquiry_id, kind, body, author_id)
				VALUES ($1, 'stage', $2, $3)`,
				leadID, req.From+" -> "+req.Status, id.UserID); nerr != nil {
				return nerr
			}
		}

		/* The three fields that are not a stage move. COALESCE against the
		   column means an absent field leaves the value alone -- a screen
		   editing only the follow-up date must not clear the owner. */
		if req.OwnerUserID != nil || req.NextFollowUp != nil || req.ValuePaise != nil {
			if _, uerr := tx.Exec(r.Context(), `
				UPDATE purchase_enquiries
				   SET owner_user_id  = CASE WHEN $2 THEN $3 ELSE owner_user_id END,
				       next_follow_up = CASE WHEN $4 THEN $5 ELSE next_follow_up END,
				       value_paise    = CASE WHEN $6 THEN $7 ELSE value_paise END,
				       updated_at = now()
				 WHERE id = $1`,
				leadID,
				req.OwnerUserID != nil, owner,
				req.NextFollowUp != nil, follow,
				req.ValuePaise != nil, req.ValuePaise); uerr != nil {
				return uerr
			}
		}

		if n := strings.TrimSpace(req.Note); n != "" {
			if _, nerr := tx.Exec(r.Context(), `
				INSERT INTO purchase_enquiry_notes (enquiry_id, kind, body, author_id)
				VALUES ($1, 'note', $2, $3)`, leadID, n, id.UserID); nerr != nil {
				return nerr
			}
		}
		return nil
	})

	switch {
	case errors.Is(err, errLeadRaced):
		// 409, not 500: somebody else moved it first. That is a race, not a
		// fault, and the screen can reload and show where the lead actually is.
		httpx.Error(w, r, http.StatusConflict, "lead_moved",
			"this lead is no longer in "+req.From+" -- reload to see where it is")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

type leadNoteRow struct {
	Kind   string  `json:"kind"`
	Body   string  `json:"body"`
	Author *string `json:"author,omitempty"`
	At     string  `json:"at"`
}

// listSalesEnquiryNotes is one lead's history, newest first.
func (s *Server) listSalesEnquiryNotes(w http.ResponseWriter, r *http.Request) {
	leadID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid lead id")
		return
	}
	items := []leadNoteRow{}
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, qerr := tx.Query(r.Context(), `
			SELECT n.kind, n.body, u.full_name,
			       to_char(n.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')
			  FROM purchase_enquiry_notes n
			  LEFT JOIN users u ON u.id = n.author_id
			 WHERE n.enquiry_id = $1
			 ORDER BY n.created_at DESC
			 LIMIT 200`, leadID)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var v leadNoteRow
			if serr := rows.Scan(&v.Kind, &v.Body, &v.Author, &v.At); serr != nil {
				return serr
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type leadStageCount struct {
	Stage      string `json:"stage"`
	Count      int    `json:"count"`
	ValuePaise int64  `json:"value_paise"`
}

type leadPipelineView struct {
	Stages []leadStageCount `json:"stages"`
	// DueToday and Overdue are the two numbers that decide what somebody does
	// this morning, which is the only question a pipeline screen has to answer
	// before it answers anything else.
	DueToday int `json:"due_today"`
	Overdue  int `json:"overdue"`
	// Unowned is the leak: a lead nobody owns is a lead nobody rings.
	Unowned int `json:"unowned"`
}

// getSalesPipeline is the board's own summary.
func (s *Server) getSalesPipeline(w http.ResponseWriter, r *http.Request) {
	out := leadPipelineView{Stages: []leadStageCount{}}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		/* Every stage, including the empty ones, in pipeline order. A GROUP BY
		   over the rows that exist drops a stage nobody is in, and a board
		   whose columns appear and disappear as leads move is unreadable. */
		rows, qerr := tx.Query(r.Context(), `
			SELECT s.stage, count(e.id)::int,
			       COALESCE(sum(e.value_paise), 0)::bigint
			  FROM unnest(ARRAY['new','contacted','demo_booked','won','lost']) AS s(stage)
			  LEFT JOIN purchase_enquiries e ON e.status = s.stage
			 GROUP BY s.stage
			 ORDER BY array_position(
			     ARRAY['new','contacted','demo_booked','won','lost'], s.stage)`)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var v leadStageCount
			if serr := rows.Scan(&v.Stage, &v.Count, &v.ValuePaise); serr != nil {
				return serr
			}
			out.Stages = append(out.Stages, v)
		}
		if rerr := rows.Err(); rerr != nil {
			return rerr
		}
		// Won and lost are excluded from the work counts: a lead that is closed
		// is not somebody's morning, whatever date is still on it.
		return tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE next_follow_up = CURRENT_DATE)::int,
			       count(*) FILTER (WHERE next_follow_up < CURRENT_DATE)::int,
			       count(*) FILTER (WHERE owner_user_id IS NULL)::int
			  FROM purchase_enquiries
			 WHERE status NOT IN ('won','lost')`).
			Scan(&out.DueToday, &out.Overdue, &out.Unowned)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/*
mountSellerCRM registers the write half of the sales pipeline.

	Called from inside the /seller group in api.go, so every route here inherits
	that group's RequirePermission(rbac.PlatformTenantsRW) -- no school role
	holds it, and a route added here later inherits the boundary rather than
	having to remember it.
*/
func (s *Server) mountSellerCRM(r chi.Router) {
	r.Get("/enquiries/pipeline", s.getSalesPipeline)
	r.Get("/enquiries/{id}/notes", s.listSalesEnquiryNotes)
	r.Put("/enquiries/{id}", s.updateSalesEnquiry)
}
