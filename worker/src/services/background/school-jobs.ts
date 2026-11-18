import { registerJob } from '../jobs'
import { jobSchool, localDate } from './schools'
import { notifyHoldersStmts } from '../../notify_holders'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** 'YYYY-MM-DD' to the '21 Nov' a person reads. */
function prettyDay(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1] ?? ''}`
}

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

/* Three days before a staff birthday, tell whoever runs the office (owner,
   2026-11-18): the school clock's "today + 3", matched on the birth date's
   month-and-day, one notification to every holder of the staff directory. Once
   per birthday per year — source_id carries the date, and the row is skipped
   when it is already there. Runs daily from cron (hr:birthday_reminder). */
registerJob('hr:birthday_reminder', async (env, job) => {
  const { inst, db } = await jobSchool(env, job)
  const target = localDate(inst.timezone, 3)
  const mmdd = target.slice(5) // 'MM-DD'
  const staff = await db.prepare(`SELECT e.id, e.first_name, e.last_name, d.name AS designation
      FROM employees e LEFT JOIN designations d ON d.id = e.designation_id
      WHERE e.status IN ('active','on_leave') AND e.date_of_birth IS NOT NULL
        AND substr(e.date_of_birth, 6, 5) = ?`).bind(mmdd)
    .all<{ id: string; first_name: string; last_name: string | null; designation: string | null }>()
  if (!staff.results.length) return
  const stmts: D1PreparedStatement[] = []
  for (const e of staff.results) {
    const sourceId = `${e.id}:${target}`
    const seen = await db.prepare(`SELECT 1 AS x FROM notifications WHERE institution_id = ? AND source_kind = 'staff.birthday' AND source_id = ? LIMIT 1`)
      .bind(inst.id, sourceId).first()
    if (seen) continue
    const name = `${e.first_name} ${e.last_name ?? ''}`.trim()
    const who = e.designation ? `${name} (${e.designation})` : name
    const title = 'Staff birthday in 3 days'
    const body = `${who}'s birthday is on ${prettyDay(target)} — 3 days away.`
    stmts.push(...await notifyHoldersStmts(db, inst.id, 'hr.employees.read', null, 'staff_birthday', title, body, '/hr/welfare/staff_welfare', 'staff.birthday', sourceId))
  }
  if (stmts.length) await db.batch(stmts)
})
