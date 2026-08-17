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
		row := tx.QueryRow(ctx, `
			SELECT s.id, s.user_id, s.institution_id, s.last_seen_at, u.full_name,
			       COALESCE(array_agg(DISTINCT rp.permission_key)
			                FILTER (WHERE rp.permission_key IS NOT NULL), '{}'),
			       COALESCE(array_agg(DISTINCT ro.key)
			                FILTER (WHERE ro.key IS NOT NULL), '{}')
			  FROM sessions s
			  JOIN users u          ON u.id = s.user_id
			  LEFT JOIN user_roles ur ON ur.user_id = u.id
			  LEFT JOIN roles ro      ON ro.id = ur.role_id
			  LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
			 WHERE s.token_hash = $1
			   AND s.revoked_at IS NULL
			   AND s.expires_at > now()
			   AND u.status = 'active'
			 GROUP BY s.id, s.user_id, s.institution_id, s.last_seen_at, u.full_name`,
			hashToken(c.Value))
		return row.Scan(&id.SessionID, &id.UserID, &instID, &lastSeen, &id.FullName,
			&perms, &roleKeys)
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
