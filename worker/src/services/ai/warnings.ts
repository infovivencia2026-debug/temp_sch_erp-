import type { Env } from '../../env'
import type { Institution } from '../../tenant'
import { registerJob } from '../jobs'
import { jobSchool, localDate } from '../background/schools'
import { llmFromEnv, parseJsonReply, type Llm } from './gemini_seam'
import {
  attendanceFlags, feeFlags, marksFlags, registerFlags, staffFlags, evidenceKey, THRESHOLDS,
  type AttendanceMark, type FeeFacts, type Flag, type MarkRow, type StaffDay, type StudentRef,
} from './warning_rules'

/* Early warnings, the stateful half: read one school's rows, run the rules
   (warning_rules.ts), upsert ai_warnings, clear flags that no longer hold,
   and ask the AI for one friendly sentence per changed flag (cached in
   ai_explanations by a hash of the evidence). Without a key the rule's own
   template sentence (`reason`) is what people read. */

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
const nowIso = () => new Date().toISOString()

async function sha(s: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...b].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Every flag the rules raise for this school today. */
export async function computeFlags(db: D1Database, today: string): Promise<Flag[]> {
  const year = await db.prepare(`SELECT id, starts_on FROM academic_years WHERE is_current = 1 ORDER BY starts_on DESC LIMIT 1`).first<{ id: string; starts_on: string }>()
  const from = [year?.starts_on?.slice(0, 10) ?? '', addDays(today, -120)].sort().pop()!
  const students = (await db.prepare(`
      SELECT st.id AS student_id, trim(st.first_name || ' ' || COALESCE(st.last_name, '')) AS name, e.section_id,
             trim(COALESCE(c.name, '') || ' ' || COALESCE(s.name, '')) AS section_name, s.class_teacher_id
        FROM students st
        LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active' AND (? IS NULL OR e.academic_year_id = ?)
        LEFT JOIN sections s ON s.id = e.section_id LEFT JOIN classes c ON c.id = s.class_id
       WHERE st.status = 'active'`).bind(year?.id ?? null, year?.id ?? null).all<StudentRef>()).results ?? []
  const byId = new Map(students.map((s) => [s.student_id, s]))
  const flags: Flag[] = []

  // Attendance: one status per student per day (any present period counts the day as present).
  const att = (await db.prepare(`SELECT student_id, on_date, group_concat(status) AS statuses FROM student_attendance
      WHERE on_date >= ? AND on_date <= ? GROUP BY student_id, on_date`).bind(from, today).all<{ student_id: string; on_date: string; statuses: string }>()).results ?? []
  const attBy = new Map<string, AttendanceMark[]>()
  for (const r of att) {
    const ss = String(r.statuses).split(',')
    const status = ss.find((x) => x === 'present' || x === 'late') ?? ss[0]
    const l = attBy.get(r.student_id) ?? []
    l.push({ on_date: String(r.on_date).slice(0, 10), status })
    attBy.set(r.student_id, l)
  }
  for (const [sid, marks] of attBy) { const st = byId.get(sid); if (st) flags.push(...attendanceFlags(st, marks, today)) }

  // Marks this year, per subject.
  const mk = (await db.prepare(`
      SELECT m.student_id, sub.name AS subject, e.name AS exam, COALESCE(e.ends_on, e.starts_on, substr(e.created_at, 1, 10)) AS exam_date,
             CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL), 0) AS obtained,
             CAST(es.max_marks AS REAL) AS max, CAST(es.pass_marks AS REAL) AS pass
        FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams e ON e.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
       WHERE m.is_absent = 0 AND m.marks_obtained IS NOT NULL AND (? IS NULL OR e.academic_year_id = ?)`)
    .bind(year?.id ?? null, year?.id ?? null).all<MarkRow & { student_id: string }>()).results ?? []
  const mkBy = new Map<string, MarkRow[]>()
  for (const r of mk) { const l = mkBy.get(r.student_id) ?? []; l.push({ ...r, obtained: Number(r.obtained), max: Number(r.max), pass: r.pass == null ? null : Number(r.pass) }); mkBy.set(r.student_id, l) }
  for (const [sid, rows] of mkBy) { const st = byId.get(sid); if (st) flags.push(...marksFlags(st, rows)) }

  // Fees: overdue now, plus the last year's payment history.
  const yearAgo = addDays(today, -365)
  const fees = (await db.prepare(`
      WITH od AS (
        SELECT student_id, count(*) AS n, min(due_on) AS oldest,
               sum(COALESCE(net_paise, gross_paise - discount_paise + fine_paise) - paid_paise) AS owed
          FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ? GROUP BY student_id
      ),
      pay AS (
        SELECT student_id, max(paid_on) AS last_paid, sum(CASE WHEN paid_on >= ? THEN 1 ELSE 0 END) AS n
          FROM payments WHERE COALESCE(status, 'success') NOT IN ('failed','cancelled','bounced','reversed') GROUP BY student_id
      ),
      late AS (
        SELECT student_id, count(*) AS n FROM invoices
         WHERE status = 'paid' AND due_on IS NOT NULL AND due_on >= ? AND substr(updated_at, 1, 10) > due_on GROUP BY student_id
      )
      SELECT od.student_id, od.n, od.oldest, od.owed, pay.last_paid, COALESCE(pay.n, 0) AS pays, COALESCE(late.n, 0) AS late
        FROM od LEFT JOIN pay ON pay.student_id = od.student_id LEFT JOIN late ON late.student_id = od.student_id`)
    .bind(today, yearAgo, yearAgo).all<{ student_id: string; n: number; oldest: string; owed: number; last_paid: string | null; pays: number; late: number }>()).results ?? []
  for (const r of fees) {
    const st = byId.get(r.student_id)
    if (!st) continue
    const f: FeeFacts = { overdue_paise: Number(r.owed), oldest_due_on: r.oldest ? String(r.oldest).slice(0, 10) : null, overdue_invoices: Number(r.n),
      last_paid_on: r.last_paid ? String(r.last_paid).slice(0, 10) : null, payments_last_year: Number(r.pays), late_payments_last_year: Number(r.late) }
    flags.push(...feeFlags(st, f, today))
  }

  // Staff absences.
  const staff = (await db.prepare(`SELECT sa.user_id, trim(e.first_name || ' ' || COALESCE(e.last_name, '')) AS name, sa.on_date, sa.status
      FROM staff_attendance sa JOIN employees e ON e.user_id = sa.user_id AND e.status = 'active'
     WHERE sa.on_date >= ? AND sa.on_date <= ?`).bind(addDays(today, -THRESHOLDS.staffWindowDays), today)
    .all<{ user_id: string; name: string; on_date: string; status: string }>()).results ?? []
  const stBy = new Map<string, { name: string; days: StaffDay[] }>()
  for (const r of staff) { const x = stBy.get(r.user_id) ?? { name: r.name, days: [] }; x.days.push({ on_date: String(r.on_date).slice(0, 10), status: r.status }); stBy.set(r.user_id, x) }
  for (const [uid, x] of stBy) flags.push(...staffFlags({ user_id: uid, name: x.name }, x.days, today))

  // Registers: school days are the days anyone marked; today is still open, so it is excluded.
  const winFrom = addDays(today, -THRESHOLDS.registerWindowDays)
  const reg = (await db.prepare(`SELECT DISTINCT section_id, on_date FROM student_attendance WHERE on_date >= ? AND on_date < ? AND section_id IS NOT NULL`)
    .bind(winFrom, today).all<{ section_id: string; on_date: string }>()).results ?? []
  const schoolDays = [...new Set(reg.map((r) => String(r.on_date).slice(0, 10)))]
  const secDays = new Map<string, string[]>()
  for (const r of reg) { const l = secDays.get(r.section_id) ?? []; l.push(String(r.on_date).slice(0, 10)); secDays.set(r.section_id, l) }
  if (schoolDays.length > 0) {
    const secs = (await db.prepare(`SELECT s.id AS section_id, trim(c.name || ' ' || s.name) AS name, s.class_teacher_id, u.full_name AS class_teacher_name
        FROM sections s JOIN classes c ON c.id = s.class_id LEFT JOIN users u ON u.id = s.class_teacher_id
       WHERE (? IS NULL OR s.academic_year_id = ?)
         AND EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = s.id AND e.status = 'active')`)
      .bind(year?.id ?? null, year?.id ?? null).all<{ section_id: string; name: string; class_teacher_id: string | null; class_teacher_name: string | null }>()).results ?? []
    for (const s of secs) flags.push(...registerFlags(s, schoolDays, secDays.get(s.section_id) ?? []))
  }
  return flags
}

