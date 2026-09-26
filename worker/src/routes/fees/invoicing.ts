import type { Router } from '../../router'
import type { Ctx } from '../../router'
import { HttpError, badRequest, created, forbidden, isUUID, notFound, now, ok, readJSON, uuidParam } from '../../http'
import { can } from '../../identity'
import { addDays, householdUserIds, isDate, notifyStmt, p, requireOpenPeriod, requireOpenYear, rupeesFixed, syncInvoice, syncPayment, today } from './common'
import { nextNumber } from './numbering'
import { school } from '../school'

/* Port of generateInvoices (fees.go) with fee_run_lines.go,
   fee_components.go and fee_arrears.go folded in, plus addInvoicePenalty
   (fee_penalty.go) and setInvoiceNote (fee_optins.go).

   invoices.net_paise was a generated column in Postgres; every write here
   sets it from gross - discount + fine. The invoices_touch trigger is the
   updated_at on each UPDATE. */

interface RunLine { head_id: string; instalment: number; amount_paise: number }
interface RunSource { version_id: string | null; filing_id: string | null; lines: RunLine[] }

/** loadFeeRunLines: the lines a run may bill from one structure, and the version they come from. */
async function loadFeeRunLines(c: Ctx, structureId: string, classId: string | null): Promise<RunSource> {
  const t = today()
  const v = await c.db.prepare(`
    SELECT v.id,
           EXISTS (SELECT 1 FROM fee_regulatory_filings f JOIN fee_structure_versions fv ON fv.id = f.fee_structure_version_id
                    WHERE fv.fee_structure_id = v.fee_structure_id AND f.status <> 'draft') AS filed,
           EXISTS (SELECT 1 FROM fee_regulatory_filings f WHERE f.fee_structure_version_id = v.id AND f.status IN ('approved','approved_with_modification')) AS approved,
           (SELECT f.id FROM fee_regulatory_filings f WHERE f.fee_structure_version_id = v.id AND f.status = 'approved_with_modification'
             ORDER BY f.decided_on IS NULL, f.decided_on DESC, f.created_at DESC LIMIT 1) AS filing_id
      FROM fee_structure_versions v
     WHERE v.fee_structure_id = ?1 AND v.status = 'active' AND v.effective_from <= ?2 AND (v.effective_to IS NULL OR v.effective_to >= ?2)
     ORDER BY v.effective_from DESC LIMIT 1`).bind(structureId, t).first<{ id: string; filed: number; approved: number; filing_id: string | null }>()
  if (!v) {
    const rows = await c.db.prepare(`SELECT fee_head_id AS head_id, instalment_no AS instalment, amount_paise FROM fee_structure_items WHERE fee_structure_id = ? ORDER BY instalment_no, fee_head_id`)
      .bind(structureId).all<RunLine>()
    return { version_id: null, filing_id: null, lines: rows.results.map((l) => ({ ...l, amount_paise: p(l.amount_paise) })) }
  }
  if (v.filed && !v.approved) throw new HttpError(409, 'this fee structure was filed with the fee committee and the committee\'s approval has not been recorded against its live version, so nothing can be billed from it yet. Record the decision under Fee regulatory filing, or activate the version the committee approved.', { code: 'fee_version_not_approved' })
  // The version's snapshot, with the committee's figure where it differs; a
  // class-specific filing line beats a school-wide one (DISTINCT ON ... ORDER BY class_id IS NULL).
  const rows = await c.db.prepare(`
    SELECT vi.fee_head_id AS head_id, vi.instalment_no AS instalment,
           COALESCE((SELECT fl.approved_paise FROM fee_regulatory_filing_lines fl
                      WHERE ?2 IS NOT NULL AND fl.filing_id = ?2 AND fl.fee_head_id = vi.fee_head_id AND fl.instalment_no = vi.instalment_no
                        AND (fl.class_id IS NULL OR fl.class_id = ?3)
                      ORDER BY fl.class_id IS NULL LIMIT 1), vi.amount_paise) AS amount_paise
      FROM fee_structure_version_items vi WHERE vi.version_id = ?1 ORDER BY vi.id`).bind(v.id, v.filing_id, classId).all<RunLine>()
  return { version_id: v.id, filing_id: v.filing_id, lines: rows.results.map((l) => ({ ...l, amount_paise: p(l.amount_paise) })) }
}

