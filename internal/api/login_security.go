package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
	"github.com/school-erp/erp/internal/rbac"
)

/* The principal's security desk, behind the Logins screen.

   What used to be knowable only from a process log is recorded and shown:
   every sign-in attempt (login_events), who is online right now across the
   whole school, flags on a session that deserves a second look, and the
   rules a session lives by. And the two levers that go with knowing: sign
   one device out, or everyone.

   Alerts go to the school's administrators as in-app notifications and,
   where a channel is configured, a WhatsApp/SMS line, for the three facts
   worth interrupting somebody over: a lockout, a money-handling login from
   a new device, and a staff login in the middle of the night. */

// RecordLogin implements auth.Recorder. Best-effort: a failed write is
// logged loudly and never fails the sign-in.
func (s *Server) RecordLogin(ctx context.Context, ev auth.LoginEvent) {
	ctx = context.WithoutCancel(ctx)
	newDevice := false
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		if ev.Outcome == "success" && ev.UserID != uuid.Nil && ev.UserAgent != "" {
			// A device this account has not signed in from in the last 90
			// days. The user-agent family is the best a browser gives us.
			if err := tx.QueryRow(ctx, `
				SELECT NOT EXISTS (
				  SELECT 1 FROM sessions
				   WHERE user_id = $1 AND user_agent = $2
				     AND created_at > now() - interval '90 days'
				     AND id <> $3)`, ev.UserID, ev.UserAgent, nullUUIDArg(ev.SessionID)).Scan(&newDevice); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO login_events (institution_id, user_id, identifier, outcome, via, ip, user_agent, session_id)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6,'')::inet, $7, $8)`,
			nullUUIDArg(ev.InstID), nullUUIDArg(ev.UserID), clip(ev.Identifier, 200), ev.Outcome,
			firstNonEmpty(ev.Via, "password"), ev.IP, clip(ev.UserAgent, 500), nullUUIDArg(ev.SessionID))
		return err
	})
	if err != nil {
		slog.Error("login event write failed", "error", err, "outcome", ev.Outcome)
		return
	}
	ev.NewDevice = newDevice
	s.raiseLoginAlerts(ctx, ev)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

/*
raiseLoginAlerts decides whether an event is worth telling the school's

	administrators about, and tells them.

	Three triggers. A lockout on an identifier belonging to this school. A
	money-handling account (anyone holding a fees/payroll/refund write key)
	signing in from a device it has not used before. Any staff sign-in
	between 22:00 and 06:00 in the school's own timezone. Parents and
	students are never flagged for the hour: their phones are theirs.
*/
func (s *Server) raiseLoginAlerts(ctx context.Context, ev auth.LoginEvent) {
	var (
		title, body, kind string
		inst              = ev.InstID
	)
	switch {
	case ev.Outcome == "wrong_password" && ev.Locked:
		kind = "login_locked"
		title = "An account was locked after repeated wrong passwords"
		body = "Eight wrong passwords in a row for " + ev.Identifier + ". The lock lifts in five minutes on its own. If nobody at the school was trying, it may be somebody guessing."
		if inst == uuid.Nil {
			// A failure carries no school; find one from the identifier.
			_ = s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
				return tx.QueryRow(ctx, `
					SELECT institution_id FROM users
					 WHERE institution_id IS NOT NULL AND (email::text = $1 OR phone = $1 OR username = $1)
					 LIMIT 1`, ev.Identifier).Scan(&inst)
			})
		}
	case ev.Outcome == "success" && ev.UserID != uuid.Nil:
		var name, tz string
		var moneyRole, staff bool
		err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT u.full_name, COALESCE(i.timezone, 'Asia/Kolkata'),
				       EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
				                WHERE ur.user_id = u.id AND rp.permission_key = ANY($2)),
				       EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id)
				  FROM users u LEFT JOIN institutions i ON i.id = u.institution_id
				 WHERE u.id = $1`, ev.UserID, moneyKeys()).Scan(&name, &tz, &moneyRole, &staff)
		})
		if err != nil {
			return
		}
		loc, err := time.LoadLocation(tz)
		if err != nil {
			loc = time.FixedZone("IST", 5*3600+1800)
		}
		hour := time.Now().In(loc).Hour()
		switch {
		case moneyRole && ev.NewDevice:
			kind = "login_new_device"
			title = name + " signed in from a new device"
			body = "This account can collect fees or run payroll. It signed in from a device it has not used before (" + deviceLabel(ev.UserAgent) + ", " + ev.IP + "). If that was expected, nothing to do; if not, sign the device out from Logins & access."
		case staff && (hour >= 22 || hour < 6):
			kind = "login_after_hours"
			title = name + " signed in at " + time.Now().In(loc).Format("3:04 pm")
			body = "A staff sign-in outside school hours, from " + deviceLabel(ev.UserAgent) + " (" + ev.IP + ")."
		}
	}
	if kind == "" || inst == uuid.Nil {
		return
	}
	link := "/institution_admin/staff/logins_access"
	if err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		// Every administrator of the school, minus the person the alert is
		// about: a principal's own after-hours sign-in is not news to them.
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT u.id, u.email::text, u.phone
			  FROM users u
			  JOIN user_roles ur ON ur.user_id = u.id
			  JOIN role_permissions rp ON rp.role_id = ur.role_id
			 WHERE u.institution_id = $1 AND u.status = 'active'
			   AND rp.permission_key = $2 AND u.id <> $3`, inst, rbac.SessionsRevoke, nullUUIDArg(ev.UserID))
		if err != nil {
			return err
		}
		defer rows.Close()
		enabled := s.platformChannels(ctx)
		for rows.Next() {
			var uid uuid.UUID
			var email, phone *string
			if err := rows.Scan(&uid, &email, &phone); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO notifications (institution_id, user_id, kind, title, body, link)
				VALUES ($1,$2,$3,$4,$5,$6)`, inst, uid, kind, title, body, link); err != nil {
				return err
			}
			// Lockouts and new devices are worth a message on the phone;
			// after-hours is a feed item only, or it would page the head
			// every time a teacher marks homework at night.
			if kind != "login_after_hours" {
				to, ch := "", ""
				if phone != nil && strings.TrimSpace(*phone) != "" && enabled["whatsapp"] {
					to, ch = strings.TrimSpace(*phone), "whatsapp"
				} else if phone != nil && strings.TrimSpace(*phone) != "" && enabled["sms"] {
					to, ch = strings.TrimSpace(*phone), "sms"
				}
				if to != "" {
					if _, err := tx.Exec(ctx, `
						INSERT INTO message_log (institution_id, channel, template_code, recipient, user_id, subject, body, status)
						VALUES ($1,$2,'login_alert',$3,$4,$5,$6,'queued')`,
						inst, ch, to, uid, title, title+". "+body); err != nil {
						return err
					}
				}
			}
		}
		return rows.Err()
	}); err != nil {
		slog.Error("login alert failed", "error", err, "kind", kind)
	}
}

