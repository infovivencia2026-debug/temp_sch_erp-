// Command migrate applies the schema and seeds the RBAC vocabulary.
//
//	migrate up            apply all pending migrations
//	migrate down          roll back one
//	migrate status        show what is applied
//	migrate seed          upsert permissions and system roles
//	migrate create-admin  create the first institution admin
//
// Migrations run as the owner role (POSTGRES_USER), not app_user: app_user is
// deliberately stripped of CREATE on the public schema so a compromised web
// process cannot alter the schema out from under RLS.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/school-erp/erp/internal/api"
	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/config"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/migrations"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		ownerURL = flag.String("db", "", "migration DSN (defaults to MIGRATE_DATABASE_URL, then DATABASE_URL)")
		email    = flag.String("email", "", "create-admin: email")
		password = flag.String("password", "", "create-admin: password")
		name     = flag.String("name", "Administrator", "create-admin: full name")
		instName = flag.String("institution", "", "create-admin: institution name (created if absent)")
	)
	// The stdlib flag package stops parsing at the first non-flag argument, so
	// `migrate create-admin -email ...` would silently see no flags at all.
	// Pull the subcommand out first and parse what is left, which makes the
	// order irrelevant.
	args := os.Args[1:]
	cmd := ""
	rest := make([]string, 0, len(args))
	for _, a := range args {
		if cmd == "" && !strings.HasPrefix(a, "-") {
			cmd = a
			continue
		}
		rest = append(rest, a)
	}
	if cmd == "" {
		return fmt.Errorf("usage: migrate <up|down|status|seed|seed-permissions|create-admin|demo-data|demo-users> [flags]")
	}
	if err := flag.CommandLine.Parse(rest); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	dsn := *ownerURL
	if dsn == "" {
		dsn = os.Getenv("MIGRATE_DATABASE_URL")
	}
	if dsn == "" {
		dsn = cfg.DatabaseURL
	}

	ctx := context.Background()

	switch cmd {
	case "up", "down", "status":
		return runGoose(ctx, dsn, cmd)
	/* seed-permissions is the half of seed that is safe to run unattended.

	   Permission keys are upserted and never removed, so a deploy that adds
	   one lands it in the database where a role can be granted it. The other
	   half — role to permission grants — deliberately stays manual: seeding a
	   role deletes its grants and rewrites them from the Go definition, which
	   would silently revert any role a school edited in the permissions grid.
	   Running that on every deploy would undo a customer's own configuration
	   as a side effect of shipping an unrelated change. */
	case "seed-permissions":
		db, err := database.Connect(ctx, dsn, 4)
		if err != nil {
			return err
		}
		defer db.Close()
		return db.AsPlatform(ctx, func(tx pgx.Tx) error {
			if err := seedPermissions(ctx, tx); err != nil {
				return err
			}
			slog.Info("permissions seeded", "count", len(rbac.All))
			return nil
		})
	case "seed":
		db, err := database.Connect(ctx, dsn, 4)
		if err != nil {
			return err
		}
		defer db.Close()
		return seed(ctx, db)
	case "demo-data":
		db, err := database.Connect(ctx, dsn, 4)
		if err != nil {
			return err
		}
		defer db.Close()
		if err := seedDemoData(ctx, db); err != nil {
			return err
		}
		// The spine, then everything the spine left blank.
		return seedDemoOperations(ctx, db)
	case "demo-users":
		if *password == "" {
			return fmt.Errorf("demo-users requires -password")
		}
		db, err := database.Connect(ctx, dsn, 4)
		if err != nil {
			return err
		}
		defer db.Close()
		return seedDemoUsers(ctx, db, cfg.PasswordPepper, *password)
	case "create-seller":
		if *email == "" || *password == "" {
			return fmt.Errorf("create-seller requires -email and -password")
		}
		db, err := database.Connect(ctx, dsn, 4)
		if err != nil {
			return err
		}
		defer db.Close()
		return createSeller(ctx, db, cfg.PasswordPepper, *email, *password, *name)
	case "create-admin":
		if *email == "" || *password == "" {
			return fmt.Errorf("create-admin requires -email and -password")
		}
		db, err := database.Connect(ctx, dsn, 4)
		if err != nil {
			return err
		}
		defer db.Close()
		return createAdmin(ctx, db, cfg.PasswordPepper, *email, *password, *name, *instName)
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func runGoose(ctx context.Context, dsn, cmd string) error {
	sqlDB := stdlib.OpenDB(*mustParse(dsn))
	defer sqlDB.Close()

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}

	switch cmd {
	case "up":
		return goose.UpContext(ctx, sqlDB, ".")
	case "down":
		return goose.DownContext(ctx, sqlDB, ".")
	case "status":
		return goose.StatusContext(ctx, sqlDB, ".")
	}
	return nil
}

