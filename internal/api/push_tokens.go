package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/push"
)

/* PUSH: THE PHONE IS TOLD.

   The alert feed was honest about being polled -- see deliverFamilyAlerts --
   and a closed app polls nothing, so a bus at the stop or a circular reached
   a parent when they next opened the portal. Two pieces close that:

     The token. The app registers its device token here after sign-in and
     withdraws it at sign-out. One row per installed app; a family with two
     phones has two.

     The pump. A loop in the worker that first materialises every token
     holder's alerts -- the same pass the feed runs when it is opened, so an
     app that is never opened still has its rows written -- then hands each
     new row to the phones its user holds and marks it pushed. Every insert
     site in this package is covered without any of them knowing, because the
     pump reads the table they already write.

   Only rows younger than a day are sent. A parent registering a phone after a
   fortnight away gets the feed, not fourteen days of buzzing. */

type pushTokenRequest struct {
	Token      string `json:"token"`
	Platform   string `json:"platform"`
	AppVersion string `json:"app_version"`
}

// registerPushToken is PUT /me/push-token.
func (s *Server) registerPushToken(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.InstitutionID == uuid.Nil {
		httpx.BadRequest(w, r, "push tokens belong to a school account")
		return
	}
	var req pushTokenRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.BadRequest(w, r, "could not read the token")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" || len(req.Token) > 4096 {
		httpx.BadRequest(w, r, "token is required")
		return
	}
	if req.Platform == "" {
		req.Platform = "android"
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The token is the key: a phone that changes hands is re-pointed at
		// its new owner rather than left delivering to the old one.
		_, err := tx.Exec(r.Context(), `
			INSERT INTO push_tokens (token, user_id, institution_id, platform, app_version, updated_at)
			VALUES ($1,$2,$3,$4,$5,now())
			ON CONFLICT (token) DO UPDATE
			   SET user_id = EXCLUDED.user_id, institution_id = EXCLUDED.institution_id,
			       platform = EXCLUDED.platform, app_version = EXCLUDED.app_version,
			       updated_at = now()`,
			req.Token, id.UserID, id.InstitutionID, req.Platform, nullString(req.AppVersion))
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// forgetPushToken is DELETE /me/push-token: the app is signing out, and the
// next person to sign in on this phone must not get this person's alerts.
func (s *Server) forgetPushToken(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pushTokenRequest
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req)
	token := strings.TrimSpace(req.Token)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if token == "" {
			_, err := tx.Exec(r.Context(), `DELETE FROM push_tokens WHERE user_id = $1`, id.UserID)
			return err
		}
		_, err := tx.Exec(r.Context(),
			`DELETE FROM push_tokens WHERE token = $1 AND user_id = $2`, token, id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// PushSender is what the pump needs from a delivery service.
type PushSender interface {
	Send(ctx context.Context, token string, m push.Message) error
}

const (
	pushTick        = 5 * time.Second
	pushMaterialise = time.Minute
	pushFreshness   = 24 * time.Hour
)

// RunPushPump runs until ctx ends. baseURL makes the notification's link
// absolute, because the phone opens it from outside the page.
func (s *Server) RunPushPump(ctx context.Context, sender PushSender, baseURL string) {
	base := strings.TrimSuffix(baseURL, "/")
	lastMaterialise := time.Time{}
	slog.Info("push pump started")
	for {
		if time.Since(lastMaterialise) >= pushMaterialise {
			if err := s.materialiseForTokenHolders(ctx); err != nil && ctx.Err() == nil {
				slog.Warn("push: materialise", "err", err)
			}
			lastMaterialise = time.Now()
		}
		if err := s.pushOnce(ctx, sender, base); err != nil && ctx.Err() == nil {
			slog.Warn("push: pass", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(pushTick):
		}
	}
}

/*
The feed's own delivery pass, run for every phone that is registered.

	deliverFamilyAlerts writes rows the first time a family's feed is READ. A
	phone that is never opened never reads, so without this a push for a
	circular would wait for the very act push exists to make unnecessary. Run
	inside each school's own RLS scope, the way the feed handler runs it.
*/
func (s *Server) materialiseForTokenHolders(ctx context.Context) error {
	type holder struct {
		user, inst uuid.UUID
	}
	var holders []holder
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT DISTINCT user_id, institution_id FROM push_tokens`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var h holder
			if err := rows.Scan(&h.user, &h.inst); err != nil {
				return err
			}
			holders = append(holders, h)
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	for _, h := range holders {
		err := s.DB.InTenant(ctx, tenantScopeFor(h.inst, false), func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				SELECT sg.student_id
				  FROM guardians g
				  JOIN student_guardians sg ON sg.guardian_id = g.id
				 WHERE g.user_id = $1`, h.user)
			if err != nil {
				return err
			}
			var kids []uuid.UUID
			for rows.Next() {
				var k uuid.UUID
				if err := rows.Scan(&k); err != nil {
					rows.Close()
					return err
				}
				kids = append(kids, k)
			}
			rows.Close()
			if len(kids) == 0 {
				// Staff hold tokens too; their alerts are written at source.
				return nil
			}
			return s.deliverFamilyAlerts(ctx, tx, h.inst, h.user, kids)
		})
		if err != nil {
			slog.Warn("push: materialise for user", "user", h.user, "err", err)
		}
	}
	return nil
}