// moneyKeys are the grants that make an account worth watching on a new
// device: anything that moves money in or out.
func moneyKeys() []string {
	return []string{rbac.PaymentsWrite, rbac.RefundsWrite, rbac.PayrollWrite, rbac.FinanceExport, rbac.WalletManage}
}

// deviceLabel turns a user agent into the words a principal reads: the
// phone or the desktop, and the browser.
func deviceLabel(ua string) string {
	if ua == "" {
		return "unknown device"
	}
	dev := "desktop"
	switch {
	case strings.Contains(ua, "iPhone"):
		dev = "iPhone"
	case strings.Contains(ua, "iPad"):
		dev = "iPad"
	case strings.Contains(ua, "Android"):
		dev = "Android phone"
		// "Android 13; Redmi Note 11" -> the model between ; and )
		if i := strings.Index(ua, "Android"); i >= 0 {
			rest := ua[i:]
			if j := strings.Index(rest, ";"); j >= 0 {
				rest = rest[j+1:]
				if k := strings.IndexAny(rest, ");"); k >= 0 {
					model := strings.TrimSpace(rest[:k])
					model = strings.TrimSuffix(model, " Build")
					if model != "" && !strings.HasPrefix(model, "wv") && len(model) < 40 {
						dev = model
					}
				}
			}
		}
	case strings.Contains(ua, "Windows"):
		dev = "Windows PC"
	case strings.Contains(ua, "Macintosh"):
		dev = "Mac"
	case strings.Contains(ua, "Linux"):
		dev = "Linux PC"
	}
	br := "browser"
	switch {
	case strings.Contains(ua, "Edg/"):
		br = "Edge"
	case strings.Contains(ua, "Firefox/"):
		br = "Firefox"
	case strings.Contains(ua, "Chrome/"):
		br = "Chrome"
	case strings.Contains(ua, "Safari/"):
		br = "Safari"
	}
	return dev + " · " + br
}