// ---- explanations ----------------------------------------------------------------

export interface ExplainItem { key: string; rule: string; name: string; evidence: Record<string, unknown>; reason: string; next_step: string }

const EXPLAIN_SYSTEM = `You write early-warning notes for teachers and principals in an Indian school.
For each item you get a rule name, the person or class, the evidence numbers and a plain template sentence.
Write ONE short, kind, factual sentence (max 30 words) a busy teacher understands at a glance. Use only the
numbers given; never invent causes, diagnoses or facts; never blame the child or family. No greetings.
Answer with JSON only: {"<key>": "<sentence>", ...} using the keys you were given.`

/** One Gemini call for a batch of flags; returns key -> sentence for those it answered. */
export async function explainBatch(llm: Llm, items: ExplainItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (items.length === 0) return out
  const prompt = JSON.stringify(items.map((i) => ({ key: i.key, rule: i.rule, who: i.name, evidence: i.evidence, template: i.reason })))
  const reply = await llm(EXPLAIN_SYSTEM, [{ text: prompt }], 2048)
  const parsed = parseJsonReply<Record<string, unknown>>(reply)
  if (!parsed || Array.isArray(parsed)) return out
  for (const i of items) {
    const v = parsed[i.key]
    if (typeof v === 'string' && v.trim() !== '' && v.length <= 400) out.set(i.key, v.trim())
  }
  return out
}

