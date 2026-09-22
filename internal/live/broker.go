// Package live fans events from writers to the open tabs that should see them.
//
// A message, a typing signal or a notification is produced inside a request
// on one Cloud Run instance and must reach a browser whose stream is held open
// by another. The one multi-instance primitive already in the stack is
// Postgres LISTEN/NOTIFY — the job queue wakes its workers with it — so that
// is the bus: a writer calls Publish inside the same transaction as its
// INSERT (NOTIFY is transactional, so an event fires only if the write
// commits), every instance holds one dedicated LISTEN connection, and each
// instance hands the event to whichever of its own subscribers it names.
//
// Deliberately no Redis: the codebase has removed it three times over, and a
// second datastore is a second thing to run out of connections on.
//
// An event is a hint, not a record. It says "something for you changed in
// this thread"; the client then refetches through the ordinary API, so a
// dropped event costs a few seconds of staleness (the 30s revision poll is
// still there) and never a lost message.
package live

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Channel is the Postgres NOTIFY channel every instance listens on.
const Channel = "erp_live"

// Event is what crosses the bus. Users names who should receive it; Keys
// carries whatever the client needs to refetch the right queries (thread
// ids, the peer, the child).
type Event struct {
	Institution uuid.UUID         `json:"inst"`
	Users       []uuid.UUID       `json:"users"`
	Type        string            `json:"type"`  // message | typing | notification
	Scope       string            `json:"scope"` // staff | parent | counselor | ""
	From        uuid.UUID         `json:"from"`
	Keys        map[string]string `json:"keys,omitempty"`
	At          time.Time         `json:"at"`
}

// Execer is the slice of pgx.Tx (or a pool) Publish needs.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Publish puts an event on the bus. Inside a transaction it is delivered only
// on commit, which is exactly the guarantee a writer wants. The payload is
// kept well under NOTIFY's 8000-byte limit by construction (ids and short
// keys, never message bodies).
func Publish(ctx context.Context, q Execer, ev Event) error {
	if ev.At.IsZero() {
		ev.At = time.Now()
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `SELECT pg_notify($1, $2)`, Channel, string(b))
	return err
}

// Broker is one instance's end of the bus: the LISTEN loop and the local
// subscribers it fans to.
type Broker struct {
	url  string
	mu   sync.Mutex
	subs map[uuid.UUID]map[chan Event]struct{}
}

// New prepares a broker for the given database URL. Run starts it.
func New(databaseURL string) *Broker {
	return &Broker{url: databaseURL, subs: map[uuid.UUID]map[chan Event]struct{}{}}
}

// Subscribe returns a channel that receives every event naming this user,
// and the function that ends the subscription. The channel is buffered and
// a slow reader drops events rather than blocking the bus: an event is a
// hint, and the client refetches on the next one (or on the poll).
func (b *Broker) Subscribe(user uuid.UUID) (<-chan Event, func()) {
	ch := make(chan Event, 16)
	b.mu.Lock()
	set := b.subs[user]
	if set == nil {
		set = map[chan Event]struct{}{}
		b.subs[user] = set
	}
	set[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		if set := b.subs[user]; set != nil {
			delete(set, ch)
			if len(set) == 0 {
				delete(b.subs, user)
			}
		}
		b.mu.Unlock()
	}
}

// Subscribers is how many streams this instance currently holds.
func (b *Broker) Subscribers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, set := range b.subs {
		n += len(set)
	}
	return n
}

func (b *Broker) fan(ev Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, u := range ev.Users {
		for ch := range b.subs[u] {
			select {
			case ch <- ev:
			default: // full: the reader is behind; it will refetch on the next event
			}
		}
	}
}

// Run holds one dedicated connection on LISTEN until ctx ends, reconnecting
// with a backoff when the connection drops. The connection is opened directly
// (not from the app's pool) so a stream never starves a request of a pooled
// connection, and so LISTEN's long wait never counts against pool limits.
func (b *Broker) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := b.listen(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("live: listener dropped, reconnecting", "err", err, "in", backoff)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
	}
}

func (b *Broker) listen(ctx context.Context) error {
	conn, err := pgx.Connect(ctx, b.url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "LISTEN "+Channel); err != nil {
		return err
	}
	slog.Info("live: listening", "channel", Channel)
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var ev Event
		if err := json.Unmarshal([]byte(n.Payload), &ev); err != nil {
			slog.Warn("live: bad payload", "err", err)
			continue
		}
		b.fan(ev)
	}
}
