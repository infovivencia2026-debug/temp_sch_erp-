import type { Router } from '../../router'
import { isUUID, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { institutionId, parseJSON } from './common'
import { arr, denied, isDate, mustFirst, nz, om, optUUID, pathUUID, refuse, runOps, tr } from './ops_common'

/* 360 evaluation under /admin-ops/evaluation, from internal/api/admin_ops.go.

   Trigger re-implemented: evaluation_answers_scale (00053) - a rating on a
   comment question, or above the question's max_rating, is refused.
   text[] columns (relations, asked_of) are JSON arrays in D1. */

const STAFF_READ = 'hr.employees.read'
const STAFF_WRITE = 'hr.employees.write'
const KNOWN = new Set(['head', 'peer', 'self', 'student', 'parent'])
const attributed = (rel: string) => rel === 'self' || rel === 'head'
const NAME = `(e.first_name || COALESCE(' ' || e.last_name, ''))`
type Row = Record<string, unknown>

const cycleRow = (v: Row) => ({
  id: v.id, name: v.name, purpose: om(v.purpose), opens_on: v.opens_on, closes_on: v.closes_on, status: v.status,
  min_responses: Number(v.min_responses), relations: parseJSON<string[]>(v.relations, []),
  reviewee_count: Number(v.reviewee_count ?? 0), invited: Number(v.invited ?? 0), responded: Number(v.responded ?? 0), question_count: Number(v.question_count ?? 0),
})

export function registerOpsEvaluation(r: Router): void {
  r.get('/admin-ops/evaluation/cycles', STAFF_READ, async (c) => {
    const rows = await c.db.prepare(`SELECT c.id, c.name, c.purpose, substr(c.opens_on,1,10) AS opens_on, substr(c.closes_on,1,10) AS closes_on,
        c.status, c.min_responses, c.relations,
        (SELECT count(*) FROM evaluation_reviewees v WHERE v.cycle_id = c.id) AS reviewee_count,
        (SELECT count(*) FROM evaluation_invitations i WHERE i.cycle_id = c.id) AS invited,
        (SELECT count(*) FROM evaluation_invitations i WHERE i.cycle_id = c.id AND i.status = 'responded') AS responded,
        (SELECT count(*) FROM evaluation_questions q WHERE q.cycle_id = c.id) AS question_count
      FROM evaluation_cycles c ORDER BY c.closes_on DESC LIMIT 100`).all<Row>()
    return ok({ items: rows.results.map(cycleRow) })
  })

  r.get('/admin-ops/evaluation/cycles/{id}', STAFF_READ, async (c) => {
    const id = pathUUID(c)
    const head = cycleRow(await mustFirst<Row>(c.db.prepare(`SELECT c.id, c.name, c.purpose, substr(c.opens_on,1,10) AS opens_on,
        substr(c.closes_on,1,10) AS closes_on, c.status, c.min_responses, c.relations FROM evaluation_cycles c WHERE c.id = ?`).bind(id)))
    const [qs, rows] = await c.db.batch<Row>([
      c.db.prepare(`SELECT id, seq, prompt, kind, max_rating, asked_of FROM evaluation_questions WHERE cycle_id = ? ORDER BY seq`).bind(id),
      c.db.prepare(`SELECT v.id, v.employee_id, ${NAME} AS name, e.employee_code, d.name AS department, v.released_at IS NOT NULL AS released,
          COALESCE(i.relation, '') AS relation, COALESCE(i.invited,0) AS invited, COALESCE(i.responded,0) AS responded, COALESCE(i.declined,0) AS declined,
          COALESCE((SELECT count(*) FROM evaluation_responses s WHERE s.reviewee_id = v.id AND s.relation = i.relation), 0) AS actual
        FROM evaluation_reviewees v
        JOIN employees e ON e.id = v.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN (SELECT n.reviewee_id, n.relation, count(*) AS invited,
                          sum(CASE WHEN n.status = 'responded' THEN 1 ELSE 0 END) AS responded,
                          sum(CASE WHEN n.status = 'declined' THEN 1 ELSE 0 END) AS declined
                     FROM evaluation_invitations n GROUP BY n.reviewee_id, n.relation) i ON i.reviewee_id = v.id
       WHERE v.cycle_id = ? ORDER BY e.first_name, e.last_name, i.relation`).bind(id),
    ])
    const questions = qs.results.map((v) => ({ id: v.id, seq: Number(v.seq), prompt: v.prompt, kind: v.kind, max_rating: Number(v.max_rating),
      asked_of: parseJSON<string[]>(v.asked_of, []) }))
    type Gap = { relation: string; invited: number; responded: number; declined: number; attributed: boolean; meets_floor: boolean }
    type Rev = { id: unknown; employee_id: unknown; name: unknown; employee_code: unknown; department?: unknown; released: boolean;
      invited: number; responded: number; complete: boolean; by_relation: Gap[] }
    const reviewees: Rev[] = [], byID = new Map<string, Rev>()
    for (const v of rows.results) {
      let rv = byID.get(String(v.id))
      if (!rv) {
        rv = { id: v.id, employee_id: v.employee_id, name: v.name, employee_code: v.employee_code, department: om(v.department), released: !!Number(v.released),
          invited: 0, responded: 0, complete: false, by_relation: [] }
        reviewees.push(rv); byID.set(String(v.id), rv)
      }
      const rel = String(v.relation)
      if (rel === '') continue
      rv.invited += Number(v.invited); rv.responded += Number(v.responded)
      rv.by_relation.push({ relation: rel, invited: Number(v.invited), responded: Number(v.responded), declined: Number(v.declined),
        attributed: attributed(rel), meets_floor: attributed(rel) || Number(v.actual) >= head.min_responses })
    }
    let invited = 0, responded = 0
    for (const rv of reviewees) {
      rv.complete = rv.by_relation.length > 0 && rv.by_relation.every((g) => g.meets_floor)
      invited += rv.invited; responded += rv.responded
    }
    const cycle = { ...head, invited, responded, reviewee_count: reviewees.length, question_count: questions.length }
    return ok({ cycle, questions, reviewees,
      note: `Results are withheld until a direction has at least ${head.min_responses} responses. Counts are shown so gaps can be chased; answers are not.` })
  })

  r.post('/admin-ops/evaluation/cycles', STAFF_WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ id?: string; name?: string; purpose?: string; academic_year_id?: string; opens_on?: string; closes_on?: string;
      min_responses?: number; relations?: string[] }>(c.req)
    if (tr(req.name) === '') throw refuse('a cycle needs a name')
    const opens = tr(req.opens_on), closes = tr(req.closes_on)
    if (!isDate(opens)) throw refuse('opens_on must be a date, as YYYY-MM-DD')
    if (!isDate(closes)) throw refuse('closes_on must be a date, as YYYY-MM-DD')
    if (closes < opens) throw refuse('the cycle closes before it opens')
    const relations = arr<string>(req.relations)
    if (relations.length === 0) throw refuse('choose at least one direction to gather feedback from')
    for (const rel of relations) if (!KNOWN.has(rel)) throw refuse('unknown direction: ' + rel)
    let min = req.min_responses ?? 0
    if (min === 0) min = 3
    if (min < 2) throw refuse('the anonymity floor cannot be below 2. With one response, the average names the person who gave it')
    const year = optUUID(req.academic_year_id)
    const t = now()
    let cycleID: string
    if (tr(req.id) !== '') {
      if (!isUUID(tr(req.id))) throw refuse('malformed cycle id')
      cycleID = tr(req.id)
      const cur = await mustFirst<{ status: string }>(c.db.prepare(`SELECT status FROM evaluation_cycles WHERE id = ?`).bind(cycleID))
      if (cur.status !== 'draft') throw refuse('this cycle is open. Its terms cannot be changed once people have been asked')
      await runOps(c, [c.db.prepare(`UPDATE evaluation_cycles SET name = ?, purpose = ?, academic_year_id = ?, opens_on = ?, closes_on = ?, min_responses = ?,
          relations = ?, updated_at = ? WHERE id = ?`).bind(tr(req.name), nz(req.purpose), year, opens, closes, min, JSON.stringify(relations), t, cycleID)])
    } else {
      cycleID = uuid()
      await runOps(c, [c.db.prepare(`INSERT INTO evaluation_cycles (id, institution_id, name, purpose, academic_year_id, opens_on, closes_on, status, min_responses,
          relations, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
        .bind(cycleID, inst, tr(req.name), nz(req.purpose), year, opens, closes, min, JSON.stringify(relations), c.id.userId, t, t)])
    }
    return ok({ id: cycleID, min_responses: min })
  })

  r.put('/admin-ops/evaluation/cycles/{id}/questions', STAFF_WRITE, async (c) => {
    const inst = institutionId(c)
    const id = pathUUID(c)
    type Q = { prompt?: string; kind?: string; max_rating?: number; asked_of?: string[] }
    const req = await readJSON<{ questions?: Q[] }>(c.req)
    const qs = arr<Q>(req.questions)
    if (qs.length === 0) throw refuse('a cycle needs at least one question')
    for (const q of qs) {
      if (tr(q.prompt) === '') throw refuse('every question needs a prompt')
      if (q.kind !== 'rating' && q.kind !== 'text') throw refuse('a question is either a rating or a comment')
      const m = q.max_rating ?? 0
      if (q.kind === 'rating' && (m < 2 || m > 10)) throw refuse('a rating scale runs from 2 to 10 points')
      for (const rel of arr<string>(q.asked_of)) if (!KNOWN.has(rel)) throw refuse('unknown direction: ' + rel)
    }
    const cur = await mustFirst<{ status: string }>(c.db.prepare(`SELECT status FROM evaluation_cycles WHERE id = ?`).bind(id))
    if (cur.status !== 'draft') throw refuse('this cycle has opened. The questions can no longer be changed')
    await runOps(c, [
      c.db.prepare(`DELETE FROM evaluation_questions WHERE cycle_id = ?`).bind(id),
      ...qs.map((q, i) => {
        const asked = arr<string>(q.asked_of)
        return c.db.prepare(`INSERT INTO evaluation_questions (id, institution_id, cycle_id, seq, prompt, kind, max_rating, asked_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(uuid(), inst, id, i + 1, tr(q.prompt), q.kind, q.kind === 'text' ? 5 : q.max_rating, JSON.stringify(asked.length ? asked : ['head', 'peer', 'self']))
      }),
    ])
    return ok({ questions: qs.length })
  })

  r.post('/admin-ops/evaluation/cycles/{id}/reviewees', STAFF_WRITE, async (c) => {
    const inst = institutionId(c)
    const id = pathUUID(c)
    const req = await readJSON<{ employee_ids?: string[] }>(c.req)
    const emps = arr<string>(req.employee_ids)
    if (emps.length === 0) throw refuse('choose at least one member of staff')
    const cur = await mustFirst<{ status: string }>(c.db.prepare(`SELECT status FROM evaluation_cycles WHERE id = ?`).bind(id))
    if (cur.status === 'closed' || cur.status === 'released') throw refuse('this cycle has closed')
    for (const e of emps) if (!isUUID(tr(e))) throw refuse('malformed employee id: ' + e)
    const t = now()
    const res = await runOps(c, emps.map((e) => c.db.prepare(`INSERT INTO evaluation_reviewees (id, institution_id, cycle_id, employee_id, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (cycle_id, employee_id) DO NOTHING`).bind(uuid(), inst, id, tr(e).toLowerCase(), t)))
    return ok({ added: res.reduce((n, x) => n + (x.meta.changes ?? 0), 0) })
  })

  r.post('/admin-ops/evaluation/cycles/{id}/invitations', STAFF_WRITE, async (c) => {
    const inst = institutionId(c)
    const cycleID = pathUUID(c)
    type I = { relation?: string; respondent_user_id?: string; respondent_label?: string }
    const req = await readJSON<{ reviewee_id?: string; invitations?: I[] }>(c.req)
    const revieweeID = tr(req.reviewee_id)
    if (!isUUID(revieweeID)) throw refuse('reviewee_id must be a uuid')
    const invs = arr<I>(req.invitations)
    if (invs.length === 0) throw refuse('add at least one person to ask')
    const cyc = await mustFirst<{ status: string; relations: string }>(c.db.prepare(`SELECT status, relations FROM evaluation_cycles WHERE id = ?`).bind(cycleID))
    if (cyc.status === 'closed' || cyc.status === 'released') throw refuse('this cycle has closed')
    const allowed = new Set(parseJSON<string[]>(cyc.relations, []))
    const subj = await mustFirst<{ user_id: string | null }>(c.db.prepare(`SELECT e.user_id FROM evaluation_reviewees v JOIN employees e ON e.id = v.employee_id
        WHERE v.id = ? AND v.cycle_id = ?`).bind(revieweeID, cycleID))
    const stmts: D1PreparedStatement[] = []
    const t = now()
    for (const inv of invs) {
      const rel = inv.relation ?? ''
      if (!allowed.has(rel)) throw refuse('this cycle does not gather feedback from: ' + rel)
      let user: string | null, label = tr(inv.respondent_label)
      if (rel === 'self') {
        if (!subj.user_id) throw refuse('that member of staff has no login, so they cannot rate themselves')
        user = subj.user_id; label = ''
      } else {
        user = optUUID(inv.respondent_user_id)
        if (!user && label === '') throw refuse('an invitation needs either a user or a name to address it to')
      }
      // ON CONFLICT on the expression index, as a NOT EXISTS guard.
      stmts.push(c.db.prepare(`INSERT INTO evaluation_invitations (id, institution_id, cycle_id, reviewee_id, relation, respondent_user_id, respondent_label, status, invited_at)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'invited', ?8
           WHERE NOT EXISTS (SELECT 1 FROM evaluation_invitations x WHERE x.reviewee_id = ?4 AND x.relation = ?5
             AND COALESCE(x.respondent_user_id, '') = COALESCE(?6, '') AND lower(trim(COALESCE(x.respondent_label, ''))) = lower(trim(COALESCE(?7, ''))))`)
        .bind(uuid(), inst, cycleID, revieweeID, rel, user, label === '' ? null : label, t))
    }
    const res = await runOps(c, stmts)
    return ok({ invited: res.reduce((n, x) => n + (x.meta.changes ?? 0), 0) })
  })

  r.post('/admin-ops/evaluation/cycles/{id}/status', STAFF_WRITE, async (c) => {
    const id = pathUUID(c)
    const req = await readJSON<{ status?: string }>(c.req)
    const st = req.status ?? ''
    if (!['open', 'closed', 'released'].includes(st)) throw refuse('status must be open, closed or released')
    const cur = await mustFirst<{ status: string; q: number; v: number }>(c.db.prepare(`SELECT c.status,
        (SELECT count(*) FROM evaluation_questions q WHERE q.cycle_id = c.id) AS q,
        (SELECT count(*) FROM evaluation_reviewees v WHERE v.cycle_id = c.id) AS v FROM evaluation_cycles c WHERE c.id = ?`).bind(id))
    if (st === 'open') {
      if (cur.status !== 'draft') throw refuse('only a draft cycle can be opened')
      if (Number(cur.q) === 0) throw refuse('write the questions before opening the cycle')
      if (Number(cur.v) === 0) throw refuse('add the staff being evaluated before opening the cycle')
    } else if (st === 'closed') {
      if (cur.status !== 'open') throw refuse('only an open cycle can be closed')
    } else if (cur.status !== 'closed') throw refuse('close the cycle before releasing results')
    const t = now(), rel = st === 'released'
    await runOps(c, [c.db.prepare(`UPDATE evaluation_cycles SET status = ?, released_at = ?, released_by = ?, updated_at = ? WHERE id = ?`)
      .bind(st, rel ? t : null, rel ? c.id.userId : null, t, id)])
    return ok({ status: st })
  })

  r.post('/admin-ops/evaluation/reviewees/{id}/release', STAFF_WRITE, async (c) => {
    const id = pathUUID(c)
    const cur = await mustFirst<{ status: string }>(c.db.prepare(`SELECT c.status FROM evaluation_reviewees v JOIN evaluation_cycles c ON c.id = v.cycle_id WHERE v.id = ?`).bind(id))
    if (cur.status !== 'closed' && cur.status !== 'released') throw refuse("close the cycle before releasing anybody's result")
    await runOps(c, [c.db.prepare(`UPDATE evaluation_reviewees SET released_at = ? WHERE id = ?`).bind(now(), id)])
    return ok({ released: true })
  })

  r.get('/admin-ops/evaluation/reviewees/{id}/results', 'auth', async (c) => {
    const id = pathUUID(c)
    const oversight = can(c.id, STAFF_READ)
    const h = await mustFirst<{ status: string; name: string; min_responses: number; released: number; subject: string; user_id: string | null }>(
      c.db.prepare(`SELECT c.status, c.name, c.min_responses, v.released_at IS NOT NULL AS released, ${NAME} AS subject, e.user_id
          FROM evaluation_reviewees v JOIN evaluation_cycles c ON c.id = v.cycle_id JOIN employees e ON e.id = v.employee_id WHERE v.id = ?`).bind(id))
    const released = !!Number(h.released)
    const isSubject = h.user_id !== null && h.user_id === c.id.userId
    if (oversight) {
      if (h.status !== 'closed' && h.status !== 'released') {
        throw denied('results are not readable until the cycle is closed - watching an average move as each response arrives identifies the respondent')
      }
    } else if (isSubject) {
      if (!released) throw denied('your results have not been released to you yet')
    } else throw denied('a 360 result is readable by the person it is about and by whoever runs the cycle')

    const [ar, cr, cm] = await c.db.batch<Row>([
      c.db.prepare(`SELECT s.relation, q.id AS question_id, q.seq, q.prompt, q.kind, q.max_rating,
          sum(CASE WHEN a.rating IS NOT NULL THEN 1 ELSE 0 END) AS responses, avg(a.rating) AS average, min(a.rating) AS low, max(a.rating) AS high
        FROM evaluation_responses s JOIN evaluation_answers a ON a.response_id = s.id JOIN evaluation_questions q ON q.id = a.question_id
       WHERE s.reviewee_id = ? GROUP BY s.relation, q.id ORDER BY s.relation, q.seq`).bind(id),
      c.db.prepare(`SELECT relation, count(*) AS n FROM evaluation_responses WHERE reviewee_id = ? GROUP BY relation`).bind(id),
      c.db.prepare(`SELECT s.relation, a.question_id, a.comment FROM evaluation_responses s JOIN evaluation_answers a ON a.response_id = s.id
       WHERE s.reviewee_id = ? AND NULLIF(trim(a.comment), '') IS NOT NULL`).bind(id),
    ])
    const comments = new Map<string, string[]>()
    for (const v of cm.results) {
      const k = `${v.relation}|${v.question_id}`
      comments.set(k, [...(comments.get(k) ?? []), String(v.comment)])
    }
    type Score = { question_id: unknown; seq: number; prompt: unknown; kind: unknown; max_rating: number; responses: number; average?: number; low?: number; high?: number; comments: string[] }
    type Res = { relation: string; responses: number; attributed: boolean; suppressed: boolean; suppressed_reason?: string; questions: Score[] }
    const results: Res[] = [], byRel = new Map<string, Res>()
    for (const v of ar.results) {
      const rel = String(v.relation)
      let rr = byRel.get(rel)
      if (!rr) { rr = { relation: rel, responses: 0, attributed: attributed(rel), suppressed: false, questions: [] }; results.push(rr); byRel.set(rel, rr) }
      rr.questions.push({ question_id: v.question_id, seq: Number(v.seq), prompt: v.prompt, kind: v.kind, max_rating: Number(v.max_rating),
        responses: Number(v.responses), average: v.average === null ? undefined : Number(v.average), low: v.low === null ? undefined : Number(v.low),
        high: v.high === null ? undefined : Number(v.high), comments: comments.get(`${rel}|${v.question_id}`) ?? [] })
    }
    for (const v of cr.results) {
      const rel = String(v.relation)
      const rr = byRel.get(rel)
      if (rr) rr.responses = Number(v.n)
      else { const n: Res = { relation: rel, responses: Number(v.n), attributed: attributed(rel), suppressed: false, questions: [] }; results.push(n); byRel.set(rel, n) }
    }
    const min = Number(h.min_responses)
    let suppressed = 0
    for (const rr of results) {
      if (rr.attributed || rr.responses >= min) continue
      rr.suppressed = true; rr.questions = []
      rr.suppressed_reason = `${rr.responses} of the ${min} responses needed. Showing an average of so few would identify who gave it.`
      suppressed++
    }
    return ok({ cycle: { name: h.name, status: h.status, min_responses: min }, subject: h.subject, viewer: { oversight, released }, results, suppressed,
      anonymity_note: 'Peer, student and parent feedback is aggregated only. Head and self ratings are shown as attributed, because a reviewee has one head and pretending otherwise would be a fiction the reviewee can see through.' })
  })

  r.get('/admin-ops/evaluation/my-invitations', 'auth', async (c) => {
    const rows = await c.db.prepare(`SELECT i.id, c.name AS cycle, c.id AS cycle_id, i.relation, ${NAME} AS about, substr(c.closes_on,1,10) AS closes_on, i.status
        FROM evaluation_invitations i JOIN evaluation_cycles c ON c.id = i.cycle_id JOIN evaluation_reviewees v ON v.id = i.reviewee_id
        JOIN employees e ON e.id = v.employee_id
       WHERE i.respondent_user_id = ? AND c.status = 'open' ORDER BY c.closes_on, e.first_name`).bind(c.id.userId).all<Row>()
    return ok({ items: rows.results })
  })

  r.post('/admin-ops/evaluation/invitations/{id}/respond', 'auth', async (c) => {
    const inst = institutionId(c)
    const id = pathUUID(c)
    type A = { question_id?: string; rating?: number | null; comment?: string }
    const req = await readJSON<{ decline?: boolean; reason?: string; answers?: A[] }>(c.req)
    const answers = arr<A>(req.answers)
    if (!req.decline && answers.length === 0) throw refuse('answer at least one question, or decline')
    const inv = await mustFirst<{ respondent_user_id: string | null; status: string; relation: string; cycle_id: string; reviewee_id: string; cstatus: string }>(
      c.db.prepare(`SELECT i.respondent_user_id, i.status, i.relation, i.cycle_id, i.reviewee_id, c.status AS cstatus
          FROM evaluation_invitations i JOIN evaluation_cycles c ON c.id = i.cycle_id WHERE i.id = ?`).bind(id))
    if (!inv.respondent_user_id || inv.respondent_user_id !== c.id.userId) throw denied('that invitation was not addressed to you')
    if (inv.cstatus !== 'open') throw refuse('this evaluation cycle is not open')
    if (inv.status === 'responded') throw refuse('you have already answered this one')
    if (req.decline) {
      await runOps(c, [c.db.prepare(`UPDATE evaluation_invitations SET status = 'declined', declined_reason = ? WHERE id = ?`).bind(nz(req.reason), id)])
      return ok({ recorded: true, note: 'Your answers are stored without any link to you.' })
    }
    const t = now(), respID = uuid()
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO evaluation_responses (id, institution_id, cycle_id, reviewee_id, relation, submitted_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(respID, inst, inv.cycle_id, inv.reviewee_id, inv.relation, t)]
    const qids = answers.map((a) => tr(a.question_id))
    for (const q of qids) if (!isUUID(q)) throw refuse('question_id must be a uuid')
    const scale = new Map((await c.db.prepare(`SELECT id, kind, max_rating FROM evaluation_questions WHERE cycle_id = ?`).bind(inv.cycle_id)
      .all<{ id: string; kind: string; max_rating: number }>()).results.map((q) => [q.id, q]))
    answers.forEach((a, i) => {
      const rating = a.rating ?? null
      if (rating === null && tr(a.comment) === '') return
      if (rating !== null && rating < 1) throw refuse('a rating starts at 1')
      if (rating !== null) { // evaluation_answers_scale
        const q = scale.get(qids[i])
        if (q && q.kind === 'text') throw refuse('that question asks for a comment, not a rating')
        if (q && rating > q.max_rating) throw refuse(`rating ${rating} is above the scale for this question (max ${q.max_rating})`)
      }
      stmts.push(c.db.prepare(`INSERT INTO evaluation_answers (id, institution_id, response_id, question_id, rating, comment) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst, respID, qids[i], rating, nz(a.comment)))
    })
    stmts.push(c.db.prepare(`UPDATE evaluation_invitations SET status = 'responded', responded_at = ? WHERE id = ?`).bind(t, id))
    await runOps(c, stmts)
    return ok({ recorded: true, note: 'Your answers are stored without any link to you.' })
  })
}
