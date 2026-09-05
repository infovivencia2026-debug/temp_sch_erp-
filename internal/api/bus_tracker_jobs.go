package api

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/queue"
)

/*
Background sweeps for live vehicle tracking.

	Both of these exist because the tracker is a phone in a driver's pocket
	rather than a wired unit, and a phone stops talking for reasons the server
	cannot distinguish: flat battery, no signal, the app killed by the OS, or
	the run simply finished and nobody pressed End. From here they all look
	the same -- silence -- and silence left alone becomes a trip that stays
	open forever, which a parent's map draws as a bus that is still coming.

	Neither sweep acts for a signed-in user, so both run AsPlatform across
	every institution. There is no request, no identity and no session to
	scope them to; the institution is a column they read, not a context they
	inherit.
*/

// Task type names are persisted in river_job.kind, so they are a wire format:
// renaming one strands whatever is already queued under the old name.
const (
	TypeTransportTripTimeout       = "transport:trip_timeout"
	TypeTransportPositionRetention = "transport:position_retention"
)

// Fallbacks for a school that has never opened the tracking settings screen
// and therefore has no transport_tracking_policy row. They are the schema's
// own DEFAULTs, repeated here because the sweeps LEFT JOIN the policy rather
// than creating one: a sweep that inserted a policy row for every institution
// would be a background job writing configuration nobody asked for.
const (
	defaultTripTimeoutMins = 20
	defaultRetainDays      = 90
)

/*
One DELETE may remove at most this many position rows, and one sweep at most

	this many batches -- per institution, and in total.

	Twenty buses at a fifteen-second ping is about thirteen million rows a school
	year, and a single unbounded DELETE over that holds row locks and a growing
	WAL segment for minutes while the ingest path -- which is a bus reporting
	where a child is -- waits behind it.

	The run-wide cap and the time budget are newer than the per-institution one.
	Two hundred batches per school was a bound on one school; with a dozen
	schools it was a bound of 2,400 batches, and a first run after somebody cut
	retain_days from 3650 to 90 would hold a worker slot for the better part of
	an hour. The sweep now runs where a container may be stopped for idling and
	a job is given five minutes, so one run does at most positionRetentionMaxRun
	batches or positionRetentionBudget of wall clock, whichever comes first, and
	leaves the rest for tomorrow. Tomorrow's run starts from the oldest rows
	again, so nothing is skipped -- only deferred.
*/
const (
	positionRetentionBatch    = 5000
	positionRetentionMaxLoops = 200
	positionRetentionMaxRun   = 60 // 300,000 rows; well inside five minutes on this box
	positionRetentionBudget   = 4 * time.Minute
)

// --- timeout arithmetic ------------------------------------------------------

/*
tripTimeoutDeadline is when an open trip becomes stale, given the last moment
anything was heard from it.

	Pulled out of the SQL and given a name so it can be tested without a
	database, because the two mistakes available here are both silent. Reading
	the timeout as seconds rather than minutes closes every trip on the first
	sweep; clamping it the wrong way round never closes any. Neither errors,
	and both are only visible on a parent's screen.
*/
func tripTimeoutDeadline(lastHeard time.Time, timeoutMins int) time.Time {
	return lastHeard.Add(time.Duration(clampTripTimeoutMins(timeoutMins)) * time.Minute)
}

// clampTripTimeoutMins keeps a policy value inside the range the schema's
// CHECK constraint allows. A zero arrives from a nil/absent policy row rather
// than from a school choosing it, and treating it literally would time out
// every trip the instant it opened.
func clampTripTimeoutMins(mins int) int {
	switch {
	case mins <= 0:
		return defaultTripTimeoutMins
	case mins < 5:
		return 5
	case mins > 240:
		return 240
	}
	return mins
}

/*
tripLastHeard is the instant a trip was last known to be alive.

	A trip with no positions at all -- the driver started a run and the phone
	never got a fix, or lost the network before its first push -- is timed out
	from started_at. Otherwise there is nothing to measure from and the trip
	stays open forever, which is exactly the stale marker this sweep exists to
	remove.
*/
func tripLastHeard(startedAt time.Time, lastFix *time.Time) time.Time {
	if lastFix == nil || lastFix.Before(startedAt) {
		return startedAt
	}
	return *lastFix
}