// ---- the nightly run ----------------------------------------------------------------

export interface RunResult { raised: number; cleared: number; explained: number; ai: boolean }

const MAX_EXPLAIN_PER_RUN = 120

export async function runWarnings(db: D1Database, instId: string, today: string, llm: Llm | null): Promise<RunResult> {
  const flags = await computeFlags(db, today)
  const started = nowIso()
  const res: RunResult = { raised: flags.length, cleared: 0, explained: 0, ai: !!llm }
  const keyed: { f: Flag; hash: string }[] = []
  for (const f of flags) keyed.push({ f, hash: await sha(f.subject_name + '|' + evidenceKey(f.rule, f.evidence)) })

  const stmts = keyed.map(({ f, hash }) => db.prepare(`
      INSERT INTO ai_warnings (id, institution_id, rule, subject_kind, subject_id, subject_name, student_id, section_id, severity, owner_role, owner_user_id,
                               evidence, evidence_hash, reason, next_step, status, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT (rule, subject_kind, subject_id) DO UPDATE SET
        subject_name = excluded.subject_name, student_id = excluded.student_id, section_id = excluded.section_id,
        severity = excluded.severity, owner_role = excluded.owner_role, owner_user_id = excluded.owner_user_id,
        evidence = excluded.evidence, reason = excluded.reason, next_step = excluded.next_step, last_seen_at = excluded.last_seen_at,
        explanation = CASE WHEN ai_warnings.evidence_hash = excluded.evidence_hash THEN ai_warnings.explanation ELSE NULL END,
        explained_by = CASE WHEN ai_warnings.evidence_hash = excluded.evidence_hash THEN ai_warnings.explained_by ELSE NULL END,
        evidence_hash = excluded.evidence_hash,
        status = CASE WHEN ai_warnings.cleared_at IS NOT NULL OR (ai_warnings.status = 'resolved' AND ai_warnings.evidence_hash <> excluded.evidence_hash
                        AND excluded.severity = 'high') THEN 'open' ELSE ai_warnings.status END,
        cleared_at = NULL`)
    .bind(crypto.randomUUID(), instId, f.rule, f.subject_kind, f.subject_id, f.subject_name, f.student_id ?? null, f.section_id ?? null, f.severity,
      f.owner_role, f.owner_user_id ?? null, JSON.stringify(f.evidence), hash, f.reason, f.next_step, started, started))
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))
  const cl = await db.prepare(`UPDATE ai_warnings SET cleared_at = ? WHERE cleared_at IS NULL AND last_seen_at < ?`).bind(started, started).run()
  res.cleared = Number(cl.meta?.changes ?? 0)

  // Explanations: cached ones first, then the AI for what is left (bounded per run).
  const need = (await db.prepare(`SELECT w.id, w.rule, w.subject_name, w.evidence, w.evidence_hash, w.reason, w.next_step, x.text AS cached
      FROM ai_warnings w LEFT JOIN ai_explanations x ON x.key = w.evidence_hash
     WHERE w.cleared_at IS NULL AND w.explanation IS NULL`).all<{ id: string; rule: string; subject_name: string; evidence: string; evidence_hash: string; reason: string; next_step: string; cached: string | null }>()).results ?? []
  const upd: D1PreparedStatement[] = []
  const ask: ExplainItem[] = []
  for (const r of need) {
    if (r.cached) upd.push(db.prepare(`UPDATE ai_warnings SET explanation = ?, explained_by = 'ai' WHERE id = ?`).bind(r.cached, r.id))
    else if (llm && ask.length < MAX_EXPLAIN_PER_RUN && !ask.some((a) => a.key === r.evidence_hash)) {
      ask.push({ key: r.evidence_hash, rule: r.rule, name: r.subject_name, evidence: JSON.parse(r.evidence), reason: r.reason, next_step: r.next_step })
    }
  }
  if (llm) {
    for (let i = 0; i < ask.length; i += 30) {
      try {
        const got = await explainBatch(llm, ask.slice(i, i + 30))
        for (const [k, text] of got) {
          upd.push(db.prepare(`INSERT OR REPLACE INTO ai_explanations (key, text, source, created_at) VALUES (?, ?, 'gemini', ?)`).bind(k, text, nowIso()))
          upd.push(db.prepare(`UPDATE ai_warnings SET explanation = ?, explained_by = 'ai' WHERE evidence_hash = ? AND explanation IS NULL`).bind(text, k))
          res.explained++
        }
      } catch (e) {
        console.error('warnings: explanation batch failed; template sentences stand', e)
        break
      }
    }
  }
  for (let i = 0; i < upd.length; i += 50) await db.batch(upd.slice(i, i + 50))
  return res
}

