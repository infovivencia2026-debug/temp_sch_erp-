package rbac

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SeedInstitution installs the system role set into one tenant.
//
// It lived in cmd/migrate, which was fine while the only way to create a
// school was a shell command. Provisioning from the seller console needs the
// same thing inside a request, and a school whose roles were seeded by a
// second, slightly different copy of this function is the kind of divergence
// nobody finds until a permission is missing in production.
//
// Idempotent: re-running re-grants the current permission set, which is how a
// new permission reaches schools that already exist.
// PlatformOperatorRole is the one role that operates the installation itself.
//
// It is the whole test for whether platform staff are held to their granted
// permissions or bypass them: every other platform role — the vendor's sales
// desk, the vendor's support desk — reaches across tenants and must still be
// limited to what it was given. Named here so the check reads as a rule rather
// than as a string literal buried in session resolution.
const PlatformOperatorRole = "super_admin"

// PlatformRoles belong to the installation, not to any school.
var PlatformRoles = map[string]bool{
	PlatformOperatorRole: true, "seller_admin": true, "support_admin": true,
}

func SeedInstitution(ctx context.Context, tx pgx.Tx, inst uuid.UUID) error {
	/* Which roles this school already has.

	   A new school opens with the default set only — see optionalRoles for why.
	   A school already running keeps everything it was given, including roles
	   that are no longer seeded by default and any the office installed later,
	   because "we stopped seeding this by default" must never read as "we
	   removed it from schools that use it". */
	existing := map[string]bool{}
	rows, err := tx.Query(ctx,
		`SELECT key FROM roles WHERE institution_id IS NOT DISTINCT FROM $1`, nullableInst(inst))
	if err != nil {
		return fmt.Errorf("load existing roles: %w", err)
	}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return err
		}
		existing[k] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, role := range SystemRoles {
		if !IsDefault(role.Key) && !existing[role.Key] {
			continue
		}
		/* Platform roles and tenant roles are seeded separately.

		   inst == Nil means "the platform" — the path create-seller takes,
		   where there is no school to attach the per-tenant roles to; writing
		   them against the all-zero institution fails the foreign key.

		   A real inst means "this school", and the platform roles must be left
		   alone. They were not: because a platform role hangs off no
		   institution, seeding *any* tenant re-seeded the single shared
		   seller_admin row — and the DELETE below removed its catalogue grants
		   on the way past, so provisioning one school silently emptied the
		   vendor's own navigation. */
		if (inst == uuid.Nil) != PlatformRoles[role.Key] {
			continue
		}
		if _, err := upsertRole(ctx, tx, inst, role); err != nil {
			return err
		}
	}
	return nil
}

// InstallRole adds one optional system role to a school that does not have it.
//
// Returns the role id and whether it was newly created, so the caller can tell
// "installed" from "already had it" without a second query.
func InstallRole(ctx context.Context, tx pgx.Tx, inst uuid.UUID, roleKey string) (uuid.UUID, bool, error) {
	if PlatformRoles[roleKey] {
		return uuid.Nil, false, fmt.Errorf("%s is a platform role and belongs to no school", roleKey)
	}
	var role Role
	for _, r := range SystemRoles {
		if r.Key == roleKey {
			role = r
		}
	}
	if role.Key == "" {
		return uuid.Nil, false, fmt.Errorf("unknown role %q", roleKey)
	}

	// EXISTS rather than a row-or-ErrNoRows probe: this has to distinguish
	// "already installed" from "not installed", and a missing row is the
	// expected answer here, not an error to sift out of the return.
	var already bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM roles WHERE institution_id = $1 AND key = $2)`,
		inst, roleKey).Scan(&already); err != nil {
		return uuid.Nil, false, err
	}
	id, err := upsertRole(ctx, tx, inst, role)
	return id, !already, err
}

// upsertRole writes one role and replaces its capability grants.
//
// The DELETE is what makes seeding idempotent — re-running re-grants the
// current set, which is how a newly added permission reaches schools that
// already exist — and it is also why a hand-edited system role does not stay
// edited. Custom roles are never passed through here.
func upsertRole(ctx context.Context, tx pgx.Tx, inst uuid.UUID, role Role) (uuid.UUID, error) {
	var owner any = inst
	if PlatformRoles[role.Key] {
		owner = nil
	}

	var roleID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO roles (institution_id, key, name, is_system, is_default)
		VALUES ($1,$2,$3,true,$4)
		-- roles_institution_key is an expression index over
		-- COALESCE(institution_id, all-zero uuid), so the conflict target
		-- has to repeat the expression verbatim to match it.
		ON CONFLICT (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
		DO UPDATE SET name = EXCLUDED.name, is_default = EXCLUDED.is_default
		RETURNING id`, owner, role.Key, role.Name, IsDefault(role.Key)).Scan(&roleID); err != nil {
		return uuid.Nil, fmt.Errorf("seed role %s: %w", role.Key, err)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM role_permissions WHERE role_id = $1`, roleID); err != nil {
		return uuid.Nil, err
	}
	for _, key := range role.Permissions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO role_permissions (role_id, permission_key)
			VALUES ($1,$2) ON CONFLICT DO NOTHING`, roleID, key); err != nil {
			return uuid.Nil, fmt.Errorf("grant %s to %s: %w", key, role.Key, err)
		}
	}
	return roleID, nil
}

// nullableInst maps the platform's all-zero institution onto SQL NULL, so one
// query serves both the platform pass and a tenant pass.
func nullableInst(inst uuid.UUID) any {
	if inst == uuid.Nil {
		return nil
	}
	return inst
}
