package database

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Shard is one physical Postgres database and the pool that reaches it.
//
// Today there is exactly one, shared by every institution and kept apart by
// RLS. The type exists so that moving a school onto its own database later is
// a placement decision rather than a rewrite: see Resolver.
//
// The pool is deliberately unexported. Handing a caller a *pgxpool.Pool would
// let them issue a query outside InTenant, on a connection where
// app.institution_id is unset -- which either returns zero rows or, for the
// handful of tables without a policy, returns every tenant's. Every query in
// this codebase goes through InTenant or AsPlatform, and the type system
// should keep it that way.
type Shard struct {
	// Name identifies the shard in logs, metrics and migration reports. It is
	// not a DSN and is safe to print.
	Name string
	pool *pgxpool.Pool
}

// Resolver decides which Shard holds a given institution's rows.
//
// The interface takes an institution id rather than returning a single pool
// because that is the seam that lets placement become data-driven: a resolver
// backed by a control table can graduate one large school onto a dedicated
// database while every other tenant keeps sharing, and no caller changes.
//
// Implementations must be safe for concurrent use.
type Resolver interface {
	// ForTenant returns the shard holding institutionID.
	ForTenant(ctx context.Context, institutionID uuid.UUID) (*Shard, error)

	// Control returns the shard for work that has no tenant yet: the login
	// lookup, session resolve/revoke, and migrate's bootstrap.
	//
	// This is the honest constraint on ever splitting databases. Those three
	// operations find a user before their institution is known, so they can
	// only stay single-shard for as long as every user lives on one shard.
	// Splitting a tenant out therefore requires either an identity directory
	// on the control shard that maps credential -> institution before the
	// lookup, or a fleet-wide fan-out. Neither is built; see Shards.
	Control(ctx context.Context) (*Shard, error)

	// Shards lists every distinct shard, for health checks, migrations and
	// shutdown. Order is stable.
	Shards() []*Shard

	Close()
}

// sharedResolver puts every institution on one shard.
type sharedResolver struct{ shard *Shard }

// NewSharedResolver places every tenant on a single shard. This is the
// production configuration and the one to keep until a commercial or
// operational requirement -- not a hypothetical one -- justifies splitting a
// specific school out. One well-run Postgres is easier to operate than ten.
func NewSharedResolver(s *Shard) Resolver { return &sharedResolver{shard: s} }

func (r *sharedResolver) ForTenant(context.Context, uuid.UUID) (*Shard, error) {
	return r.shard, nil
}
func (r *sharedResolver) Control(context.Context) (*Shard, error) { return r.shard, nil }
func (r *sharedResolver) Shards() []*Shard                        { return []*Shard{r.shard} }
func (r *sharedResolver) Close()                                  { r.shard.pool.Close() }

// OpenShard dials one database and verifies it answers.
func OpenShard(ctx context.Context, name, url string, maxConns int32) (*Shard, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DSN for shard %s: %w", name, err)
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
		return nil, fmt.Errorf("connect shard %s: %w", name, err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping shard %s: %w", name, err)
	}
	return &Shard{Name: name, pool: pool}, nil
}

// inTenant runs fn inside a transaction on this shard whose GUCs are set for
// the scope.
//
// SET LOCAL is deliberate: it is scoped to the transaction, so the setting
// cannot leak to the next request that borrows this pooled connection. Doing
// this with a plain SET on an acquired connection is the classic way to hand
// tenant A's data to tenant B after a mid-request error skips the reset.
func (s *Shard) inTenant(ctx context.Context, sc Scope, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

	admin := "off"
	if sc.PlatformAdmin {
		admin = "on"
	}
	// set_config with parameters, not string interpolation into SET LOCAL --
	// SET LOCAL does not accept placeholders, and the value is a UUID from the
	// session record, but interpolating it would still be an injection sink.
	inst := ""
	if sc.InstitutionID != uuid.Nil {
		inst = sc.InstitutionID.String()
	}
	/* The clock, as well as the tenant.

	   Every to_char over a timestamptz renders in the SESSION timezone, and the
	   server's is UTC. So a notification written at 16:22 IST was sent to the
	   browser as the string "10:52" with no zone on it, the browser read that
	   as local time, and a parent saw a message arrive five and a half hours
	   before it was written. Same for every date this product formats in SQL —
	   which, near midnight, moves things onto the wrong day entirely.

	   Set here rather than fixed at each query because there are hundreds of
	   them and the next one written would have the same hole. LOCAL, so it
	   lasts the transaction: a pooled connection handed on afterwards is
	   unchanged.

	   Asia/Kolkata rather than a per-school setting: this product is sold into
	   Indian schools, every date it prints is an Indian date, and a timezone
	   column nobody sets would just be UTC wearing a different name. */
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.institution_id', $1, true),
		        set_config('app.is_platform_admin', $2, true),
		        set_config('timezone', 'Asia/Kolkata', true)`,
		inst, admin); err != nil {
		return fmt.Errorf("set tenant scope: %w", err)
	}

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Shard) ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := s.pool.Ping(ctx); err != nil {
		return fmt.Errorf("shard %s: %w", s.Name, err)
	}
	return nil
}
