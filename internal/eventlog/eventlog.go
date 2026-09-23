// Package eventlog keeps the process's own warnings and errors, per school.
//
// slog already writes every record to stdout as JSON, which is right for an
// operator with Cloud Logging open. It is the wrong place for the question a
// school asks two months later -- "what happened here on that afternoon" --
// because stdout knows nothing of tenants and Cloud Logging forgets in thirty
// days. So a handler here sits in front of the real one: every record still
// goes where it went, and WARN and above are also queued for app_events,
// stamped with the institution and user the request was serving.
//
// A LOG, NOT A LEDGER. Writes are batched from a bounded channel by one
// goroutine; if the sink falls behind, records are dropped and a counter says
// so, because a request must never wait on its own diagnostics. The database
// write is the platform's (AsPlatform): the row names its own institution.
package eventlog

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

type record struct {
	inst      *uuid.UUID
	user      *uuid.UUID
	requestID string
	level     string
	message   string
	attrs     map[string]any
	at        time.Time
}

// Sink is the background writer. One per process.
type Sink struct {
	db      *database.DB
	source  string
	queue   chan record
	dropped atomic.Int64
}

// Attach wraps the default slog handler so WARN+ records also reach
// app_events, and starts the writer. source is "web" or "worker".
func Attach(db *database.DB, source string) *Sink {
	s := &Sink{db: db, source: source, queue: make(chan record, 4096)}
	slog.SetDefault(slog.New(&handler{inner: slog.Default().Handler(), sink: s}))
	go s.run()
	return s
}

// Dropped is how many records the sink could not keep, for a health line.
func (s *Sink) Dropped() int64 { return s.dropped.Load() }

func (s *Sink) offer(r record) {
	select {
	case s.queue <- r:
	default:
		s.dropped.Add(1)
	}
}

// run drains the queue in batches: one INSERT per flush, at most every
// 500ms, so a burst of warnings is one round trip and a quiet process costs
// nothing.
func (s *Sink) run() {
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	var batch []record
	flush := func() {
		if len(batch) == 0 {
			return
		}
		b := batch
		batch = nil
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.db.AsPlatform(ctx, func(tx pgx.Tx) error {
			for _, r := range b {
				attrs, _ := json.Marshal(r.attrs)
				if _, err := tx.Exec(ctx, `
					INSERT INTO app_events (institution_id, user_id, request_id, source,
					                        level, message, attrs, at)
					VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8)`,
					r.inst, r.user, r.requestID, s.source, r.level, r.message, attrs, r.at); err != nil {
					return err
				}
			}
			return nil
		})
	}
	for {
		select {
		case r := <-s.queue:
			batch = append(batch, r)
			if len(batch) >= 200 {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}

// handler forwards everything to the real handler and tees WARN+ to the sink.
// WithAttrs/WithGroup keep the attrs slog would have printed, so the row
// carries what the line carried.
type handler struct {
	inner slog.Handler
	sink  *Sink
	attrs []slog.Attr
	group string
}

func (h *handler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.inner.Enabled(ctx, l)
}

func (h *handler) Handle(ctx context.Context, r slog.Record) error {
	err := h.inner.Handle(ctx, r)
	if r.Level < slog.LevelWarn {
		return err
	}
	rec := record{level: r.Level.String(), message: r.Message, at: r.Time, attrs: map[string]any{}}
	/* An error attr is stored as its sentence. json.Marshal of an error
	   value is "{}" -- the first evening of this table was a column of
	   empty braces where the reason should have been. */
	plain := func(v any) any {
		if e, ok := v.(error); ok {
			return e.Error()
		}
		return v
	}
	for _, a := range h.attrs {
		rec.attrs[a.Key] = plain(a.Value.Any())
	}
	r.Attrs(func(a slog.Attr) bool {
		rec.attrs[a.Key] = plain(a.Value.Any())
		return true
	})
	/* The tenant comes from the request the record was emitted under, when
	   the caller passed its context (slog.WarnContext). A record with no
	   context is still kept, stamped for the platform, with whatever
	   "institution"/"institution_id" attribute the caller wrote by hand. */
	if id := httpx.IdentityFrom(ctx); id != nil {
		if id.InstitutionID != uuid.Nil {
			v := id.InstitutionID
			rec.inst = &v
		}
		if id.UserID != uuid.Nil {
			u := id.UserID
			rec.user = &u
		}
		rec.requestID = httpx.RequestIDFrom(ctx)
	}
	if rec.inst == nil {
		for _, k := range []string{"institution_id", "institution", "inst"} {
			if v, ok := rec.attrs[k]; ok {
				if u, err := uuid.Parse(asString(v)); err == nil && u != uuid.Nil {
					rec.inst = &u
					break
				}
			}
		}
	}
	h.sink.offer(rec)
	return err
}

func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case uuid.UUID:
		return x.String()
	case *uuid.UUID:
		if x != nil {
			return x.String()
		}
	}
	return ""
}

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &handler{inner: h.inner.WithAttrs(attrs), sink: h.sink,
		attrs: append(append([]slog.Attr(nil), h.attrs...), attrs...), group: h.group}
}

func (h *handler) WithGroup(name string) slog.Handler {
	return &handler{inner: h.inner.WithGroup(name), sink: h.sink, attrs: h.attrs, group: name}
}
