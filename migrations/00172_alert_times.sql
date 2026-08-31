-- +goose Up

/* Alerts already delivered carry the moment they were delivered.
 *
 * The family feed is written the first time somebody opens the app, and the
 * insert did not set created_at — so a fortnight of school life arrived
 * stamped with one timestamp, to the minute. A parent signing in saw eight
 * notices "at 3:15 PM", one of them a fee overdue since 26 August.
 *
 * The inserts are fixed in internal/api/portal_school_life.go. This corrects
 * what they have already written, because the alternative is a feed that reads
 * correctly only for families who have not signed in yet.
 *
 * Only rows that name their source, and only where the source can still be
 * found: source_kind/source_id is exactly the pair that says what this alert is
 * about. Anything else keeps the time it has, which is the honest answer when
 * there is nothing to correct it from.
 */
SET LOCAL app.is_platform_admin = 'on';

UPDATE notifications n SET created_at = a.publish_at
  FROM announcements a
 WHERE n.source_kind = 'announcement' AND n.source_id = a.id
   AND a.publish_at IS NOT NULL AND a.publish_at < n.created_at;

UPDATE notifications n SET created_at = sa.marked_at
  FROM student_attendance sa
 WHERE n.source_kind = 'attendance' AND n.source_id = sa.id
   AND sa.marked_at < n.created_at;

UPDATE notifications n SET created_at = (inv.due_on + 1)::timestamptz
  FROM invoices inv
 WHERE n.source_kind = 'invoice' AND n.source_id = inv.id
   AND inv.due_on IS NOT NULL
   AND (inv.due_on + 1)::timestamptz < n.created_at;

UPDATE notifications n SET created_at = h.created_at
  FROM homework h
 WHERE n.source_kind = 'homework' AND n.source_id = h.id
   AND h.created_at < n.created_at;

-- +goose Down
/* Nothing. The old values were the delivery time, which carried no information
 * about the thing the alert is about — restoring them would mean inventing
 * timestamps that were wrong when they were written. */
SELECT 1;