// --- sessions, school-wide -------------------------------------------------

type liveSession struct {
	sessionRow
	Device      string   `json:"device"`
	Via         string   `json:"via"`
	EndedReason string   `json:"ended_reason,omitempty"`
	Roles       []string `json:"roles"`
	Flags       []string `json:"flags"`
}

/*
listLiveSessions answers GET /admin/sessions/live: everyone signed in

	right now, newest activity first, with the flags a principal wants
	pointed out rather than noticed. Flags:
	  after_hours   a staff session opened between 22:00 and 06:00
	  many_devices  the account holds more live sessions than its policy
	  new_device    a money-handling account on a user agent not seen before
	  no_record     the account's person (employee/student/guardian) is gone
	  failed_first  three or more failed attempts in the half hour before
*/
func (s *Server) listLiveSessions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	all := r.URL.Query().Get("all") == "true"
	items, err := collect(s, r, `
		WITH se AS (
		  SELECT se.*, u.full_name,
		         COALESCE((SELECT array_agg(ro.name ORDER BY ro.name) FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id = se.user_id), '{}') AS roles,
		         EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
		                  WHERE ur.user_id = se.user_id AND rp.permission_key = ANY($2)) AS money,
		         EXISTS (SELECT 1 FROM employees e WHERE e.user_id = se.user_id) AS staff,
		         (EXISTS (SELECT 1 FROM employees e WHERE e.user_id = se.user_id)
		          OR EXISTS (SELECT 1 FROM students st WHERE st.user_id = se.user_id)
		          OR EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = se.user_id)) AS has_record,
		         (SELECT count(*) FROM sessions x WHERE x.user_id = se.user_id AND x.revoked_at IS NULL AND x.expires_at > now()) AS live_count,
		         (SELECT count(*) FROM login_events le WHERE le.identifier <> '' AND le.user_id IS NULL
		            AND le.outcome IN ('wrong_password','locked')
		            AND le.created_at BETWEEN se.created_at - interval '30 minutes' AND se.created_at
		            AND le.identifier IN (SELECT email::text FROM users WHERE id = se.user_id UNION SELECT phone FROM users WHERE id = se.user_id UNION SELECT username FROM users WHERE id = se.user_id)) AS failed_before,
		         NOT EXISTS (SELECT 1 FROM sessions y WHERE y.user_id = se.user_id AND y.user_agent = se.user_agent AND y.id <> se.id AND y.created_at > now() - interval '90 days') AS new_device,
		         EXTRACT(HOUR FROM se.created_at AT TIME ZONE COALESCE((SELECT timezone FROM institutions WHERE id = se.institution_id), 'Asia/Kolkata')) AS hr
		    FROM sessions se JOIN users u ON u.id = se.user_id
		   WHERE ($1::bool OR (se.revoked_at IS NULL AND se.expires_at > now()))
		)
		SELECT se.id::text, se.user_id::text, se.full_name, host(se.ip), se.user_agent,
		       to_char(se.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       to_char(se.last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       to_char(se.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       se.revoked_at IS NOT NULL OR se.expires_at <= now(),
		       se.via, COALESCE(se.ended_reason, CASE WHEN se.revoked_at IS NULL AND se.expires_at <= now() THEN 'expired' ELSE '' END),
		       se.roles,
		       ARRAY_REMOVE(ARRAY[
		         CASE WHEN se.staff AND (se.hr >= 22 OR se.hr < 6) THEN 'after_hours' END,
		         CASE WHEN se.live_count > 3 THEN 'many_devices' END,
		         CASE WHEN se.money AND se.new_device THEN 'new_device' END,
		         CASE WHEN NOT se.has_record THEN 'no_record' END,
		         CASE WHEN se.failed_before >= 3 THEN 'failed_first' END
		       ], NULL)
		  FROM se
		 ORDER BY se.last_seen_at DESC
		 LIMIT 500`, []any{all, moneyKeys()},
		func(rows pgx.Rows) (liveSession, error) {
			var v liveSession
			err := rows.Scan(&v.ID, &v.UserID, &v.FullName, &v.IP, &v.UserAgent,
				&v.CreatedAt, &v.LastSeenAt, &v.ExpiresAt, &v.Revoked, &v.Via, &v.EndedReason, &v.Roles, &v.Flags)
			if v.UserAgent != nil {
				v.Device = deviceLabel(*v.UserAgent)
			}
			if v.Flags == nil {
				v.Flags = []string{}
			}
			return v, err
		})
	_ = id
	respond(w, r, items, err)
}

