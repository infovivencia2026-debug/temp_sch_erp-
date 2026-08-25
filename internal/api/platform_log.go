package api

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

/* What the platform did, and what went wrong doing it.

   Instance Health says plainly that error rates are not measured: the lines go
   to slog and nowhere a screen can read them. That honesty is right, and it
   leaves the vendor unable to answer the question they are actually asked —
   "we tried to sign up on Tuesday and it failed, what happened?"

   Deliberately narrow. Not a log of every request: that is a metrics store, it
   is a different piece of infrastructure, and pretending a table is one is how
   a database becomes a landfill. This records the handful of platform
   operations somebody has to be able to account for afterwards.

   Failures are the point. A successful provision announces itself — the school
   is in the directory, and nobody needs a log to find it. A failed one leaves
   nothing at all, which is how the same school gets provisioned three times by
   three people who each concluded it had not worked. */

// recordPlatformEvent writes one line to the vendor's log. It never returns an
// error: a log that can fail the thing it is logging is worse than no log.
func recordPlatformEvent(ctx context.Context, db *database.DB, kind string, ok bool,
	inst *uuid.UUID, subject, detail string, actor uuid.UUID) {

	_ = db.AsPlatform(ctx, func(tx pgx.Tx) error {
		var instArg any
		if inst != nil && *inst != uuid.Nil {
			instArg = *inst
		}
		var actorArg any
		if actor != uuid.Nil {
			actorArg = actor
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO platform_events (kind, ok, institution_id, subject, detail, actor_id)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			kind, ok, instArg, subject, detail, actorArg)
		return err
	})
}

type platformEventRow struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	OK      bool    `json:"ok"`
	School  *string `json:"school,omitempty"`
	Subject string  `json:"subject"`
	Detail  string  `json:"detail,omitempty"`
	Actor   *string `json:"actor,omitempty"`
	At      string  `json:"at"`
}

/*
listPlatformEvents is the provisioning and error log.

	Failures first when asked for, because the list exists for them: a vendor
	opening this screen is not browsing, they are looking for the thing that
	broke. `?failures=1` narrows to those.
*/
func (s *Server) listPlatformEvents(w http.ResponseWriter, r *http.Request) {
	onlyFailures := r.URL.Query().Get("failures") == "1"

	items := []platformEventRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, e.kind, e.ok, i.name, e.subject, e.detail,
			       u.full_name, to_char(e.at, 'YYYY-MM-DD"T"HH24:MI')
			  FROM platform_events e
			  LEFT JOIN institutions i ON i.id = e.institution_id
			  LEFT JOIN users u ON u.id = e.actor_id
			 WHERE ($1::bool IS NOT TRUE OR NOT e.ok)
			 ORDER BY e.at DESC
			 LIMIT 200`, onlyFailures)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platformEventRow
			if err := rows.Scan(&v.ID, &v.Kind, &v.OK, &v.School, &v.Subject,
				&v.Detail, &v.Actor, &v.At); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var failures int
	for _, it := range items {
		if !it.OK {
			failures++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "failures": failures,
	})
}
