-- +goose Up

/* The reference the composer stamped on this notice before it was sent.
 *
 * Publishing a broadcast is one POST that both records the announcement and
 * fans it out over SMS and WhatsApp to every household in the class. Nothing
 * made that POST idempotent: a double tap on a slow connection, or a retry
 * after a dropped response, wrote a second announcement and texted four
 * hundred parents the same notice twice. The queue's own idempotency cannot
 * help — each fan-out task is minted with a fresh job id, precisely so that
 * one rejected address does not lose the rest of the notice.
 *
 * So the client names the send. The composer generates the reference once,
 * when the teacher starts writing, and keeps it across retries; the second
 * arrival collides with this index and is answered with the first one's id
 * instead of sending anything.
 *
 * Nullable, because everything published before this column existed has no
 * reference and the sends that came through other paths do not need one.
 */
ALTER TABLE announcements
    ADD COLUMN IF NOT EXISTS client_ref text;

COMMENT ON COLUMN announcements.client_ref IS
    'Idempotency key minted by the composer that published this announcement. A repeat POST carrying the same reference is answered with this row rather than publishing and fanning out a second time. NULL for announcements published before the column, and for paths that do not send one.';

CREATE UNIQUE INDEX IF NOT EXISTS announcements_client_ref
    ON announcements (institution_id, client_ref)
    WHERE client_ref IS NOT NULL;

-- +goose Down

DROP INDEX IF EXISTS announcements_client_ref;
ALTER TABLE announcements DROP COLUMN IF EXISTS client_ref;
