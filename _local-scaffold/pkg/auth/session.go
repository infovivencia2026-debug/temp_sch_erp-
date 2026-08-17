package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// Session is server-side state keyed by an opaque token. Nothing about identity
// or permissions lives in the token itself, so revoking a session is immediate
// and does not wait for an expiry — which is what a school needs when a laptop
// goes missing.
type Session struct {
	UserID         uuid.UUID `json:"user_id"`
	OrganizationID uuid.UUID `json:"organization_id"`
	IssuedAt       time.Time `json:"issued_at"`
	IP             string    `json:"ip"`
	UserAgent      string    `json:"user_agent"`
}

var ErrSessionNotFound = errors.New("auth: session not found")

const (
	sessionPrefix   = "session:"
	userIndexPrefix = "user_sessions:"

	// SecureCookieName carries the __Host- prefix, which browsers only accept on
	// a Secure, same-origin, path-/ cookie — a subdomain then cannot overwrite
	// the session.
	SecureCookieName = "__Host-erp_session"

	// InsecureCookieName is the development fallback. The __Host- prefix is not
	// merely ignored over plain HTTP, it makes the browser reject the cookie
	// outright, so local development would silently never stay signed in.
	InsecureCookieName = "erp_session"
)

// CookieName returns the session cookie name for the current transport. Always
// pass secure=true in staging and production; the prefix is free hardening and
// costs nothing once TLS is in front.
func CookieName(secure bool) string {
	if secure {
		return SecureCookieName
	}
	return InsecureCookieName
}

type SessionStore struct {
	rdb *redis.Client
	ttl time.Duration
}

func NewSessionStore(rdb *redis.Client, ttl time.Duration) *SessionStore {
	return &SessionStore{rdb: rdb, ttl: ttl}
}

// Create issues a 32-byte random token and stores the session under its hash.
// The plaintext token goes to the client; a Redis dump therefore does not hand
// an attacker usable session tokens.
func (s *SessionStore) Create(ctx context.Context, sess Session) (token string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: generate session token: %w", err)
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	sess.IssuedAt = time.Now().UTC()

	payload, err := json.Marshal(sess)
	if err != nil {
		return "", fmt.Errorf("auth: encode session: %w", err)
	}

	key := sessionKey(token)
	pipe := s.rdb.TxPipeline()
	pipe.Set(ctx, key, payload, s.ttl)
	// Index by user so "sign out everywhere" and the device list are one lookup.
	pipe.SAdd(ctx, userIndexPrefix+sess.UserID.String(), key)
	pipe.Expire(ctx, userIndexPrefix+sess.UserID.String(), s.ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return "", fmt.Errorf("auth: store session: %w", err)
	}
	return token, nil
}

func (s *SessionStore) Get(ctx context.Context, token string) (Session, error) {
	if token == "" {
		return Session{}, ErrSessionNotFound
	}
	payload, err := s.rdb.Get(ctx, sessionKey(token)).Bytes()
	if errors.Is(err, redis.Nil) {
		return Session{}, ErrSessionNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("auth: read session: %w", err)
	}
	var sess Session
	if err := json.Unmarshal(payload, &sess); err != nil {
		return Session{}, fmt.Errorf("auth: decode session: %w", err)
	}
	return sess, nil
}

// Touch extends a session's life on use, so an active user is not logged out
// mid-task while an idle one still expires.
func (s *SessionStore) Touch(ctx context.Context, token string) error {
	return s.rdb.Expire(ctx, sessionKey(token), s.ttl).Err()
}

func (s *SessionStore) Revoke(ctx context.Context, token string) error {
	sess, err := s.Get(ctx, token)
	if err != nil && !errors.Is(err, ErrSessionNotFound) {
		return err
	}
	pipe := s.rdb.TxPipeline()
	pipe.Del(ctx, sessionKey(token))
	if sess.UserID != uuid.Nil {
		pipe.SRem(ctx, userIndexPrefix+sess.UserID.String(), sessionKey(token))
	}
	_, err = pipe.Exec(ctx)
	return err
}

// RevokeAllForUser signs a user out of every device. Called on password change,
// on deactivation, and from the user's own session list.
func (s *SessionStore) RevokeAllForUser(ctx context.Context, userID uuid.UUID) error {
	indexKey := userIndexPrefix + userID.String()
	keys, err := s.rdb.SMembers(ctx, indexKey).Result()
	if err != nil {
		return fmt.Errorf("auth: list sessions: %w", err)
	}
	pipe := s.rdb.TxPipeline()
	for _, k := range keys {
		pipe.Del(ctx, k)
	}
	pipe.Del(ctx, indexKey)
	_, err = pipe.Exec(ctx)
	return err
}

func sessionKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return sessionPrefix + hex.EncodeToString(sum[:])
}
