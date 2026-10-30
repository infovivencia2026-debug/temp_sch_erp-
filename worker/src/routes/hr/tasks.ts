import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, forbidden, isUUID, notFound, now, ok, readJSON, uuidParam } from '../../http'
import { can } from '../../identity'
import { fullName, nz, str, todayIST } from '../admissions/util'
import { isDate } from '../fees/common'
import { school } from '../school'

/* Office work handed to a member of staff, and who each person answers to.

   A task moves To do (open) -> In progress -> Review -> Done. Work handed
   over by somebody else goes back to them when it is finished: they accept
   it (Done) or send it back with a note (In progress again). A task someone
   sets themselves is done when they say so. HR, the person's reporting
   manager and whoever gave the task may edit it, reassign it or cancel it;
   the person it went to starts it, comments on it and hands it in. Every step
   is kept in staff_task_updates and told to the other side by the bell.

   Reporting managers are a column on employees. The leave queue already
   reads it (daily.ts getApprovals) so a manager sees their own people's
   requests without holding the school-wide right. */

const READ = 'hr.employees.read', WRITE = 'hr.employees.write'
const PRIORITIES = new Set(['low', 'normal', 'high'])
const LIVE = ['open', 'in_progress', 'review']

interface Me { id: string }
async function myEmployee(c: Ctx): Promise<Me | null> {
  return c.db.prepare(`SELECT id FROM employees WHERE user_id = ? AND status IN ('active', 'on_leave')`).bind(c.id.userId).first<Me>()
}
const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

interface TaskRow { id: string; title: string; status: string; assigned_to: string; assigned_by: string | null; reports_to: string | null; assignee_user: string | null }
async function loadTask(c: Ctx, id: string) {
  const t = await c.db.prepare(`SELECT t.id, t.title, t.status, t.assigned_to, t.assigned_by, e.reports_to, e.user_id AS assignee_user
      FROM staff_tasks t JOIN employees e ON e.id = t.assigned_to WHERE t.id = ?`).bind(id).first<TaskRow>()
  if (!t) throw notFound()
  const me = await myEmployee(c)
  const mine = !!me && me.id === t.assigned_to
  /* Who may steer it: HR, the person's manager, whoever gave it. */
  const manage = can(c.id, WRITE) || (!!me && me.id === t.reports_to) || t.assigned_by === c.id.userId
  if (!mine && !manage && !can(c.id, READ)) throw notFound()
  /* Handed over by somebody else: finishing it is handing it in for review. */
  const reviewed = !!t.assigned_by && t.assigned_by !== t.assignee_user
  return { t, mine, manage, reviewed }
}

const logStmt = (c: Ctx, task: string, kind: string, note: string | null) =>
  c.db.prepare(`INSERT INTO staff_task_updates (id, institution_id, task_id, by_user, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), school(c).id, task, c.id.userId, kind, note, now())

/* One bell entry per person, event and task; a repeat refreshes it. */
const tellStmt = (c: Ctx, user: string | null, kind: string, title: string, body: string, task: string) =>
  !user || user === c.id.userId ? [] : [c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, source_kind, source_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'staff_task', ?, ?)
      ON CONFLICT (user_id, kind, COALESCE(source_id, '00000000-0000-0000-0000-000000000000'), COALESCE(student_id, '00000000-0000-0000-0000-000000000000'))
        WHERE source_kind IS NOT NULL
      DO UPDATE SET title = excluded.title, body = excluded.body, created_at = excluded.created_at, read_at = NULL, dismissed_at = NULL`)
    .bind(crypto.randomUUID(), school(c).id, user, kind, title, body, `/go/tasks?task=${task}`, task, now())]

