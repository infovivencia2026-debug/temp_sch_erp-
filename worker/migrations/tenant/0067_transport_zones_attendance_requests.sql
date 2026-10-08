-- 0067_transport_zones_attendance_requests (tenant: every school database).
--
--   route_stops.zone               the locality a stop belongs to (Kukatpally,
--                                  Miyapur), so the zone-wise student report and
--                                  the daily transport sheet can group by it.
--   staff_attendance_requests      a member of staff asks for a day's punch to
--                                  be fixed (forgot to punch, machine was down);
--                                  HR approves and the register takes the fix.
--
-- Forward-only: once applied anywhere this file must not change.

ALTER TABLE route_stops ADD COLUMN zone TEXT;

CREATE TABLE IF NOT EXISTS staff_attendance_requests (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  on_date TEXT NOT NULL,
  status_wanted TEXT NOT NULL DEFAULT 'present',
  check_in TEXT,
  check_out TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS staff_attendance_requests_open ON staff_attendance_requests (institution_id, status, on_date);
