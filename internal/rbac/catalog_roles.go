package rbac

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
)

/* Navigation, as distinct from capability.

   SeedInstitution grants a school's roles their *capabilities* — the keys the
   API gates handlers on. This grants the same roles their *catalog features* —
   the keys the SPA builds its navigation from. A school with the first and not
   the second has a working API and an empty screen, which is exactly what
   every provisioned tenant had: the seller console and the website both built
   schools whose principal signed in to no menu at all, because this ran only
   from the migrate command's seed pass over institutions that already existed.

   Lifted out of cmd/migrate so the two doors that create schools and the
   command that repairs them cannot drift. */

// platformRole names the roles that belong to the installation rather than to
// any one school.
var platformRole = map[string]bool{"super_admin": true, "seller_admin": true}

// nullableInstitution maps the platform's all-zero institution onto SQL NULL,
// so one query serves both the platform pass and a tenant pass.
func nullableInstitution(inst uuid.UUID) any {
	if inst == uuid.Nil {
		return nil
	}
	return inst
}

func SeedCatalogRoles(ctx context.Context, tx pgx.Tx, inst uuid.UUID) error {
	/* Which roles this school already has, for the same reason
	   rbac.SeedInstitution loads it: the optional roles are not part of a new
	   school's opening position, and creating the row here anyway would hand a
	   fresh tenant a hod and an operations workspace with navigation but no
	   capability grants behind it — a menu whose every entry answers 403. */
	existing := map[string]bool{}
	rows, err := tx.Query(ctx,
		`SELECT key FROM roles WHERE institution_id IS NOT DISTINCT FROM $1`,
		nullableInstitution(inst))
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

	for _, r := range catalog.Roles {
		if !IsDefault(r.Key) && !existing[r.Key] {
			continue
		}
		var owner any = inst
		if platformRole[r.Key] {
			owner = nil
		}

		var roleID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO roles (institution_id, key, name, is_system, is_default)
			VALUES ($1,$2,$3,true,$4)
			ON CONFLICT (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
			DO UPDATE SET name = EXCLUDED.name, is_default = EXCLUDED.is_default
			RETURNING id`, owner, r.Key, r.Name, IsDefault(r.Key)).Scan(&roleID); err != nil {
			return fmt.Errorf("seed catalog role %s: %w", r.Key, err)
		}

		// Replace this role's catalog grants, leaving its rbac capability grants
		// alone. Deleting by LIKE '<role>.%' looked equivalent and was not:
		// rbac keys such as "admissions.read" and "hr.employees.read" share the
		// role's prefix, so the wildcard silently removed exactly the grants the
		// API gates its handlers on, and every back-office endpoint began
		// answering 403.
		keys := make([]string, 0, 64)
		for _, sec := range r.Sections {
			for _, f := range sec.Features {
				keys = append(keys, f.Key)
			}
		}
		/* Drop this role's stale catalog grants as well as replacing its
		   current ones.

		   A feature key is role.section.feature, so regrouping a role's
		   sections renames every one of its keys. Deleting only the keys in
		   the new list left the old ones granted forever: invisible, because
		   no handler gates on a key that is not in the catalog, and wrong,
		   because every count of "what does this role grant" included them.

		   The prefix match is bounded by two exclusions. rbac capability keys
		   such as admissions.read and hr.employees.read share these prefixes
		   and gate real handlers — deleting those by wildcard is what once
		   made every back-office endpoint answer 403. */
		rbacKeys := make([]string, 0, len(All))
		for _, p := range All {
			rbacKeys = append(rbacKeys, p.Key)
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM role_permissions
			 WHERE role_id = $1
			   AND (permission_key = ANY($2)
			        OR (permission_key LIKE $3
			            AND permission_key <> ALL($4)))`,
			roleID, keys, r.Key+".%", rbacKeys); err != nil {
			return err
		}
		for _, key := range keys {
			if _, err := tx.Exec(ctx, `
				INSERT INTO role_permissions (role_id, permission_key)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, roleID, key); err != nil {
				return fmt.Errorf("grant %s: %w", key, err)
			}
		}
	}
	return nil
}