function forInstalment(src: RunSource, n: number, all: boolean): { lines: RunLine[]; worth: number; instalments: number } {
  const seen = new Set<number>(); const lines: RunLine[] = []; let worth = 0
  for (const l of src.lines) {
    if (!all && l.instalment !== n) continue
    lines.push(l); worth += l.amount_paise; seen.add(l.instalment)
  }
  return { lines, worth, instalments: seen.size || 1 }
}

interface Concession { fee_head_id: string | null; amount_paise: number | null; percent: string | null }

/**
 * The per-line concession rule shared by structure lines and components: a
 * flat amount applies to the head it names, a percent to every line it
 * matches, the larger wins, capped at the line. Head-less flat amounts are
 * applied once by applyFlatConcession.
 */
function lineDiscount(amount: number, headId: string, cons: Concession[]): number {
  let flat = 0, pct = 0
  for (const fc of cons) {
    if (!(fc.fee_head_id === null || fc.fee_head_id === headId)) continue
    if (fc.fee_head_id === headId && fc.amount_paise !== null) flat = Math.max(flat, p(fc.amount_paise))
    if (fc.percent !== null) { const pc = Number(fc.percent); if (Number.isFinite(pc)) pct = Math.max(pct, Math.round(amount * pc / 100)) }
  }
  return Math.min(amount, Math.max(flat, pct))
}

/** ensureFeeHead: the school's own head by code or name, or a new one. */
export async function ensureFeeHead(c: Ctx, code: string, name: string): Promise<string> {
  const up = code.toUpperCase()
  const found = await c.db.prepare(`SELECT id FROM fee_heads WHERE institution_id = ?1 AND (code = ?2 OR name LIKE '%' || ?3 || '%') ORDER BY code = ?2 DESC, created_at LIMIT 1`)
    .bind(school(c).id, up, code).first<{ id: string }>()
  if (found) return found.id
  const id = crypto.randomUUID()
  try {
    await c.db.prepare(`INSERT INTO fee_heads (id, institution_id, name, code, is_recurring, created_at) VALUES (?, ?, ?, ?, 1, ?)`).bind(id, school(c).id, name, up, now()).run()
    return id
  } catch {
    const again = await c.db.prepare(`SELECT id FROM fee_heads WHERE institution_id = ? AND code = ?`).bind(school(c).id, up).first<{ id: string }>()
    if (!again) throw new Error('fee head ' + code)
    return again.id
  }
}