func mustParse(dsn string) *pgx.ConnConfig {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		panic(err)
	}
	return cfg
}

// seed upserts the permission vocabulary and the system roles.
//
// Idempotent by design: it runs on every deploy, and adding a permission
// constant must not require hand-written SQL. Roles are seeded per institution
// because roles.institution_id is part of their identity.
func seed(ctx context.Context, db *database.DB) error {
	return db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if err := seedPermissions(ctx, tx); err != nil {
			return err
		}
		slog.Info("permissions seeded", "count", len(rbac.All))

		rows, err := tx.Query(ctx, `SELECT id FROM institutions`)
		if err != nil {
			return err
		}
		var insts []uuid.UUID
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			insts = append(insts, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, inst := range insts {
			if err := seedRoles(ctx, tx, inst); err != nil {
				return err
			}
			if err := rbac.SeedCatalogRoles(ctx, tx, inst); err != nil {
				return err
			}
			if err := seedMergedPersonas(ctx, tx, inst); err != nil {
				return err
			}
		}
		slog.Info("roles seeded", "institutions", len(insts), "roles", len(rbac.SystemRoles))
		return nil
	})
}

// seedPermissions upserts the permission vocabulary. Split out from seed so
// create-admin can bootstrap a fresh database in one command.
//
// Two vocabularies are seeded side by side:
//
//   - internal/rbac — coarse capability keys (students.read, finance.fees.write)
//     that the hand-written API handlers gate on.
//   - internal/catalog — one key per row of docs/edu_features.csv, generated,
//     which is what drives each role's navigation.
//
// They coexist deliberately. The catalog says what a role may *see*; the rbac
// keys say what a handler may *do*. Collapsing them would either explode the
// handler vocabulary to 419 keys or flatten the catalog's per-role structure.
func seedPermissions(ctx context.Context, tx pgx.Tx) error {
	upsert := func(key, module, desc string) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO permissions (key, module, description)
			VALUES ($1,$2,$3)
			ON CONFLICT (key) DO UPDATE
			   SET module = EXCLUDED.module, description = EXCLUDED.description`,
			key, module, desc); err != nil {
			return fmt.Errorf("seed permission %s: %w", key, err)
		}
		return nil
	}

	for _, p := range rbac.All {
		if err := upsert(p.Key, p.Module, p.Description); err != nil {
			return err
		}
	}

	for _, r := range catalog.Roles {
		for _, sec := range r.Sections {
			for _, f := range sec.Features {
				desc := f.Summary
				// permissions.description is NOT NULL and the column is read
				// straight into the admin UI, so keep it short and never empty.
				if len(desc) > 240 {
					desc = desc[:237] + "..."
				}
				if desc == "" {
					desc = f.Name
				}
				if err := upsert(f.Key, r.Key, desc); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// seedCatalogRoles creates one role per catalog persona and grants it exactly
// its own feature keys.
//
// super_admin and seller_admin are seeded with a NULL institution_id: they are
// platform roles, not members of any tenant — one operates the schools, the
// other sells to them. roles_institution_key indexes COALESCE(institution_id,
// all-zero uuid), so the NULL row is unique globally and is created once
// rather than per institution.
/*
mergedPersonas keeps the specialist roles navigable after their workspaces were
folded into the principal's.

	Eight personas were removed from the catalogue; their capability roles were
	not, because deleting those would either strip permissions from people who
	have them or — worse — reassign a head of department to institution_admin
	and hand them the payroll on the way past.

	So the capability role stays exactly as it was, and is granted the feature
	keys of the workspace its work moved to. A librarian keeps library.read and
	library.write, and now sees the Library group of the principal's Operations
	workspace and nothing else in it: the catalogue grants decide the menu, the
	capability keys still decide what the handlers allow.

	Keyed by section slug, which survived the merge; the workspace name did not.
*/
var mergedPersonas = map[string]struct {
	From     string
	Sections []string
}{
	"vice_principal": {"institution_admin", []string{
		"home", "approvals", "academics", "examinations", "students", "communication"}},
	"hod": {"institution_admin", []string{
		"home", "approvals", "staff", "academics", "students", "communication", "reports"}},
	"class_teacher":     {"faculty", nil}, // the whole teacher workspace
	"it_admin":          {"super_admin", []string{"access_security", "institution_setup", "platform_configuration"}},
	"operations":        {"institution_admin", []string{"transport", "hostel", "library", "infirmary", "stores"}},
	"transport_manager": {"institution_admin", []string{"transport"}},
	"librarian":         {"institution_admin", []string{"library"}},
	"hostel_warden":     {"institution_admin", []string{"hostel"}},
}

// seedMergedPersonas grants the folded-in roles their share of the surviving
// workspace, and clears the grants that pointed at the persona they lost.
func seedMergedPersonas(ctx context.Context, tx pgx.Tx, inst uuid.UUID) error {
	for roleKey, m := range mergedPersonas {
		var roleID uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM roles WHERE institution_id = $1 AND key = $2`,
			inst, roleKey).Scan(&roleID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue // this school never installed the role
		}
		if err != nil {
			return fmt.Errorf("merged persona %s: %w", roleKey, err)
		}

		src, ok := catalog.RoleByKey(m.From)
		if !ok {
			return fmt.Errorf("merged persona %s: no such role %s", roleKey, m.From)
		}
		want := make([]string, 0, 32)

		/* A persona's own workspace, where it has grown one.

		   These roles were folded into somebody else's catalogue because they
		   had no entry of their own: a HOD borrowed the principal's academics
		   and staff sections because there was nothing called hod to grant.
		   Now that there is, the borrowing has to stop excluding it. The
		   delete below removes every catalog grant outside `want`, so leaving
		   the role's own keys out of the set wiped them microseconds after
		   SeedCatalogRoles wrote them — the head of department kept exactly
		   the screens addressed to the principal and none addressed to them.

		   Additive on purpose. The borrowed sections are still the right
		   answer for the parts of the job this role shares with the role it
		   was merged from; the point is that its own screens now survive
		   alongside them. */
		if own, ok := catalog.RoleByKey(roleKey); ok {
			for _, sec := range own.Sections {
				for _, f := range sec.Features {
					want = append(want, f.Key)
				}
			}
		}

		for _, sec := range src.Sections {
			if m.Sections != nil && !slices.Contains(m.Sections, sec.Slug) {
				continue
			}
			for _, f := range sec.Features {
				want = append(want, f.Key)
			}
		}

		// Drop every catalog grant this role holds that is not in the new set,
		// including the ones naming the persona that no longer exists. rbac
		// capability keys are excluded by name so the role keeps what it can do.
		rbacKeys := make([]string, 0, len(rbac.All))
		for _, p := range rbac.All {
			rbacKeys = append(rbacKeys, p.Key)
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM role_permissions
			 WHERE role_id = $1
			   AND permission_key <> ALL($2)
			   AND permission_key <> ALL($3)`, roleID, rbacKeys, want); err != nil {
			return err
		}
		for _, k := range want {
			if _, err := tx.Exec(ctx, `
				INSERT INTO role_permissions (role_id, permission_key)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, roleID, k); err != nil {
				return fmt.Errorf("grant %s to %s: %w", k, roleKey, err)
			}
		}
	}
	return nil
}