export function registerStaffTasks(r: Router): void {
  /* ?for=mine  the signed-in person's own tasks (anybody on the roll)
     ?for=team  people who report to the signed-in person, and tasks they gave
     otherwise  every task, which needs the HR right.
     Narrowed by status, priority, assignee, due (overdue | week) and q. */
  r.get('/hr/tasks', 'auth', async (c) => {
    const q = c.url.searchParams
    const scope = q.get('for') ?? (can(c.id, READ) ? 'all' : 'mine')
    const me = await myEmployee(c)
    const empty = { items: [], summary: { open: 0, in_progress: 0, review: 0, overdue: 0, done: 0 } }
    if (scope === 'mine' && !me) return ok(empty)
    if (scope === 'all' && !can(c.id, READ)) throw forbidden('only HR sees every task')
    const t = todayIST()
    const where = scope === 'mine' ? 't.assigned_to = ?1' : scope === 'team' ? '(e.reports_to = ?1 OR t.assigned_by = ?2)' : '1'
    const status = nz(q.get('status')), priority = nz(q.get('priority')), who = nz(q.get('assignee')), due = nz(q.get('due'))
    const text = (q.get('q') ?? '').trim().replace(/[%_]/g, '').slice(0, 80)
    if (priority !== null && !PRIORITIES.has(priority)) throw badRequest('priority is low, normal or high')
    if (who !== null && !isUUID(who)) throw badRequest('assignee must name a member of staff')
    if (due !== null && due !== 'overdue' && due !== 'week') throw badRequest('due is overdue or week')
    const rows = await c.db.prepare(`
      SELECT t.id, t.title, t.detail, t.due_on, t.priority, t.status, t.done_note, t.done_at, t.created_at, t.updated_at,
             e.id AS employee_id, ${fullName('e.first_name', 'e.last_name')} AS assigned_to, e.employee_code, e.user_id AS assignee_user,
             e.reports_to, t.assigned_by AS assigned_by_id, u.full_name AS assigned_by,
             (SELECT COUNT(*) FROM staff_task_updates x WHERE x.task_id = t.id AND x.kind = 'comment') AS comments
        FROM staff_tasks t JOIN employees e ON e.id = t.assigned_to LEFT JOIN users u ON u.id = t.assigned_by
       WHERE ${where}
         AND (?3 IS NULL OR t.status = ?3) AND (?4 IS NULL OR t.priority = ?4) AND (?5 IS NULL OR t.assigned_to = ?5)
         AND (?6 IS NULL OR (t.status IN ('open', 'in_progress', 'review') AND t.due_on IS NOT NULL
               AND ((?6 = 'overdue' AND t.due_on < ?7) OR (?6 = 'week' AND t.due_on >= ?7 AND t.due_on <= date(?7, '+7 days')))))
         AND (?8 = '' OR t.title LIKE '%' || ?8 || '%' OR t.detail LIKE '%' || ?8 || '%' OR ${fullName('e.first_name', 'e.last_name')} LIKE '%' || ?8 || '%')
       ORDER BY t.status IN ('done', 'cancelled'), t.due_on IS NULL, t.due_on, t.priority = 'low', t.priority <> 'high', t.created_at DESC LIMIT 500`)
      .bind(me?.id ?? '', c.id.userId, status, priority, who, due, t, text).all<Record<string, unknown>>()
    const hr = can(c.id, WRITE)
    const list = rows.results.map((v) => {
      const mine = !!me && v.employee_id === me.id
      const manage = hr || (!!me && v.reports_to === me.id) || v.assigned_by_id === c.id.userId
      const reviewed = !!v.assigned_by_id && v.assigned_by_id !== v.assignee_user
      const { assignee_user: _a, reports_to: _r, assigned_by_id: _b, ...row } = v
      return omitNull<Record<string, unknown>>({ ...row, mine, manage, reviewed, comments: Number(v.comments ?? 0),
        overdue: LIVE.includes(String(v.status)) && !!v.due_on && String(v.due_on) < t })
    })
    const summary = { open: 0, in_progress: 0, review: 0, overdue: 0, done: 0 }
    for (const v of list) {
      const st = String(v.status)
      if (st === 'open' || st === 'in_progress' || st === 'review' || st === 'done') summary[st]++
      if (v.overdue) summary.overdue++
    }
    return ok({ items: list, summary })
  })

  /* Hand a task to somebody. HR may hand one to anyone; a reporting manager
     to their own people; anybody to themselves. */
  r.post('/hr/tasks', 'auth', async (c) => {
    const req = await readJSON<{ title?: unknown; detail?: unknown; assigned_to?: unknown; due_on?: unknown; priority?: unknown }>(c.req)
    const title = str(req.title).trim()
    if (title === '') throw badRequest('say what the task is')
    if (title.length > 200) throw badRequest('keep the title under 200 characters; the detail box takes the rest')
    /* No assignee: a personal to-do for the signed-in member of staff. */
    let to = str(req.assigned_to)
    if (to === '') {
      const self = await myEmployee(c)
      if (!self) throw forbidden('only somebody on the staff roll can keep tasks')
      to = self.id
    }
    if (!isUUID(to)) throw badRequest('assigned_to must name a member of staff')
    const due = nz(str(req.due_on))
    if (due !== null && !isDate(due)) throw badRequest('due_on must be YYYY-MM-DD')
    const priority = str(req.priority) || 'normal'
    if (!PRIORITIES.has(priority)) throw badRequest('priority is low, normal or high')
    const target = await c.db.prepare(`SELECT id, reports_to, user_id FROM employees WHERE id = ? AND status IN ('active', 'on_leave')`).bind(to)
      .first<{ id: string; reports_to: string | null; user_id: string | null }>()
    if (!target) throw badRequest('no member of staff on the roll with that id')
    const me = await myEmployee(c)
    if (!can(c.id, WRITE) && !(me && (target.reports_to === me.id || target.id === me.id))) throw forbidden('you can hand tasks only to people who report to you, or to yourself')
    const id = crypto.randomUUID(), t = now()
    await c.db.batch([
      c.db.prepare(`INSERT INTO staff_tasks (id, institution_id, title, detail, assigned_to, assigned_by, due_on, priority, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,'open',?,?)`)
        .bind(id, school(c).id, title, nz(str(req.detail)), target.id, c.id.userId, due, priority, t, t),
      logStmt(c, id, 'created', null),
      ...tellStmt(c, target.user_id, 'staff_task_given', 'New task: ' + title, due ? `Due ${due}.` : 'No due date.', id),
    ])
    return created({ id, status: 'open' })
  })

  /* Edit, reassign or re-date a task: whoever steers it. */
  r.patch('/hr/tasks/{id}', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const { t, manage } = await loadTask(c, id)
    if (!manage) throw forbidden('only whoever gave the task, the manager or HR can change it')
    if (t.status === 'done' || t.status === 'cancelled') throw new HttpError(409, 'this task is finished; give a new one instead', { code: 'finished' })
    const req = await readJSON<{ title?: unknown; detail?: unknown; due_on?: unknown; priority?: unknown; assigned_to?: unknown }>(c.req)
    const sets: string[] = [], args: unknown[] = []
    if (req.title !== undefined) {
      const v = str(req.title).trim()
      if (v === '' || v.length > 200) throw badRequest('say what the task is, under 200 characters')
      sets.push('title = ?'); args.push(v)
    }
    if (req.detail !== undefined) { sets.push('detail = ?'); args.push(nz(str(req.detail))) }
    if (req.due_on !== undefined) {
      const v = nz(str(req.due_on))
      if (v !== null && !isDate(v)) throw badRequest('due_on must be YYYY-MM-DD')
      sets.push('due_on = ?'); args.push(v)
    }
    if (req.priority !== undefined) {
      const v = str(req.priority)
      if (!PRIORITIES.has(v)) throw badRequest('priority is low, normal or high')
      sets.push('priority = ?'); args.push(v)
    }
    let newUser: string | null = null
    if (req.assigned_to !== undefined && str(req.assigned_to) !== t.assigned_to) {
      const to = str(req.assigned_to)
      if (!isUUID(to)) throw badRequest('assigned_to must name a member of staff')
      const target = await c.db.prepare(`SELECT id, reports_to, user_id FROM employees WHERE id = ? AND status IN ('active', 'on_leave')`).bind(to)
        .first<{ id: string; reports_to: string | null; user_id: string | null }>()
      if (!target) throw badRequest('no member of staff on the roll with that id')
      const me = await myEmployee(c)
      if (!can(c.id, WRITE) && !(me && target.reports_to === me.id)) throw forbidden('you can hand tasks only to people who report to you')
      sets.push('assigned_to = ?'); args.push(target.id)
      newUser = target.user_id
    }
    if (!sets.length) throw badRequest('nothing to change')
    await c.db.batch([
      c.db.prepare(`UPDATE staff_tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, now(), id),
      logStmt(c, id, newUser !== null ? 'reassigned' : 'edited', null),
      ...(newUser !== null ? tellStmt(c, newUser, 'staff_task_given', 'New task: ' + (str(req.title).trim() || t.title), 'Handed over to you.', id) : []),
    ])
    return ok({ id })
  })

  /* Delete a task: one's own to-do (set by oneself, for oneself), or HR. */
  r.del('/hr/tasks/{id}', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const { t, mine } = await loadTask(c, id)
    const own = mine && t.assigned_by === c.id.userId
    if (!own && !can(c.id, WRITE)) throw forbidden('you can delete only the tasks you set yourself')
    await c.db.batch([
      c.db.prepare(`DELETE FROM notifications WHERE source_kind = 'staff_task' AND source_id = ?`).bind(id),
      c.db.prepare(`DELETE FROM staff_task_updates WHERE task_id = ?`).bind(id),
      c.db.prepare(`DELETE FROM staff_tasks WHERE id = ?`).bind(id),
    ])
    return ok({ id, deleted: true })
  })

  /* A word on the task from anyone it concerns. */
  r.post('/hr/tasks/{id}/comments', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const { t, mine, manage } = await loadTask(c, id)
    if (!mine && !manage) throw forbidden('only the people on this task can comment')
    const note = str((await readJSON<{ note?: unknown }>(c.req)).note).trim()
    if (note === '') throw badRequest('write the comment')
    if (note.length > 2000) throw badRequest('keep a comment under 2000 characters')
    const other = mine ? t.assigned_by : t.assignee_user
    await c.db.batch([logStmt(c, id, 'comment', note), ...tellStmt(c, other, 'staff_task_comment', 'Comment on: ' + t.title, note.slice(0, 160), id)])
    return created({ id })
  })

  /* Move a task along the pipeline.
       start   open -> in_progress                  the person it went to, or whoever steers it
       finish  -> review (handed over) or done      the person it went to
       accept  review -> done                       whoever steers it
       return  review -> in_progress, with a note   whoever steers it
       reopen  done -> in_progress                  whoever steers it
       cancel  any live -> cancelled                whoever steers it
     The older body ({status}) is still read: done means finish, in_progress start. */
  r.post('/hr/tasks/{id}/status', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ status?: unknown; action?: unknown; note?: unknown }>(c.req)
    const legacy: Record<string, string> = { in_progress: 'start', done: 'finish', cancelled: 'cancel' }
    const action = str(req.action) || legacy[str(req.status)] || ''
    const note = nz(str(req.note).trim())
    const { t, mine, manage, reviewed } = await loadTask(c, id)
    if (!mine && !manage) throw forbidden('this task is not yours')
    if (t.status === 'cancelled') throw new HttpError(409, 'this task was cancelled', { code: 'cancelled' })
    const stale = () => new HttpError(409, `this task is ${t.status.replace('_', ' ')}; reload to see where it is`, { code: 'stale' })
    let next: string, kind: string
    const tell: D1PreparedStatement[] = []
    switch (action) {
      case 'start':
        if (t.status !== 'open') throw stale()
        next = 'in_progress'; kind = 'started'
        break
      case 'finish':
        if (t.status !== 'open' && t.status !== 'in_progress') throw stale()
        if (reviewed && mine && !manage) {
          next = 'review'; kind = 'submitted'
          tell.push(...tellStmt(c, t.assigned_by, 'staff_task_review', 'Ready for you to check: ' + t.title, note ?? 'Marked finished.', id))
        } else { next = 'done'; kind = 'accepted' }
        break
      case 'accept':
        if (!manage) throw forbidden('only whoever gave the task, the manager or HR can accept it')
        if (t.status !== 'review') throw stale()
        next = 'done'; kind = 'accepted'
        tell.push(...tellStmt(c, t.assignee_user, 'staff_task_done', 'Accepted: ' + t.title, note ?? 'Marked done.', id))
        break
      case 'return':
        if (!manage) throw forbidden('only whoever gave the task, the manager or HR can send it back')
        if (t.status !== 'review') throw stale()
        if (!note) throw badRequest('say what still needs doing, so they know')
        next = 'in_progress'; kind = 'returned'
        tell.push(...tellStmt(c, t.assignee_user, 'staff_task_returned', 'Sent back: ' + t.title, note, id))
        break
      case 'reopen':
        if (!manage) throw forbidden('only whoever gave the task, the manager or HR can reopen it')
        if (t.status !== 'done') throw stale()
        next = 'in_progress'; kind = 'reopened'
        tell.push(...tellStmt(c, t.assignee_user, 'staff_task_returned', 'Reopened: ' + t.title, note ?? 'Reopened.', id))
        break
      case 'cancel':
        if (!manage) throw forbidden('only whoever gave the task can cancel it')
        if (!LIVE.includes(t.status)) throw stale()
        next = 'cancelled'; kind = 'cancelled'
        break
      default:
        throw badRequest('action is start, finish, accept, return, reopen or cancel')
    }
    const at = now()
    await c.db.batch([
      c.db.prepare(`UPDATE staff_tasks SET status = ?, done_note = CASE WHEN ? = 'done' THEN COALESCE(?, done_note) ELSE done_note END,
          done_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END, updated_at = ? WHERE id = ?`)
        .bind(next, next, note, next, at, at, id),
      logStmt(c, id, kind, note),
      ...tell,
    ])
    return ok({ id, status: next })
  })

  /* The report: per person, how many tasks are open, waiting for review, overdue and done. */
  r.get('/hr/tasks/report', READ, async (c) => {
    const t = todayIST()
    const rows = await c.db.prepare(`
      SELECT e.id AS employee_id, ${fullName('e.first_name', 'e.last_name')} AS full_name, e.employee_code, d.name AS department,
             SUM(CASE WHEN t.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS open,
             SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) AS review,
             SUM(CASE WHEN t.status IN ('open', 'in_progress', 'review') AND t.due_on IS NOT NULL AND t.due_on < ? THEN 1 ELSE 0 END) AS overdue,
             SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
             MIN(CASE WHEN t.status IN ('open', 'in_progress') THEN t.due_on END) AS next_due
        FROM employees e JOIN staff_tasks t ON t.assigned_to = e.id LEFT JOIN departments d ON d.id = e.department_id
       GROUP BY e.id ORDER BY overdue DESC, open DESC, full_name`).bind(t).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  /* One task with its story, oldest first. After /hr/tasks/report, which
     this pattern would otherwise catch. */
  r.get('/hr/tasks/{id}', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const { mine, manage, reviewed } = await loadTask(c, id)
    const task = await c.db.prepare(`
      SELECT t.id, t.title, t.detail, t.due_on, t.priority, t.status, t.done_note, t.done_at, t.created_at,
             e.id AS employee_id, ${fullName('e.first_name', 'e.last_name')} AS assigned_to, e.employee_code, u.full_name AS assigned_by
        FROM staff_tasks t JOIN employees e ON e.id = t.assigned_to LEFT JOIN users u ON u.id = t.assigned_by WHERE t.id = ?`).bind(id).first<Record<string, unknown>>()
    const updates = await c.db.prepare(`SELECT x.id, x.kind, x.note, x.created_at, u.full_name AS by_name FROM staff_task_updates x
        LEFT JOIN users u ON u.id = x.by_user WHERE x.task_id = ? ORDER BY x.created_at, x.id`).bind(id).all<Record<string, unknown>>()
    const tday = todayIST()
    return ok({ ...omitNull(task!), mine, manage, reviewed,
      overdue: LIVE.includes(String(task!.status)) && !!task!.due_on && String(task!.due_on) < tday,
      updates: updates.results.map(omitNull) })
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
