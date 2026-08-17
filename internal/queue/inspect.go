package queue

import (
	"context"
	"errors"
	"fmt"

	"github.com/hibiken/asynq"
)

// Inspector answers "what happened to my job?".
//
// A heavy request returns 202 with a job id; the SPA then polls this. Without
// it the only honest answer after the request returns is "unknown", which
// pushes users into re-submitting an import that is already running.
type Inspector struct{ i *asynq.Inspector }

func NewInspector(redisURL string) (*Inspector, error) {
	opt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	return &Inspector{i: asynq.NewInspector(opt)}, nil
}

func (n *Inspector) Close() error { return n.i.Close() }

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

// notFound reports whether err means "no such task/queue".
//
// GetTaskInfo wraps the exported sentinels, so errors.Is works there. Note that
// GetQueueInfo does *not*: it returns rdb's QueueNotFoundError unwrapped, and
// that type lives in asynq/internal/errors so it cannot be matched by type
// either. Stats avoids the problem by listing queues first rather than probing.
func notFound(err error) bool {
	return errors.Is(err, asynq.ErrTaskNotFound) || errors.Is(err, asynq.ErrQueueNotFound)
}

// Find looks the task up across the queues it could plausibly be in. asynq
// indexes tasks per queue, so there is no global lookup by id.
func (n *Inspector) Find(_ context.Context, id string) (*JobStatus, error) {
	for _, q := range []string{QueueCritical, QueueDefault, QueueBulk, QueueLow} {
		info, err := n.i.GetTaskInfo(q, id)
		if err != nil {
			if notFound(err) {
				continue
			}
			return nil, fmt.Errorf("inspect %s: %w", q, err)
		}
		return &JobStatus{
			ID:        info.ID,
			Type:      info.Type,
			State:     info.State.String(),
			Queue:     info.Queue,
			Retried:   info.Retried,
			MaxRetry:  info.MaxRetry,
			LastError: info.LastErr,
		}, nil
	}
	return nil, ErrJobNotFound
}

// Stats powers an ops view: depth per queue, so a growing bulk backlog is
// visible before users start reporting that exports never arrive.
func (n *Inspector) Stats(_ context.Context) (map[string]*asynq.QueueInfo, error) {
	// Queues() reports what Redis actually knows about. A queue that has never
	// received a task does not exist yet, and GetQueueInfo on it is an error
	// rather than an empty result -- so ask first, then fill the gaps with
	// zeros. That keeps the ops view stable instead of having rows appear and
	// vanish as traffic comes and goes.
	known, err := n.i.Queues()
	if err != nil {
		return nil, fmt.Errorf("list queues: %w", err)
	}
	exists := make(map[string]bool, len(known))
	for _, q := range known {
		exists[q] = true
	}

	out := map[string]*asynq.QueueInfo{}
	for _, q := range []string{QueueCritical, QueueDefault, QueueBulk, QueueLow} {
		if !exists[q] {
			out[q] = &asynq.QueueInfo{Queue: q}
			continue
		}
		info, err := n.i.GetQueueInfo(q)
		if err != nil {
			return nil, fmt.Errorf("queue info %s: %w", q, err)
		}
		out[q] = info
	}
	return out, nil
}