// signEveryoneOut answers DELETE /admin/sessions?all=true: every live
// session at the school except the caller's own ends now, reason
// all_signed_out. The office uses it after a leaver, a leaked password or
// an incident; every device shows the sign-in page on its next request.
func (s *Server) signEveryoneOut(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if r.URL.Query().Get("all") != "true" {
		httpx.BadRequest(w, r, "pass all=true to sign everyone out")
		return
	}
	var n int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now(), ended_reason = 'all_signed_out'
			 WHERE revoked_at IS NULL AND expires_at > now() AND id <> $1`, id.SessionID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.Sessions.ForgetAll()
	httpx.JSON(w, http.StatusOK, map[string]any{"signed_out": n})
}

// --- login history -----------------------------------------------------------

type loginEventRow struct {
	ID         int64   `json:"id"`
	At         string  `json:"at"`
	Outcome    string  `json:"outcome"`
	Identifier string  `json:"identifier,omitempty"`
	UserID     *string `json:"user_id,omitempty"`
	FullName   *string `json:"full_name,omitempty"`
	Via        string  `json:"via"`
	IP         *string `json:"ip,omitempty"`
	Device     string  `json:"device"`
	SessionID  *string `json:"session_id,omitempty"`
}

// listLoginEvents answers GET /admin/login-events?user=&outcome=&days=&limit=.
// Failures that name no account are matched to a user by identifier, so
// "somebody tried the accountant's password twelve times" shows under the
// accountant.
func (s *Server) listLoginEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var user any
	if raw := strings.TrimSpace(q.Get("user")); raw != "" {
		u, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "invalid user id")
			return
		}
		user = u
	}
	days := clampInt(q.Get("days"), 30, 1, 365)
	limit := clampInt(q.Get("limit"), 200, 1, 1000)
	failedOnly := q.Get("failed") == "true"
	items, err := collect(s, r, `
		SELECT le.id, to_char(le.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       le.outcome, le.identifier, COALESCE(le.user_id, m.id)::text, COALESCE(u.full_name, m.full_name),
		       le.via, host(le.ip), COALESCE(le.user_agent,''), le.session_id::text
		  FROM login_events le
		  LEFT JOIN users u ON u.id = le.user_id
		  LEFT JOIN LATERAL (
		    SELECT id, full_name FROM users
		     WHERE le.user_id IS NULL AND le.identifier <> ''
		       AND (email::text = le.identifier OR phone = le.identifier OR username = le.identifier)
		     LIMIT 1) m ON true
		 WHERE le.created_at > now() - ($1 || ' days')::interval
		   AND ($2::uuid IS NULL OR COALESCE(le.user_id, m.id) = $2)
		   AND (NOT $3::bool OR le.outcome NOT IN ('success','reauth_ok','mfa_required'))
		 ORDER BY le.id DESC
		 LIMIT $4`, []any{strconv.Itoa(days), user, failedOnly, limit},
		func(rows pgx.Rows) (loginEventRow, error) {
			var v loginEventRow
			var ua string
			err := rows.Scan(&v.ID, &v.At, &v.Outcome, &v.Identifier, &v.UserID, &v.FullName,
				&v.Via, &v.IP, &ua, &v.SessionID)
			v.Device = deviceLabel(ua)
			return v, err
		})
	respond(w, r, items, err)
}

// signInDays answers GET /admin/users/{id}/sign-in-days?days=30: one row
// per day with successes and failures, the strip under a person's name.
func (s *Server) signInDays(w http.ResponseWriter, r *http.Request) {
	userID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid user id")
		return
	}
	days := clampInt(r.URL.Query().Get("days"), 30, 7, 180)
	type day struct {
		Day     string `json:"day"`
		OK      int    `json:"ok"`
		Failed  int    `json:"failed"`
		Screens int    `json:"screens"`
	}
	items, err := collect(s, r, `
		WITH d AS (SELECT generate_series(current_date - ($2 || ' days')::interval + interval '1 day', current_date, interval '1 day')::date AS day),
		ids AS (SELECT email::text AS i FROM users WHERE id = $1 UNION SELECT phone FROM users WHERE id = $1 UNION SELECT username FROM users WHERE id = $1)
		SELECT to_char(d.day, 'YYYY-MM-DD'),
		       (SELECT count(*) FROM login_events le WHERE le.user_id = $1 AND le.outcome = 'success' AND le.created_at::date = d.day)::int,
		       (SELECT count(*) FROM login_events le WHERE le.outcome IN ('wrong_password','locked','mfa_failed')
		          AND (le.user_id = $1 OR (le.user_id IS NULL AND le.identifier IN (SELECT i FROM ids WHERE i IS NOT NULL)))
		          AND le.created_at::date = d.day)::int,
		       (SELECT COALESCE(sum(hits),0) FROM session_screens ss WHERE ss.user_id = $1 AND ss.last_at::date = d.day)::int
		  FROM d ORDER BY d.day`, []any{userID, strconv.Itoa(days)},
		func(rows pgx.Rows) (day, error) {
			var v day
			return v, rows.Scan(&v.Day, &v.OK, &v.Failed, &v.Screens)
		})
	respond(w, r, items, err)
}

// --- session policies -----------------------------------------------------

type sessionPolicyRow struct {
	RoleKey       string `json:"role_key"`
	RoleName      string `json:"role_name"`
	AbsoluteHours int    `json:"absolute_hours"`
	IdleMinutes   int    `json:"idle_minutes"`
	MaxDevices    int    `json:"max_devices"`
	// Overridden says the school changed this from the built-in default.
	Overridden bool `json:"overridden"`
}

// listSessionPolicies answers GET /admin/session-policies: one row per role
// the school has, with the built-in default where it has not chosen.
func (s *Server) listSessionPolicies(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ro.key, ro.name, sp.absolute_hours, sp.idle_minutes, sp.max_devices
		  FROM roles ro
		  LEFT JOIN session_policies sp ON sp.role_key = ro.key AND sp.institution_id = ro.institution_id
		 WHERE ro.institution_id IS NOT NULL
		 ORDER BY ro.is_system DESC, ro.name`, nil,
		func(rows pgx.Rows) (sessionPolicyRow, error) {
			var v sessionPolicyRow
			var h, i, d *int
			if err := rows.Scan(&v.RoleKey, &v.RoleName, &h, &i, &d); err != nil {
				return v, err
			}
			def := auth.DefaultPolicy(v.RoleKey)
			v.AbsoluteHours, v.IdleMinutes, v.MaxDevices = int(def.Absolute.Hours()), int(def.Idle.Minutes()), def.MaxDevices
			if h != nil {
				v.AbsoluteHours, v.IdleMinutes, v.MaxDevices, v.Overridden = *h, *i, *d, true
			}
			return v, nil
		})
	respond(w, r, items, err)
}

