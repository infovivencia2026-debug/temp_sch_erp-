import type { Router, Ctx } from '../../router'
import { created, isUUID, now, ok, readJSON, uuid } from '../../http'
import { institutionId, parseJSON } from './common'
import { arr, fmtPaise, mustFirst, nextNumber, nz, om, optDate, optUUID, pathUUID, qStr, refuse, runOps, todayIST, tr } from './ops_common'

/* Fee regulatory committee filings under /admin-ops/fee-filings, from
   internal/api/admin_ops.go.

   Triggers re-implemented (00053): fee_regulatory_filings_frozen and
   fee_regulatory_filing_lines_frozen. The handlers here only ever write the
   frozen columns while the filing is a draft (checked before the write, and
   each UPDATE carries `status = 'draft'` where it touches them); after
   submission only the decision columns and approved amounts move, which the
   triggers allowed. */

const FEES_READ = 'finance.fees.read'
const FEES_WRITE = 'finance.fees.write'
type Row = Record<string, unknown>

const FILING_SELECT = `
  SELECT f.id, f.filing_no, f.committee_name, f.committee_level, f.state, y.name AS academic_year, f.status,
         substr(f.submitted_on,1,10) AS submitted_on, f.acknowledgement_no, substr(f.decided_on,1,10) AS decided_on,
         st.name AS fee_structure, v.version_no,
         (SELECT count(*) FROM fee_regulatory_filing_lines l WHERE l.filing_id = f.id) AS line_count,
         (SELECT count(*) FROM fee_regulatory_filing_documents d JOIN files fi ON fi.id = d.file_id
           WHERE d.filing_id = f.id AND fi.deleted_at IS NULL) AS document_count,
         COALESCE((SELECT sum(l.proposed_paise) FROM fee_regulatory_filing_lines l WHERE l.filing_id = f.id), 0) AS proposed_total_paise,
         (SELECT sum(l.approved_paise) FROM fee_regulatory_filing_lines l WHERE l.filing_id = f.id) AS approved_total_paise
    FROM fee_regulatory_filings f
    LEFT JOIN academic_years y ON y.id = f.academic_year_id
    LEFT JOIN fee_structure_versions v ON v.id = f.fee_structure_version_id
    LEFT JOIN fee_structures st ON st.id = v.fee_structure_id`

const filingRow = (v: Row) => ({
  id: v.id, filing_no: v.filing_no, committee_name: v.committee_name, committee_level: v.committee_level, state: om(v.state),
  academic_year: om(v.academic_year), status: v.status, submitted_on: om(v.submitted_on), acknowledgement_no: om(v.acknowledgement_no),
  decided_on: om(v.decided_on), fee_structure: om(v.fee_structure), version_no: v.version_no === null ? undefined : Number(v.version_no),
  line_count: Number(v.line_count), document_count: Number(v.document_count), proposed_total_paise: Number(v.proposed_total_paise),
  approved_total_paise: v.approved_total_paise === null ? undefined : Number(v.approved_total_paise),
})

/** The frozen copy submitFeeFiling builds in SQL, built here from the same rows. */
async function snapshot(c: Ctx, id: string): Promise<string> {
  const [fr, lr, dr] = await c.db.batch<Row>([
    c.db.prepare(`SELECT filing_no, committee_name, committee_level, fee_structure_version_id FROM fee_regulatory_filings WHERE id = ?`).bind(id),
    c.db.prepare(`SELECT h.name AS fee_head, l.fee_head_id, c.name AS class, l.class_id, l.instalment_no, l.proposed_paise
        FROM fee_regulatory_filing_lines l JOIN fee_heads h ON h.id = l.fee_head_id LEFT JOIN classes c ON c.id = l.class_id
       WHERE l.filing_id = ? ORDER BY h.name, l.instalment_no`).bind(id),
    c.db.prepare(`SELECT d.doc_type, fi.original_name AS file, d.file_id FROM fee_regulatory_filing_documents d JOIN files fi ON fi.id = d.file_id
       WHERE d.filing_id = ? ORDER BY d.doc_type`).bind(id),
  ])
  const f = fr.results[0] ?? {}
  return JSON.stringify({
    filed_at: new Date().toISOString().slice(0, 19) + 'Z', filing_no: f.filing_no, committee: f.committee_name, committee_level: f.committee_level,
    version_id: f.fee_structure_version_id ?? null,
    lines: lr.results.map((l) => ({ fee_head: l.fee_head, fee_head_id: l.fee_head_id, class: l.class ?? null, class_id: l.class_id ?? null,
      instalment_no: Number(l.instalment_no), proposed_paise: Number(l.proposed_paise) })),
    documents: dr.results.map((d) => ({ doc_type: d.doc_type, file: d.file, file_id: d.file_id })),
  })
}