// tripHasTimedOut is the whole rule, in one place, as the SQL below applies it.
func tripHasTimedOut(startedAt time.Time, lastFix *time.Time, timeoutMins int, now time.Time) bool {
	return now.After(tripTimeoutDeadline(tripLastHeard(startedAt, lastFix), timeoutMins))
}

// --- sweep 1: close trips nothing has been heard from ------------------------

/*
SweepTripTimeouts closes every open trip that has gone quiet, everywhere.

	ended_reason is 'timeout' and that distinction is the point of the sweep,
	not bookkeeping. 'driver' means a person pressed End on the handset, which
	is the only record this system has that the children were actually dropped
	off; 'timeout' means the server stopped hearing a phone and guessed. A
	report that collapsed the two would answer "was the run completed?" with a
	number that includes every flat battery.

	ended_at is the last moment the trip was known alive, not the moment the
	sweep ran. A trip that went silent at 08:12 and is closed at 08:32 ended
	at 08:12 as far as anyone reconstructing the morning is concerned; writing
	now() would add twenty invented minutes to every timed-out run.
*/
func (s *Server) SweepTripTimeouts(ctx context.Context) (trips int, events int, err error) {
	now := nowInIndia()
	err = s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		/* The aggregate is over open trips only, which is a handful per
		   school at any moment, and max(recorded_at) per trip is one backwards
		   index scan on vehicle_positions_replay -- not a scan of the
		   thirteen-million-row history. */
		rows, err := tx.Query(ctx, `
			WITH stale AS (
			    SELECT t.id,
			           GREATEST(t.started_at, COALESCE(max(p.recorded_at), t.started_at)) AS last_heard,
			           LEAST(240, GREATEST(5, COALESCE(pol.trip_timeout_mins, $2))) AS timeout_mins
			      FROM vehicle_trips t
			      LEFT JOIN vehicle_positions p ON p.trip_id = t.id
			      LEFT JOIN transport_tracking_policy pol
			             ON pol.institution_id = t.institution_id
			     WHERE t.ended_at IS NULL
			     GROUP BY t.id, t.started_at, pol.trip_timeout_mins
			)
			UPDATE vehicle_trips t
			   SET ended_at = stale.last_heard,
			       ended_reason = 'timeout'
			  FROM stale
			 WHERE t.id = stale.id
			   AND t.ended_at IS NULL
			   AND stale.last_heard + make_interval(mins => stale.timeout_mins) < $1
			RETURNING t.id, t.institution_id, t.vehicle_id, t.ended_at`,
			now, defaultTripTimeoutMins)
		if err != nil {
			return err
		}
		type closed struct {
			id    uuid.UUID
			inst  uuid.UUID
			veh   uuid.UUID
			endAt time.Time
		}
		var shut []closed
		for rows.Next() {
			var c closed
			if err := rows.Scan(&c.id, &c.inst, &c.veh, &c.endAt); err != nil {
				rows.Close()
				return err
			}
			shut = append(shut, c)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(shut) == 0 {
			return nil
		}

		ids := make([]uuid.UUID, 0, len(shut))
		for _, c := range shut {
			ids = append(ids, c.id)
			slog.Info("trip closed on timeout", "trip_id", c.id,
				"institution_id", c.inst, "vehicle_id", c.veh,
				"ended_at", c.endAt.Format(time.RFC3339))
		}
		trips = len(shut)

		/* An open safety episode belongs to the trip, so closing the trip must
		   close it too. A speeding row with started_at and no ended_at reads
		   as "this bus is over the limit right now" -- on the office's alert
		   list, and in every duration computed from it -- and it would read
		   that way for the rest of the year. It is ended at the trip's own end
		   instant, which is the last moment anything was actually observed.

		   GREATEST guards the period CHECK: a fix filed out of a dead-zone
		   buffer can open an episode marginally after the last position the
		   trip is being closed at. */
		tag, err := tx.Exec(ctx, `
			UPDATE transport_safety_events e
			   SET ended_at = GREATEST(e.started_at, t.ended_at)
			  FROM vehicle_trips t
			 WHERE t.id = e.trip_id
			   AND e.trip_id = ANY($1)
			   AND e.ended_at IS NULL`, ids)
		if err != nil {
			return err
		}
		events = int(tag.RowsAffected())
		if events > 0 {
			slog.Info("safety episodes closed with their trip", "events", events, "trips", trips)
		}
		return nil
	})
	return trips, events, err
}