// seedRoles installs the system roles for one institution.
//
// Grants are replaced rather than merged, so removing a permission from a role
// in code actually revokes it instead of leaving a stale grant behind.
// seedRoles delegates to rbac.SeedInstitution so the migrate command and the
// seller console install exactly the same role set.
func seedRoles(ctx context.Context, tx pgx.Tx, inst uuid.UUID) error {
	return rbac.SeedInstitution(ctx, tx, inst)
}

/*
createSeller makes an account for the software vendor's own staff.

	Deliberately a command and not a screen. Every school account is created by
	somebody already inside the system — the seller provisions the principal,
	the principal provisions the clerk — but the first vendor account has nobody
	above it, and a sign-up page that mints platform staff is a door nobody
	needs.

	The account belongs to no institution, which is what gives it reach across
	tenants, and holds only the seller_admin permissions, which is what stops
	that reach becoming access to every child's record.
*/
func createSeller(ctx context.Context, db *database.DB, pepper, email, password, name string) error {
	hasher := auth.NewHasher(pepper)
	hash, err := hasher.Hash(password)
	if err != nil {
		return err
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if name == "" {
		name = "Vendor Operations"
	}
	username := strings.SplitN(email, "@", 2)[0]

	return db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if err := seedPermissions(ctx, tx); err != nil {
			return err
		}
		// The platform roles live on a NULL institution; seeding against a nil
		// tenant creates exactly those and skips the per-school ones.
		if err := rbac.SeedInstitution(ctx, tx, uuid.Nil); err != nil {
			return err
		}

		var userID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (institution_id, email, username, full_name,
			                   password_hash, status)
			VALUES (NULL, $1::citext, $2::citext, $3, $4, 'active')
			ON CONFLICT (email) WHERE institution_id IS NULL
			DO UPDATE SET password_hash = EXCLUDED.password_hash,
			              username = EXCLUDED.username, status = 'active'
			RETURNING id`, email, username, name, hash).Scan(&userID); err != nil {
			return fmt.Errorf("upsert seller: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO user_roles (user_id, role_id, institution_id)
			SELECT $1, r.id, NULL FROM roles r
			 WHERE r.key = 'seller_admin' AND r.institution_id IS NULL
			ON CONFLICT DO NOTHING`, userID); err != nil {
			return fmt.Errorf("grant seller_admin: %w", err)
		}

		slog.Info("seller ready", "email", email, "username", username, "user_id", userID)
		return nil
	})
}

