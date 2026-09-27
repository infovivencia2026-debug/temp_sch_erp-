/* Background work: a job enqueued through the API runs on the queue
   consumer, and the per-minute cron tick records its schedule and enqueues
   what is due. */
import { describe, it, expect, beforeAll } from 'vitest'
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../../src/index'
import type { Job } from '../../src/services/jobs'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed)

async function jobState(id: string, want: string, ms = 8000): Promise<string | undefined> {
  const until = Date.now() + ms
  let state: string | undefined
  while (Date.now() < until) {
    state = (await api('admin', 'GET', `/jobs/${id}`)).body?.state
    if (state === want) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return state
}

describe('queue', () => {
  it('runs a job enqueued through POST /jobs to completion', async () => {
    const { status, body } = await api('admin', 'POST', '/jobs', { type: 'reportcard:generate', payload: { exam_id: IDS.exam, section_id: IDS.section } })
    expect(status).toBe(202)
    expect(body).toMatchObject({ type: 'reportcard:generate', queue: 'bulk', poll_url: `/api/v1/jobs/${body.task_id}` })
    expect(await jobState(body.task_id, 'completed')).toBe('completed')
  })

  it('refuses a job type that is not enqueueable', async () => {
    const { status } = await api('admin', 'POST', '/jobs', { type: 'backup:fanout' })
    expect(status).toBe(400)
  })

  it('acks and archives a message with no handler instead of retrying it', async () => {
    const id = crypto.randomUUID()
    await E.CONTROL.prepare(`INSERT INTO jobs (id, type, queue, state, attempts, max_attempts, created_at, updated_at) VALUES (?, 'nope', 'default', 'pending', 0, 5, ?, ?)`)
      .bind(id, new Date().toISOString(), new Date().toISOString()).run()
    const batch = createMessageBatch<Job>('jobs-test', [{ id: 'm1', timestamp: new Date(), attempts: 1, body: { type: 'nope', payload: {}, institution_id: null, id, enqueued_at: '' } as Job }])
    const ctx = createExecutionContext()
    await worker.queue(batch, E)
    await waitOnExecutionContext(ctx)
    const result = await getQueueResult(batch, ctx)
    expect(result.explicitAcks).toEqual(['m1'])
    const row = await E.CONTROL.prepare('SELECT state FROM jobs WHERE id = ?').bind(id).first<{ state: string }>()
    expect(row?.state).toBe('archived')
  })
})

describe('cron', () => {
  const tick = async (at: Date) => {
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ scheduledTime: at, cron: '* * * * *' }), E, ctx)
    await waitOnExecutionContext(ctx)
  }

  it('records a baseline on the first tick and enqueues what is due on the next', async () => {
    const t0 = new Date(Date.UTC(2026, 8, 28, 3, 59, 30)) // 09:29:30 IST
    await tick(t0)
    const global = (await E.CONTROL.prepare('SELECT name FROM cron_runs').all<{ name: string }>()).results.map((r) => r.name)
    expect(global).toEqual(expect.arrayContaining(['session_prune', 'diary_reminders', 'backup_nightly']))
    const school = (await E.TENANT_TEST.prepare('SELECT name FROM cron_runs').all<{ name: string }>()).results.map((r) => r.name)
    expect(school).toEqual(expect.arrayContaining(['attendance_rollup', 'fee_reminders', 'message_plans']))
    const before = await E.CONTROL.prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'diary:reminders'`).first<{ n: number }>()
    expect(before?.n).toBe(0)

    await tick(new Date(t0.getTime() + 6 * 60_000)) // a */5 boundary has passed
    const after = await E.CONTROL.prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'diary:reminders'`).first<{ n: number }>()
    expect(after?.n).toBe(1)
    const plans = await E.CONTROL.prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'message:plans' AND institution_id = ?`).bind(IDS.school).first<{ n: number }>()
    expect(plans?.n).toBe(1)
  })
})
