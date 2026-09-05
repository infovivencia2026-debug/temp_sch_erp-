package queue

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/robfig/cron/v3"

	"github.com/school-erp/erp/internal/database"
)

/*
Cron, without a process that never stops.

	asynq's scheduler lived inside the worker: one goroutine holding the
	schedule in memory, elected through Redis, ticking every minute for as
	long as the process ran. That is a fine design for a box with systemd and
	a bad one for a platform that stops the container when nothing is
	happening -- the scheduler would stop with it, and the 09:00 fee
	reminders would go out whenever somebody next opened the app.

	So the tick is a request. GET or POST /api/v1/cron, carrying X-Cron-Key,
	asks "what has come due since you were last asked?", enqueues it, and
	answers with counts. Whoever calls it -- Cloud Scheduler, a systemd timer,
	a curl in a crontab -- owns the clock; this package owns the schedule and
	the memory of when each entry last ran, which is a row per entry in
	cron_runs. Because the memory is in the database, the caller can be
	anything and can be more than one thing: two callers a second apart
	serialise on an advisory lock and the second finds nothing due.

	The worker keeps an in-process fallback, CRON_INPROCESS=1, which runs the
	same Tick every minute from a goroutine. That is what the VPS does today
	and it changes nothing there: same schedule, same table, same jobs.

	Missed time collapses. A schedule that was due four times while nobody
	called runs once, not four times, because every entry here is a sweep
	over current state -- "flush what is queued", "close what has gone quiet",
	"chase what is overdue" -- and running yesterday's sweep today would do
	today's work and then do it again.
*/

// Schedule is one recurring entry.
type Schedule struct {
	// Name is the stable key in cron_runs. Renaming one forgets when it last
	// ran, which for a daily entry means it fires at the next occurrence
	// rather than at once -- harmless, but do it knowingly.
	Name string
	// Spec is a standard five-field cron expression, read in the
	// institution's timezone for per-institution entries and in the oldest
	// active institution's for global ones.
	Spec string
	Kind string
	// PerInstitution entries run once per active school, each in that
	// school's own timezone and with its id in the envelope. Global entries
	// run once for the whole installation with an empty envelope.
	PerInstitution bool
	// Payload builds the job body for the envelope it will run under.
	Payload func(env Envelope) any
	Opts    []Option
}

// Schedules is the built-in schedule, as data rather than as registrations,
// so a test can assert what runs and how often without a database. The bug
// this shape was introduced for was an absent entry, not a broken one --
// exactly the class of mistake that is invisible until something enumerates
// the list.
func Schedules() []Schedule {
	return []Schedule{
		// 00:30 — roll up the day that just closed.
		{Name: "attendance_rollup", Spec: "30 0 * * *", Kind: TypeAttendanceRollup, PerInstitution: true,
			Payload: func(env Envelope) any { return AttendanceRollupPayload{Envelope: env} },
			Opts:    Options(QueueLow, 3, 10*time.Minute)},
		// 09:00 — reminders during office hours, never overnight.
		{Name: "fee_reminders", Spec: "0 9 * * *", Kind: TypeFeeReminderFanout, PerInstitution: true,
			Payload: func(env Envelope) any {
				return FeeReminderFanoutPayload{Envelope: env, TemplateKey: "fee.overdue"}
			},
			Opts: HeavyOptions()},
		// 03:00 Sunday — housekeeping in the quietest window.
		{Name: "session_prune", Spec: "0 3 * * 0", Kind: TypeSessionPrune,
			Payload: func(Envelope) any { return Envelope{} },
			Opts:    Options(QueueLow, 2, 5*time.Minute)},

		/* Every 5 minutes — diary reminders that have come due.

		   The same interval as the dispatch below, for the same reason: a
		   child who asked to be reminded at 16:00 is reminded by 16:05, and a
		   tick that finds nothing is one indexed query over a partial index
		   holding only unsent reminders. Not a daily entry — this produces no
		   work at a time of day, it delivers work somebody scheduled for any
		   time of day.

		   Global: the sweep runs across every school in one pass, because a
		   per-institution entry would run the same query ten times to find
		   the same nothing. */
		{Name: "diary_reminders", Spec: "*/5 * * * *", Kind: TypeDiaryReminders,
			Payload: func(Envelope) any { return Envelope{} },
			Opts:    Options(QueueDefault, 3, 2*time.Minute)},

		/* Every minute — flush message_log.

		   Not a daily entry like the three above, because this one does not
		   produce work at a time of day; it drains work other things produced
		   at any time of day. Until it existed nothing ever selected a queued
		   row, so every trigger rule in the product queued correctly and
		   delivered nothing.

		   QueueDefault rather than QueueLow: a parent waiting on a reminder is
		   waiting on it now. Timeout comfortably exceeds 50 sends at the
		   dispatcher's own 20-second per-send deadline in the worst case
		   where every one of them hangs, because a task killed mid-drain
		   leaves the rows it had not reached queued -- correct, but a tick
		   wasted. */
		{Name: "message_dispatch", Spec: "* * * * *", Kind: TypeMessageDispatch, PerInstitution: true,
			Payload: func(env Envelope) any { return MessageDispatchPayload{Envelope: env, Limit: 50} },
			Opts:    Options(QueueDefault, 3, 10*time.Minute)},

		/* Every 15 minutes — fill message_log from the reminder plans.

		   The other half of the pipe the entry above drains. A plan is a
		   standing policy rather than an event, so nothing pushes it: an
		   invoice does not announce that it has become 23 days overdue, and a
		   register marked at 10:40 does not announce that a child is still
		   absent at 11:30. Somebody has to come back and look, and this is
		   that somebody.

		   Fifteen rather than five because a plan's occurrences change on the
		   scale of a school morning, not a minute, and each tick is a scan of
		   the overdue invoices and today's absences for one institution --
		   real work, unlike a dispatch tick that usually finds nothing.

		   Safe to run twice, and that is not incidental. Every occurrence key
		   a plan produces is derived from the data rather than counted -- the
		   chase number from the days overdue, the absence from the child and
		   the date -- so a retry firing beside the next tick writes the same
		   keys and the one-per-occurrence index refuses the second copy. */
		{Name: "message_plans", Spec: "*/15 * * * *", Kind: TypeMessagePlans, PerInstitution: true,
			Payload: func(env Envelope) any { return MessagePlansPayload{Envelope: env} },
			Opts:    Options(QueueDefault, 3, 10*time.Minute)},
	}
}

