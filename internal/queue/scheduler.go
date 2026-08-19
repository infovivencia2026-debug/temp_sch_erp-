package queue

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
)

// Scheduler owns recurring work. It runs inside the worker process, and asynq
// elects a single active scheduler through Redis, so scaling the worker to N
// replicas does not produce N copies of every nightly job.
type Scheduler struct{ s *asynq.Scheduler }

func NewScheduler(redisURL, tz string) (*Scheduler, error) {
	opt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("load timezone %q: %w", tz, err)
	}
	return &Scheduler{s: asynq.NewScheduler(opt, &asynq.SchedulerOpts{Location: loc})}, nil
}

// Register installs the cron entries. Times are in the institution's timezone
// (Asia/Kolkata in production), which is why the scheduler is constructed with
// an explicit Location rather than defaulting to the host's UTC.
func (s *Scheduler) Register(institutionID uuid.UUID) error {
	for _, e := range schedulerEntries(Envelope{InstitutionID: institutionID}) {
		b, err := json.Marshal(e.payload)
		if err != nil {
			return fmt.Errorf("marshal %s: %w", e.typ, err)
		}
		if _, err := s.s.Register(e.spec, asynq.NewTask(e.typ, b), e.opts...); err != nil {
			return fmt.Errorf("register %s: %w", e.typ, err)
		}
	}
	return nil
}

type cronEntry struct {
	spec    string
	typ     string
	payload any
	opts    []asynq.Option
}

// schedulerEntries is the schedule itself, separated from the act of
// registering it so a test can assert what runs and how often without a Redis
// to register against. The bug this package is being changed for was an
// absent entry, not a broken one, which is exactly the class of mistake that
// is invisible until something enumerates the list.
func schedulerEntries(env Envelope) []cronEntry {
	return []cronEntry{
		// 00:30 — roll up the day that just closed.
		{"30 0 * * *", TypeAttendanceRollup,
			AttendanceRollupPayload{Envelope: env}, Options(QueueLow, 3, 10*time.Minute)},
		// 09:00 — reminders during office hours, never overnight.
		{"0 9 * * *", TypeFeeReminderFanout,
			FeeReminderFanoutPayload{Envelope: env, TemplateKey: "fee.overdue"}, HeavyOptions()},
		// 03:00 Sunday — housekeeping in the quietest window.
		{"0 3 * * 0", TypeSessionPrune, Envelope{}, Options(QueueLow, 2, 5*time.Minute)},

		/* Every 5 minutes — flush message_log.

		   Not a daily entry like the three above, because this one does not
		   produce work at a time of day; it drains work other things produced
		   at any time of day. Until it existed nothing ever selected a queued
		   row, so every trigger rule in the product queued correctly and
		   delivered nothing.

		   Five minutes is the interval the two ends of the queue argue for. An
		   absence alert wants to reach a parent while the morning is still the
		   morning, which rules out hourly; a tick that finds nothing is one
		   indexed query on message_log_due, which is cheap enough that a
		   shorter interval buys nothing but noise. It also bounds the lateness
		   of a quiet-hours release: a row held to 09:00 goes out by 09:05
		   rather than waiting for a daily entry to come round.

		   QueueDefault rather than QueueLow: a parent waiting on a reminder is
		   waiting on it now, and the low queue is serviced least often of the
		   four. Timeout comfortably exceeds 50 sends at the dispatcher's own
		   20-second per-send deadline in the worst case where every one of
		   them hangs, because a task killed mid-drain leaves the rows it had
		   not reached queued -- correct, but a tick wasted. */
		{"*/5 * * * *", TypeMessageDispatch,
			MessageDispatchPayload{Envelope: env, Limit: 50},
			Options(QueueDefault, 3, 10*time.Minute)},
	}
}

func (s *Scheduler) Start() error { return s.s.Start() }
func (s *Scheduler) Shutdown()    { s.s.Shutdown() }
