-- Sign-in pictures: square pictures a school's vendor uploads for the school's
-- public sign-in page. Kept apart from the School Gallery, which holds class
-- posts with children and is never public.
CREATE TABLE IF NOT EXISTS login_slides (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_slides_school ON login_slides (institution_id, position);
