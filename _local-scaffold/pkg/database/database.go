// Package database owns the connection pool and the transaction helper.
//
// Two rules are enforced here rather than left to discipline:
//
//  1. Every transaction that touches tenant data binds the organisation onto the
//     connection with SET LOCAL, which is what the RLS policies read. A query
//     that forgets its WHERE clause returns nothing instead of another school's
//     students.
//
//  2. Services own transactions; repositories take a Tx and never open one. That
//     is what lets the audit row and the outbox event be written in the same
//     transaction as the business change.
package database

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tx is what repositories accept. Both pgx.Tx and *pgxpool.Pool satisfy it, so a
// repository method can also be called outside a transaction for a plain read.
type Tx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type DB struct {
	pool *pgxpool.Pool
}

func Connect(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 15 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Close()                         { d.pool.Close() }
func (d *DB) Pool() *pgxpool.Pool            { return d.pool }
func (d *DB) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

// InTx runs fn inside a transaction with no tenant bound. Use it only for
// genuinely cross-tenant work: login (which resolves a user before we know the
// organisation), migrations, and platform administration.
func InTx[T any](ctx context.Context, db *DB, fn func(Tx) (T, error)) (T, error) {
	return runTx(ctx, db, uuid.Nil, fn)
}

// InTenantTx runs fn inside a transaction with the organisation bound onto the
// connection, so every RLS policy in the schema applies to every statement fn
// issues. This is the normal path for request handling.
func InTenantTx[T any](ctx context.Context, db *DB, orgID uuid.UUID, fn func(Tx) (T, error)) (T, error) {
	if orgID == uuid.Nil {
		var zero T
		return zero, errors.New("database: InTenantTx called without an organisation")
	}
	return runTx(ctx, db, orgID, fn)
}

func runTx[T any](ctx context.Context, db *DB, orgID uuid.UUID, fn func(Tx) (T, error)) (T, error) {
	var zero T

	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return zero, fmt.Errorf("begin transaction: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			// Rolling back after a cancelled request still needs a live context.
			rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		}
	}()

	if orgID != uuid.Nil {
		// set_config(..., true) is SET LOCAL: with pgbouncer in transaction mode
		// the connection returns to the pool at commit carrying no tenant state.
		if _, err := tx.Exec(ctx, "SELECT set_config('app.organization_id', $1, true)", orgID.String()); err != nil {
			return zero, fmt.Errorf("bind tenant: %w", err)
		}
	}

	result, err := fn(tx)
	if err != nil {
		return zero, err
	}

	if err := tx.Commit(ctx); err != nil {
		return zero, fmt.Errorf("commit: %w", err)
	}
	committed = true
	return result, nil
}

// IsUniqueViolation reports whether err is a Postgres unique-constraint failure,
// optionally for a specific constraint. Services use it to turn a lost race into
// a clean 409 rather than a 500.
func IsUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	if constraint == "" {
		return true
	}
	// Postgres names the index for unique indexes and the constraint for table
	// constraints; accept either.
	return pgErr.ConstraintName == constraint || strings.Contains(pgErr.Message, constraint)
}

// IsForeignKeyViolation reports whether err is a Postgres FK failure.
func IsForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

// IsInsufficientPrivilege reports a permission failure from Postgres itself —
// which is how an attempt to UPDATE audit_logs surfaces.
func IsInsufficientPrivilege(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42501"
}

// NoRows reports whether the error is pgx's "no rows" sentinel.
func NoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
