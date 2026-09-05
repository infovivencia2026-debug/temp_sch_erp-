package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

/*
Postgres keeps the hits in one table, so every instance counts the same ones.

	The table is rate_limit_hits (migration 00251): scope, subject, hit_at, one
	row per allowed attempt, and nothing else. No RLS -- a caller's address is
	not a tenant's row -- and no id, because nothing ever addresses a hit; they
	are counted and they are swept.

	Each decision is one short transaction holding an advisory lock on the
	(scope, subject) pair. The lock is what makes count-then-insert honest:
	without it two instances could each count five, each insert a sixth, and
	the limit of six would be seven. pg_advisory_xact_lock releases with the
	transaction, so there is no lock to leak and nothing to clean up after a
	crash.

	The time is the caller's, not now(). Every store must give the same answer
	to the same timeline for the tests to mean anything, and a handler's clock
	is the one thing the tests must be able to replace. It also means a fleet
	whose clocks disagree by a second limits a second differently, which is
	acceptable in a way that untestable code is not.

	Sweeping is opportunistic and scope-wide, the same shape as the memory
	store's one-entry sweep: each hit deletes what its own window has already
	stopped counting. A sliding scope drops every row older than the window; a
	fixed scope drops every subject whose window has closed, whole, because a
	fixed window is defined by its oldest row and deleting only some of a
	subject's rows would move the window it is in. The table therefore holds at
	most Burst rows per active subject and nothing for anybody who has gone
	quiet, without a reaper.
*/
type Postgres struct {
	// Run executes fn in a transaction and commits when it returns nil. In the
	// server it is (*database.DB).AsPlatform, whose GUCs this table ignores;
	// in a test it can be anything that begins a transaction.
	Run func(ctx context.Context, fn func(pgx.Tx) error) error
}

// NewPostgres wraps a transaction runner.
func NewPostgres(run func(ctx context.Context, fn func(pgx.Tx) error) error) *Postgres {
	return &Postgres{Run: run}
}

// Hit implements Store.
func (s *Postgres) Hit(ctx context.Context, scope, key string, p Policy, now time.Time) (bool, time.Duration, error) {
	var ok bool
	var retry time.Duration
	err := s.Run(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, scope, key); err != nil {
			return fmt.Errorf("rate limit lock: %w", err)
		}
		var err error
		if p.Fixed {
			ok, retry, err = fixedSQL(ctx, tx, scope, key, p, now)
		} else {
			ok, retry, err = slidingSQL(ctx, tx, scope, key, p, now)
		}
		return err
	})
	if err != nil {
		return false, 0, err
	}
	return ok, retry, nil
}

// slidingSQL mirrors Memory's sliding log: a hit older than or equal to the
// cutoff has left the window, and the oldest hit still inside it is when the
// window reopens.
func slidingSQL(ctx context.Context, tx pgx.Tx, scope, key string, p Policy, now time.Time) (bool, time.Duration, error) {
	cutoff := now.Add(-p.Window)
	if _, err := tx.Exec(ctx,
		`DELETE FROM rate_limit_hits WHERE scope = $1 AND hit_at <= $2`, scope, cutoff); err != nil {
		return false, 0, fmt.Errorf("rate limit sweep: %w", err)
	}
	var count int
	var oldest *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT count(*), min(hit_at) FROM rate_limit_hits WHERE scope = $1 AND subject = $2`,
		scope, key).Scan(&count, &oldest); err != nil {
		return false, 0, fmt.Errorf("rate limit count: %w", err)
	}
	if count >= p.burst() {
		return false, oldest.Sub(cutoff), nil
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO rate_limit_hits (scope, subject, hit_at) VALUES ($1, $2, $3)`,
		scope, key, now); err != nil {
		return false, 0, fmt.Errorf("rate limit record: %w", err)
	}
	return true, 0, nil
}

// fixedSQL mirrors Memory's fixed window: the oldest row is when the window
// opened, and a hit at or past its close opens a new one.
func fixedSQL(ctx context.Context, tx pgx.Tx, scope, key string, p Policy, now time.Time) (bool, time.Duration, error) {
	closedBefore := now.Add(-p.Window)
	if _, err := tx.Exec(ctx, `
		DELETE FROM rate_limit_hits
		 WHERE scope = $1
		   AND subject IN (SELECT subject FROM rate_limit_hits
		                    WHERE scope = $1 GROUP BY subject HAVING min(hit_at) <= $2)`,
		scope, closedBefore); err != nil {
		return false, 0, fmt.Errorf("rate limit sweep: %w", err)
	}
	var count int
	var started *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT count(*), min(hit_at) FROM rate_limit_hits WHERE scope = $1 AND subject = $2`,
		scope, key).Scan(&count, &started); err != nil {
		return false, 0, fmt.Errorf("rate limit count: %w", err)
	}
	if count > 0 && count >= p.burst() {
		return false, p.Window - now.Sub(*started), nil
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO rate_limit_hits (scope, subject, hit_at) VALUES ($1, $2, $3)`,
		scope, key, now); err != nil {
		return false, 0, fmt.Errorf("rate limit record: %w", err)
	}
	return true, 0, nil
}
