package queue

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river/rivertype"
)

// Inspector answers "what happened to my job?".
//
// A heavy request returns 202 with a job id; the SPA then polls this. Without
// it the only honest answer after the request returns is "unknown", which
// pushes users into re-submitting an import that is already running.
//
// It reads river_job directly through the client's own pool rather than
// through River's JobGet/JobList, for two reasons: Stats wants one GROUP BY
// over the table rather than a list per state per queue, and the vocabulary
// the SPA speaks is asynq's, not River's, so the mapping has to live
// somewhere and a query that returns River's states to be translated in Go
// is the clearest place for it.
type Inspector struct{ c *Client }

// Inspector hands out the read side of the client. Held separately on
// api.Server because that is where it has always been; it is the same
// connection underneath.
func (c *Client) Inspector() *Inspector { return &Inspector{c: c} }

// JobStatus is what the poll returns. State uses the words the SPA was built
// against -- pending, active, scheduled, retry, archived, completed -- see
// stateName. Retried and MaxRetry keep asynq's arithmetic: retries after the
// first attempt, not attempts.
type JobStatus struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	State     string `json:"state"`
	Queue     string `json:"queue"`
	Retried   int    `json:"retried"`
	MaxRetry  int    `json:"max_retry"`
	LastError string `json:"last_error,omitempty"`
}

var ErrJobNotFound = errors.New("job not found")

/*
stateName maps River's states onto the vocabulary the screens show.

	The SPA stops polling on "completed" or "archived" and colours the rest,
	and the platform's queue-depth table has a column per asynq state. Those
	screens were right about what an operator needs to see and wrong about
	nothing, so they stay, and this is the translation:

	  available  -> pending    waiting for a worker
	  running    -> active
	  scheduled  -> scheduled  not yet due
	  pending    -> scheduled  River's "held", which nothing here uses
	  retryable  -> retry      failed, will try again
	  discarded  -> archived   gave up; the one an operator most needs
	  cancelled  -> archived   given up on purpose (SkipRetry lands here)
	  completed  -> completed
*/
func stateName(s rivertype.JobState) string {
	switch s {
	case rivertype.JobStateAvailable:
		return "pending"
	case rivertype.JobStateRunning:
		return "active"
	case rivertype.JobStateScheduled, rivertype.JobStatePending:
		return "scheduled"
	case rivertype.JobStateRetryable:
		return "retry"
	case rivertype.JobStateDiscarded, rivertype.JobStateCancelled:
		return "archived"
	case rivertype.JobStateCompleted:
		return "completed"
	}
	return string(s)
}

// Find looks one job up by the id Enqueue returned. Anything that does not
// parse as one of River's ids is simply not found, which is also the honest
// answer for an asynq-era id a client kept polling across the migration.
func (n *Inspector) Find(ctx context.Context, id string) (*JobStatus, error) {
	rid, err := strconv.ParseInt(id, 10, 64)
	if err != nil || rid <= 0 {
		return nil, ErrJobNotFound
	}
	var (
		st      JobStatus
		state   string
		attempt int
		maxAtt  int
		lastErr *string
	)
	err = n.c.pool.QueryRow(ctx, `
		SELECT kind, state::text, queue, attempt, max_attempts,
		       (errors[array_length(errors, 1)])->>'error'
		  FROM river_job
		 WHERE id = $1`, rid).
		Scan(&st.Type, &state, &st.Queue, &attempt, &maxAtt, &lastErr)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrJobNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("inspect job %d: %w", rid, err)
	}
	st.ID = id
	st.State = stateName(rivertype.JobState(state))
	// River's attempt counts the one in flight or the last one made; asynq's
	// Retried counted attempts after the first. Keep the SPA's arithmetic.
	st.Retried = max(attempt-1, 0)
	st.MaxRetry = max(maxAtt-1, 0)
	if lastErr != nil {
		st.LastError = *lastErr
	}
	return &st, nil
}

// QueueStats is one queue's depth, in the columns the ops screens have.
//
// Size is the backlog -- everything not finished -- exactly as asynq defined
// it (pending + active + scheduled + retry + archived). Processed and Failed
// were daily counters under asynq that reset at midnight; here they are what
// is still within retention, which for completed is a day and for archived a
// week, so the numbers are of the same order and the columns keep their
// meaning without a separate counter table.
type QueueStats struct {
	Queue     string `json:"queue"`
	Size      int    `json:"size"`
	Pending   int    `json:"pending"`
	Active    int    `json:"active"`
	Scheduled int    `json:"scheduled"`
	Retry     int    `json:"retry"`
	Archived  int    `json:"archived"`
	Completed int    `json:"completed"`
	Processed int    `json:"processed"`
	Failed    int    `json:"failed"`
	Paused    bool   `json:"paused"`
	Priority  int    `json:"priority"`
}

// Stats powers an ops view: depth per queue, so a growing bulk backlog is
// visible before users start reporting that exports never arrive. Every one
// of the four queues is always present, zeroed when empty, so rows do not
// appear and vanish as traffic comes and goes.
func (n *Inspector) Stats(ctx context.Context) (map[string]*QueueStats, error) {
	out := make(map[string]*QueueStats, len(Queues))
	for _, q := range Queues {
		out[q] = &QueueStats{Queue: q, Priority: Priorities[q]}
	}

	// One pass over the table. It is bounded by retention -- a day of
	// completed jobs, a week of failures, and whatever is waiting -- and the
	// (state, queue) prefix of River's fetching index serves the grouping.
	rows, err := n.c.pool.Query(ctx,
		`SELECT queue, state::text, count(*) FROM river_job GROUP BY queue, state`)
	if err != nil {
		return nil, fmt.Errorf("queue stats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var q, state string
		var n int
		if err := rows.Scan(&q, &state, &n); err != nil {
			return nil, err
		}
		s, ok := out[q]
		if !ok {
			// A queue this build does not know -- a job inserted by hand, or a
			// name from a newer deploy. Shown rather than hidden.
			s = &QueueStats{Queue: q}
			out[q] = s
		}
		switch stateName(rivertype.JobState(state)) {
		case "pending":
			s.Pending += n
		case "active":
			s.Active += n
		case "scheduled":
			s.Scheduled += n
		case "retry":
			s.Retry += n
		case "archived":
			s.Archived += n
			s.Failed += n
		case "completed":
			s.Completed += n
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	prows, err := n.c.pool.Query(ctx, `SELECT name FROM river_queue WHERE paused_at IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("paused queues: %w", err)
	}
	defer prows.Close()
	for prows.Next() {
		var q string
		if err := prows.Scan(&q); err != nil {
			return nil, err
		}
		if s, ok := out[q]; ok {
			s.Paused = true
		}
	}
	if err := prows.Err(); err != nil {
		return nil, err
	}

	for _, s := range out {
		s.Size = s.Pending + s.Active + s.Scheduled + s.Retry + s.Archived
		s.Processed = s.Completed + s.Archived
	}
	return out, nil
}

// Health is what a /healthz can ask: can the queue's own pool reach the
// database. Bounded so a wedged pool is a 503, not a hung probe.
func (c *Client) Health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return c.pool.Ping(ctx)
}