// --- the tick ---------------------------------------------------------------

// Cron ties a schedule to the database that remembers it and the queue that
// runs it. Zero-value fields are not supported; api and cmd/worker build it
// with all three.
type Cron struct {
	DB        *database.DB
	Queue     *Client
	Schedules []Schedule
	// Now is the clock, replaceable in tests. Nil means time.Now.
	Now func() time.Time
}

// TickResult is what a tick reports back to whoever called it.
type TickResult struct {
	// Checked is how many (schedule, target) pairs were evaluated: global
	// entries count once, per-institution ones once per active school.
	Checked int `json:"checked"`
	// Enqueued is how many jobs this tick inserted.
	Enqueued int `json:"enqueued"`
	// Started is how many entries were seen for the first time and given a
	// baseline without running. Non-zero right after a deploy or a new
	// school, zero otherwise.
	Started int `json:"started"`
	// Institutions is how many active schools the per-institution entries
	// fanned out over.
	Institutions int `json:"institutions"`
	// Kinds counts enqueued jobs by task type, for the caller's log line.
	Kinds map[string]int `json:"kinds,omitempty"`
	At    time.Time      `json:"at"`
}

/*
Tick evaluates every entry once and enqueues what has come due.

	One transaction, under an advisory lock, so concurrent callers -- a
	scheduler retrying a slow response beside the original, or the
	in-process fallback beside an external one during a cut-over -- take
	turns, and the second sees the first's bookkeeping and does nothing. The
	job insert and the last-run update commit together: a tick that inserts
	and then fails to record would run the entry again next minute, and a
	tick that records and then fails to insert would lose the run. Neither
	can happen when they are one COMMIT.

	First sight of an entry sets its baseline to now without running it. A
	fresh deploy therefore runs the every-minute entries a minute later and
	the daily ones at their next time, exactly as asynq's scheduler did on a
	restart, instead of firing everything at once because nothing had ever
	run.
*/
func (c *Cron) Tick(ctx context.Context) (TickResult, error) {
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	res := TickResult{Kinds: map[string]int{}, At: now.UTC()}

	err := c.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('cron_tick'))`); err != nil {
			return fmt.Errorf("cron lock: %w", err)
		}

		insts, err := activeInstitutions(ctx, tx)
		if err != nil {
			return err
		}
		res.Institutions = len(insts)
		// Global entries follow the oldest school's clock, as the worker's
		// scheduler always did: a fleet of Indian schools wants 03:00 IST,
		// and a fleet with none wants UTC.
		globalTZ := time.UTC
		if len(insts) > 0 {
			globalTZ = insts[0].loc
		}

		last, err := lastRuns(ctx, tx)
		if err != nil {
			return err
		}

		for _, s := range c.Schedules {
			targets := []target{{key: s.Name, loc: globalTZ}}
			if s.PerInstitution {
				targets = targets[:0]
				for _, i := range insts {
					targets = append(targets, target{key: s.Name + ":" + i.id.String(), loc: i.loc, inst: i.id})
				}
			}
			for _, t := range targets {
				res.Checked++
				prev, seen := last[t.key]
				fire, err := due(s.Spec, prev, seen, now, t.loc)
				if err != nil {
					return fmt.Errorf("schedule %s: %w", s.Name, err)
				}
				if !seen {
					res.Started++
				}
				if _, err := tx.Exec(ctx, `
					INSERT INTO cron_runs (name, last_run_at)
					VALUES ($1, $2)
					ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
					t.key, now); err != nil {
					return fmt.Errorf("record %s: %w", t.key, err)
				}
				if !fire {
					continue
				}
				env := Envelope{InstitutionID: t.inst, JobID: uuid.New()}
				if _, err := c.Queue.EnqueueTx(ctx, tx, s.Kind, s.Payload(env), s.Opts...); err != nil {
					return err
				}
				res.Enqueued++
				res.Kinds[s.Kind]++
			}
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	if res.Enqueued > 0 || res.Started > 0 {
		slog.Info("cron tick", "checked", res.Checked, "enqueued", res.Enqueued,
			"started", res.Started, "kinds", res.Kinds)
	}
	return res, nil
}

