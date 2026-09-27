import type { Ctx, Router } from '../../router'
import { badRequest, HttpError, notFound, ok, readJSON, uuidParam } from '../../http'
import { localDate } from '../../services/background/schools'
import { can, resolveScope, studentInScope } from '../students/common'
import { digestCounts, digestText, runWarnings, RULE_LABEL } from '../../services/ai/warnings'
import { geminiKeySet, llmFromEnv } from '../../services/ai/gemini_seam'

/* Early warnings, the HTTP side. Who sees what:
   - students.read.all (principal, admin): every student and register flag;
   - finance.invoices.read: fee-risk flags;
   - hr.employees.read: staff-absence flags;
   - a class teacher: attendance / marks / register flags for their own sections only.
   Status changes (acknowledge / resolve with a note) need the same sight. */

interface Vis { sql: string; args: unknown[] }

async function visibility(c: Ctx): Promise<Vis> {
  const parts: string[] = []
  const args: unknown[] = []
  const studentRules = `w.rule NOT IN ('fee_risk','staff_absence')`
  if (can(c, 'students.read.all')) parts.push(studentRules)
  else {
    const s = await resolveScope(c)
    if (s.classTeacherOf.length > 0) {
      parts.push(`(${studentRules} AND w.section_id IN (SELECT id FROM sections WHERE class_teacher_id = ?))`)
      args.push(c.id.userId)
    }
  }
  if (can(c, 'finance.invoices.read')) parts.push(`w.rule = 'fee_risk'`)
  if (can(c, 'hr.employees.read')) parts.push(`w.rule = 'staff_absence'`)
  return { sql: parts.length ? '(' + parts.join(' OR ') + ')' : '0', args }
}

const COLS = `w.id, w.rule, w.subject_kind, w.subject_id, w.subject_name, w.student_id, w.section_id, w.severity, w.owner_role, w.owner_user_id,
  w.evidence, w.reason, w.explanation, w.explained_by, w.next_step, w.status, w.status_note, w.status_at, w.first_seen_at, w.last_seen_at,
  (SELECT full_name FROM users u WHERE u.id = w.status_by) AS status_by_name,
  (SELECT trim(c.name || ' ' || s.name) FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = w.section_id) AS section_name`

function shape(r: Record<string, unknown>) {
  let evidence: unknown = {}
  try { evidence = JSON.parse(String(r.evidence ?? '{}')) } catch { /* leave empty */ }
  return { ...r, evidence, label: RULE_LABEL[String(r.rule)] ?? r.rule, summary: (r.explanation as string | null) || r.reason }
}

const SEV_ORDER = `CASE w.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`

export function registerAIWarnings(r: Router): void {
  // The Needs-attention list. ?status=open|acknowledged|resolved|active (default active = open+acknowledged), ?section_id, ?rule
  r.get('/ai/warnings', 'auth', async (c) => {
    const v = await visibility(c)
    const q = c.url.searchParams
    const status = q.get('status') ?? 'active'
    const where = [v.sql, 'w.cleared_at IS NULL']
    const args = [...v.args]
    if (status === 'active') where.push(`w.status IN ('open','acknowledged')`)
    else if (['open', 'acknowledged', 'resolved'].includes(status)) { where.push('w.status = ?'); args.push(status) }
    const sec = q.get('section_id'); if (sec) { where.push('w.section_id = ?'); args.push(sec) }
    const rule = q.get('rule'); if (rule) { where.push('w.rule = ?'); args.push(rule) }
    const rows = (await c.db.prepare(`SELECT ${COLS} FROM ai_warnings w WHERE ${where.join(' AND ')}
        ORDER BY CASE w.status WHEN 'open' THEN 0 ELSE 1 END, ${SEV_ORDER}, w.first_seen_at DESC LIMIT 300`).bind(...args).all<Record<string, unknown>>()).results ?? []
    const last = await c.db.prepare(`SELECT max(last_seen_at) AS at FROM ai_warnings`).first<{ at: string | null }>()
    return ok({ items: rows.map(shape), computed_at: last?.at ?? null, ai: geminiKeySet(c.env) })
  })

  // Badge on a student profile: that child's open flags the caller may see.
  r.get('/ai/warnings/student/{id}', 'auth', async (c) => {
    const sid = uuidParam(c.params.id)
    await studentInScope(c, sid)
    const v = await visibility(c)
    const rows = (await c.db.prepare(`SELECT ${COLS} FROM ai_warnings w WHERE ${v.sql} AND w.student_id = ? AND w.cleared_at IS NULL AND w.status <> 'resolved'
        ORDER BY ${SEV_ORDER}`).bind(...v.args, sid).all<Record<string, unknown>>()).results ?? []
    return ok({ items: rows.map(shape) })
  })

  r.get('/ai/warnings/digest', 'auth', async (c) => {
    const v = await visibility(c)
    const d = await digestCounts(c.db, v.sql.replace(/\bw\./g, ''), v.args)
    return ok({ ...d, text: digestText(d) })
  })

  r.post('/ai/warnings/{id}/status', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const body = await readJSON<{ status?: string; note?: string }>(c.req)
    const status = String(body.status ?? '')
    if (!['open', 'acknowledged', 'resolved'].includes(status)) throw badRequest('status must be open, acknowledged or resolved')
    const note = String(body.note ?? '').trim().slice(0, 1000)
    if (status === 'resolved' && note === '') throw badRequest('add a short note saying what was done')
    const v = await visibility(c)
    const row = await c.db.prepare(`SELECT w.id FROM ai_warnings w WHERE w.id = ? AND ${v.sql}`).bind(id, ...v.args).first()
    if (!row) throw notFound('resource not found')
    await c.db.prepare(`UPDATE ai_warnings SET status = ?, status_note = NULLIF(?, ''), status_by = ?, status_at = ? WHERE id = ?`)
      .bind(status, note, c.id.userId, new Date().toISOString(), id).run()
    const out = await c.db.prepare(`SELECT ${COLS} FROM ai_warnings w WHERE w.id = ?`).bind(id).first<Record<string, unknown>>()
    return ok(shape(out!))
  })

  // Recompute now (the nightly job's work), for the principal after fixing data.
  r.post('/ai/warnings/run', 'students.read.all', async (c) => {
    const inst = c.id.institution
    if (!inst) throw new HttpError(400, 'this needs a school in scope', { code: 'no_institution' })
    return ok(await runWarnings(c.db, inst.id, localDate(inst.timezone || 'Asia/Kolkata'), llmFromEnv(c.env)))
  })
}