export function registerOpsFeeFilings(r: Router): void {
  r.get('/admin-ops/fee-filings', FEES_READ, async (c) => {
    const rows = await c.db.prepare(`${FILING_SELECT} WHERE (?1 IS NULL OR f.status = ?1) ORDER BY f.created_at DESC LIMIT 200`)
      .bind(qStr(c.url.searchParams.get('status'))).all<Row>()
    return ok({ items: rows.results.map(filingRow) })
  })

  r.get('/admin-ops/fee-filings/{id}', FEES_READ, async (c) => {
    const id = pathUUID(c)
    const head = await mustFirst<Row>(c.db.prepare(`${FILING_SELECT} WHERE f.id = ?`).bind(id))
    const [xr, lr, dr] = await c.db.batch<Row>([
      c.db.prepare(`SELECT filed_snapshot, decision_note, notes FROM fee_regulatory_filings WHERE id = ?`).bind(id),
      c.db.prepare(`SELECT l.id, l.fee_head_id, h.name AS fee_head, l.class_id, c.name AS class, l.instalment_no, l.proposed_paise, l.approved_paise, l.modification_note
          FROM fee_regulatory_filing_lines l JOIN fee_heads h ON h.id = l.fee_head_id LEFT JOIN classes c ON c.id = l.class_id
         WHERE l.filing_id = ? ORDER BY (c.level IS NOT NULL), c.level, h.name, l.instalment_no`).bind(id),
      c.db.prepare(`SELECT d.id, d.file_id, d.doc_type, fi.original_name, fi.size_bytes, d.covers_period, u.full_name AS attached_by, substr(d.created_at,1,10) AS attached_on
          FROM fee_regulatory_filing_documents d JOIN files fi ON fi.id = d.file_id LEFT JOIN users u ON u.id = d.attached_by
         WHERE d.filing_id = ? AND fi.deleted_at IS NULL ORDER BY d.doc_type, d.created_at`).bind(id),
    ])
    const x = xr.results[0] ?? {}
    return ok({
      filing: filingRow(head),
      lines: lr.results.map((v) => ({ id: v.id, fee_head_id: v.fee_head_id, fee_head: v.fee_head, class_id: om(v.class_id), class: om(v.class),
        instalment_no: Number(v.instalment_no), proposed_paise: Number(v.proposed_paise), approved_paise: v.approved_paise === null ? undefined : Number(v.approved_paise),
        modification_note: om(v.modification_note) })),
      documents: dr.results.map((v) => ({ id: v.id, file_id: v.file_id, doc_type: v.doc_type, original_name: v.original_name, size_bytes: Number(v.size_bytes),
        covers_period: om(v.covers_period), attached_by: om(v.attached_by), attached_on: v.attached_on })),
      decision_note: x.decision_note ?? null, notes: x.notes ?? null, filed_snapshot: parseJSON<unknown>(x.filed_snapshot, {}),
    })
  })

  r.post('/admin-ops/fee-filings', FEES_WRITE, async (c) => {
    const inst = institutionId(c)
    type L = { fee_head_id?: string; class_id?: string; instalment_no?: number; proposed_paise?: number }
    const req = await readJSON<{ id?: string; filing_no?: string; committee_name?: string; committee_level?: string; state?: string; academic_year_id?: string;
      campus_id?: string; fee_structure_version_id?: string; notes?: string; lines?: L[] }>(c.req)
    if (tr(req.committee_name) === '') throw refuse('name the committee this is being filed with')
    const level = tr(req.committee_level) || 'district'
    if (!['district', 'division', 'state'].includes(level)) throw refuse('committee_level must be district, division or state')
    const version = optUUID(req.fee_structure_version_id)
    const lines = arr<L>(req.lines)
    if (!version && lines.length === 0) throw refuse('choose the fee structure version being filed, or supply the proposed amounts')
    const year = optUUID(req.academic_year_id)
    const campus = optUUID(req.campus_id)
    const t = now()
    const stmts: D1PreparedStatement[] = []
    let id: string, no: string
    if (tr(req.id) !== '') {
      if (!isUUID(tr(req.id))) throw refuse('malformed filing id')
      id = tr(req.id)
      const cur = await mustFirst<{ status: string; filing_no: string }>(c.db.prepare(`SELECT status, filing_no FROM fee_regulatory_filings WHERE id = ?`).bind(id))
      no = cur.filing_no
      if (cur.status !== 'draft') throw refuse('this filing has been submitted. What was filed cannot be changed')
      stmts.push(c.db.prepare(`UPDATE fee_regulatory_filings SET committee_name = ?, committee_level = ?, state = ?, academic_year_id = ?, campus_id = ?,
          fee_structure_version_id = ?, notes = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
        .bind(tr(req.committee_name), level, nz(req.state), year, campus, version, nz(req.notes), t, id))
      stmts.push(c.db.prepare(`DELETE FROM fee_regulatory_filing_lines WHERE filing_id = ?`).bind(id))
    } else {
      no = tr(req.filing_no) || await nextNumber(c, 'fee_regulatory_filings', 'filing_no', 'FRC', 4)
      id = uuid()
      stmts.push(c.db.prepare(`INSERT INTO fee_regulatory_filings (id, institution_id, campus_id, filing_no, academic_year_id, committee_name, committee_level, state,
          fee_structure_version_id, status, filed_snapshot, prepared_by, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '{}', ?, ?, ?, ?)`)
        .bind(id, inst, campus, no, year, tr(req.committee_name), level, nz(req.state), version, c.id.userId, nz(req.notes), t, t))
    }
    let compiled: number
    if (lines.length > 0) {
      for (const l of lines) {
        const headID = tr(l.fee_head_id)
        if (!isUUID(headID)) throw refuse('fee_head_id must be a uuid')
        const cls = optUUID(l.class_id)
        if ((l.proposed_paise ?? 0) < 0) throw refuse('a proposed amount cannot be negative')
        stmts.push(c.db.prepare(`INSERT INTO fee_regulatory_filing_lines (id, institution_id, filing_id, fee_head_id, class_id, instalment_no, proposed_paise)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, id, headID, cls, l.instalment_no || 1, l.proposed_paise ?? 0))
      }
      compiled = lines.length
    } else {
      const items = (await c.db.prepare(`SELECT i.fee_head_id, st.class_id, i.instalment_no, i.amount_paise
          FROM fee_structure_version_items i JOIN fee_structure_versions v ON v.id = i.version_id JOIN fee_structures st ON st.id = v.fee_structure_id
         WHERE i.version_id = ?`).bind(version).all<Row>()).results
      compiled = items.length
      if (compiled === 0) throw refuse('that fee structure version has no amounts on it yet')
      for (const i of items) stmts.push(c.db.prepare(`INSERT INTO fee_regulatory_filing_lines (id, institution_id, filing_id, fee_head_id, class_id, instalment_no, proposed_paise)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, id, i.fee_head_id, i.class_id ?? null, i.instalment_no, i.amount_paise))
    }
    await runOps(c, stmts)
    return ok({ id, filing_no: no, lines: compiled })
  })

  r.post('/admin-ops/fee-filings/{id}/submit', FEES_WRITE, async (c) => {
    const id = pathUUID(c)
    const req = await readJSON<{ submitted_on?: string; acknowledgement_no?: string }>(c.req)
    const submitted = optDate(req.submitted_on, 'submitted_on must be a date, as YYYY-MM-DD') ?? todayIST()
    const cur = await mustFirst<{ status: string; lines: number; docs: number }>(c.db.prepare(`SELECT f.status,
        (SELECT count(*) FROM fee_regulatory_filing_lines l WHERE l.filing_id = f.id) AS lines,
        (SELECT count(*) FROM fee_regulatory_filing_documents d WHERE d.filing_id = f.id) AS docs FROM fee_regulatory_filings f WHERE f.id = ?`).bind(id))
    if (cur.status !== 'draft') throw refuse('this filing has already been submitted')
    if (Number(cur.lines) === 0) throw refuse('a filing needs the proposed fee amounts on it')
    if (Number(cur.docs) === 0) throw refuse('attach the supporting accounts before filing')
    const snap = await snapshot(c, id)
    await runOps(c, [c.db.prepare(`UPDATE fee_regulatory_filings SET status = 'submitted', submitted_on = ?, acknowledgement_no = ?, filed_snapshot = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'`).bind(submitted, nz(req.acknowledgement_no), snap, now(), id)])
    return ok({ status: 'submitted', submitted_on: submitted })
  })

  r.post('/admin-ops/fee-filings/{id}/decide', FEES_WRITE, async (c) => {
    const id = pathUUID(c)
    type A = { line_id?: string; approved_paise?: number; note?: string }
    const req = await readJSON<{ decision?: string; decided_on?: string; note?: string; acknowledgement_no?: string; approved_lines?: A[] }>(c.req)
    const d = req.decision ?? ''
    if (!['approved', 'approved_with_modification', 'rejected', 'withdrawn'].includes(d)) {
      throw refuse('decision must be approved, approved_with_modification, rejected or withdrawn')
    }
    if ((d === 'approved_with_modification' || d === 'rejected') && tr(req.note) === '') throw refuse('record what the committee said')
    const approved = arr<A>(req.approved_lines)
    if (d === 'approved_with_modification' && approved.length === 0) throw refuse('record the amounts the committee allowed')
    const decided = optDate(req.decided_on, 'decided_on must be a date, as YYYY-MM-DD') ?? todayIST()
    const cur = await mustFirst<{ status: string }>(c.db.prepare(`SELECT status FROM fee_regulatory_filings WHERE id = ?`).bind(id))
    if (cur.status === 'draft') throw refuse('this filing has not been submitted yet')
    const onFiling = new Set((await c.db.prepare(`SELECT id FROM fee_regulatory_filing_lines WHERE filing_id = ?`).bind(id).all<{ id: string }>()).results.map((x) => x.id))
    const stmts: D1PreparedStatement[] = []
    for (const a of approved) {
      const lineID = tr(a.line_id)
      if (!isUUID(lineID)) throw refuse('line_id must be a uuid')
      if ((a.approved_paise ?? 0) < 0) throw refuse('an approved amount cannot be negative')
      if (!onFiling.has(lineID)) throw refuse('one of those lines is not on this filing')
      stmts.push(c.db.prepare(`UPDATE fee_regulatory_filing_lines SET approved_paise = ?, modification_note = ? WHERE id = ? AND filing_id = ?`)
        .bind(a.approved_paise ?? 0, nz(a.note), lineID, id))
    }
    if (d === 'approved' || d === 'approved_with_modification') {
      stmts.push(c.db.prepare(`UPDATE fee_regulatory_filing_lines SET approved_paise = proposed_paise WHERE filing_id = ? AND approved_paise IS NULL`).bind(id))
    }
    stmts.push(c.db.prepare(`UPDATE fee_regulatory_filings SET status = ?, decided_on = ?, decision_note = ?, decided_recorded_by = ?,
        acknowledgement_no = COALESCE(?, acknowledgement_no), updated_at = ? WHERE id = ?`)
      .bind(d, d === 'withdrawn' ? null : decided, nz(req.note), c.id.userId, nz(req.acknowledgement_no), now(), id))
    await runOps(c, stmts)
    return ok({ status: d })
  })

  r.post('/admin-ops/fee-filings/{id}/documents', FEES_WRITE, async (c) => {
    const inst = institutionId(c)
    const id = pathUUID(c)
    const req = await readJSON<{ file_id?: string; doc_type?: string; covers_period?: string; notes?: string }>(c.req)
    const fileID = tr(req.file_id)
    if (!isUUID(fileID)) throw refuse('file_id must be a uuid. Upload the document first')
    if (tr(req.doc_type) === '') throw refuse('say what this document is')
    const f = await mustFirst<{ deleted_at: string | null }>(c.db.prepare(`SELECT deleted_at FROM files WHERE id = ?`).bind(fileID))
    if (f.deleted_at) throw refuse('that file has been deleted')
    const docID = uuid()
    await runOps(c, [c.db.prepare(`INSERT INTO fee_regulatory_filing_documents (id, institution_id, filing_id, file_id, doc_type, covers_period, notes, attached_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(docID, inst, id, fileID, tr(req.doc_type), nz(req.covers_period), nz(req.notes), c.id.userId, now())])
    return created({ id: docID })
  })

  r.get('/admin-ops/fee-filings/{id}/variance', FEES_READ, async (c) => {
    const id = pathUUID(c)
    const f = await mustFirst<{ filing_no: string; status: string; academic_year_id: string | null; year: string | null }>(c.db.prepare(`SELECT f.filing_no, f.status,
        f.academic_year_id, y.name AS year FROM fee_regulatory_filings f LEFT JOIN academic_years y ON y.id = f.academic_year_id WHERE f.id = ?`).bind(id))
    if (!f.academic_year_id) throw refuse('this filing names no academic year, so there is nothing to compare it against')
    const q = await c.db.prepare(`WITH charged AS (
        SELECT (SELECT e.class_id FROM enrollments e WHERE e.student_id = i.student_id AND e.academic_year_id = i.academic_year_id LIMIT 1) AS class_id,
               il.fee_head_id, COALESCE(i.instalment_no, 1) AS instalment_no, max(il.amount_paise) AS charged_paise, count(DISTINCT i.student_id) AS students
          FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
         WHERE i.academic_year_id = ?1 AND i.status <> 'cancelled'
         GROUP BY 1, 2, 3)
      SELECT c.name AS class, h.name AS fee_head, ch.instalment_no, ch.charged_paise, ch.students,
             (SELECT l.approved_paise FROM fee_regulatory_filing_lines l
               WHERE l.filing_id = ?2 AND l.fee_head_id = ch.fee_head_id AND l.instalment_no = ch.instalment_no
                 AND (l.class_id = ch.class_id OR l.class_id IS NULL)
               ORDER BY (l.class_id IS NULL) LIMIT 1) AS approved_paise
        FROM charged ch JOIN fee_heads h ON h.id = ch.fee_head_id LEFT JOIN classes c ON c.id = ch.class_id
       ORDER BY (c.level IS NOT NULL), c.level, h.name, ch.instalment_no`).bind(f.academic_year_id, id).all<Row>()
    let total = 0, over = 0, unfiled = 0
    const rows = q.results.map((v) => {
      const charged = Number(v.charged_paise), students = Number(v.students)
      const appr = v.approved_paise === null ? null : Number(v.approved_paise)
      let verdict: string, variance = 0, exposure = 0
      if (appr === null) { verdict = 'not_filed'; exposure = charged * students; unfiled++ }
      else if (charged > appr) { verdict = 'over_approved'; variance = charged - appr; exposure = variance * students; over++ }
      else if (charged < appr) { verdict = 'under_approved'; variance = charged - appr }
      else verdict = 'as_approved'
      total += exposure
      return { class: om(v.class), fee_head: v.fee_head, instalment_no: Number(v.instalment_no), approved_paise: appr ?? undefined,
        charged_paise: charged, students, variance_paise: variance, exposure_paise: exposure, verdict }
    })
    let summary = 'Everything billed matches what the committee approved.'
    if (f.status === 'draft' || f.status === 'submitted') summary = 'This filing has not been decided yet, so there is nothing approved to charge against.'
    else if (over > 0 || unfiled > 0) summary = `${over} fee lines are above the approved amount and ${unfiled} were never filed. Exposure if refunds are ordered: ${fmtPaise(total)}.`
    return ok({ filing: { filing_no: f.filing_no, status: f.status, academic_year: f.year }, rows, over_approved: over, never_filed: unfiled,
      exposure_paise: total, summary,
      basis: 'Charged figures are invoice_lines.amount_paise. What students were actually billed. Before concessions, because a concession is the school remitting an approved fee and not a lower fee.' })
  })
}
