-- 0016_log_indexes (tenant: every school database).
-- Indexes for the log-shaped tables the dashboards read newest-first or by a
-- recent window (docs/audit-2026-09-23.md Tier 4): the messaging providers
-- card counts what was sent in the last 24 hours by sent_at, and the
-- transport office lists stop events and safety events newest-first, by day
-- or by trip. Without these each read walked the whole table.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE INDEX IF NOT EXISTS message_log_sent_at ON message_log (sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS transport_stop_events_occurred ON transport_stop_events (occurred_at);
CREATE INDEX IF NOT EXISTS transport_stop_events_trip_occurred ON transport_stop_events (trip_id, occurred_at);
CREATE INDEX IF NOT EXISTS transport_safety_events_started ON transport_safety_events (started_at);
