-- +goose Up
-- Scheduled report digests, configured per school.
--
-- A board member does not open the ERP every morning; an institution admin
-- does, but reads the same four numbers each day and would rather have them
-- arrive than go looking. Both are served by the same thing: a digest of the
-- reports that already exist -- attendance, fees, admissions, staff -- built on
-- a schedule and delivered on the channels the school already sends on.
--
-- What this table holds is only the choosing: which of the four reports a
-- school wants, on which channels each of them travels, and whether the daily
-- and the weekly run at all. Nothing here computes a number -- every figure is
-- assembled at send time from the same roll-up queries the screens use, so the
-- digest and the dashboard can never disagree. And nothing here holds a
-- recipient list: recipients are resolved at send time as the users who hold
-- board_member or institution_admin in the school, so a board member added
-- tomorrow is on the next morning's digest without anyone editing a row.
--
-- One row per institution. config is a JSONB map keyed by report:
--   { "attendance_summary":   {"enabled": true,  "channels": ["email","in_app"]},
--     "fees_collected_dues":   {"enabled": true,  "channels": ["email"]},
--     "admissions_enrolment":  {"enabled": false, "channels": []},
--     "staff_attendance_leave":{"enabled": true,  "channels": ["email","in_app"]} }
-- A report absent from the map, or with enabled=false, is not sent. A missing
-- row means the school has never been asked: the API applies a sensible default
-- (all four reports on email + in_app, daily and weekly on) rather than
-- treating silence as "send nothing".
CREATE TABLE IF NOT EXISTS report_digest_settings (
    institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    -- Which reports are on, and the channels each rides. Queryable by report
    -- with config->'attendance_summary'->>'enabled' where a report ever needs
    -- to be found without reading the whole object.
    config         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- The two runs, switched independently: a school may want the Monday
    -- summary without the daily one, or the reverse.
    daily_enabled  boolean     NOT NULL DEFAULT true,
    weekly_enabled boolean     NOT NULL DEFAULT true,
    updated_by     uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE report_digest_settings IS
    'Per-institution configuration for scheduled report digests: which reports are enabled, the channels each goes on, and whether the daily and weekly runs fire. Read by the digest builder in internal/api/report_digest.go; recipients (board_member + institution_admin) are resolved at send time, not stored here.';
COMMENT ON COLUMN report_digest_settings.config IS
    'JSONB map {report_key: {enabled: bool, channels: [email|sms|whatsapp|in_app]}}. Reports: attendance_summary, fees_collected_dues, admissions_enrolment, staff_attendance_leave.';

ALTER TABLE report_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_digest_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_digest_settings_tenant ON report_digest_settings;
CREATE POLICY report_digest_settings_tenant ON report_digest_settings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON report_digest_settings TO app_user;

-- +goose Down
DROP TABLE IF EXISTS report_digest_settings;
