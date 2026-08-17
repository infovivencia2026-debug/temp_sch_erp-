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
// PlatformRoles belong to the installation, not to any school.
var PlatformRoles = map[string]bool{"super_admin": true, "seller_admin": true}

func SeedInstitution(ctx context.Context, tx pgx.Tx, inst uuid.UUID) error {
	for _, role := range SystemRoles {
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
		platform := PlatformRoles[role.Key]
		if (inst == uuid.Nil) != platform {
			continue
		}
		var owner any = inst
		if platform {
			owner = nil
		}

		var roleID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO roles (institution_id, key, name, is_system)
			VALUES ($1,$2,$3,true)
			-- roles_institution_key is an expression index over
			-- COALESCE(institution_id, all-zero uuid), so the conflict target
			-- has to repeat the expression verbatim to match it.
			ON CONFLICT (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
			DO UPDATE SET name = EXCLUDED.name
			RETURNING id`, owner, role.Key, role.Name).Scan(&roleID); err != nil {
			return fmt.Errorf("seed role %s: %w", role.Key, err)
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM role_permissions WHERE role_id = $1`, roleID); err != nil {
			return err
		}
		for _, key := range role.Permissions {
			if _, err := tx.Exec(ctx, `
				INSERT INTO role_permissions (role_id, permission_key)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, roleID, key); err != nil {
				return fmt.Errorf("grant %s to %s: %w", key, role.Key, err)
			}
		}
	}
	return nil
}
