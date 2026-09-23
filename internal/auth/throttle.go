package auth

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

// --- login throttling --------------------------------------------------------

/*
Throttle rate-limits failed sign-ins per identifier.

	The count lives in Postgres (login_throttle) so that every instance of the
	service and every restart agree on it. It was in process memory, which
	was fine on one VPS and is not fine on Cloud Run: a new instance, or a
	restart, forgot the count, so eight guesses, wait for a restart, eight
	more. The memory map is kept as the fallback for when the database call
	itself fails -- the failure mode of "database down locks everyone out" is
	worse than "one instance briefly counts on its own". Successful logins
	reset immediately, so a legitimate user who mistypes twice is never
	delayed.
*/
type Throttle struct {
	db       *database.DB
	mu       sync.Mutex
	attempts map[string]*attemptRecord
}

type attemptRecord struct {
	count     int
	lockedTil time.Time
	lastSeen  time.Time
}

const (
	maxFailedAttempts = 8
	lockoutDuration   = 5 * time.Minute
)

// NewThrottle builds a throttle. db may be nil (tests), in which case it
// counts in memory only.
func NewThrottle(db *database.DB) *Throttle {
	t := &Throttle{db: db, attempts: map[string]*attemptRecord{}}
	go t.reap()
	return t
}

// Allowed reports whether an identifier may attempt a sign-in, and how long
// they must wait if not.
func (t *Throttle) Allowed(ctx context.Context, identifier string) (bool, time.Duration) {
	if t.db != nil {
		var until *time.Time
		err := t.db.AsPlatform(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				`SELECT locked_until FROM login_throttle WHERE identifier = $1`, identifier).Scan(&until)
		})
		switch {
		case err == nil:
			if until != nil && time.Now().Before(*until) {
				return false, time.Until(*until)
			}
			return true, 0
		case err == pgx.ErrNoRows:
			return true, 0
		default:
			slog.Warn("login throttle read failed; counting in memory", "error", err)
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.attempts[identifier]
	if !ok {
		return true, 0
	}
	if time.Now().Before(rec.lockedTil) {
		return false, time.Until(rec.lockedTil)
	}
	return true, 0
}

// Failed counts one wrong attempt and reports whether it tipped the
// identifier into a lockout -- the moment worth telling the principal about.
func (t *Throttle) Failed(ctx context.Context, identifier string) (locked bool) {
	return t.FailedN(ctx, identifier, maxFailedAttempts)
}

// FailedN is Failed with its own ceiling. The per-address count uses a higher
// one: a classroom NAT carries every teacher in the building, and eight wrong
// day codes between them in five minutes is a Monday, not an attack. Forty is
// not a Monday.
func (t *Throttle) FailedN(ctx context.Context, identifier string, max int) (locked bool) {
	if t.db != nil {
		err := t.db.AsPlatform(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				INSERT INTO login_throttle (identifier, failures, last_seen)
				VALUES ($1, 1, now())
				ON CONFLICT (identifier) DO UPDATE
				   SET failures = CASE WHEN login_throttle.failures + 1 >= $2 THEN 0
				                       ELSE login_throttle.failures + 1 END,
				       locked_until = CASE WHEN login_throttle.failures + 1 >= $2
				                           THEN now() + $3::interval
				                           ELSE login_throttle.locked_until END,
				       last_seen = now()
				RETURNING locked_until IS NOT NULL AND locked_until > now() AND failures = 0`,
				identifier, max, lockoutDuration.String()).Scan(&locked)
		})
		if err == nil {
			return locked
		}
		slog.Warn("login throttle write failed; counting in memory", "error", err)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.attempts[identifier]
	if !ok {
		rec = &attemptRecord{}
		t.attempts[identifier] = rec
	}
	rec.count++
	rec.lastSeen = time.Now()
	if rec.count >= max {
		rec.lockedTil = time.Now().Add(lockoutDuration)
		rec.count = 0
		return true
	}
	return false
}

func (t *Throttle) Succeeded(ctx context.Context, identifier string) {
	if t.db != nil {
		_ = t.db.AsPlatform(ctx, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `DELETE FROM login_throttle WHERE identifier = $1`, identifier)
			return err
		})
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.attempts, identifier)
}

// reap discards records nobody has touched, so a stuffing run against thousands
// of usernames cannot grow the map (or the table) without bound.
func (t *Throttle) reap() {
	for range time.Tick(10 * time.Minute) {
		cutoff := time.Now().Add(-30 * time.Minute)
		t.mu.Lock()
		for k, rec := range t.attempts {
			if rec.lastSeen.Before(cutoff) && time.Now().After(rec.lockedTil) {
				delete(t.attempts, k)
			}
		}
		t.mu.Unlock()
		if t.db != nil {
			_ = t.db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
				_, err := tx.Exec(context.Background(), `
					DELETE FROM login_throttle
					 WHERE last_seen < now() - interval '30 minutes'
					   AND (locked_until IS NULL OR locked_until < now())`)
				return err
			})
		}
	}
}
