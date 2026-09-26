import type { Ctx, Router } from '../../router'
import { scopeOf } from '../../services/messaging'
import { emitMessageEvent, type MessageSubject } from '../../services/message_rules'
import { badRequest, created, isUUID, notFound, ok, readJSON, uuid } from '../../http'
import {
  addDays, all, alsoNeeds, coded, denied, has, instId, isDate, isUniqueViolation, isoDow, missingPerm, nowISO, nullStr,
  todayIST, trimStr, utcSeconds, uuidOr400,
} from './common'
import { UUID_SQL, guardStmt, isGuardFailure } from './tt_shared'

/* Port of timetable_ops.go section 3: /timetable-cover/*, a teacher asking
   for their periods to be covered and the approver choosing who covers.

   generate_series over the date range is a recursive CTE, and isodow is
   strftime('%w') with Sunday moved to 7. The Go transaction's FOR UPDATE on
   the request becomes a batch guard that fails the whole write if the
   request stopped being pending between the read and the write. */

const READ = 'academics.timetable.read'
const WRITE = 'academics.timetable.write'

const DAYS_CTE = `WITH RECURSIVE d(day) AS (SELECT ?1 UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < ?2)`
const ISODOW = (col: string) => `(CASE CAST(strftime('%w', ${col}) AS INTEGER) WHEN 0 THEN 7 ELSE CAST(strftime('%w', ${col}) AS INTEGER) END)`
const NOT_HOLIDAY = `NOT EXISTS (SELECT 1 FROM holidays h WHERE h.kind IN ('holiday','vacation') AND h.applies_to IN ('all','staff')
                       AND d.day BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date))`

/** coverRange: the next fortnight by default, never backwards, never more than 92 days. */
function coverRange(rawFrom: unknown, rawTo: unknown): { from: string; to: string } {
  const today = todayIST()
  let from = today, to = addDays(today, 13)
  const f = trimStr(rawFrom), t = trimStr(rawTo)
  if (f !== '') { if (!isDate(f)) throw badRequest('from must be YYYY-MM-DD'); from = f }
  if (t !== '') { if (!isDate(t)) throw badRequest('to must be YYYY-MM-DD'); to = t }
  if (to < from) throw badRequest('to must not be before from')
  if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw badRequest('a cover request may span at most 92 days')
  return { from, to }
}

/** The teacher the request speaks for: the caller, or somebody else for an office holding timetable.write. */
function subjectOf(c: Ctx, raw: unknown): string {
  const v = trimStr(raw)
  if (v === '') return c.id.userId
  if (!isUUID(v)) throw badRequest('teacher_id must be a uuid')
  if (v !== c.id.userId && !has(c, WRITE)) throw missingPerm(WRITE)
  return v
}

async function listCoverablePeriods(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const { from, to } = coverRange(q.get('from'), q.get('to'))
  const subject = subjectOf(c, q.get('teacher_id'))
  const rows = await all<{ te_id: string; on_date: string; weekday: number; period_id: string; period_name: string; starts_at: string | null
    class_name: string; section_name: string; subject_name: string; asked: number; covered_by: string | null }>(c.db.prepare(`
    ${DAYS_CTE}
    SELECT te.id AS te_id, d.day AS on_date, te.weekday, p.id AS period_id, p.name AS period_name, p.starts_at,
           c.name AS class_name, sec.name AS section_name, sub.name AS subject_name,
           EXISTS (SELECT 1 FROM substitution_request_periods srp WHERE srp.timetable_entry_id = te.id AND srp.on_date = d.day AND srp.status = 'pending') AS asked,
           (SELECT su.full_name FROM substitutions sb JOIN users su ON su.id = sb.substitute_user_id
             WHERE sb.timetable_entry_id = te.id AND sb.on_date = d.day) AS covered_by
      FROM d
      JOIN timetable_entries te ON te.weekday = ${ISODOW('d.day')} AND te.teacher_user_id = ?3
      JOIN periods p ON p.id = te.period_id
      JOIN sections sec ON sec.id = te.section_id
      JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = te.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
     WHERE ${NOT_HOLIDAY}
     ORDER BY d.day, p.sequence`).bind(from, to, subject))
  const leaves = await all<{ id: string; from_date: string; to_date: string; reason: string | null; status: string }>(c.db.prepare(`
    SELECT lr.id, lr.from_date, lr.to_date, lr.reason, lr.status
      FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
     WHERE lr.subject_kind = 'staff' AND e.user_id = ? AND lr.status IN ('pending','approved')
       AND lr.to_date >= ? AND lr.from_date <= ?
     ORDER BY lr.from_date`).bind(subject, from, to))
  return ok({
    items: rows.map((v) => {
      const o: Record<string, unknown> = { timetable_entry_id: v.te_id, on_date: v.on_date, weekday: v.weekday, period_id: v.period_id,
        period_name: v.period_name, starts_at: (v.starts_at ?? '').slice(0, 5), class_name: v.class_name, section_name: v.section_name,
        subject_name: v.subject_name, already_asked: !!v.asked }
      if (v.covered_by !== null) o.covered_by = v.covered_by
      return o
    }),
    from, to,
    leave: leaves.map((l) => ({ id: l.id, from_date: l.from_date.slice(0, 10), to_date: l.to_date.slice(0, 10), reason: l.reason ?? '', status: l.status })),
  })
}

