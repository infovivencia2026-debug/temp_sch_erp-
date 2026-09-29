import type { Env } from '../env'
import type { Job } from './jobs'
import { platformProviders } from './messaging'

/* The dead-letter queue's consumer. A job that exhausted its retries on
   school-erp-jobs lands on school-erp-jobs-dlq (wrangler.jsonc); here each
   one is recorded in CONTROL.dead_letters, its CONTROL.jobs row marked
   'dead', and the platform admins are emailed, once per job type per hour
   so a burst of one failure is one alert. Always acks: a dead letter that
   cannot be recorded is logged, never retried into a loop. */

const ALERT_EVERY_MS = 3_600_000

export async function consumeDeadLetters(batch: MessageBatch<Job>, env: Env): Promise<void> {
  const byType = new Map<string, number>()
  for (const msg of batch.messages) {
    const job = (msg.body ?? {}) as Partial<Job>
    const type = String(job.type ?? 'unknown')
    const at = new Date().toISOString()
    try {
      const last = job.id ? await env.CONTROL.prepare(`SELECT last_error, attempts FROM jobs WHERE id = ?`).bind(job.id)
        .first<{ last_error: string | null; attempts: number }>().catch(() => null) : null
      await env.CONTROL.prepare(`INSERT INTO dead_letters (id, job_id, type, institution_id, payload, error, attempts, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), job.id ?? null, type, job.institution_id ?? null, JSON.stringify(job.payload ?? null).slice(0, 8000),
          last?.last_error ?? null, Number(last?.attempts ?? msg.attempts), at).run()
      if (job.id) await env.CONTROL.prepare(`UPDATE jobs SET state = 'dead', updated_at = ? WHERE id = ?`).bind(at, job.id).run().catch(() => undefined)
      byType.set(type, (byType.get(type) ?? 0) + 1)
    } catch (e) {
      console.error('dead letter not recorded', type, job.id, e)
    }
    msg.ack()
  }
  for (const [type, n] of byType) {
    try { await alertPlatform(env, type, n) } catch (e) { console.error('dead letter alert failed', type, e) }
  }
}

async function alertPlatform(env: Env, type: string, n: number): Promise<void> {
  const since = new Date(Date.now() - ALERT_EVERY_MS).toISOString()
  const recent = await env.CONTROL.prepare(`SELECT 1 AS x FROM dead_letters WHERE type = ? AND alerted_at > ? LIMIT 1`).bind(type, since).first()
  if (recent) return
  const at = new Date().toISOString()
  await env.CONTROL.prepare(`UPDATE dead_letters SET alerted_at = ? WHERE type = ? AND alerted_at IS NULL`).bind(at, type).run()
  console.error(`dead letters: ${n} job(s) of type ${type} failed every retry`)
  const email = (await platformProviders(env, null)).email
  if (!email?.configured) return
  const admins = (await env.CONTROL.prepare(`SELECT DISTINCT u.email FROM platform_users u JOIN platform_user_roles ur ON ur.user_id = u.id
      WHERE u.status = 'active' AND u.email IS NOT NULL AND ur.role_key IN ('super_admin', 'seller_admin')`).all<{ email: string }>()
    .catch(() => ({ results: [] as { email: string }[] }))).results
  for (const a of admins) {
    await email.send({ to: a.email, dlt: '', subject: `Background job failing: ${type}`,
      body: `${n} "${type}" job(s) failed every retry and were moved to the dead-letter queue at ${at}.\n\n` +
        'They are listed with their last error under Seller → Dead letters (GET /api/v1/seller/dead-letters). ' +
        'No further alert for this job type will be sent for an hour.' }).catch((e) => console.error('dead letter alert', a.email, e))
  }
}
