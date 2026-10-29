import { registerJob } from '../jobs'
import { jobSchool } from './schools'
import { staffHolidayRows, isStaffHoliday, teachingUsers } from '../../routes/hr/staff_holidays'
import { staffGroupMemberIds } from '../../routes/growth/people'

/* STAFF AUTO-ABSENT (owner, 2026-10-26): at the school's set time (18:00 by
   default, in the school's own time zone) every active member of staff with
   no punch and no attendance mark for the day is marked absent, source
   'auto_absent'. Off unless the school switches it on (module_settings
   'staff_auto_absent', config.time "HH:MM"; registry keys
   staff.auto_absent / staff.auto_absent_time).

   Skipped: the person's holiday (the staff holiday calendar, a Working day
   entry cancelling it), their weekly off (their work pattern, else the
   school's default pattern, else Monday to Saturday), approved leave covering
   the day (half-day included: no punch on a half day is not an absence),
   a pending or approved attendance request for the day, a pending or
   approved on-duty request (leave_requests kind 'on_duty') covering the day, and anyone who
   already has a mark of any kind (manual, device, on duty...). Nothing is
   ever overwritten: INSERT OR IGNORE on (user_id, on_date). A manual mark
   later simply replaces the auto one like any other mark.

   Runs once per school per day: the day done is remembered in the school's
   cron_runs under DONE_KEY, so a retry or a later tick that day does
   nothing, and an auto mark the office deletes is not put back. */

export const AUTO_ABSENT_MODULE = 'staff_auto_absent'
const DONE_KEY = 'staff_auto_absent:done'
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function localParts(tz: string, at: number): { day: string; hm: string; offMin: number } {
  let p: Record<string, string>
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]))
  } catch {
    return localParts('UTC', at)
  }
  const offMin = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at / 60_000) * 60_000) / 60_000)
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, offMin }
}

export interface AutoAbsentResult { ran: boolean; reason?: string; day?: string; marked: number }

export async function runStaffAutoAbsent(db: D1Database, institutionId: string, tz: string, at: number = Date.now()): Promise<AutoAbsentResult> {
  const s = await db.prepare(`SELECT enabled, config FROM module_settings WHERE module = ?`).bind(AUTO_ABSENT_MODULE).first<{ enabled: number; config: string }>()
  if (!s?.enabled) return { ran: false, reason: 'off', marked: 0 }
  let time = '18:00'
  try { const t = JSON.parse(s.config || '{}').time; if (typeof t === 'string' && TIME.test(t)) time = t } catch { /* default */ }
  const { day, hm, offMin } = localParts(tz, at)
  if (hm < time) return { ran: false, reason: 'not yet', day, marked: 0 }
  const done = await db.prepare(`SELECT last_run_at FROM cron_runs WHERE name = ?`).bind(DONE_KEY).first<{ last_run_at: string }>()
  if (done?.last_run_at === day) return { ran: false, reason: 'done', day, marked: 0 }

  const dow = new Date(day + 'T00:00:00Z').getUTCDay() || 7
  const shift = `${offMin >= 0 ? '+' : ''}${offMin} minutes`
  const emps = await db.prepare(`
      SELECT e.id, e.user_id, COALESCE(wp.working_days, dp.working_days, '[1,2,3,4,5,6]') AS working_days
        FROM employees e
        LEFT JOIN work_patterns wp ON wp.id = e.work_pattern_id
        LEFT JOIN (SELECT working_days FROM work_patterns WHERE is_default = 1 LIMIT 1) dp
       WHERE e.status = 'active' AND e.user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM staff_attendance sa WHERE sa.user_id = e.user_id AND sa.on_date = ?1)
         AND NOT EXISTS (SELECT 1 FROM biometric_punches p WHERE p.employee_id = e.id AND date(datetime(p.punched_at, ?2)) = ?1)
         AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.employee_id = e.id
               AND ((l.status = 'approved' AND COALESCE(l.kind, 'leave') IN ('leave', 'comp_off', 'on_duty'))
                    OR (l.status = 'pending' AND l.kind = 'on_duty')) AND ?1 BETWEEN substr(l.from_date, 1, 10) AND substr(l.to_date, 1, 10))
         AND NOT EXISTS (SELECT 1 FROM staff_attendance_requests r WHERE r.employee_id = e.id AND r.on_date = ?1 AND r.status IN ('pending', 'approved'))`)
    .bind(day, shift).all<{ id: string; user_id: string; working_days: string }>()

  const rows = await staffHolidayRows(db, day, day)
  const teachers = rows.length ? await teachingUsers(db) : new Set<string>()
  const groups = new Map<string, Set<string>>()
  for (const h of rows) if (h.applies_to.startsWith('group:') && !groups.has(h.applies_to.slice(6))) groups.set(h.applies_to.slice(6), await staffGroupMemberIds(db, h.applies_to.slice(6)))
  const nowIso = new Date(at).toISOString()
  const stmts: D1PreparedStatement[] = []
  for (const e of emps.results) {
    if (isStaffHoliday(rows, day, teachers.has(e.user_id), e.id, groups)) continue
    let days: number[] = []
    try { days = (JSON.parse(e.working_days) as unknown[]).map(Number) } catch { days = [1, 2, 3, 4, 5, 6] }
    const workingDayEntry = rows.some((h) => h.kind === 'working_day' && day >= h.on_date && day <= h.to_date)
    if (!days.includes(dow) && !workingDayEntry) continue
    stmts.push(db.prepare(`INSERT OR IGNORE INTO staff_attendance (id, institution_id, user_id, on_date, status, source, remarks, created_at)
        VALUES (?, ?, ?, ?, 'absent', 'auto_absent', ?, ?)`)
      .bind(crypto.randomUUID(), institutionId, e.user_id, day, `No punch by ${time}`, nowIso))
  }
  stmts.push(db.prepare(`INSERT INTO cron_runs (name, last_run_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at`).bind(DONE_KEY, day))
  const res = await db.batch(stmts)
  const marked = res.slice(0, -1).reduce((n, r) => n + (r.meta?.changes ?? 0), 0)
  return { ran: true, day, marked }
}

registerJob<Record<string, unknown>>('staff:auto_absent', async (env, job) => {
  const { inst, db } = await jobSchool(env, job)
  const r = await runStaffAutoAbsent(db, inst.id, inst.timezone)
  if (r.ran) console.log('staff auto-absent', { school: inst.slug, day: r.day, marked: r.marked })
})
