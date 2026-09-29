import type { Env } from '../env'
import { institutionById, tenantDb } from '../tenant'
import { registerJob } from './jobs'
import { Messenger, type MsgScope } from './messaging'
import { digestMoment, loadSettings } from './delivery'

/* The daily digest (services/delivery.ts holds items in
   message_digest_items). At the school's digest time, everything held for a
   person before that moment goes as one message through the 'digest'
   ladder (in-app + push first, then WhatsApp, then SMS). Items that arrive
   after the moment wait for tomorrow's. Run by the cron every 15 minutes per
   school that has something held ('message_digest' in services/cron.ts). */

const MAX_LINES = 8

export async function runDigest(m: MsgScope, now = Date.now()): Promise<{ digests: number; items: number }> {
  const { db, inst } = m
  const settings = await loadSettings(db)
  const moment = digestMoment(now, settings.digest_time)
  if (now < moment) return { digests: 0, items: 0 }
  const cutoff = new Date(moment).toISOString()
  const rows = (await db.prepare(`SELECT id, user_id, recipient, title, message_type FROM message_digest_items
      WHERE bundled_at IS NULL AND created_at < ? ORDER BY created_at LIMIT 2000`).bind(cutoff)
    .all<{ id: string; user_id: string | null; recipient: string; title: string; message_type: string }>()).results
  if (!rows.length) return { digests: 0, items: 0 }
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = r.user_id ?? r.recipient
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const ms = new Messenger(m)
  const day = new Date(moment + 330 * 60_000).toISOString().slice(0, 10)
  let digests = 0
  for (const [key, items] of groups) {
    const lines = items.slice(0, MAX_LINES).map((i) => '• ' + i.title.replace(/\s+/g, ' ').trim())
    if (items.length > MAX_LINES) lines.push(`• and ${items.length - MAX_LINES} more in the app`)
    const first = items[0]
    let msgId: string | null = null
    try {
      const res = await ms.queue({ channel: 'auto', template_code: 'digest.daily', to_user_id: first.user_id, recipient: first.user_id ? null : first.recipient,
        vars: { count: items.length, items: lines.join('\n') }, source_kind: 'digest', occurrence_key: `${day}:${key}`,
        idempotency_key: `digest:${day}:${key}` })
      msgId = res.id
      if (res.id || res.duplicate) digests++
    } catch (e) {
      console.warn('digest not queued', key, (e as Error).message)
    }
    const at = new Date().toISOString()
    await db.prepare(`UPDATE message_digest_items SET bundled_at = ?, digest_message_id = ? WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(at, msgId, JSON.stringify(items.map((i) => i.id))).run()
  }
  await ms.kick()
  return { digests, items: rows.length }
}

registerJob<{ institution_id: string }>('message:digest', async (env: Env, job) => {
  const inst = job.payload.institution_id ?? job.institution_id
  if (!inst) return
  const row = await institutionById(env, inst)
  if (!row) return
  await runDigest({ env, db: tenantDb(env, row), inst })
})
