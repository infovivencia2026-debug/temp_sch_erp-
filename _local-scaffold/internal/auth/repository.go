package auth

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
)

type userRecord struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Email          string
	FullName       string
	PasswordHash   string
	Status         string
	FailedAttempts int
	LockedUntil    *time.Time
}

// access is the result of resolving what a user may do: their role keys, the
// schools they are scoped to, and the union of their permissions.
type access struct {
	Roles       []string
	Schools     []uuid.UUID
	Permissions []string
}

type repository struct{}

// findUserForLogin runs before we know which organisation to bind, because the
// person is typing an email rather than choosing a tenant. It goes through the
// SECURITY DEFINER function introduced in migration 0002 — the only RLS bypass
// in the system, returning at most one row and only the columns login needs.
//
// Everything after this point in the login flow runs tenant-bound, using the
// organisation this lookup returns.
func (r repository) findUserForLogin(ctx context.Context, tx database.Tx, email string) (userRecord, error) {
	var u userRecord
	err := tx.QueryRow(ctx, `
		SELECT id, organization_id, coalesce(email, ''), full_name,
		       password_hash, status, failed_attempts, locked_until
		FROM   auth_lookup_login($1)`, email).
		Scan(&u.ID, &u.OrganizationID, &u.Email, &u.FullName,
			&u.PasswordHash, &u.Status, &u.FailedAttempts, &u.LockedUntil)
	return u, err
}

func (r repository) findUserByID(ctx context.Context, tx database.Tx, id uuid.UUID) (userRecord, error) {
	var u userRecord
	err := tx.QueryRow(ctx, `
		SELECT id, organization_id, coalesce(email::text, ''), full_name,
		       password_hash, status, failed_attempts, locked_until
		FROM   users
		WHERE  id = $1 AND archived_at IS NULL`, id).
		Scan(&u.ID, &u.OrganizationID, &u.Email, &u.FullName,
			&u.PasswordHash, &u.Status, &u.FailedAttempts, &u.LockedUntil)
	return u, err
}

// loadAccess resolves roles, school scope and the permission union in one query
// per concern. Called on every authenticated request, so it is deliberately
// cheap and indexed on memberships(user_id) WHERE status = 'active'.
func (r repository) loadAccess(ctx context.Context, tx database.Tx, userID uuid.UUID) (access, error) {
	var a access

	rows, err := tx.Query(ctx, `
		SELECT DISTINCT r.key, m.school_id
		FROM   memberships m
		JOIN   roles r ON r.id = m.role_id
		WHERE  m.user_id = $1 AND m.status = 'active'`, userID)
	if err != nil {
		return a, err
	}
	seenRole := map[string]bool{}
	for rows.Next() {
		var role string
		var schoolID *uuid.UUID
		if err := rows.Scan(&role, &schoolID); err != nil {
			rows.Close()
			return a, err
		}
		if !seenRole[role] {
			seenRole[role] = true
			a.Roles = append(a.Roles, role)
		}
		if schoolID != nil {
			a.Schools = append(a.Schools, *schoolID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return a, err
	}

	permRows, err := tx.Query(ctx, `
		SELECT DISTINCT rp.permission_key
		FROM   memberships m
		JOIN   role_permissions rp ON rp.role_id = m.role_id
		WHERE  m.user_id = $1 AND m.status = 'active'
		ORDER  BY rp.permission_key`, userID)
	if err != nil {
		return a, err
	}
	defer permRows.Close()
	for permRows.Next() {
		var key string
		if err := permRows.Scan(&key); err != nil {
			return a, err
		}
		a.Permissions = append(a.Permissions, key)
	}
	return a, permRows.Err()
}

func (r repository) recordFailedLogin(ctx context.Context, tx database.Tx, userID uuid.UUID, lockFor time.Duration, threshold int) error {
	_, err := tx.Exec(ctx, `
		UPDATE users
		SET    failed_attempts = failed_attempts + 1,
		       locked_until = CASE WHEN failed_attempts + 1 >= $2
		                           THEN now() + $3::interval
		                           ELSE locked_until END,
		       updated_at = now()
		WHERE  id = $1`, userID, threshold, lockFor.String())
	return err
}

func (r repository) recordSuccessfulLogin(ctx context.Context, tx database.Tx, userID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		UPDATE users
		SET    failed_attempts = 0, locked_until = NULL,
		       last_login_at = now(), updated_at = now()
		WHERE  id = $1`, userID)
	return err
}

func (r repository) updatePasswordHash(ctx context.Context, tx database.Tx, userID uuid.UUID, hash string) error {
	_, err := tx.Exec(ctx,
		`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
		userID, hash)
	return err
}
