package auth

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* How long a session lives, by role.

   One global 12h/2h treated the accountant at the office PC and a parent
   on their own phone alike, and neither was right: the parent was signed
   out every two idle hours for no gain, the accountant stayed signed in
   all day at a shared desk. The defaults below are per role; a school can
   override any of them in session_policies (Logins > Session rules), and
   the strictest rule among a person's roles wins.

   Device cap: when a person signs in on one device more than the cap, the
   oldest live session is ended with reason "superseded" and that device
   sees "signed out because you signed in elsewhere". */

type SessionPolicy struct {
	Absolute   time.Duration
	Idle       time.Duration
	MaxDevices int
}

// DefaultPolicy is the built-in rule for a role key. The keys mirror
// rbac.SystemRoles; an unknown key gets the staff default.
func DefaultPolicy(roleKey string) SessionPolicy {
	switch roleKey {
	case "institution_admin", "principal", "vice_principal", "accounts", "accountant", "hr", "admin_office":
		return SessionPolicy{Absolute: 12 * time.Hour, Idle: 30 * time.Minute, MaxDevices: 2}
	case "faculty", "teacher", "hod", "class_teacher", "librarian", "counselor", "transport", "nurse":
		return SessionPolicy{Absolute: 30 * 24 * time.Hour, Idle: 7 * 24 * time.Hour, MaxDevices: 2}
	case "parent", "guardian":
		return SessionPolicy{Absolute: 90 * 24 * time.Hour, Idle: 30 * 24 * time.Hour, MaxDevices: 3}
	case "student":
		return SessionPolicy{Absolute: 8 * time.Hour, Idle: 30 * time.Minute, MaxDevices: 1}
	case "super_admin", "seller_admin", "support_admin":
		return SessionPolicy{Absolute: 8 * time.Hour, Idle: 15 * time.Minute, MaxDevices: 1}
	}
	return SessionPolicy{Absolute: 12 * time.Hour, Idle: 2 * time.Hour, MaxDevices: 2}
}

// policyFor resolves the strictest policy across a user's roles, school
// overrides first. Falls back to the store's global limits for a user with
// no roles at all. Never returns something looser than the store's ceiling.
func (s *Store) policyFor(ctx context.Context, tx pgx.Tx, userID, instID uuid.UUID) (SessionPolicy, error) {
	rows, err := tx.Query(ctx, `
		SELECT ro.key, sp.absolute_hours, sp.idle_minutes, sp.max_devices
		  FROM user_roles ur
		  JOIN roles ro ON ro.id = ur.role_id
		  LEFT JOIN session_policies sp
		         ON sp.role_key = ro.key AND sp.institution_id = $2
		 WHERE ur.user_id = $1`, userID, nullUUID(instID))
	if err != nil {
		return SessionPolicy{}, err
	}
	defer rows.Close()
	out := SessionPolicy{}
	any := false
	for rows.Next() {
		var key string
		var hours, idle, devices *int
		if err := rows.Scan(&key, &hours, &idle, &devices); err != nil {
			return SessionPolicy{}, err
		}
		p := DefaultPolicy(key)
		if hours != nil {
			p.Absolute = time.Duration(*hours) * time.Hour
		}
		if idle != nil {
			p.Idle = time.Duration(*idle) * time.Minute
		}
		if devices != nil {
			p.MaxDevices = *devices
		}
		if !any {
			out, any = p, true
			continue
		}
		if p.Absolute < out.Absolute {
			out.Absolute = p.Absolute
		}
		if p.Idle < out.Idle {
			out.Idle = p.Idle
		}
		if p.MaxDevices < out.MaxDevices {
			out.MaxDevices = p.MaxDevices
		}
	}
	if err := rows.Err(); err != nil {
		return SessionPolicy{}, err
	}
	if !any {
		out = SessionPolicy{Absolute: s.ttl, Idle: s.idleTTL, MaxDevices: 2}
	}
	return out, nil
}

// supersede ends the oldest live sessions beyond the cap, keeping room for
// the one about to be issued. Returns how many it ended.
func supersede(ctx context.Context, tx pgx.Tx, userID uuid.UUID, maxDevices int) (int64, error) {
	if maxDevices < 1 {
		return 0, nil
	}
	tag, err := tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = now(), ended_reason = 'superseded'
		 WHERE id IN (
		   SELECT id FROM sessions
		    WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		    ORDER BY last_seen_at DESC
		   OFFSET $2)`, userID, maxDevices-1)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
