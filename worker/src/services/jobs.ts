import type { Env } from '../env'

/* Background jobs on Cloudflare Queues, replacing River (internal/queue).

   One queue (school-erp-jobs), many job types. A job is {type, payload,
   institution_id?}. Producers call enqueue(); the Worker's queue() handler
   (src/index.ts) hands each message to runBatch(), which finds the handler
   registered for its type. A handler that throws is retried by the queue
   (max_retries in wrangler.jsonc) and then lands in the dead-letter queue.

   Handlers register themselves at module load via registerJob(); every
   module that registers one is imported from src/services/job-registry.ts,
   which src/index.ts imports, so the table is complete before any batch
   runs. */

export interface Job<P = Record<string, unknown>> {
  type: string
  payload: P
  /** The school the job belongs to, when it has one. */
  institution_id?: string | null
  /** Set by enqueue(); handlers may use it for idempotency. */
  id?: string
  enqueued_at?: string
}

export type JobHandler<P = any> = (env: Env, job: Job<P>) => Promise<void>

const handlers = new Map<string, JobHandler>()

export function registerJob<P>(type: string, fn: JobHandler<P>): void {
  if (handlers.has(type)) throw new Error(`job type registered twice: ${type}`)
  handlers.set(type, fn as JobHandler)
}

export function jobTypes(): string[] {
  return [...handlers.keys()].sort()
}

/* Job state, in CONTROL.jobs, so GET /jobs/{id} and /jobs/queues can answer
   what River's inspector answered. Best effort: a failure to record never
   stops the job itself from being queued or run. */

/** Which of the Go server's four queues a type belonged to, for the stats
    screen. Anything unlisted is 'default'. */
const QUEUE_OF: Record<string, string> = {
  'reportcard:generate': 'bulk', 'invoice:generate': 'bulk', 'fee:reminder_fanout': 'bulk',
  'bulk:import': 'bulk', 'export:build': 'bulk',
  'message:send': 'critical', 'message.send': 'critical',
  'attendance:rollup': 'low', 'session:prune': 'low', 'report:digest_daily': 'low',
  'report:digest_weekly': 'low', 'transport:trip_timeout': 'low',
  'transport:position_retention': 'low', 'security:retention': 'low',
}
export const QUEUES = ['critical', 'default', 'bulk', 'low'] as const
export const queueOf = (type: string) => QUEUE_OF[type] ?? 'default'
/** Deliveries a job gets: the first plus max_retries in wrangler.jsonc. */
const MAX_ATTEMPTS = 6

/** Throw (or wrap) this when retrying cannot help: the job is archived at once. */
export class SkipRetry extends Error {}

function recordRow(id: string, type: string, inst: string | null | undefined, at: string) {
  return [id, type, queueOf(type), inst ?? null, MAX_ATTEMPTS, at, at]
}
const INSERT_JOB = `INSERT OR IGNORE INTO jobs (id, type, queue, institution_id, state, attempts, max_attempts, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`

async function setState(env: Env, id: string | undefined, state: string, attempts: number, err?: unknown) {
  if (!id) return
  const at = new Date().toISOString()
  const done = state === 'completed' || state === 'archived'
  try {
    await env.CONTROL.prepare(`UPDATE jobs SET state = ?, attempts = ?, last_error = COALESCE(?, last_error),
        updated_at = ?, finished_at = ? WHERE id = ?`)
      .bind(state, attempts, err === undefined ? null : String(err instanceof Error ? err.message : err).slice(0, 2000),
        at, done ? at : null, id).run()
  } catch (e) {
    console.error('job: state not recorded', id, e)
  }
}

export async function enqueue<P>(env: Env, type: string, payload: P,
  opts: { institution_id?: string | null; delaySeconds?: number } = {}): Promise<string> {
  const id = crypto.randomUUID()
  const at = new Date().toISOString()
  const job: Job<P> = { type, payload, institution_id: opts.institution_id ?? null, id, enqueued_at: at }
  try {
    await env.CONTROL.prepare(INSERT_JOB).bind(...recordRow(id, type, job.institution_id, at)).run()
  } catch (e) {
    console.error('job: not recorded', type, e)
  }
  await env.JOBS.send(job, opts.delaySeconds ? { delaySeconds: Math.min(opts.delaySeconds, 43200) } : undefined)
  return id
}

/** Many jobs in one call (max 100 per sendBatch). */
export async function enqueueMany<P>(env: Env, jobs: { type: string; payload: P; institution_id?: string | null }[]): Promise<void> {
  for (let i = 0; i < jobs.length; i += 100) {
    const at = new Date().toISOString()
    const bodies = jobs.slice(i, i + 100).map((j) => ({ ...j, institution_id: j.institution_id ?? null, id: crypto.randomUUID(), enqueued_at: at }))
    try {
      const st = env.CONTROL.prepare(INSERT_JOB)
      await env.CONTROL.batch(bodies.map((b) => st.bind(...recordRow(b.id, b.type, b.institution_id, at))))
    } catch (e) {
      console.error('job: batch not recorded', e)
    }
    await env.JOBS.sendBatch(bodies.map((body) => ({ body })))
  }
}

export async function runBatch(batch: MessageBatch<Job>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body
    const fn = handlers.get(job?.type)
    if (!fn) {
      console.error('job: no handler for type', job?.type)
      await setState(env, job?.id, 'archived', msg.attempts, 'no handler for type ' + job?.type)
      msg.ack() // unknown type: retrying cannot help
      continue
    }
    await setState(env, job.id, 'active', msg.attempts)
    try {
      await fn(env, job)
      await setState(env, job.id, 'completed', msg.attempts)
      msg.ack()
    } catch (err) {
      console.error('job failed', job.type, job.id, err)
      if (err instanceof SkipRetry || msg.attempts >= MAX_ATTEMPTS) {
        // SkipRetry, or the last delivery: the queue sends it to the DLQ.
        await setState(env, job.id, 'archived', msg.attempts, err)
        if (err instanceof SkipRetry) { msg.ack(); continue }
      } else {
        await setState(env, job.id, 'retry', msg.attempts, err)
      }
      msg.retry({ delaySeconds: Math.min(30 * 2 ** (msg.attempts - 1), 3600) })
    }
  }
}
