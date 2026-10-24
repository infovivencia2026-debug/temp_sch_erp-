-- 0114_digest_keep_latest (tenant: every school database).
-- Owner, 2026-10-24: "only one daily digest should be there, not all". The
-- digests go only to the principal and the school admin, and only each one's
-- newest stays in the bell. This clears the pile already there: every digest
-- of someone who is neither is dismissed, and for the rest all but the
-- newest of each kind. Also dismisses repeated "marked absent" bells (one
-- per person, child and day is kept: the oldest).
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Re-runnable.

UPDATE notifications SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE dismissed_at IS NULL
   AND kind IN ('report_digest.daily', 'report_digest.weekly', 'ai.warnings.digest')
   AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = notifications.user_id AND r.key IN ('principal', 'institution_admin'));

UPDATE notifications SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE dismissed_at IS NULL
   AND kind IN ('report_digest.daily', 'report_digest.weekly', 'ai.warnings.digest')
   AND EXISTS (SELECT 1 FROM notifications n2
                WHERE n2.user_id = notifications.user_id AND n2.kind = notifications.kind
                  AND n2.dismissed_at IS NULL
                  AND (n2.created_at > notifications.created_at
                       OR (n2.created_at = notifications.created_at AND n2.id > notifications.id)));

UPDATE notifications SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE dismissed_at IS NULL AND kind = 'attendance' AND student_id IS NOT NULL
   AND title LIKE '% was marked absent'
   AND EXISTS (SELECT 1 FROM notifications n2
                WHERE n2.user_id = notifications.user_id AND n2.kind = 'attendance'
                  AND n2.student_id = notifications.student_id AND n2.dismissed_at IS NULL
                  AND n2.title LIKE '% was marked absent'
                  AND substr(n2.created_at, 1, 10) = substr(notifications.created_at, 1, 10)
                  AND (n2.created_at < notifications.created_at
                       OR (n2.created_at = notifications.created_at AND n2.id < notifications.id)));
