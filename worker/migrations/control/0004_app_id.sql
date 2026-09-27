-- control_app_id (CONTROL D1 only). The store identity of a school's own
-- apps (Android applicationId, iOS bundle id, desktop appId). Set once in
-- Tenants → Branding; a store never lets it change after the first upload.
ALTER TABLE institutions ADD COLUMN app_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS institutions_app_id ON institutions (app_id) WHERE app_id IS NOT NULL;