// ---- weekly digest ---------------------------------------------------------------------

export interface DigestCounts { open: number; high: number; new_this_week: number; resolved_this_week: number; by_rule: Record<string, number> }

export async function digestCounts(db: D1Database, where = '1', args: unknown[] = []): Promise<DigestCounts> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const rows = (await db.prepare(`SELECT rule, severity, status, first_seen_at, status_at FROM ai_warnings w WHERE (${where}) AND (cleared_at IS NULL OR status_at >= ?)`)
    .bind(...args, weekAgo).all<{ rule: string; severity: string; status: string; first_seen_at: string; status_at: string | null }>()).results ?? []
  const d: DigestCounts = { open: 0, high: 0, new_this_week: 0, resolved_this_week: 0, by_rule: {} }
  for (const r of rows) {
    if (r.status === 'resolved') { if (r.status_at && r.status_at >= weekAgo) d.resolved_this_week++; continue }
    d.open++
    if (r.severity === 'high') d.high++
    if (r.first_seen_at >= weekAgo) d.new_this_week++
    d.by_rule[r.rule] = (d.by_rule[r.rule] ?? 0) + 1
  }
  return d
}

export const RULE_LABEL: Record<string, string> = {
  attendance_drop: 'attendance dropping', consecutive_absence: 'absent days in a row', marks_falling: 'marks falling',
  fee_risk: 'fees overdue', staff_absence: 'staff absence pattern', unmarked_registers: 'registers not marked',
}

export function digestText(d: DigestCounts): string {
  const parts = Object.entries(d.by_rule).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${RULE_LABEL[k] ?? k}`)
  return `${d.open} open (${d.high} urgent), ${d.new_this_week} new this week, ${d.resolved_this_week} resolved.` + (parts.length ? ' ' + parts.join(', ') + '.' : '')
}

async function sendDigest(db: D1Database, inst: Institution): Promise<number> {
  const leaders = (await db.prepare(`SELECT DISTINCT u.id, r.key FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.status = 'active' AND r.key IN ('principal','vice_principal','institution_admin','accountant','accounts')`).all<{ id: string; key: string }>()).results ?? []
  const teachers = (await db.prepare(`SELECT DISTINCT owner_user_id AS id FROM ai_warnings WHERE owner_role = 'class_teacher' AND owner_user_id IS NOT NULL AND cleared_at IS NULL AND status <> 'resolved'`)
    .all<{ id: string }>()).results ?? []
  const stmts: D1PreparedStatement[] = []
  const at = nowIso()
  const push = (uid: string, d: DigestCounts) => {
    if (d.open === 0 && d.resolved_this_week === 0) return
    stmts.push(db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, created_at) VALUES (?, ?, ?, 'ai.warnings.digest', ?, ?, '/needs-attention', ?)`)
      .bind(crypto.randomUUID(), inst.id, uid, 'Needs attention this week', digestText(d), at))
  }
  const done = new Set<string>()
  for (const l of leaders) {
    if (done.has(l.id)) continue
    done.add(l.id)
    const accounts = l.key === 'accountant' || l.key === 'accounts'
    push(l.id, await digestCounts(db, accounts ? `owner_role = 'accounts'` : '1'))
  }
  for (const t of teachers) {
    if (done.has(t.id)) continue
    push(t.id, await digestCounts(db, `section_id IN (SELECT id FROM sections WHERE class_teacher_id = ?) AND rule <> 'fee_risk'`, [t.id]))
  }
  if (stmts.length) await db.batch(stmts)
  return stmts.length
}

registerJob('ai:warnings_nightly', async (env: Env, job) => {
  const { inst, db } = await jobSchool(env, job)
  const r = await runWarnings(db, inst.id, localDate(inst.timezone), llmFromEnv(env))
  console.log('early warnings', inst.slug, r)
})

registerJob('ai:warnings_digest', async (env: Env, job) => {
  const { inst, db } = await jobSchool(env, job)
  console.log('early warnings digest', inst.slug, await sendDigest(db, inst))
})
