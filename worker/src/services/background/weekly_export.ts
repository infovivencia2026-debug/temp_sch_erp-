import type { Env } from '../../env'
import { enqueueMany, registerJob, SkipRetry } from '../jobs'
import { institutionById } from '../../tenant'
import { GzipToR2 } from './backup'

/* Weekly backups through the D1 export API, 8 weeks kept.

   backup:weekly_fanout (cron, Saturday 21:00 UTC = Sunday 02:30 IST) queues
   one backup:weekly_export per school. That job asks Cloudflare for a SQL
   export of the school's database (POST /d1/database/<id>/export, polled until
   it is ready), streams the file from the signed URL, gzips it into the
   FILES_WRITE bucket at
     backups/<slug>/weekly/<YYYY-MM-DD>.sql.gz
   and then deletes all but the newest WEEKLY_KEEP objects under that prefix.

   This is Cloudflare's own export (every table, index and trigger, as
   `wrangler d1 export` writes it), a second, independent copy beside the
   nightly dumps the Worker writes itself (backup.ts). An export blocks
   other queries on that database while it runs; at this size that is
   seconds, which is why it runs in the night.

   Restore rehearsal: docs/d1-health.md, "Restore rehearsal".
   Needs the secrets CF_ACCOUNT_ID and CF_API_TOKEN (Account > D1 > Edit). */

export const WEEKLY_KEEP = 8
export const weeklyPrefix = (slug: string) => `backups/${slug}/weekly/`
export const weeklyKey = (slug: string, date: string) => `${weeklyPrefix(slug)}${date}.sql.gz`

interface ExportPoll {
  at_bookmark?: string
  status?: 'active' | 'complete' | 'error'
  error?: string
  result?: { filename?: string; signed_url?: string }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Starts a D1 export and polls it until Cloudflare hands back a signed URL. */
export async function d1ExportUrl(accountId: string, token: string, databaseId: string, fetchFn: Fetch = (u, i) => fetch(u, i),
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), maxPolls = 120): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`
  let bookmark: string | undefined
  for (let i = 0; i < maxPolls; i++) {
    const res = await fetchFn(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) }) })
    const body = await res.json().catch(() => ({})) as { success?: boolean; result?: ExportPoll; errors?: { message?: string }[] }
    if (!res.ok || body.success === false) throw new Error(`D1 export ${res.status}: ${(body.errors ?? []).map((e) => e.message).join('; ')}`)
    const r = body.result ?? {}
    if (r.status === 'error') throw new Error('D1 export failed: ' + (r.error ?? 'unknown'))
    if (r.status === 'complete' && r.result?.signed_url) return r.result.signed_url
    bookmark = r.at_bookmark ?? bookmark
    await sleep(2000)
  }
  throw new Error('D1 export did not finish in time')
}

/** Keeps the newest `keep` weekly exports of a school, deletes the rest. Returns the keys deleted. */
export async function pruneWeekly(bucket: R2Bucket, slug: string, keep = WEEKLY_KEEP): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const l = await bucket.list({ prefix: weeklyPrefix(slug), cursor })
    keys.push(...l.objects.map((o) => o.key))
    cursor = l.truncated ? l.cursor : undefined
  } while (cursor)
  const gone = keys.sort().reverse().slice(keep)
  if (gone.length) await bucket.delete(gone)
  return gone
}

registerJob('backup:weekly_fanout', async (env: Env) => {
  const r = await env.CONTROL.prepare(`SELECT id FROM institutions WHERE status <> 'deleted' AND d1_database_id NOT LIKE 'local-%' ORDER BY created_at`).all<{ id: string }>()
  await enqueueMany(env, (r.results ?? []).map((s) => ({ type: 'backup:weekly_export', payload: { institution_id: s.id }, institution_id: s.id })))
})

registerJob<{ institution_id?: string }>('backup:weekly_export', async (env, job) => {
  const acc = env.CF_ACCOUNT_ID, tok = env.CF_API_TOKEN
  if (typeof acc !== 'string' || !acc || typeof tok !== 'string' || !tok) throw new SkipRetry('weekly export: CF_ACCOUNT_ID / CF_API_TOKEN not set')
  const instId = job.institution_id ?? job.payload.institution_id
  const inst = instId ? await institutionById(env, instId) : null
  if (!inst) throw new SkipRetry('weekly export: unknown school ' + instId)
  const signed = await d1ExportUrl(acc, tok, inst.d1_database_id)
  const file = await fetch(signed)
  if (!file.ok || !file.body) throw new Error(`weekly export download: ${file.status}`)
  const date = new Date().toISOString().slice(0, 10)
  const key = weeklyKey(inst.slug, date)
  const bucket = env.FILES_WRITE // never the live bucket
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { school: inst.slug, database_id: inst.d1_database_id, source: 'd1-export-api', created_at: new Date().toISOString() } })
  const out = new GzipToR2(upload)
  try {
    const reader = file.body.pipeThrough(new TextDecoderStream()).getReader()
    for (;;) { const { done, value } = await reader.read(); if (done) break; await out.write(value) }
    const res = await out.finish()
    const pruned = await pruneWeekly(bucket, inst.slug)
    console.log('weekly export done', { school: inst.slug, key, ...res, pruned: pruned.length })
  } catch (err) {
    await out.abort()
    throw err
  }
})
