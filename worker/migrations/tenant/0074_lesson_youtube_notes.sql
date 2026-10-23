-- 0072_lesson_youtube_notes (tenant: every school database).
-- A lesson may be a YouTube video or playlist; a child keeps their own
-- timestamped notes against it; the teacher writes the key points.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT.
--
-- The id and nothing else. Not the thumbnail, not the description, not the
-- duration, not the channel's artwork: YouTube's API terms cap how long its
-- metadata may be cached, and a school database that quietly becomes a
-- mirror of someone else's catalogue is the thing those terms exist to
-- prevent. The id is what the embed needs; everything else is fetched by
-- the player at the moment of watching, from YouTube, as it should be.
--
-- yt_channel is the one exception and it is attribution, not metadata: the
-- name shown beside the player so the uploader is credited on the page. The
-- teacher types it or it stays empty; nothing scrapes it.
--
-- The video is never copied. There is no column here for a file, a stream
-- URL or a transcript, because the moment a school re-hosts somebody's video
-- it is no longer embedding it.
ALTER TABLE lms_lessons ADD COLUMN yt_video_id TEXT;
ALTER TABLE lms_lessons ADD COLUMN yt_playlist_id TEXT;
ALTER TABLE lms_lessons ADD COLUMN yt_channel TEXT;

-- THE TEACHER'S OWN WORDS, NEVER THE MACHINE'S.
--
-- "Key points" is written by the person who set the video. It is not a
-- summary generated from the video, and there is no column anywhere here for
-- one: a summary derived from somebody else's recording is derived from
-- their work, and the same goes for its captions. A teacher writing down
-- what their class should take from a video is the school's own writing and
-- raises no such question.
ALTER TABLE lms_lessons ADD COLUMN key_points TEXT;

-- A CHILD'S OWN NOTES, AGAINST THE SECOND THEY WERE WATCHING.
--
-- Keyed on the user and not the student record: a lesson can be opened by a
-- child and, one day, by somebody else with a login, and notes belong to
-- whoever wrote them. at_seconds is nullable -- a note about the whole thing
-- is as valid as one pinned to 4:12 -- and is an integer because a note does
-- not need to know about half a second.
--
-- No sharing, no visibility column, no teacher read. These are private by
-- construction: every query that touches this table filters on the caller's
-- own user_id, and there is nothing in the schema to loosen later by
-- accident.
CREATE TABLE IF NOT EXISTS lms_lesson_notes (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lms_lessons (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Where in the video the note was taken, in whole seconds. NULL: about the
  -- lesson as a whole.
  at_seconds INTEGER,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The one read this table ever serves: my notes on this lesson, in the order
-- they sit along the video.
CREATE INDEX IF NOT EXISTS lms_lesson_notes_mine
  ON lms_lesson_notes (lesson_id, user_id, at_seconds);
