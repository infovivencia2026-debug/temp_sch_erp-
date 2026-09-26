import { registerJob } from '../jobs'
import { jobSchool, localDate } from './schools'

/* The per-school jobs from internal/queue/worker.go. In Go every one of
   these bodies was "the minimum that exercises the plumbing": a count and a
   log line, with the real work left for later. They are ported as exactly
   that, so enqueueing them from POST /jobs behaves as it did. */

registerJob<{ exam_id?: string; section_id?: string }>('reportcard:generate', async (env, job) => {
  const { db } = await jobSchool(env, job)
  const r = await db.prepare(`SELECT count(*) AS n FROM enrollments WHERE section_id = ? AND status = 'active'`)
    .bind(job.payload.section_id ?? '').first<{ n: number }>()
  console.log('report cards queued for render', { exam_id: job.payload.exam_id, students: r?.n ?? 0 })
})

registerJob<{ fee_structure_id?: string; academic_year_id?: string }>('invoice:generate', async (env, job) => {
  const { db } = await jobSchool(env, job)
  const r = await db.prepare(`SELECT count(*) AS n FROM enrollments WHERE academic_year_id = ? AND status = 'active'`)
    .bind(job.payload.academic_year_id ?? '').first<{ n: number }>()
  console.log('invoice run', { fee_structure_id: job.payload.fee_structure_id, students: r?.n ?? 0 })
})

registerJob<{ overdue_since?: string; template_key?: string }>('fee:reminder_fanout', async (env, job) => {
  const { db } = await jobSchool(env, job)
  const since = (job.payload.overdue_since ?? new Date().toISOString()).slice(0, 10)
  const r = await db.prepare(`SELECT count(*) AS n FROM invoices
      WHERE status IN ('unpaid','partial','overdue') AND due_on < ?`).bind(since).first<{ n: number }>()
  console.log('fee reminder fanout', { overdue_invoices: r?.n ?? 0, template: job.payload.template_key })
})

registerJob<{ kind?: string; file_key?: string }>('bulk:import', async (_env, job) => {
  console.log('bulk import', { kind: job.payload.kind, file_key: job.payload.file_key })
})

registerJob<{ kind?: string; format?: string }>('export:build', async (_env, job) => {
  console.log('export build', { kind: job.payload.kind, format: job.payload.format })
})

registerJob<{ on?: string }>('attendance:rollup', async (env, job) => {
  const { inst, db } = await jobSchool(env, job)
  // The cron entry sends no date; the day that just closed, in the school's clock.
  const on = job.payload.on ? job.payload.on.slice(0, 10) : localDate(inst.timezone, -1)
  const r = await db.prepare(`SELECT count(*) AS n FROM student_attendance WHERE on_date = ?`).bind(on).first<{ n: number }>()
  console.log('attendance rollup', { on, rows: r?.n ?? 0 })
})