func createAdmin(ctx context.Context, db *database.DB, pepper, email, password, name, instName string) error {
	hasher := auth.NewHasher(pepper)
	hash, err := hasher.Hash(password)
	if err != nil {
		return err
	}
	email = strings.ToLower(strings.TrimSpace(email))

	return db.AsPlatform(ctx, func(tx pgx.Tx) error {
		var instID uuid.UUID
		if instName != "" {
			slug := strings.ToLower(strings.ReplaceAll(instName, " ", "-"))
			if err := tx.QueryRow(ctx, `
				INSERT INTO institutions (name, short_name, slug)
				VALUES ($1,$2,$3)
				ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
				RETURNING id`, instName, firstWord(instName), slug).Scan(&instID); err != nil {
				return fmt.Errorf("upsert institution: %w", err)
			}
		} else {
			if err := tx.QueryRow(ctx,
				`SELECT id FROM institutions ORDER BY created_at LIMIT 1`).Scan(&instID); err != nil {
				return fmt.Errorf("no institution exists; pass -institution: %w", err)
			}
		}

		var userID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (institution_id, email, full_name, password_hash, status)
			VALUES ($1,$2::citext,$3,$4,'active')
			-- users_institution_email is partial (WHERE email IS NOT NULL) and
			-- scoped per institution: the same address may exist in two
			-- schools, so the tenant is part of the key.
			ON CONFLICT (institution_id, email) WHERE email IS NOT NULL
			DO UPDATE SET password_hash = EXCLUDED.password_hash,
			              full_name     = EXCLUDED.full_name,
			              status        = 'active'
			RETURNING id`, instID, email, name, hash).Scan(&userID); err != nil {
			return fmt.Errorf("upsert user: %w", err)
		}

		// Bootstrap the RBAC rows for this tenant so a fresh database needs
		// exactly one command. Both helpers are idempotent.
		if err := seedPermissions(ctx, tx); err != nil {
			return err
		}
		if err := seedRoles(ctx, tx, instID); err != nil {
			return err
		}
		if err := rbac.SeedCatalogRoles(ctx, tx, instID); err != nil {
			return err
		}

		// The first account holds every staff role.
		//
		// A school that has just installed this has one person, and that person
		// needs to do all of it: admit a child, take a fee, mark a register, run
		// payroll. Handing them an account that can only do one and a screen
		// telling them to create more users is the wrong first five minutes.
		// Roles stay separate — the left rail switches between the workspaces —
		// so this is convenience, not a merged super-user.
		tag, err := tx.Exec(ctx, `
			INSERT INTO user_roles (institution_id, user_id, role_id)
			SELECT $1, $2, r.id FROM roles r
			 WHERE r.institution_id = $1 AND r.key = ANY($3)
			ON CONFLICT (user_id, role_id) WHERE campus_id IS NULL DO NOTHING`,
			instID, userID, api.AllOperationalRoles)
		if err != nil {
			return fmt.Errorf("assign roles: %w", err)
		}
		slog.Info("roles assigned to first account", "count", tag.RowsAffected())

		slog.Info("admin ready", "email", email, "user_id", userID, "institution_id", instID)
		return nil
	})
}

func firstWord(s string) string {
	if i := strings.IndexByte(s, ' '); i > 0 {
		return s[:i]
	}
	return s
}
