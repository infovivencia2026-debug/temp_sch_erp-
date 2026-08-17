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
	env := Envelope{InstitutionID: institutionID}

	entries := []struct {
		spec    string
		typ     string
		payload any
		opts    []asynq.Option
	}{
		// 00:30 — roll up the day that just closed.
		{"30 0 * * *", TypeAttendanceRollup,
			AttendanceRollupPayload{Envelope: env}, Options(QueueLow, 3, 10*time.Minute)},
		// 09:00 — reminders during office hours, never overnight.
		{"0 9 * * *", TypeFeeReminderFanout,
			FeeReminderFanoutPayload{Envelope: env, TemplateKey: "fee.overdue"}, HeavyOptions()},
		// 03:00 Sunday — housekeeping in the quietest window.
		{"0 3 * * 0", TypeSessionPrune, Envelope{}, Options(QueueLow, 2, 5*time.Minute)},
	}

	for _, e := range entries {
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

func (s *Scheduler) Start() error { return s.s.Start() }
func (s *Scheduler) Shutdown()    { s.s.Shutdown() }
