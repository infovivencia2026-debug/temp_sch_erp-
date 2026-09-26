import { registerJob } from '../jobs'
import { daysAgo, forEachSchool } from './schools'

/* Housekeeping sweeps: session:prune (worker.go sessionPrune),
   security:retention (api/login_security.go handleSecurityRetention) and
   diary:reminders (worker.go diaryReminders). All three were global
   ("AsPlatform") in Go; here that is CONTROL plus a loop over the schools. */

registerJob('session:prune', async (env) => {
  const s = await env.CONTROL.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(daysAgo(7)).run()
  console.log('pruned sessions', { rows: s.meta.changes })
  // The offline outbox's receipts: fourteen days, twice the client's retry window.
  let receipts = 0
  await forEachSchool(env, async (_inst, db) => {
    const r = await db.prepare(`DELETE FROM idempotency_keys WHERE created_at < ?`).bind(daysAgo(14)).run()
    receipts += r.meta.changes
  })
  console.log('pruned idempotency receipts', { rows: receipts })
})

registerJob('security:retention', async (env) => {
  const ev = await env.CONTROL.prepare(`DELETE FROM login_events WHERE at < ?`).bind(daysAgo(365)).run()
  const nowIso = new Date().toISOString()
  const se = await env.CONTROL.prepare(`DELETE FROM sessions
      WHERE (revoked_at IS NOT NULL OR expires_at < ?) AND last_seen_at < ?`).bind(nowIso, daysAgo(365)).run()
  // Not in Go: River kept finished jobs 24h; CONTROL.jobs is trimmed here.
  const jb = await env.CONTROL.prepare(`DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?`).bind(daysAgo(1)).run()
  let screens = 0
  await forEachSchool(env, async (_inst, db) => {
    const r = await db.prepare(`DELETE FROM session_screens WHERE last_at < ?`).bind(daysAgo(90)).run()
    screens += r.meta.changes
    // The pre-migration copies of the platform tables in each school database.
    await db.prepare(`DELETE FROM login_events WHERE created_at < ?`).bind(daysAgo(365)).run()
  })
  console.log('security retention sweep', { screens, login_events: ev.meta.changes, sessions: se.meta.changes, jobs: jb.meta.changes })
})

/* Reminders the child (or parent) asked for, delivered when they asked.
   Claim and read in one UPDATE ... RETURNING, so two overlapping sweeps
   cannot both claim a note; the notification goes to whoever wrote it. */
registerJob('diary:reminders', async (env) => {
  let sent = 0
  await forEachSchool(env, async (_inst, db) => {
    const at = new Date().toISOString()
    const claimed = await db.prepare(`
      UPDATE student_diary_notes SET reminded_at = ?
       WHERE id IN (SELECT id FROM student_diary_notes
                     WHERE remind_at IS NOT NULL AND reminded_at IS NULL
                       AND julianday(remind_at) <= julianday(?) AND done_at IS NULL
                     ORDER BY remind_at LIMIT 500)
      RETURNING institution_id, author_user_id, kind, body`).bind(at, at)
      .all<{ institution_id: string; author_user_id: string; kind: string; body: string }>()
    const rows = claimed.results ?? []
    if (!rows.length) return
    const ins = db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, created_at)
      VALUES (?, ?, ?, 'diary_reminder', ?, ?, '/go/digital_diary_schedule', ?)`)
    await db.batch(rows.map((d) => ins.bind(crypto.randomUUID(), d.institution_id, d.author_user_id,
      d.kind && d.kind !== 'note' ? 'Reminder: ' + d.kind : 'Reminder', d.body, at)))
    sent += rows.length
  })
  if (sent > 0) console.log('diary reminders sent', { count: sent })
})