// Run is the in-process fallback: Tick every interval until ctx ends. A tick
// that fails is logged and the next one tries again; the schedule is in the
// database, so nothing is lost by a miss.
func (c *Cron) Run(ctx context.Context, every time.Duration) {
	slog.Info("cron running in-process", "every", every)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if _, err := c.Tick(ctx); err != nil && ctx.Err() == nil {
			slog.Error("cron tick failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

/*
due decides whether one entry fires on this tick.

	The question is not "does the spec match now?" -- a tick that arrives at
	09:00:40 must still fire the 09:00 entry, and a scheduler that was down
	from 08:55 to 09:10 must fire it once when it returns. It is "has an
	occurrence passed since the last time this ran?", which is one call to
	the parsed spec's Next from the last run, in the entry's timezone. Never
	seen means baseline only.
*/
func due(spec string, last time.Time, seen bool, now time.Time, loc *time.Location) (bool, error) {
	sched, err := parseSpec(spec)
	if err != nil {
		return false, err
	}
	if !seen {
		return false, nil
	}
	next := sched.Next(last.In(loc))
	return !next.After(now), nil
}

var (
	specMu    sync.Mutex
	specCache = map[string]cron.Schedule{}
)

// parseSpec parses a five-field expression once and remembers it; a tick
// evaluates each spec once per school, every minute, and the parser is not
// free.
func parseSpec(spec string) (cron.Schedule, error) {
	specMu.Lock()
	defer specMu.Unlock()
	if s, ok := specCache[spec]; ok {
		return s, nil
	}
	s, err := cron.ParseStandard(spec)
	if err != nil {
		return nil, fmt.Errorf("parse cron spec %q: %w", spec, err)
	}
	specCache[spec] = s
	return s, nil
}

type target struct {
	key  string
	loc  *time.Location
	inst uuid.UUID
}

type institution struct {
	id  uuid.UUID
	loc *time.Location
}

// activeInstitutions is who the per-institution entries fan out over, oldest
// first, each with its timezone loaded. A timezone the host cannot load is
// logged and treated as UTC rather than taking every school's schedule down
// with it.
func activeInstitutions(ctx context.Context, tx pgx.Tx) ([]institution, error) {
	rows, err := tx.Query(ctx,
		`SELECT id, timezone FROM institutions WHERE status = 'active' ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("active institutions: %w", err)
	}
	defer rows.Close()
	var out []institution
	for rows.Next() {
		var i institution
		var tz string
		if err := rows.Scan(&i.id, &tz); err != nil {
			return nil, err
		}
		i.loc = loadLocation(tz)
		out = append(out, i)
	}
	return out, rows.Err()
}

var (
	locMu    sync.Mutex
	locCache = map[string]*time.Location{}
)

func loadLocation(tz string) *time.Location {
	locMu.Lock()
	defer locMu.Unlock()
	if l, ok := locCache[tz]; ok {
		return l
	}
	l, err := time.LoadLocation(tz)
	if err != nil {
		slog.Error("institution timezone unusable; scheduling in UTC", "timezone", tz, "error", err)
		l = time.UTC
	}
	locCache[tz] = l
	return l
}

func lastRuns(ctx context.Context, tx pgx.Tx) (map[string]time.Time, error) {
	rows, err := tx.Query(ctx, `SELECT name, last_run_at FROM cron_runs`)
	if err != nil {
		return nil, fmt.Errorf("cron runs: %w", err)
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var name string
		var at time.Time
		if err := rows.Scan(&name, &at); err != nil {
			return nil, err
		}
		out[name] = at
	}
	return out, rows.Err()
}
