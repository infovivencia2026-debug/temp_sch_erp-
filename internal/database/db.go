// Package database owns the pgx pools and, more importantly, the only correct
// way to run a tenant-scoped query.
//
// Every tenant table in the schema carries an RLS policy of the form
//
//	USING (app_is_platform_admin() OR institution_id = app_current_institution())
//
// and those helpers read the `app.institution_id` / `app.is_platform_admin`
// GUCs. A query issued on a connection where those are unset sees zero rows,
// which is the safe direction to fail. Pools therefore connect as the
// unprivileged app_user: Postgres exempts superusers and table owners from
// RLS, so connecting as erp_owner would silently disable every policy.
//
// # Where the rows live
//
// DB is a facade over a Resolver, which maps an institution to the Shard --
// the physical database -- holding its rows. Today one shared shard holds
// every tenant and RLS is what keeps them apart. That is the right shape at
// this size: one managed Postgres with point-in-time recovery is far easier to
// operate than ten, and RLS with FORCE ROW LEVEL SECURITY is real isolation,
// not a convention a handler can forget.
//
// The resolver exists so the decision stays reversible. When a specific school
// justifies its own database -- a procurement requirement, a restore-
// granularity need, or one tenant large enough to distort the shared instance
// -- that becomes a placement change behind this interface rather than a
// change at the 900-odd call sites below. Resolver.Control documents the one
// thing that must be solved first.
package database

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DB is the handle every caller holds. It routes each unit of work to the
// shard that owns the tenant, then runs it with the RLS GUCs set.
type DB struct{ r Resolver }

// Connect opens the single shared shard. It is the production constructor;
// New takes an arbitrary resolver for tests and for a future split fleet.
func Connect(ctx context.Context, url string, maxConns int32) (*DB, error) {
	shard, err := OpenShard(ctx, "shared", url, maxConns)
	if err != nil {
		return nil, err
	}
	return New(NewSharedResolver(shard)), nil
}

// New wraps a resolver.
func New(r Resolver) *DB { return &DB{r: r} }

// Resolver exposes the placement map, for callers that must address shards
// directly: health checks, the migrator, and per-shard metrics.
func (d *DB) Resolver() Resolver { return d.r }

func (d *DB) Close() { d.r.Close() }

// Health pings every shard. One unreachable shard fails the check: with a
// shared fleet that is the whole service, and with a split one it is still an
// outage for the schools placed there.
func (d *DB) Health(ctx context.Context) error {
	for _, s := range d.r.Shards() {
		if err := s.ping(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Scope carries the RLS identity for a unit of work.
type Scope struct {
	InstitutionID uuid.UUID
	PlatformAdmin bool
}

// InTenant runs fn inside a transaction whose GUCs are set for the scope, on
// whichever shard holds the scope's institution.
//
// A scope naming no institution routes to the control shard; see AsPlatform.
func (d *DB) InTenant(ctx context.Context, s Scope, fn func(pgx.Tx) error) error {
	shard, err := d.shardFor(ctx, s)
	if err != nil {
		return err
	}
	return shard.inTenant(ctx, s, fn)
}

func (d *DB) shardFor(ctx context.Context, s Scope) (*Shard, error) {
	if s.InstitutionID == uuid.Nil {
		return d.r.Control(ctx)
	}
	return d.r.ForTenant(ctx, s.InstitutionID)
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
//
// It runs on the control shard only. That is correct while the fleet is one
// shard and every user is on it; it is also precisely why splitting a tenant
// out needs the identity problem solved first, since a login for a school on
// its own database would find nothing here.
func (d *DB) AsPlatform(ctx context.Context, fn func(pgx.Tx) error) error {
	return d.InTenant(ctx, Scope{PlatformAdmin: true}, fn)
}
