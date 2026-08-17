// Package auth implements sign-in, sign-out and session resolution.
//
// The deliberate choices here: a failed login and a nonexistent account are
// indistinguishable in both response and timing; lockout is progressive and
// recorded; and the session carries no identity of its own — every request
// re-resolves the actor's permissions from the database, so revoking a role
// takes effect on the next request rather than at the next login.
package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/internal/audit"
	"github.com/school-erp/erp/pkg/auth"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

const (
	lockoutThreshold = 8
	lockoutDuration  = 15 * time.Minute
)

type Service struct {
	db       *database.DB
	sessions *auth.SessionStore
	audit    *audit.Writer
	repo     repository
}

func NewService(db *database.DB, sessions *auth.SessionStore, auditor *audit.Writer) *Service {
	return &Service{db: db, sessions: sessions, audit: auditor}
}

type LoginInput struct {
	Email     string
	Password  string
	IP        string
	UserAgent string
}

type LoginResult struct {
	Token string
	Actor *httpx.Actor
}

// Login verifies credentials and issues a session.
//
// Note what is *not* returned on failure: whether the account exists, whether it
// is locked, or whether the password was merely wrong. All three produce the
// same INVALID_CREDENTIALS response, because the difference is exactly what
// account enumeration needs.
func (s *Service) Login(ctx context.Context, in LoginInput) (LoginResult, error) {
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if email == "" || in.Password == "" {
		return LoginResult{}, httpx.BadRequest("INVALID_CREDENTIALS", "Enter your email and password.")
	}

	user, err := database.InTx(ctx, s.db, func(tx database.Tx) (userRecord, error) {
		return s.repo.findUserForLogin(ctx, tx, email)
	})
	if err != nil && !database.NoRows(err) {
		return LoginResult{}, httpx.Internal(err)
	}

	invalid := httpx.Unauthorized("INVALID_CREDENTIALS", "That email and password do not match.")

	if database.NoRows(err) {
		// Spend the same time hashing as a real verification would, so a missing
		// account cannot be spotted with a stopwatch.
		_ = auth.VerifyPassword(in.Password, auth.DummyHash)
		return LoginResult{}, invalid
	}

	if user.LockedUntil != nil && user.LockedUntil.After(time.Now()) {
		_ = auth.VerifyPassword(in.Password, auth.DummyHash)
		return LoginResult{}, invalid
	}
	if user.Status != "active" {
		_ = auth.VerifyPassword(in.Password, auth.DummyHash)
		return LoginResult{}, invalid
	}

	if err := auth.VerifyPassword(in.Password, user.PasswordHash); err != nil {
		if !errors.Is(err, auth.ErrMismatch) {
			return LoginResult{}, httpx.Internal(err)
		}
		// Record the attempt tenant-bound; we now know the organisation.
		_, _ = database.InTenantTx(ctx, s.db, user.OrganizationID, func(tx database.Tx) (struct{}, error) {
			if err := s.repo.recordFailedLogin(ctx, tx, user.ID, lockoutDuration, lockoutThreshold); err != nil {
				return struct{}{}, err
			}
			return struct{}{}, s.audit.Write(ctx, tx, audit.Entry{
				OrganizationID: user.OrganizationID,
				ActorUserID:    &user.ID,
				Action:         "auth.login_failed",
				EntityKind:     "user",
				EntityID:       &user.ID,
				IP:             in.IP,
				UserAgent:      in.UserAgent,
			})
		})
		return LoginResult{}, invalid
	}

	// Credentials are good. Everything from here is tenant-bound.
	acc, err := database.InTenantTx(ctx, s.db, user.OrganizationID, func(tx database.Tx) (access, error) {
		if err := s.repo.recordSuccessfulLogin(ctx, tx, user.ID); err != nil {
			return access{}, err
		}
		// A password hashed with weaker parameters gets upgraded here — the one
		// moment we hold the plaintext.
		if auth.NeedsRehash(user.PasswordHash) {
			if fresh, hashErr := auth.HashPassword(in.Password); hashErr == nil {
				if err := s.repo.updatePasswordHash(ctx, tx, user.ID, fresh); err != nil {
					return access{}, err
				}
			}
		}
		a, err := s.repo.loadAccess(ctx, tx, user.ID)
		if err != nil {
			return access{}, err
		}
		return a, s.audit.Write(ctx, tx, audit.Entry{
			OrganizationID: user.OrganizationID,
			ActorUserID:    &user.ID,
			ActorRole:      primaryRole(a.Roles),
			Action:         "auth.login",
			EntityKind:     "user",
			EntityID:       &user.ID,
			IP:             in.IP,
			UserAgent:      in.UserAgent,
		})
	})
	if err != nil {
		return LoginResult{}, httpx.Internal(err)
	}

	token, err := s.sessions.Create(ctx, auth.Session{
		UserID:         user.ID,
		OrganizationID: user.OrganizationID,
		IP:             in.IP,
		UserAgent:      in.UserAgent,
	})
	if err != nil {
		return LoginResult{}, httpx.Internal(err)
	}

	return LoginResult{
		Token: token,
		Actor: httpx.NewActor(user.ID, user.OrganizationID, user.FullName, user.Email,
			acc.Roles, acc.Schools, acc.Permissions),
	}, nil
}

// ResolveActor rebuilds the actor for an authenticated request. It reloads
// permissions every time rather than trusting the session: a role revoked at
// 10:00 must not keep working until the session expires at 22:00.
func (s *Service) ResolveActor(ctx context.Context, sess auth.Session) (*httpx.Actor, error) {
	return database.InTenantTx(ctx, s.db, sess.OrganizationID, func(tx database.Tx) (*httpx.Actor, error) {
		user, err := s.repo.findUserByID(ctx, tx, sess.UserID)
		if err != nil {
			if database.NoRows(err) {
				return nil, httpx.ErrSessionExpired
			}
			return nil, httpx.Internal(err)
		}
		if user.Status != "active" {
			return nil, httpx.ErrSessionExpired
		}
		acc, err := s.repo.loadAccess(ctx, tx, user.ID)
		if err != nil {
			return nil, httpx.Internal(err)
		}
		return httpx.NewActor(user.ID, user.OrganizationID, user.FullName, user.Email,
			acc.Roles, acc.Schools, acc.Permissions), nil
	})
}

func (s *Service) Logout(ctx context.Context, token string, actor *httpx.Actor) error {
	if err := s.sessions.Revoke(ctx, token); err != nil {
		return httpx.Internal(err)
	}
	if actor != nil {
		_, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (struct{}, error) {
			return struct{}{}, s.audit.Write(ctx, tx, audit.Entry{
				OrganizationID: actor.OrganizationID,
				ActorUserID:    &actor.UserID,
				ActorRole:      actor.PrimaryRole(),
				Action:         "auth.logout",
				EntityKind:     "user",
				EntityID:       &actor.UserID,
			})
		})
		if err != nil {
			return httpx.Internal(err)
		}
	}
	return nil
}

func primaryRole(roles []string) string {
	if len(roles) == 0 {
		return ""
	}
	return roles[0]
}

var _ = uuid.Nil