async function createCoverRequest(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const body = await readJSON<Record<string, unknown>>(c.req)
  if (trimStr(body.reason) === '') throw badRequest('reason is required. The approver has to know why')
  const { from, to } = coverRange(body.from_date, body.to_date)
  const subject = subjectOf(c, body.teacher_id)
  const suggested = nullStr(body.suggested_user_id)
  if (suggested !== null && !isUUID(suggested)) throw badRequest('suggested_user_id must be a uuid')
  const leaveID = nullStr(body.leave_request_id)
  if (leaveID !== null && !isUUID(leaveID)) throw badRequest('leave_request_id must be a uuid')

  const emp = await c.db.prepare(`SELECT id FROM employees WHERE user_id = ? LIMIT 1`).bind(subject).first<{ id: string }>()
  const requestID = uuid()
  const ts = nowISO()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO substitution_requests (id, institution_id, requested_by, employee_id, from_date, to_date, reason,
        leave_request_id, suggested_user_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(requestID, inst, subject, emp?.id ?? null, from, to, trimStr(body.reason), leaveID, suggested, ts, ts),
  ]
  const refs = Array.isArray(body.periods) ? (body.periods as Record<string, unknown>[]) : []
  let lines = 0
  if (refs.length === 0) {
    // Every period the teacher holds in the range, holidays excluded.
    stmts.push(c.db.prepare(`
      ${DAYS_CTE}
      INSERT INTO substitution_request_periods (id, institution_id, request_id, timetable_entry_id, on_date, status)
      SELECT ${UUID_SQL}, ?4, ?5, te.id, d.day, 'pending'
        FROM d JOIN timetable_entries te ON te.weekday = ${ISODOW('d.day')} AND te.teacher_user_id = ?3
       WHERE ${NOT_HOLIDAY}`).bind(from, to, subject, inst, requestID))
  } else {
    for (const ref of refs) {
      const entryID = trimStr(ref?.timetable_entry_id)
      if (!isUUID(entryID)) throw badRequest('timetable_entry_id must be a uuid')
      const onDate = trimStr(ref?.on_date)
      if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
      const mine = await c.db.prepare(`SELECT 1 AS x FROM timetable_entries te WHERE te.id = ? AND te.teacher_user_id = ? AND te.weekday = ?`)
        .bind(entryID, subject, isoDow(onDate)).first()
      if (!mine) throw denied('one of those periods is not yours to hand over')
      stmts.push(c.db.prepare(`INSERT INTO substitution_request_periods (id, institution_id, request_id, timetable_entry_id, on_date, status)
          VALUES (?, ?, ?, ?, ?, 'pending')`).bind(uuid(), inst, requestID, entryID, onDate))
      lines++
    }
  }
  let results: D1Result[]
  try {
    results = await c.db.batch(stmts)
  } catch (e) {
    if (isUniqueViolation(e)) throw coded(409, 'already_requested', 'cover has already been requested for one of those periods')
    throw e
  }
  if (refs.length === 0) lines = results[1]?.meta.changes ?? 0
  if (lines === 0) {
    return created({ id: requestID, periods: 0, note: 'no timetabled periods fall in that range, so there is nothing to cover' })
  }
  return created({ id: requestID, periods: lines })
}

