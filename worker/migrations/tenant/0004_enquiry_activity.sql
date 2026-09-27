-- 0004_enquiry_activity (tenant: every school database).
-- The admissions CRM's per-lead timeline: every call, WhatsApp, note, visit
-- and stage change on an enquiry, with who did it and when. Before this, a
-- lead's history was lines appended to enquiries.notes, which cannot say who
-- called, when, or what stage the lead moved from.
--
-- Additive only. Forward-only: once applied anywhere this file must not
-- change; fix a mistake with a new migration. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS enquiry_activities (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  enquiry_id TEXT NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
  -- 'created' | 'call' | 'whatsapp' | 'note' | 'visit' | 'stage'
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT,
  -- for kind 'stage': the move
  from_status TEXT,
  to_status TEXT,
  -- the follow-up date set with this entry, if any
  next_follow_up TEXT,
  author_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS enquiry_activities_lead ON enquiry_activities (enquiry_id, created_at);