// --- sweep 2: drop position history past its retention -----------------------

/*
SweepPositionRetention deletes breadcrumbs older than each school's
retain_days.

	Not optional and not cosmetic. This is the only table in the product whose
	growth is measured in millions of rows a year, and the school has already
	been asked how long it wants to keep them -- retain_days exists so the
	answer is a decision rather than "forever by omission".

	Per institution, because retention is the school's own answer and a single
	global cutoff would apply the strictest school's policy to everyone. In
	bounded batches, because the delete competes with the ingest path: a bus
	pushing a fix waits behind whatever locks this holds.
*/
func (s *Server) SweepPositionRetention(ctx context.Context) (deleted int, err error) {
	now := nowInIndia()
	deadline := time.Now().Add(positionRetentionBudget)
	runLoops := 0

	type target struct {
		inst   uuid.UUID
		cutoff time.Time
		days   int
	}
	var targets []target

	err = s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		// Every institution, not only those with a policy row: a school that
		// never opened the settings screen still accumulates positions, and
		// leaving it out is how "the sweep is running" and "the table is
		// growing" turn out to both be true.
		rows, err := tx.Query(ctx, `
			SELECT i.id, COALESCE(p.retain_days, $1)
			  FROM institutions i
			  LEFT JOIN transport_tracking_policy p ON p.institution_id = i.id`,
			defaultRetainDays)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var t target
			if err := rows.Scan(&t.inst, &t.days); err != nil {
				return err
			}
			if t.days < 7 {
				t.days = defaultRetainDays
			}
			t.cutoff = now.AddDate(0, 0, -t.days)
			targets = append(targets, t)
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}

	for _, t := range targets {
		instDeleted := 0
		for loop := 0; loop < positionRetentionMaxLoops; loop++ {
			if runLoops >= positionRetentionMaxRun || time.Now().After(deadline) {
				// Out of budget for this run. Logged once, at the point it
				// happened, so an operator can tell "the sweep is behind" from
				// "the sweep is not running" -- the two look identical from
				// the table's size alone.
				slog.Info("position retention sweep paused for today",
					"batches", runLoops, "rows_deleted", deleted,
					"institution_id", t.inst, "reason", "run budget")
				return deleted, nil
			}
			runLoops++
			var n int64
			err := s.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
				/* One transaction per batch, deliberately. Holding all the
				   batches in one transaction would put the whole delete back
				   into a single lock window and defeat the batching entirely.

				   The subquery is bounded and ordered by the same index the
				   sweep was given (vehicle_positions_age), so each batch is
				   the oldest rows rather than an arbitrary slice, and stopping
				   halfway through leaves the remainder for the next tick. */
				tag, err := tx.Exec(ctx, `
					DELETE FROM vehicle_positions
					 WHERE id IN (
					     SELECT id FROM vehicle_positions
					      WHERE institution_id = $1 AND recorded_at < $2
					      ORDER BY recorded_at
					      LIMIT $3)`, t.inst, t.cutoff, positionRetentionBatch)
				if err != nil {
					return err
				}
				n = tag.RowsAffected()
				return nil
			})
			if err != nil {
				return deleted, err
			}
			instDeleted += int(n)
			deleted += int(n)
			if n < positionRetentionBatch {
				break
			}
		}
		if instDeleted > 0 {
			// Logged per institution and not only in total, because "the sweep
			// deleted two million rows" does not tell an operator which
			// school's retention was just shortened by mistake.
			slog.Info("position history pruned", "institution_id", t.inst,
				"rows", instDeleted, "retain_days", t.days,
				"cutoff", t.cutoff.Format(time.RFC3339))
		}
	}
	return deleted, nil
}

