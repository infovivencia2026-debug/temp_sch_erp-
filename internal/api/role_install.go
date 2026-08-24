package api

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/rbac"
)

/* Installing an optional role means two things, always together.

   A role is capability grants and menu grants. Writing only the first gives a
   school a role that can reach every endpoint it needs and shows nothing,
   which is how front_office spent its life: seven permissions, no navigation,
   an empty rail.

   This logic existed once already, inside the super admin's install handler.
   It moved here because the other caller — a principal picking a staffing
   preset — was silently skipping any role the school had not installed yet,
   and the remedy is for both to install a role the same way rather than for
   the second to grow its own half of one. */
func installOptionalRole(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	key string) (uuid.UUID, bool, error) {

	roleID, created, err := rbac.InstallRole(ctx, tx, inst, key)
	if err != nil {
		return uuid.Nil, false, err
	}
	persona, ok := catalog.RoleByKey(key)
	if !ok {
		// A capability bundle with no workspace of its own — class_teacher,
		// operations. There is no navigation to write.
		return roleID, created, nil
	}
	for _, sec := range persona.Sections {
		for _, f := range sec.Features {
			if _, err := tx.Exec(ctx, `
				INSERT INTO role_permissions (role_id, permission_key)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, roleID, f.Key); err != nil {
				return uuid.Nil, false, err
			}
		}
	}
	return roleID, created, nil
}
