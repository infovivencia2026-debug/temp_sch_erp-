import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, forbidden, isUUID, notFound, now, ok, readJSON, uuidParam } from '../../http'
import { can } from '../../identity'
import { fullName, nz, str, todayIST } from '../admissions/util'
import { isDate } from '../fees/common'
import { school } from '../school'

/* Office work handed to a member of staff, and who each person answers to.

   A task is one line: what, who, by when. The person it went to sees it
   under My tasks; HR and the person's reporting manager see the team's; the
   report counts open, overdue and done per person. Nothing here sends a
   message beyond the bell: a task is not a leave request.

   Reporting managers are a column on employees. The leave queue already
   reads it (daily.ts getApprovals) so a manager sees their own people's
   requests without holding the school-wide right. */

const READ = 'hr.employees.read', WRITE = 'hr.employees.write'
const PRIORITIES = new Set(['low', 'normal', 'high'])
const STATUSES = new Set(['open', 'in_progress', 'done', 'cancelled'])

interface Me { id: string }
async function myEmployee(c: Ctx): Promise<Me | null> {
  return c.db.prepare(`SELECT id FROM employees WHERE user_id = ? AND status IN ('active', 'on_leave')`).bind(c.id.userId).first<Me>()
}
const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

export function registerStaffTasks(r: Router): void {
  /* ?for=mine  the signed-in person's own tasks (anybody on the roll)
     ?for=team  people who report to the signed-in person
     otherwise  every task, which needs the HR right. */
  r.get('/hr/tasks', 'auth', async (c) => {
    const q = c.url.searchParams
    const scope = q.get('for') ?? (can(c.id, READ) ? 'all' : 'mine')
    const me = await myEmployee(c)
    if (scope !== 'all' && !me) return ok({ items: [], summary: { open: 0, overdue: 0, done: 0 } })
    if (scope === 'all' && !can(c.id, READ)) throw forbidden('only HR sees every task')
    const status = nz(q.get('status'))
    const where = scope === 'mine' ? 't.assigned_to = ?' : scope === 'team' ? 'e.reports_to = ?' : '1'
    const binds: unknown[] = scope === 'all' ? [] : [me!.id]
    const rows = await c.db.prepare(`
      SELECT t.id, t.title, t.detail, t.due_on, t.priority, t.status, t.done_note, t.done_at, t.created_at,
             e.id AS employee_id, ${fullName('e.first_name', 'e.last_name')} AS assigned_to, e.employee_code,
             u.full_name AS assigned_by
        FROM staff_tasks t JOIN employees e ON e.id = t.assigned_to LEFT JOIN users u ON u.id = t.assigned_by
       WHERE ${where} AND (? IS NULL OR t.status = ?)
       ORDER BY t.status IN ('done', 'cancelled'), t.due_on IS NULL, t.due_on, t.priority = 'low', t.created_at DESC LIMIT 500`)
      .bind(...binds, status, status).all<Record<string, unknown>>()
    const t = todayIST()
    const list = rows.results.map((v) => omitNull({ ...v, overdue: v.status !== 'done' && v.status !== 'cancelled' && !!v.due_on && String(v.due_on) < t } as Record<string, unknown> & { overdue: boolean }))
    const summary = { open: 0, overdue: 0, done: 0 }
    for (const v of list) {
      if (v.status === 'done') summary.done++
      else if (v.status !== 'cancelled') { summary.open++; if (v.overdue) summary.overdue++ }
    }
    return ok({ items: list, summary })
  })

  /* Hand a task to somebody. HR may hand one to anyone; a reporting manager
     to their own people. */
  r.post('/hr/tasks', 'auth', async (c) => {
    const req = await readJSON<{ title?: unknown; detail?: unknown; assigned_to?: unknown; due_on?: unknown; priority?: unknown }>(c.req)
    const title = str(req.title).trim()
    if (title === '') throw badRequest('say what the task is')
    if (title.length > 200) throw badRequest('keep the title under 200 characters; the detail box takes the rest')
    const to = str(req.assigned_to)
    if (!isUUID(to)) throw badRequest('assigned_to must name a member of staff')
    const due = nz(str(req.due_on))
    if (due !== null && !isDate(due)) throw badRequest('due_on must be YYYY-MM-DD')
    const priority = str(req.priority) || 'normal'
    if (!PRIORITIES.has(priority)) throw badRequest('priority is low, normal or high')
    const target = await c.db.prepare(`SELECT id, reports_to FROM employees WHERE id = ? AND status IN ('active', 'on_leave')`).bind(to)
      .first<{ id: string; reports_to: string | null }>()
    if (!target) throw badRequest('no member of staff on the roll with that id')
    if (!can(c.id, WRITE)) {
      const me = await myEmployee(c)
      if (!me || target.reports_to !== me.id) throw forbidden('you can hand tasks only to people who report to you')
    }
    const id = crypto.randomUUID(), t = now()
    await c.db.prepare(`INSERT INTO staff_tasks (id, institution_id, title, detail, assigned_to, assigned_by, due_on, priority, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,'open',?,?)`)
      .bind(id, school(c).id, title, nz(str(req.detail)), target.id, c.id.userId, due, priority, t, t).run()
    return created({ id, status: 'open' })
  })

  /* Move a task along. The assignee may start or finish their own; HR and
     the manager who gave it may do anything, including cancel. */
  r.post('/hr/tasks/{id}/status', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ status?: unknown; note?: unknown }>(c.req)
    const status = str(req.status)
    if (!STATUSES.has(status)) throw badRequest('status is open, in_progress, done or cancelled')
    const task = await c.db.prepare(`SELECT t.assigned_to, t.assigned_by, t.status, e.reports_to FROM staff_tasks t JOIN employees e ON e.id = t.assigned_to WHERE t.id = ?`)
      .bind(id).first<{ assigned_to: string; assigned_by: string | null; status: string; reports_to: string | null }>()
    if (!task) throw notFound()
    const me = await myEmployee(c)
    const mine = !!me && me.id === task.assigned_to
    const manages = !!me && me.id === task.reports_to
    const gave = task.assigned_by === c.id.userId
    if (!(can(c.id, WRITE) || manages || gave || mine)) throw forbidden('this task is not yours')
    if (mine && !(can(c.id, WRITE) || manages || gave) && status === 'cancelled') throw forbidden('only whoever gave the task can cancel it')
    if (task.status === 'cancelled') throw new HttpError(409, 'this task was cancelled', { code: 'cancelled' })
    const t = now()
    const done = status === 'done' ? t : null
    await c.db.prepare(`UPDATE staff_tasks SET status = ?, done_note = COALESCE(?, done_note), done_at = ?, updated_at = ? WHERE id = ?`)
      .bind(status, nz(str(req.note)), done, t, id).run()
    return ok({ id, status })
  })

  /* The report: per person, how many tasks are open, overdue and done. */
  r.get('/hr/tasks/report', READ, async (c) => {
    const t = todayIST()
    const rows = await c.db.prepare(`
      SELECT e.id AS employee_id, ${fullName('e.first_name', 'e.last_name')} AS full_name, e.employee_code, d.name AS department,
             SUM(CASE WHEN t.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS open,
             SUM(CASE WHEN t.status IN ('open', 'in_progress') AND t.due_on IS NOT NULL AND t.due_on < ? THEN 1 ELSE 0 END) AS overdue,
             SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
             MIN(CASE WHEN t.status IN ('open', 'in_progress') THEN t.due_on END) AS next_due
        FROM employees e JOIN staff_tasks t ON t.assigned_to = e.id LEFT JOIN departments d ON d.id = e.department_id
       GROUP BY e.id ORDER BY overdue DESC, open DESC, full_name`).bind(t).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  // --- reporting managers ------------------------------------------------------

  r.get('/hr/reporting-managers', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT e.id, ${fullName('e.first_name', 'e.last_name')} AS full_name, e.employee_code, d.name AS department, des.name AS designation,
             e.reports_to, ${fullName('m.first_name', 'm.last_name')} AS manager_name, m.employee_code AS manager_code,
             (SELECT COUNT(*) FROM employees x WHERE x.reports_to = e.id AND x.status IN ('active', 'on_leave')) AS reports
        FROM employees e
        LEFT JOIN employees m ON m.id = e.reports_to
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN designations des ON des.id = e.designation_id
       WHERE e.status IN ('active', 'on_leave')
       ORDER BY d.name, full_name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.put('/hr/employees/{id}/reporting-manager', WRITE, async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ reports_to?: unknown }>(c.req)
    const to = nz(str(req.reports_to))
    if (to !== null && !isUUID(to)) throw badRequest('reports_to must name a member of staff, or be empty to clear it')
    if (to === id) throw badRequest('nobody reports to themselves')
    const who = await c.db.prepare(`SELECT id FROM employees WHERE id = ?`).bind(id).first()
    if (!who) throw notFound()
    if (to !== null) {
      const mgr = await c.db.prepare(`SELECT id, reports_to FROM employees WHERE id = ? AND status IN ('active', 'on_leave')`).bind(to)
        .first<{ id: string; reports_to: string | null }>()
      if (!mgr) throw badRequest('no member of staff on the roll with that id')
      /* A loop would send a leave request round for ever. Walk up from the
         manager; if we reach the person being assigned, refuse. */
      let cur = mgr.reports_to, hops = 0
      while (cur && hops++ < 50) {
        if (cur === id) throw badRequest('that would make these two report to each other')
        const up = await c.db.prepare(`SELECT reports_to FROM employees WHERE id = ?`).bind(cur).first<{ reports_to: string | null }>()
        cur = up?.reports_to ?? null
      }
    }
    await c.db.prepare(`UPDATE employees SET reports_to = ?, updated_at = ? WHERE id = ?`).bind(to, now(), id).run()
    return ok({ id, reports_to: to })
  })
}