interface RequestDb {
  id: string; requested_by: string; teacher_name: string; from_date: string; to_date: string; reason: string; status: string
  suggested_name: string | null; suggested_user_id: string | null; leave_request_id: string | null; decided_by: string | null
  decision_note: string | null; created_at: string; periods?: number; covered?: number; mine: number
}
function requestJSON(v: RequestDb): Record<string, unknown> {
  const o: Record<string, unknown> = { id: v.id, requested_by: v.requested_by, teacher_name: v.teacher_name,
    from_date: v.from_date.slice(0, 10), to_date: v.to_date.slice(0, 10), reason: v.reason, status: v.status }
  if (v.suggested_name !== null) o.suggested_teacher = v.suggested_name
  if (v.suggested_user_id !== null) o.suggested_user_id = v.suggested_user_id
  if (v.leave_request_id !== null) o.leave_request_id = v.leave_request_id
  if (v.decided_by !== null) o.decided_by = v.decided_by
  if (v.decision_note !== null) o.decision_note = v.decision_note
  o.created_at = utcSeconds(v.created_at) ?? ''
  o.periods = v.periods ?? 0
  o.covered = v.covered ?? 0
  o.mine = !!v.mine
  return o
}
const REQUEST_COLS = `sr.id, sr.requested_by, u.full_name AS teacher_name, sr.from_date, sr.to_date, sr.reason, sr.status,
       su.full_name AS suggested_name, sr.suggested_user_id, sr.leave_request_id, du.full_name AS decided_by, sr.decision_note, sr.created_at`
const REQUEST_JOINS = `FROM substitution_requests sr
  JOIN users u ON u.id = sr.requested_by
  LEFT JOIN users su ON su.id = sr.suggested_user_id
  LEFT JOIN users du ON du.id = sr.decided_by`

async function listCoverRequests(c: Ctx): Promise<Response> {
  const approver = has(c, WRITE)
  const status = trimStr(c.url.searchParams.get('status'))
  const rows = await all<RequestDb>(c.db.prepare(`
    SELECT ${REQUEST_COLS},
           (SELECT count(*) FROM substitution_request_periods p WHERE p.request_id = sr.id) AS periods,
           (SELECT count(*) FROM substitution_request_periods p WHERE p.request_id = sr.id AND p.status = 'covered') AS covered,
           (sr.requested_by = ?1) AS mine
      ${REQUEST_JOINS}
     WHERE (?2 = 1 OR sr.requested_by = ?1) AND (?3 = '' OR sr.status = ?3)
     ORDER BY (sr.status = 'pending') DESC, sr.from_date DESC
     LIMIT 200`).bind(c.id.userId, approver ? 1 : 0, status))
  return ok({ items: rows.map(requestJSON), can_decide: approver })
}

interface Candidate { user_id: string; full_name: string; teaches_subject: boolean; periods_today: number; periods_week: number; max_periods_per_week: number; suggested: boolean }