// setSessionPolicy answers PUT /admin/session-policies/{role}. A body with
// reset=true removes the override and the built-in default applies again.
func (s *Server) setSessionPolicy(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	role := chiURLParam(r, "role")
	var req struct {
		AbsoluteHours int  `json:"absolute_hours"`
		IdleMinutes   int  `json:"idle_minutes"`
		MaxDevices    int  `json:"max_devices"`
		Reset         bool `json:"reset"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !req.Reset {
		switch {
		case req.AbsoluteHours < 1 || req.AbsoluteHours > 24*180:
			httpx.BadRequest(w, r, "a session can live between 1 hour and 180 days")
			return
		case req.IdleMinutes < 5 || req.IdleMinutes > 60*24*60:
			httpx.BadRequest(w, r, "the idle limit is between 5 minutes and 60 days")
			return
		case req.MaxDevices < 1 || req.MaxDevices > 20:
			httpx.BadRequest(w, r, "between 1 and 20 devices")
			return
		}
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM roles WHERE key = $1 AND institution_id = $2`, role, id.InstitutionID).Scan(&exists); err != nil {
			return err
		}
		if req.Reset {
			_, err := tx.Exec(r.Context(), `DELETE FROM session_policies WHERE institution_id = $1 AND role_key = $2`, id.InstitutionID, role)
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO session_policies (institution_id, role_key, absolute_hours, idle_minutes, max_devices)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (institution_id, role_key) DO UPDATE
			   SET absolute_hours = EXCLUDED.absolute_hours, idle_minutes = EXCLUDED.idle_minutes,
			       max_devices = EXCLUDED.max_devices, updated_at = now()`,
			id.InstitutionID, role, req.AbsoluteHours, req.IdleMinutes, req.MaxDevices)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"role_key": role, "saved": true})
}

// --- step-up for money -------------------------------------------------------

// freshFor is how recently the person must have typed their password for a
// money action to go through. Fifteen minutes: long enough to work a
// counter queue, short enough that a desk left open at lunch is not a till.
const freshFor = 15 * time.Minute

/*
RequireFresh refuses a money action on a session whose password was typed

	more than freshFor ago, with code reauth_required. The SPA answers that
	code with a password prompt (POST /session/reauth) and the person
	presses the button again. Day-code sessions and API keys are refused
	outright: neither has a password to retype.
*/
func (s *Server) RequireFresh(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := httpx.IdentityFrom(r.Context())
		if id == nil {
			next.ServeHTTP(w, r)
			return
		}
		if id.APIKey {
			next.ServeHTTP(w, r)
			return
		}
		last := id.IssuedAt
		if id.ReauthAt.After(last) {
			last = id.ReauthAt
		}
		if id.DayCode || (!last.IsZero() && time.Since(last) > freshFor) {
			httpx.Error(w, r, http.StatusForbidden, "reauth_required",
				"Confirm your password to continue: this action moves money and your sign-in is older than fifteen minutes.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// reauth answers POST /session/reauth {password}: the password again, on
// this session, and the fifteen minutes start over.
func (s *Server) reauth(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		Password string `json:"password"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	var hash *string
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT password_hash FROM users WHERE id = $1`, id.UserID).Scan(&hash)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if hash == nil || s.Hasher.Verify(*hash, req.Password) != nil {
		s.RecordLogin(r.Context(), auth.LoginEvent{Outcome: "reauth_failed", UserID: id.UserID, InstID: id.InstitutionID,
			SessionID: id.SessionID, IP: clientIPOf(r), UserAgent: r.UserAgent()})
		httpx.Error(w, r, http.StatusUnauthorized, "wrong_password", "That password is not right.")
		return
	}
	if err := s.Sessions.Reauth(r.Context(), id.SessionID); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.RecordLogin(r.Context(), auth.LoginEvent{Outcome: "reauth_ok", UserID: id.UserID, InstID: id.InstitutionID,
		SessionID: id.SessionID, IP: clientIPOf(r), UserAgent: r.UserAgent()})
	httpx.JSON(w, http.StatusOK, map[string]any{"fresh_until": time.Now().Add(freshFor).UTC().Format(time.RFC3339)})
}

func clientIPOf(r *http.Request) string {
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
		return strings.Trim(r.RemoteAddr[:i], "[]")
	}
	return r.RemoteAddr
}

// --- retention ---------------------------------------------------------------

const TypeLoginSecurityRetention = "security:retention"

// handleSecurityRetention drops what nobody will ask about any more: screen
// notes past 90 days, login events and ended sessions past a year.
func (s *Server) handleSecurityRetention(ctx context.Context, _ *queue.Task) error {
	var screens, events, sessions int64
	err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		t, err := tx.Exec(ctx, `DELETE FROM session_screens WHERE last_at < now() - interval '90 days'`)
		if err != nil {
			return err
		}
		screens = t.RowsAffected()
		t, err = tx.Exec(ctx, `DELETE FROM login_events WHERE created_at < now() - interval '365 days'`)
		if err != nil {
			return err
		}
		events = t.RowsAffected()
		t, err = tx.Exec(ctx, `
			DELETE FROM sessions
			 WHERE (revoked_at IS NOT NULL OR expires_at < now())
			   AND last_seen_at < now() - interval '365 days'`)
		if err != nil {
			return err
		}
		sessions = t.RowsAffected()
		return nil
	})
	slog.Info("security retention sweep", "screens", screens, "login_events", events, "sessions", sessions)
	return err
}

func securityCronEntries() []queue.Schedule {
	empty := func(queue.Envelope) any { return map[string]any{} }
	return []queue.Schedule{
		// 03:40 daily, after the other housekeeping deletes.
		{Name: "security_retention", Spec: "40 3 * * *", Kind: TypeLoginSecurityRetention,
			Payload: empty, Opts: queue.Options(queue.QueueLow, 2, 5*time.Minute)},
	}
}