// --- registration ------------------------------------------------------------

/*
RegisterBusTrackerJobs installs both sweeps' handlers on the worker.

	It takes the queue's handler table rather than living in internal/queue
	for the same reason queue.Messaging does not: internal/api already
	imports internal/queue to enqueue, so queue cannot import api back to
	reach these methods. cmd/worker is the one process that knows both, and
	one call there -- before queue.New, which takes its worker set at
	construction -- is the whole splice.

	The schedule is registered separately, through CronSchedules, because the
	worker is no longer where the schedule lives; see queue/cron.go.
*/
func (s *Server) RegisterBusTrackerJobs(h *queue.Handlers) error {
	if err := h.Handle(TypeTransportTripTimeout, 5*time.Minute, s.handleTripTimeoutTask); err != nil {
		return err
	}
	return h.Handle(TypeTransportPositionRetention, 5*time.Minute, s.handlePositionRetentionTask)
}

/*
CronSchedules is the whole installation's schedule: the queue's own entries
and the bus-tracker sweeps together.

	Both the cron endpoint and the worker's in-process fallback want the same
	list, and neither should have to know that two of the entries are
	declared here. api is the one package that sees both halves, so api
	joins them.
*/
func (s *Server) CronSchedules() []queue.Schedule {
	return append(queue.Schedules(), busTrackerCronEntries()...)
}

/*
busTrackerCronEntries is the schedule as data, so a test can assert what runs
without a database to record it in.

	Neither entry is PerInstitution, unlike most of queue.Schedules. Those run
	once per school; these run once, full stop, because both sweep every
	institution in one pass. Per institution they would run N identical
	global sweeps on every tick, each one racing the others over the same
	rows.

	Both are QueueLow. They are housekeeping -- nobody is waiting on either
	-- and the low queue has a single slot, which is the trade this schedule
	wants: never starved, never crowding out the work somebody is waiting on.
*/
func busTrackerCronEntries() []queue.Schedule {
	empty := func(queue.Envelope) any { return map[string]any{} }
	return []queue.Schedule{
		/* Every 5 minutes — close trips nothing has been heard from.

		   The timeout itself is the school's (default 20 minutes); this is
		   only how often the question is asked. Five minutes bounds how long a
		   parent can see a stale "the bus is on its way" past the school's own
		   patience, and a tick that finds nothing is one indexed pass over the
		   open trips, of which a school has at most a busful. */
		{Name: "transport_trip_timeout", Spec: "*/5 * * * *", Kind: TypeTransportTripTimeout,
			Payload: empty, Opts: queue.Options(queue.QueueLow, 3, 5*time.Minute)},

		/* 03:20 daily — drop position history past its retention.

		   Daily rather than hourly: retention is measured in days, so an
		   hourly tick would delete the same rows a day earlier by luck and do
		   nothing the other 23 times. In the quiet window, and not on the
		   half-hour, so it does not start alongside the 03:00 Sunday session
		   prune and put two housekeeping deletes on one vCPU at once.

		   Five minutes, not the thirty it used to have: the sweep now budgets
		   itself (positionRetentionMaxRun, positionRetentionBudget) and
		   stops inside that, leaving the remainder for tomorrow. A school
		   switching retain_days from 3650 to 90 is therefore caught up over
		   a week or two of nights rather than in one enormous run. */
		{Name: "transport_position_retention", Spec: "20 3 * * *", Kind: TypeTransportPositionRetention,
			Payload: empty, Opts: queue.Options(queue.QueueLow, 2, 5*time.Minute)},
	}
}

func (s *Server) handleTripTimeoutTask(ctx context.Context, _ *queue.Task) error {
	trips, events, err := s.SweepTripTimeouts(ctx)
	if trips > 0 || events > 0 {
		slog.Info("trip timeout sweep", "trips_closed", trips, "safety_events_closed", events)
	}
	return err
}

func (s *Server) handlePositionRetentionTask(ctx context.Context, _ *queue.Task) error {
	rows, err := s.SweepPositionRetention(ctx)
	slog.Info("position retention sweep", "rows_deleted", rows)
	return err
}