/** coverCandidatesFor: who is free in this period on this date, best first, at most eight. */
async function coverCandidatesFor(c: Ctx, entryID: string, onDate: string, absentUser: string, suggested: string | null): Promise<Candidate[]> {
  const rows = await all<{ user_id: string; full_name: string; teaches: number; today: number; week: number; max_week: number }>(c.db.prepare(`
    WITH slot AS (
      SELECT te.id, te.weekday, te.period_id, te.academic_year_id, cs.subject_id
        FROM timetable_entries te JOIN class_subjects cs ON cs.id = te.class_subject_id WHERE te.id = ?1
    )
    SELECT u.id AS user_id, u.full_name,
           EXISTS (SELECT 1 FROM section_subject_teachers sst JOIN class_subjects cs2 ON cs2.id = sst.class_subject_id
                    WHERE sst.teacher_user_id = u.id AND cs2.subject_id = (SELECT subject_id FROM slot)) AS teaches,
           (SELECT count(*) FROM timetable_entries t2 WHERE t2.teacher_user_id = u.id AND t2.weekday = (SELECT weekday FROM slot)) AS today,
           (SELECT count(*) FROM timetable_entries t3 WHERE t3.teacher_user_id = u.id AND t3.academic_year_id = (SELECT academic_year_id FROM slot)) AS week,
           COALESCE(lr.max_periods_per_week, 35) AS max_week
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
     WHERE e.status = 'active' AND u.id <> ?3
       AND NOT EXISTS (SELECT 1 FROM timetable_entries t4 WHERE t4.teacher_user_id = u.id
                        AND t4.weekday = (SELECT weekday FROM slot) AND t4.period_id = (SELECT period_id FROM slot))
       AND NOT EXISTS (SELECT 1 FROM substitutions sb JOIN timetable_entries t5 ON t5.id = sb.timetable_entry_id
                        WHERE sb.substitute_user_id = u.id AND sb.on_date = ?2 AND t5.period_id = (SELECT period_id FROM slot))
       AND NOT EXISTS (SELECT 1 FROM staff_attendance sa WHERE sa.user_id = u.id AND sa.on_date = ?2 AND sa.status IN ('absent','leave'))
       AND NOT EXISTS (SELECT 1 FROM leave_requests lv WHERE lv.employee_id = e.id AND lv.status = 'approved'
                        AND ?2 BETWEEN lv.from_date AND lv.to_date)
       AND NOT EXISTS (SELECT 1 FROM teacher_unavailability tu WHERE tu.teacher_user_id = u.id AND tu.weekday = (SELECT weekday FROM slot)
                        AND (tu.period_id IS NULL OR tu.period_id = (SELECT period_id FROM slot)))
     ORDER BY u.full_name
     LIMIT 40`).bind(entryID, onDate, absentUser))
  const out: Candidate[] = rows.map((r) => ({ user_id: r.user_id, full_name: r.full_name, teaches_subject: !!r.teaches, periods_today: r.today,
    periods_week: r.week, max_periods_per_week: r.max_week, suggested: suggested !== null && suggested === r.user_id }))
  out.sort((a, b) => {
    if (a.suggested !== b.suggested) return a.suggested ? -1 : 1
    if (a.teaches_subject !== b.teaches_subject) return a.teaches_subject ? -1 : 1
    const la = a.periods_week / Math.max(a.max_periods_per_week, 1), lb = b.periods_week / Math.max(b.max_periods_per_week, 1)
    if (la !== lb) return la - lb
    if (a.periods_today !== b.periods_today) return a.periods_today - b.periods_today
    return a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0
  })
  return out.slice(0, 8)
}

async function getCoverRequest(c: Ctx): Promise<Response> {
  const reqID = uuidOr400(c.params.id)
  const approver = has(c, WRITE)
  const head = await c.db.prepare(`SELECT ${REQUEST_COLS}, (sr.requested_by = ?2) AS mine ${REQUEST_JOINS} WHERE sr.id = ?1`)
    .bind(reqID, c.id.userId).first<RequestDb>()
  if (!head) throw notFound()
  if (!head.mine && !approver) throw denied('that request is not yours')
  const lines = await all<{ id: string; entry_id: string; on_date: string; period_name: string; starts_at: string | null; class_name: string
    section_name: string; subject_name: string; status: string; assigned_name: string | null; assigned_id: string | null }>(c.db.prepare(`
    SELECT srp.id, srp.timetable_entry_id AS entry_id, srp.on_date, p.name AS period_name, p.starts_at,
           c.name AS class_name, sec.name AS section_name, sub.name AS subject_name, srp.status,
           au.full_name AS assigned_name, srp.assigned_user_id AS assigned_id
      FROM substitution_request_periods srp
      JOIN timetable_entries te ON te.id = srp.timetable_entry_id
      JOIN periods p ON p.id = te.period_id
      JOIN sections sec ON sec.id = te.section_id
      JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = te.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users au ON au.id = srp.assigned_user_id
     WHERE srp.request_id = ?
     ORDER BY srp.on_date, p.sequence`).bind(reqID))
  const periods: Record<string, unknown>[] = []
  for (const v of lines) {
    const o: Record<string, unknown> = { id: v.id, timetable_entry_id: v.entry_id, on_date: v.on_date.slice(0, 10), period_name: v.period_name,
      starts_at: (v.starts_at ?? '').slice(0, 5), class_name: v.class_name, section_name: v.section_name, subject_name: v.subject_name, status: v.status }
    if (v.assigned_name !== null) o.assigned_teacher = v.assigned_name
    if (v.assigned_id !== null) o.assigned_user_id = v.assigned_id
    o.candidates = approver && head.status === 'pending'
      ? await coverCandidatesFor(c, v.entry_id, v.on_date.slice(0, 10), head.requested_by, head.suggested_user_id)
      : []
    periods.push(o)
  }
  // The request head carries no counts here; Go leaves them at zero.
  return ok({ request: requestJSON({ ...head, periods: 0, covered: 0 }), periods, can_decide: approver && head.status === 'pending' })
}

