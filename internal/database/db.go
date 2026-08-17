// Package database owns the pgx pool and, more importantly, the only correct
// way to run a tenant-scoped query.
//
// Every tenant table in the schema carries an RLS policy of the form
//
//	USING (app_is_platform_admin() OR institution_id = app_current_institution())
//
// and those helpers read the `app.institution_id` / `app.is_platform_admin`
// GUCs. A query issued on a connection where those are unset sees zero rows,
// which is the safe direction to fail. The pool therefore connects as the
// unprivileged app_user: Postgres exempts superusers and table owners from
// RLS, so connecting as erp_owner would silently disable every policy.
package database

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct{ Pool *pgxpool.Pool }

func Connect(ctx context.Context, url string, maxConns int32) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = maxConns
	// A 1 vCPU box shares this pool with nginx and Redis; idle connections cost
	// backend memory for no benefit, so retire them fairly aggressively.
	cfg.MinConns = 1
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = time.Hour
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &DB{Pool: pool}, nil
}

func (d *DB) Close() { d.Pool.Close() }

func (d *DB) Health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return d.Pool.Ping(ctx)
}

// Scope carries the RLS identity for a unit of work.
type Scope struct {
	InstitutionID uuid.UUID
	PlatformAdmin bool
}

// InTenant runs fn inside a transaction whose GUCs are set for the scope.
//
// SET LOCAL is deliberate: it is scoped to the transaction, so the setting
// cannot leak to the next request that borrows this pooled connection. Doing
// this with a plain SET on an acquired connection is the classic way to hand
// tenant A's data to tenant B after a mid-request error skips the reset.
func (d *DB) InTenant(ctx context.Context, s Scope, fn func(pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

	admin := "off"
	if s.PlatformAdmin {
		admin = "on"
	}
	// set_config with parameters, not string interpolation into SET LOCAL --
	// SET LOCAL does not accept placeholders, and the value is a UUID from the
	// session record, but interpolating it would still be an injection sink.
	inst := ""
	if s.InstitutionID != uuid.Nil {
		inst = s.InstitutionID.String()
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.institution_id', $1, true),
		        set_config('app.is_platform_admin', $2, true)`,
		inst, admin); err != nil {
		return fmt.Errorf("set tenant scope: %w", err)
	}

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AsPlatform runs fn with app.is_platform_admin set, which satisfies every
// tenant_isolation policy.
//
// This exists because the schema uses FORCE ROW LEVEL SECURITY, so even
// erp_owner is subject to the policies -- there is no "connect as the owner and
// see everything" escape hatch. A handful of operations genuinely cannot be
// tenant-scoped:
//
//   - the login lookup, which must find a user before their institution is known
//   - session resolve/revoke, keyed by token hash or session id
//   - migrate's seed and create-admin bootstrap
//
// Everything else must go through InTenant. Queries here are unfiltered by
// tenant, so keep them narrow and always parameterised: a LIKE over users in
// this scope would read every tenant's rows.
func (d *DB) AsPlatform(ctx context.Context, fn func(pgx.Tx) error) error {
	return d.InTenant(ctx, Scope{PlatformAdmin: true}, fn)
}
