-- 0009_lms_videos (tenant: every school database).
-- The LMS video library: videos a teacher uploads (R2 multipart, through the
-- Worker, into FILES_WRITE under lms-videos/<institution>/), a lesson that
-- plays one of them, and each child's place in each lesson's video.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS lms_videos (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  -- Seconds, as the uploader's browser read it; NULL until known.
  duration_seconds REAL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL,
  original_name TEXT,
  object_key TEXT NOT NULL,
  -- R2 multipart upload id while uploading; NULL once complete or aborted.
  upload_id TEXT,
  part_size INTEGER,
  thumb_key TEXT,
  subject_id TEXT REFERENCES subjects (id) ON DELETE SET NULL,
  class_id TEXT REFERENCES classes (id) ON DELETE SET NULL,
  -- uploading | ready | failed
  status TEXT NOT NULL DEFAULT 'uploading',
  uploaded_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS lms_videos_uploader ON lms_videos (uploaded_by, created_at);
CREATE INDEX IF NOT EXISTS lms_videos_status ON lms_videos (status);

-- Parts received so far, so an upload can resume and complete.
CREATE TABLE IF NOT EXISTS lms_video_parts (
  video_id TEXT NOT NULL REFERENCES lms_videos (id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (video_id, part_number)
);

-- Per-school limits; a school with no row gets the defaults in code.
CREATE TABLE IF NOT EXISTS lms_video_limits (
  institution_id TEXT NOT NULL PRIMARY KEY,
  max_file_bytes INTEGER NOT NULL,
  max_total_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A lesson that plays a library video (kind 'video', url NULL).
ALTER TABLE lms_lessons ADD COLUMN video_id TEXT REFERENCES lms_videos (id) ON DELETE SET NULL;

-- Where a child is in a lesson's video. `watched` marks which stretches have
-- been played ('0'/'1' per bucket of bucket_seconds), so skipping to the end
-- is not watching it.
CREATE TABLE IF NOT EXISTS lms_video_progress (
  institution_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lms_lessons (id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES lms_videos (id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  bucket_seconds REAL NOT NULL DEFAULT 5,
  watched TEXT NOT NULL DEFAULT '',
  percent INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (lesson_id, student_id)
);
CREATE INDEX IF NOT EXISTS lms_video_progress_student ON lms_video_progress (student_id);