async function decideCoverRequest(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const reqID = uuidOr400(c.params.id)
  const body = await readJSON<Record<string, unknown>>(c.req)
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'reject') throw badRequest('decision must be "approve" or "reject"')
  const note = nullStr(body.note)
  const cur = await c.db.prepare(`SELECT status, reason, requested_by FROM substitution_requests WHERE id = ?`).bind(reqID)
    .first<{ status: string; reason: string; requested_by: string }>()
  if (!cur) throw notFound()
  if (cur.status !== 'pending') throw coded(409, 'request_closed', 'this request has already been decided')
  const ts = nowISO()
  const actor = c.id.platformAdmin ? null : c.id.userId
  const guard = guardStmt(c, `(SELECT status FROM substitution_requests WHERE id = ?) = 'pending'`, [reqID])

  const run = async (stmts: D1PreparedStatement[]) => {
    try { await c.db.batch([guard, ...stmts]) } catch (e) {
      if (isGuardFailure(e)) throw coded(409, 'request_closed', 'this request has already been decided')
      throw e
    }
  }

  if (decision === 'reject') {
    await run([
      c.db.prepare(`UPDATE substitution_request_periods SET status = 'declined' WHERE request_id = ? AND status = 'pending'`).bind(reqID),
      c.db.prepare(`UPDATE substitution_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`)
        .bind(actor, ts, note, ts, reqID),
    ])
    return ok({ status: 'rejected', covered: 0, still_uncovered: 0 })
  }

  const stmts: D1PreparedStatement[] = []
  const usedLines = new Set<string>()
  const promised = new Set<string>() // substitute|date|period given within this decision
  let covered = 0
  for (const a of Array.isArray(body.assignments) ? (body.assignments as Record<string, unknown>[]) : []) {
    const lineID = trimStr(a?.period_id), subID = trimStr(a?.substitute_user_id)
    if (!isUUID(lineID) || !isUUID(subID)) throw badRequest('period_id and substitute_user_id must be uuids')
    if (usedLines.has(lineID)) throw notFound()
    const line = await c.db.prepare(`SELECT srp.timetable_entry_id AS entry_id, srp.on_date, te.period_id
        FROM substitution_request_periods srp JOIN timetable_entries te ON te.id = srp.timetable_entry_id
       WHERE srp.id = ? AND srp.request_id = ? AND srp.status = 'pending'`).bind(lineID, reqID)
      .first<{ entry_id: string; on_date: string; period_id: string }>()
    if (!line) throw notFound()
    const onDate = line.on_date.slice(0, 10)
    const busy = await c.db.prepare(`
      SELECT EXISTS (SELECT 1 FROM timetable_entries te WHERE te.teacher_user_id = ?1 AND te.weekday = ?3 AND te.period_id = ?4)
          OR EXISTS (SELECT 1 FROM substitutions sb JOIN timetable_entries t2 ON t2.id = sb.timetable_entry_id
                      WHERE sb.substitute_user_id = ?1 AND sb.on_date = ?2 AND t2.period_id = ?4) AS busy`)
      .bind(subID, onDate, isoDow(onDate), line.period_id).first<{ busy: number }>()
    const key = `${subID}|${onDate}|${line.period_id}`
    if (busy?.busy || promised.has(key)) {
      const u = await c.db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(subID).first<{ full_name: string }>()
      throw coded(409, 'proxy_busy', u?.full_name ? `${u.full_name} already has a class in that period` : 'that teacher already has a class in this period')
    }
    promised.add(key)
    usedLines.add(lineID)
    stmts.push(
      c.db.prepare(`INSERT INTO substitutions (id, institution_id, timetable_entry_id, on_date, substitute_user_id, reason, created_by, created_at, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (timetable_entry_id, on_date) DO UPDATE
             SET substitute_user_id = excluded.substitute_user_id, reason = excluded.reason, request_id = excluded.request_id`)
        .bind(uuid(), inst, line.entry_id, line.on_date, subID, cur.reason, actor, ts, reqID),
      c.db.prepare(`UPDATE substitution_request_periods
          SET status = 'covered', assigned_user_id = ?2,
              substitution_id = (SELECT id FROM substitutions WHERE timetable_entry_id = ?3 AND on_date = ?4)
        WHERE id = ?1`).bind(lineID, subID, line.entry_id, line.on_date),
    )
    covered++
  }
  const pendingNow = await c.db.prepare(`SELECT count(*) AS n FROM substitution_request_periods WHERE request_id = ? AND status = 'pending'`)
    .bind(reqID).first<{ n: number }>()
  const pending = (pendingNow?.n ?? 0) - usedLines.size
  const status = pending > 0 ? 'partially_approved' : 'approved'
  stmts.push(c.db.prepare(`UPDATE substitution_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`)
    .bind(status, actor, ts, note, ts, reqID))
  await run(stmts)
  // notifyCovering: one substitution.assigned message event per covering teacher, through the messaging foundation.
  if (covered > 0) {
    try {
      const rows = (await c.db.prepare(`SELECT srp.id, e.id AS emp, substr(srp.on_date,1,10) AS on_date, p.name AS period, c.name || '-' || sec.name AS section, sub.name AS subject
          FROM substitution_request_periods srp JOIN employees e ON e.user_id = srp.assigned_user_id
          JOIN timetable_entries te ON te.id = srp.timetable_entry_id JOIN periods p ON p.id = te.period_id
          JOIN sections sec ON sec.id = te.section_id JOIN classes c ON c.id = sec.class_id
          JOIN class_subjects cs ON cs.id = te.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
         WHERE srp.request_id = ? AND srp.status = 'covered'`).bind(reqID)
        .all<{ id: string; emp: string; on_date: string; period: string; section: string; subject: string }>()).results
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const subjects: MessageSubject[] = rows.map((r2) => {
        const at = Date.parse(r2.on_date + 'T00:00:00Z')
        return { employee_id: r2.emp, occurrence_key: r2.id, at, facts: { days_ahead: Math.trunc((at - Date.now()) / 86_400_000) },
          vars: { date: `${Number(r2.on_date.slice(8, 10))} ${MON[Number(r2.on_date.slice(5, 7)) - 1]}`, period: r2.period, section: r2.section, subject: r2.subject } }
      })
      if (subjects.length) await emitMessageEvent(scopeOf(c), 'substitution.assigned', subjects)
    } catch (e) { console.warn('substitution.assigned messages', e) }
  }
  return ok({ status, covered, still_uncovered: pending })
}

