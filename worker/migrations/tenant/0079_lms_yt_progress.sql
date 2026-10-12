-- Where a student is in a YouTube lesson, kept on the server (owner, 2026-10-12:
-- "let them resume where they left" -- on any phone, not only the one they
-- started on). The library's lms_video_progress cannot hold these: its
-- video_id must name a library video. Same shape: the place, and which
-- stretches (buckets) have actually been played.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS lms_yt_progress (
  institution_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lms_lessons (id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  bucket_seconds INTEGER NOT NULL,
  watched TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (lesson_id, student_id)
);
CREATE INDEX IF NOT EXISTS lms_yt_progress_student ON lms_yt_progress (student_id);
