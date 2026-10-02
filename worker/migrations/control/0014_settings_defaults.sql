-- 0014_settings_defaults (CONTROL).
-- The vendor's defaults for school settings (services/settings_registry.ts):
-- scope 'platform' applies to every new school; scope 'plan:<code>' to new
-- schools on that plan and wins over the platform value. value is the JSON
-- of the setting's value. Written into a new school by runProvision and
-- pushed to existing ones only by an explicit "Apply to schools".
--
-- platform_role_templates: the vendor's version of a built-in role's
-- permissions. Absent = the code's SYSTEM_ROLES list. Used by provisioning
-- and by "push to schools", which skips any school that customised the role.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS platform_setting_defaults (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS platform_role_templates (
  role_key TEXT PRIMARY KEY,
  permissions TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
