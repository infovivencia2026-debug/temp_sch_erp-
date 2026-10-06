-- A heart on a status, and on a pinned post in the school gallery.
--
-- One row per person per post, so the count is a COUNT and un-liking is a
-- DELETE: nothing to keep in step and no way to double-count. The post is the
-- owner of the row -- deleting a status takes its hearts with it.
CREATE TABLE IF NOT EXISTS status_likes (
  post_id    TEXT NOT NULL REFERENCES status_posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_status_likes_post ON status_likes(post_id);
