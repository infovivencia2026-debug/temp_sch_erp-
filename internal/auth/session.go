package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

const CookieName = "erp_session"

var ErrNoSession = errors.New("no session")

// Store issues and validates sessions.
//
// Only the SHA-256 of the token is persisted. The cookie holds the raw value,
// so a leaked database gives an attacker nothing they can replay -- the same
// reason the sessions table column is named token_hash and typed bytea.
type Store struct {
	db      *database.DB
	ttl     time.Duration
	idleTTL time.Duration
	secure  bool
}

func NewStore(db *database.DB, ttl, idleTTL time.Duration, secure bool) *Store {
	return &Store{db: db, ttl: ttl, idleTTL: idleTTL, secure: secure}
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(tok string) []byte {
	sum := sha256.Sum256([]byte(tok))
	return sum[:]
}

func (s *Store) Issue(ctx context.Context, w http.ResponseWriter, r *http.Request, userID, instID uuid.UUID) error {
	tok, err := newToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(s.ttl)

	var ip *string
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip = &host
	} else if r.RemoteAddr != "" {
		h := r.RemoteAddr
		ip = &h
	}

	err = s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO sessions (institution_id, user_id, token_hash, ip, user_agent, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			nullUUID(instID), userID, hashToken(tok), ip, r.UserAgent(), expires)
		return err
	})
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    tok,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// Resolve validates the cookie and loads the caller's identity and effective
// permissions in one round trip.
//
// The idle check is enforced here rather than by an expires_at bump on write,
// because a user who leaves a tab open should not stay signed in forever.
func (s *Store) Resolve(ctx context.Context, r *http.Request) (*httpx.Identity, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil, ErrNoSession
	}

	var (
		id       httpx.Identity
		instID   *uuid.UUID
		lastSeen time.Time
		perms    []string
		roleKeys []string
	)
	err = s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		/* THE ROLES COME BACK AS SUBQUERIES, NOT AS JOINS.

		   This ran on every authenticated request and it was the single most
		   expensive thing the server did: 620-1280ms warm and 306,065 shared
		   buffers -- 2.4GB read -- to answer "who is this cookie".

		   The cause was the join order, and the planner was not being stupid.
		   Every RLS policy on these tables reads
		   `app_is_platform_admin() OR institution_id = ...`, which Postgres
		   cannot estimate, so it guessed one row from users, from user_roles
		   and from roles alike. On those estimates the cheapest-looking plan
		   drives from a sequential scan of users and joins sessions LAST
		   through a materialise, which meant user_roles was scanned once per
		   user and `roles` -- a 46-row table -- was scanned 47,040 times per
		   request. Measured across two minutes of live traffic: 2.87 MILLION
		   sequential scans of roles for 77 requests served. Lifetime, that
		   table had read 3.3 billion tuples.

		   Correlating on s.user_id instead takes users, user_roles and roles
		   out of the driving join altogether, so there is no order left for
		   the planner to get wrong: the unique index on sessions.token_hash
		   finds the one row and each subquery answers from an index on the
		   user id it already has. The GROUP BY goes with the joins.

		   Verified against production, same output, same 131 permissions:
		   620-1280ms and 306,065 buffers becomes 0.28-0.84ms and 30.

		   The lesson is the one this codebase keeps re-learning: a query that
		   reads correctly can still be unable to run well, and only EXPLAIN
		   on real data says which. */
		row := tx.QueryRow(ctx, `
			SELECT s.id, s.user_id, s.institution_id, s.last_seen_at, u.full_name,
			       u.must_change_password,
			       COALESCE((SELECT array_agg(DISTINCT rp.permission_key)
			                   FROM user_roles ur
			                   JOIN role_permissions rp ON rp.role_id = ur.role_id
			                  WHERE ur.user_id = s.user_id), '{}'),
			       COALESCE((SELECT array_agg(DISTINCT ro.key)
			                   FROM user_roles ur
			                   JOIN roles ro ON ro.id = ur.role_id
			                  WHERE ur.user_id = s.user_id), '{}')
			  FROM sessions s
			  JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = $1
			   AND s.revoked_at IS NULL
			   AND s.expires_at > now()
			   AND u.status = 'active'`,
			hashToken(c.Value))
		return row.Scan(&id.SessionID, &id.UserID, &instID, &lastSeen, &id.FullName,
			&id.MustChangePassword, &perms, &roleKeys)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoSession
	}
	if err != nil {
		return nil, fmt.Errorf("resolve session: %w", err)
	}

	if time.Since(lastSeen) > s.idleTTL {
		_ = s.Revoke(ctx, id.SessionID)
		return nil, ErrNoSession
	}

	if instID != nil {
		id.InstitutionID = *instID
	} else {
		// A user with no institution is platform staff; RLS gives them nothing
		// unless app.is_platform_admin is also set.
		id.PlatformAdmin = true
		/* ...but platform staff are not all the same. A vendor's billing
		   administrator reaches across tenants and must still be held to the
		   permissions they were granted, or they would inherit every school's
		   records by virtue of belonging to none. Restricted says "wide reach,
		   narrow rights".

		   Restriction is decided by role, not inferred from which permissions
		   the account happens to hold. The inference it replaces — restricted
		   if you can sell, unrestricted again if you can also write settings —
		   answered "is this a full operator?" by proxy, and the proxy failed
		   open: support_admin holds neither key, so a support engineer would
		   have been read as a full operator and handed every school's records.
		   super_admin is the only role that operates the installation, so
		   holding super_admin is the whole test. */
		id.Restricted = true
		for _, k := range roleKeys {
			if k == rbac.PlatformOperatorRole {
				id.Restricted = false
			}
		}
	}
	id.Permissions = make(map[string]struct{}, len(perms))
	for _, p := range perms {
		id.Permissions[p] = struct{}{}
	}

	// Throttled so a chatty SPA does not turn every poll into a write.
	if time.Since(lastSeen) > time.Minute {
		_ = s.touch(ctx, id.SessionID)
	}
	return &id, nil
}

func (s *Store) touch(ctx context.Context, sessionID uuid.UUID) error {
	return s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, sessionID)
		return err
	})
}

func (s *Store) Revoke(ctx context.Context, sessionID uuid.UUID) error {
	return s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, sessionID)
		return err
	})
}

func (s *Store) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// Middleware attaches the identity when a valid cookie is present and is
// otherwise transparent, so public routes still work.
func (s *Store) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id, err := s.Resolve(r.Context(), r); err == nil {
			r = r.WithContext(httpx.WithIdentity(r.Context(), id))
		}
		next.ServeHTTP(w, r)
	})
}

func nullUUID(u uuid.UUID) *uuid.UUID {
	if u == uuid.Nil {
		return nil
	}
	return &u
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