func (s *Server) pushOnce(ctx context.Context, sender PushSender, base string) error {
	type row struct {
		id, user    uuid.UUID
		kind, title string
		body, link  *string
		created     time.Time
	}
	var rows []row
	tokens := map[uuid.UUID][]string{}
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		rs, err := tx.Query(ctx, `
			SELECT id, user_id, kind, title, body, link, created_at
			  FROM notifications
			 WHERE pushed_at IS NULL
			 ORDER BY created_at
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rs.Close()
		for rs.Next() {
			var r row
			if err := rs.Scan(&r.id, &r.user, &r.kind, &r.title, &r.body, &r.link, &r.created); err != nil {
				return err
			}
			rows = append(rows, r)
		}
		if err := rs.Err(); err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		users := make([]uuid.UUID, 0, len(rows))
		for _, r := range rows {
			users = append(users, r.user)
		}
		ts, err := tx.Query(ctx, `SELECT user_id, token FROM push_tokens WHERE user_id = ANY($1)`, users)
		if err != nil {
			return err
		}
		defer ts.Close()
		for ts.Next() {
			var u uuid.UUID
			var t string
			if err := ts.Scan(&u, &t); err != nil {
				return err
			}
			tokens[u] = append(tokens[u], t)
		}
		return ts.Err()
	})
	if err != nil || len(rows) == 0 {
		return err
	}

	var dead []string
	ids := make([]uuid.UUID, 0, len(rows))
	sent := 0
	for _, r := range rows {
		ids = append(ids, r.id)
		if time.Since(r.created) > pushFreshness {
			continue
		}
		for _, t := range tokens[r.user] {
			m := push.Message{Title: r.title, Body: strVal(r.body), Kind: r.kind, ID: r.id.String()}
			if r.link != nil && *r.link != "" {
				if strings.HasPrefix(*r.link, "/") {
					m.Link = base + *r.link
				} else {
					m.Link = *r.link
				}
			}
			switch err := sender.Send(ctx, t, m); {
			case err == nil:
				sent++
			case errors.Is(err, push.ErrUnregistered):
				dead = append(dead, t)
			default:
				slog.Warn("push: send", "err", err)
			}
		}
	}
	return s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE notifications SET pushed_at = now() WHERE id = ANY($1)`, ids); err != nil {
			return err
		}
		if len(dead) > 0 {
			if _, err := tx.Exec(ctx, `DELETE FROM push_tokens WHERE token = ANY($1)`, dead); err != nil {
				return err
			}
		}
		if sent > 0 || len(dead) > 0 {
			slog.Info("push: pass", "rows", len(rows), "sent", sent, "dead_tokens", len(dead))
		}
		return nil
	})
}