export function registerInvoicing(r: Router): void {
  r.post('/fees/invoices/generate', 'auth', async (c) => {
    if (!can(c.id, 'finance.invoices.write') && !can(c.id, 'admissions.write')) throw forbidden()
    const req = await readJSON<{ fee_structure_id?: string; instalment_no?: number; due_on?: string; student_id?: string; all_instalments?: boolean }>(c.req)
    const studentOnly = (req.student_id ?? '').trim()
    if (studentOnly === '' && !can(c.id, 'finance.invoices.write')) {
      throw forbidden("raising a whole class's demand needs the invoices permission. One child's fee can be raised from their own record")
    }
    if (!isUUID(req.fee_structure_id)) throw badRequest('fee_structure_id must be a uuid')
    let instalmentNo = Number(req.instalment_no ?? 0)
    if (!Number.isInteger(instalmentNo) || instalmentNo <= 0) instalmentNo = 1
    let dueOn = addDays(today(), 14)
    if (req.due_on) { if (!isDate(req.due_on)) throw badRequest('due_on must be YYYY-MM-DD'); dueOn = req.due_on }
    const allInstalments = !!req.all_instalments

    const fs = await c.db.prepare(`SELECT institution_id, campus_id, academic_year_id, class_id FROM fee_structures WHERE id = ? AND is_active`).bind(req.fee_structure_id)
      .first<{ institution_id: string; campus_id: string; academic_year_id: string; class_id: string | null }>()
    if (!fs) throw badRequest('no active fee structure with that id')
    await requireOpenYear(c, fs.academic_year_id)
    await requireOpenPeriod(c, today())

    const t = today()
    const vc = await c.db.prepare(`SELECT count(*) AS versions,
        sum(CASE WHEN status = 'active' AND effective_from <= ?2 AND (effective_to IS NULL OR effective_to >= ?2) THEN 1 ELSE 0 END) AS live
        FROM fee_structure_versions WHERE fee_structure_id = ?1`).bind(req.fee_structure_id, t).first<{ versions: number; live: number | null }>()
    if (p(vc?.versions) > 0 && p(vc?.live) === 0) {
      throw new HttpError(409, 'cannot generate invoices: this fee structure has no live version. Activate a version first, or a parent will be billed a figure the school has not agreed.', { code: 'no_live_fee_version' })
    }

    const source = await loadFeeRunLines(c, req.fee_structure_id, fs.class_id)
    const run = forInstalment(source, instalmentNo, allInstalments)
    const worthNothing = () => badRequest('every head in that structure is priced at nought, so raising it would bill the family nothing. Price the heads under Fees → Class & transport fee setup, or pick the structure that does')
    if (run.lines.length > 0 && run.worth === 0) throw worthNothing()
    if (run.lines.length === 0) {
      if (allInstalments) throw worthNothing()
      throw new HttpError(409, `this fee structure has nothing priced under instalment ${instalmentNo}, so every invoice would come to zero. Check the instalment number, or add the lines to the structure first.`, { code: 'no_such_instalment' })
    }

    const pending = await c.db.prepare(`SELECT count(DISTINCT fc.student_id) AS n FROM fee_concessions fc JOIN enrollments e ON e.student_id = fc.student_id
        WHERE fc.status = 'pending' AND e.academic_year_id = ?1 AND e.status = 'active' AND (?2 IS NULL OR e.class_id = ?2)`)
      .bind(fs.academic_year_id, fs.class_id).first<{ n: number }>()

    const students = await c.db.prepare(`
      SELECT e.student_id FROM enrollments e
       WHERE e.academic_year_id = ?1 AND e.status = 'active'
         AND (?4 IS NULL OR e.student_id = ?4)
         AND (?2 IS NULL OR e.class_id = ?2)
         AND (?2 IS NOT NULL OR NOT EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.class_id = e.class_id AND fs.is_active AND fs.academic_year_id = e.academic_year_id))
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.student_id = e.student_id AND i.academic_year_id = ?1 AND (i.instalment_no = ?3 OR i.covers_year) AND i.status <> 'cancelled')`)
      .bind(fs.academic_year_id, fs.class_id, instalmentNo, studentOnly || null).all<{ student_id: string }>()

    const headNames = new Map<string, string>()
    const headIds = [...new Set(run.lines.map((l) => l.head_id))]
    if (headIds.length) {
      const hs = await c.db.prepare(`SELECT id, name FROM fee_heads WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(headIds)).all<{ id: string; name: string }>()
      for (const h of hs.results) headNames.set(h.id, h.name)
    }

    let createdN = 0, arrearsChildren = 0, arrearsPaise = 0
    const inst = school(c).id
    for (const { student_id: sid } of students.results) {
      const cons = (await c.db.prepare(`SELECT fee_head_id, amount_paise, percent FROM fee_concessions
          WHERE student_id = ? AND academic_year_id = ? AND approved_at IS NOT NULL AND kind <> 'full_payment'`).bind(sid, fs.academic_year_id).all<Concession>()).results

      type Line = { head_id: string; description: string; amount: number; discount: number }
      const lines: Line[] = run.lines.filter((l) => headNames.has(l.head_id)).map((l) => ({
        head_id: l.head_id, description: headNames.get(l.head_id)!, amount: l.amount_paise, discount: lineDiscount(l.amount_paise, l.head_id, cons) }))
      // The child's own charges (bus fare), priced per instalment covered.
      const comps = await c.db.prepare(`SELECT fee_head_id, description, amount_paise FROM student_fee_components
          WHERE student_id = ?1 AND academic_year_id = ?2 AND valid_from <= ?3 AND (valid_to IS NULL OR valid_to >= ?3) AND amount_paise > 0`)
        .bind(sid, fs.academic_year_id, t).all<{ fee_head_id: string; description: string; amount_paise: number }>()
      for (const cp of comps.results) {
        const amt = p(cp.amount_paise) * run.instalments
        lines.push({ head_id: cp.fee_head_id, description: cp.description, amount: amt, discount: lineDiscount(amt, cp.fee_head_id, cons) })
      }
      // The blanket flat concession, once, on the line with the most left to discount.
      const flat = cons.filter((fc) => fc.fee_head_id === null && fc.amount_paise !== null).reduce((m, fc) => Math.max(m, p(fc.amount_paise)), 0)
      if (flat > 0 && lines.length) {
        const target = [...lines].sort((a, b) => (b.amount - b.discount) - (a.amount - a.discount) || b.amount - a.amount)[0]
        target.discount = Math.min(target.amount, target.discount + flat)
      }

      // Arrears from earlier years, restated on this bill and settled by adjustment.
      const old = await c.db.prepare(`
        SELECT i.id, i.invoice_no, ay.name AS year_name, i.net_paise - i.paid_paise AS balance
          FROM invoices i JOIN academic_years ay ON ay.id = i.academic_year_id JOIN academic_years this ON this.id = ?2
         WHERE i.student_id = ?1 AND i.academic_year_id <> ?2 AND ay.starts_on < this.starts_on
           AND i.status IN ('unpaid','partial','overdue') AND i.net_paise > i.paid_paise
           AND NOT EXISTS (SELECT 1 FROM invoice_carry_forwards cf WHERE cf.from_invoice_id = i.id)
         ORDER BY COALESCE(i.due_on, i.issued_on), i.invoice_no`).bind(sid, fs.academic_year_id).all<{ id: string; invoice_no: string; year_name: string; balance: number }>()
      let arrearsHead: string | null = null
      if (old.results.length) arrearsHead = await ensureFeeHead(c, 'arrears', 'Arrears brought forward')
      for (const o of old.results) lines.push({ head_id: arrearsHead!, description: `Brought forward from ${o.invoice_no} (${o.year_name})`, amount: p(o.balance), discount: 0 })

      if (lines.length === 0) continue // an invoice with nothing on it is not a bill

      const number = await nextNumber(c, 'invoice')
      const invoiceId = crypto.randomUUID()
      const gross = lines.reduce((s, l) => s + l.amount, 0)
      const discount = lines.reduce((s, l) => s + l.discount, 0)
      const stmts: D1PreparedStatement[] = [
        ...number.stmts,
        c.db.prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, instalment_no, issued_on, due_on,
                        gross_paise, discount_paise, fine_paise, net_paise, paid_paise, status, fee_structure_version_id, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'unpaid', ?, ?, ?)`)
          .bind(invoiceId, fs.institution_id, fs.campus_id, sid, fs.academic_year_id, number.text, instalmentNo, t, dueOn, gross, discount, gross - discount, source.version_id, now(), now()),
      ]
      for (const l of lines) {
        stmts.push(c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), inst, invoiceId, l.head_id, l.description, l.amount, l.discount))
      }
      let moved = 0
      for (const o of old.results) {
        const paymentId = crypto.randomUUID()
        const bal = p(o.balance)
        stmts.push(c.db.prepare(`INSERT INTO payments (id, institution_id, campus_id, student_id, amount_paise, allocated_paise, mode, paid_on, status, remarks, created_at)
                                 VALUES (?, ?, ?, ?, ?, 0, 'adjustment', ?, 'success', ?, ?)`)
          .bind(paymentId, inst, fs.campus_id, sid, bal, t, 'Carried forward to ' + number.text, now()))
        stmts.push(c.db.prepare(`INSERT INTO payment_allocations (id, institution_id, payment_id, invoice_id, amount_paise, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), inst, paymentId, o.id, bal, now()))
        stmts.push(...syncInvoice(c, o.id), syncPayment(c, paymentId))
        stmts.push(c.db.prepare(`INSERT INTO invoice_carry_forwards (id, institution_id, from_invoice_id, to_invoice_id, payment_id, amount_paise, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), inst, o.id, invoiceId, paymentId, bal, now()))
        moved += bal
      }
      await c.db.batch(stmts)
      if (moved > 0) { arrearsChildren++; arrearsPaise += moved }
      createdN++
    }
    return created({ created: createdN, skipped: 0, instalment_no: instalmentNo, due_on: dueOn,
      pending_concessions: p(pending?.n), arrears_children: arrearsChildren, arrears_paise: arrearsPaise })
  })

  // ---------------------------------------------------------------- penalty
  r.post('/fees/invoices/{id}/penalty', 'finance.payments.write', async (c) => {
    const invoiceId = uuidParam(c.params.id)
    const req = await readJSON<{ amount?: number; reason?: string }>(c.req)
    const reason = (req.reason ?? '').trim()
    if (reason === '') throw badRequest('say what the penalty is for, the family sees this, and a charge they cannot account for is a charge they ring the school about')
    const amount = Number(req.amount ?? 0)
    if (!(amount > 0)) throw badRequest('a penalty has to be more than nothing')
    if (amount > 100000) throw badRequest('that is over ₹1,00,000, if it is right, raise it as its own invoice so it is on the record as a charge rather than a late fee')
    const fine = Math.trunc(amount * 100 + 0.5)

    const inv = await c.db.prepare(`SELECT student_id, status, net_paise FROM invoices WHERE id = ?`).bind(invoiceId).first<{ student_id: string; status: string; net_paise: number }>()
    if (!inv) throw notFound()
    if (inv.status === 'cancelled') throw badRequest('this invoice has been cancelled')
    let head = (await c.db.prepare(`SELECT id FROM fee_heads WHERE lower(name) LIKE '%fine%' OR lower(name) LIKE '%penalt%' ORDER BY name LIMIT 1`).first<{ id: string }>())?.id ?? null
    if (!head) head = (await c.db.prepare(`SELECT fee_head_id AS id FROM invoice_lines WHERE invoice_id = ? LIMIT 1`).bind(invoiceId).first<{ id: string }>())?.id ?? null
    const stmts: D1PreparedStatement[] = []
    if (head) {
      stmts.push(c.db.prepare(`INSERT INTO invoice_lines (id, institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise) VALUES (?, ?, ?, ?, ?, 0, 0)`)
        .bind(crypto.randomUUID(), school(c).id, invoiceId, head, 'Penalty · ' + reason))
    }
    stmts.push(c.db.prepare(`UPDATE invoices SET fine_paise = fine_paise + ?2,
        status = CASE WHEN paid_paise >= (gross_paise - discount_paise + fine_paise + ?2) THEN status ELSE 'unpaid' END,
        net_paise = gross_paise - discount_paise + fine_paise + ?2, updated_at = ?3 WHERE id = ?1`).bind(invoiceId, fine, now()))
    const told = await householdUserIds(c, inv.student_id)
    const amountText = '₹' + rupeesFixed(fine)
    for (const u of told) stmts.push(notifyStmt(c, u, inv.student_id, 'fee_penalty', amountText + ' added to a fee bill', reason + '. The bill now shows the new total.', '/go/fees_payments', 'invoice', invoiceId))
    await c.db.batch(stmts)
    const after = await c.db.prepare(`SELECT net_paise, paid_paise FROM invoices WHERE id = ?`).bind(invoiceId).first<{ net_paise: number; paid_paise: number }>()
    return ok({ fine_added_paise: fine, net_paise: p(after?.net_paise), due_paise: p(after?.net_paise) - p(after?.paid_paise), told: told.length })
  })

  // ---------------------------------------------------------------- note
  r.patch('/fees/invoices/{id}/note', 'finance.payments.write', async (c) => {
    const invoiceId = uuidParam(c.params.id)
    const req = await readJSON<{ note?: string }>(c.req)
    const res = await c.db.prepare(`UPDATE invoices SET note = NULLIF(?2, ''), updated_at = ?3 WHERE id = ?1`).bind(invoiceId, (req.note ?? '').trim(), now()).run()
    if (!res.meta.changes) throw notFound()
    return ok({ ok: true })
  })
}