async function cancelCoverRequest(c: Ctx): Promise<Response> {
  const reqID = uuidOr400(c.params.id)
  const ts = nowISO()
  const res = await c.db.batch([
    c.db.prepare(`UPDATE substitution_requests SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND status = 'pending' AND (? = 1 OR requested_by = ?)`).bind(ts, reqID, has(c, WRITE) ? 1 : 0, c.id.userId),
    c.db.prepare(`UPDATE substitution_request_periods SET status = 'declined'
        WHERE request_id = ?1 AND status = 'pending' AND (SELECT updated_at FROM substitution_requests WHERE id = ?1) = ?2
          AND (SELECT status FROM substitution_requests WHERE id = ?1) = 'cancelled'`).bind(reqID, ts),
  ])
  if (!res[0].meta.changes) throw coded(409, 'not_cancellable', 'only your own undecided request can be withdrawn')
  return ok({ cancelled: true })
}

export function registerCover(r: Router): void {
  r.get('/timetable-cover/my-periods', READ, listCoverablePeriods)
  r.get('/timetable-cover/requests', READ, listCoverRequests)
  r.post('/timetable-cover/requests', READ, createCoverRequest)
  r.get('/timetable-cover/requests/{id}', READ, getCoverRequest)
  r.post('/timetable-cover/requests/{id}/cancel', READ, cancelCoverRequest)
  r.post('/timetable-cover/requests/{id}/decide', WRITE, alsoNeeds(READ, decideCoverRequest))
}
