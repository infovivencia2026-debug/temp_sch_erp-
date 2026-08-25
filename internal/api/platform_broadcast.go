package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The vendor talking to every school at once.

   Taking the installation down for twenty minutes on a Sunday had no way of
   being said. The choices were writing to each principal by hand — ten now,
   unworkable at fifty — or saying nothing and letting schools discover it by
   failing to sign in on Monday.

   Two endpoints and two audiences. The vendor writes and retires notices;
   every signed-in user reads whichever are live, and reading needs no
   permission at all, because a notice nobody may read is not a notice. That
   asymmetry is the whole design: broad read, narrow write.

   Deliberately not a circular. A circular belongs to one school, is written by
   that school's staff and reaches parents. This is the software's operator
   talking about the software, and the two must not be confusable in anybody's
   list — which is why it is its own table and its own screen rather than a
   flag on the existing one. */

type platformNotice struct {
	ID       string  `json:"id"`
	Severity string  `json:"severity"`
	Title    string  `json:"title"`
	Body     string  `json:"body,omitempty"`
	StartsAt string  `json:"starts_at"`
	EndsAt   *string `json:"ends_at,omitempty"`
	By       *string `json:"created_by,omitempty"`
	// Whether it is on screen right now, which is not the same as existing:
	// one written on Friday for Sunday is real and not yet showing.
	Live bool `json:"live"`
}

// listPlatformBroadcasts is the vendor's own list: live, scheduled and retired.
func (s *Server) listPlatformBroadcasts(w http.ResponseWriter, r *http.Request) {
	items := []platformNotice{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT b.id::text, b.severity, b.title, b.body,
			       to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI'),
			       to_char(b.ends_at,   'YYYY-MM-DD"T"HH24:MI'),
			       u.full_name,
			       (b.retired_at IS NULL
			        AND b.starts_at <= now()
			        AND (b.ends_at IS NULL OR b.ends_at > now()))
			  FROM platform_broadcasts b
			  LEFT JOIN users u ON u.id = b.created_by
			 ORDER BY b.starts_at DESC
			 LIMIT 100`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platformNotice
			if err := rows.Scan(&v.ID, &v.Severity, &v.Title, &v.Body,
				&v.StartsAt, &v.EndsAt, &v.By, &v.Live); err != nil {
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
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type platformNoticeRequest struct {
	Severity string `json:"severity,omitempty"`
	Title    string `json:"title"`
	Body     string `json:"body,omitempty"`
	StartsAt string `json:"starts_at,omitempty"`
	EndsAt   string `json:"ends_at,omitempty"`
}

// raisePlatformBroadcast publishes a notice to every school on the installation.
func (s *Server) raisePlatformBroadcast(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req platformNoticeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		httpx.BadRequest(w, r, "a notice needs a title — it is the only part most people read")
		return
	}
	switch req.Severity {
	case "", "info":
		req.Severity = "info"
	case "warning", "critical":
	default:
		httpx.BadRequest(w, r, "severity must be info, warning or critical")
		return
	}

	/* Times are optional, and each absence means something different. No start
	   is "now" — the ordinary case, somebody typing during an incident. No end
	   is "until I take it down", which is right for an outage whose length
	   nobody knows and wrong to guess at. */
	parse := func(v string) (any, error) {
		v = strings.TrimSpace(v)
		if v == "" {
			return nil, nil
		}
		for _, layout := range []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02"} {
			if t, err := time.Parse(layout, v); err == nil {
				return t, nil
			}
		}
		return nil, errors.New("unparseable time")
	}
	startsAt, err := parse(req.StartsAt)
	if err != nil {
		httpx.BadRequest(w, r, "starts_at must be a date and time")
		return
	}
	endsAt, err := parse(req.EndsAt)
	if err != nil {
		httpx.BadRequest(w, r, "ends_at must be a date and time")
		return
	}

	var newID string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO platform_broadcasts
			    (severity, title, body, starts_at, ends_at, created_by)
			VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)
			RETURNING id::text`,
			req.Severity, strings.TrimSpace(req.Title), strings.TrimSpace(req.Body),
			startsAt, endsAt, id.UserID).Scan(&newID)
	})
	if err != nil {
		// The window check is the one a person can actually have got wrong.
		if strings.Contains(err.Error(), "platform_broadcasts_window_check") {
			httpx.BadRequest(w, r,
				"that notice ends before it starts, so nobody would ever see it")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// retirePlatformBroadcast takes a notice down without deleting the record of it.
func (s *Server) retirePlatformBroadcast(w http.ResponseWriter, r *http.Request) {
	bid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid broadcast id")
		return
	}
	var affected int64
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		/* Retired, not deleted. "Which schools were told about the outage, and
		   when" is a question that gets asked afterwards, and a row that has
		   been removed cannot answer it. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE platform_broadcasts SET retired_at = now()
			 WHERE id = $1 AND retired_at IS NULL`, bid)
		if err != nil {
			return err
		}
		affected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if affected == 0 {
		httpx.Error(w, r, http.StatusConflict, "already_retired",
			"that notice is already down, or there is no such notice")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"retired": true})
}

/*
listLiveBroadcasts is what every signed-in user sees.

	Gated on nothing beyond being signed in. A maintenance notice that only
	the vendor may read is not a notice, and putting a permission in front of
	it would mean the one person in a school who most needs to know the site
	is going down on Sunday — whoever is at the counter — is the one who does
	not get told.

	Only what is showing now. The vendor's own list carries the scheduled and
	the retired; a school has no use for either, and a notice about last
	month's maintenance sitting on a principal's screen is how people learn to
	stop reading them.
*/
func (s *Server) listLiveBroadcasts(w http.ResponseWriter, r *http.Request) {
	items := []platformNotice{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, severity, title, body,
			       to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI'),
			       to_char(ends_at,   'YYYY-MM-DD"T"HH24:MI')
			  FROM platform_broadcasts
			 WHERE retired_at IS NULL
			   AND starts_at <= now()
			   AND (ends_at IS NULL OR ends_at > now())
			 ORDER BY
			   CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
			   starts_at DESC
			 LIMIT 5`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v platformNotice
			if err := rows.Scan(&v.ID, &v.Severity, &v.Title, &v.Body,
				&v.StartsAt, &v.EndsAt); err != nil {
				return err
			}
			v.Live = true
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
