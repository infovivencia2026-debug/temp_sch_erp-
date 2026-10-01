-- 0021_status_thumbs_and_text (tenant: every school database).
-- Class Status in the notification panel: a small (~320px) thumbnail the
-- poster's browser draws at post time (a photo scaled down, a video's first
-- frame), kept beside the media under class-status/<institution>/ and served
-- only through GET /status/posts/{id}/thumb after the same audience check as
-- the media. NULL for posts made before this, and for text statuses.
--
-- Text statuses need no column: media_kind 'text', the words in caption,
-- object_key '' and content_type 'text/plain' (src/routes/comms/class_status.ts).
--
-- Numbered above 0015-0019 being written elsewhere so the two never collide.
-- Forward-only. No BEGIN/COMMIT (D1 rejects them).

ALTER TABLE status_posts ADD COLUMN thumb_key TEXT;
