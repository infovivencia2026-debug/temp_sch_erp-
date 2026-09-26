import type { Router } from '../../router'
import { bool, ok } from '../../http'
import { fin, items, nameSQL, omitNulls, p, rangeJSON, resolveRange, today } from './common'

/* Port of the finance third of role_backoffice.go: the dashboard KPIs and
   the two 300-row lists behind the fee workspace. Reads only. */

export function registerBackoffice(r: Router): void {
  r.get('/finance/dashboard', 'finance.invoices.read', fin(async (c) => {
    const rng = resolveRange(c)
    const t = today()
    const k = await c.db.prepare(`
      SELECT COALESCE((SELECT sum(amount_paise) FROM payments WHERE status = 'success' AND mode <> 'adjustment' AND paid_on = ?1), 0) AS today_paise,
             COALESCE((SELECT sum(amount_paise) FROM payments WHERE status = 'success' AND mode <> 'adjustment' AND paid_on BETWEEN ?2 AND ?3), 0) AS month_paise,
             COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE status IN ('unpaid','partial','overdue')), 0) AS outstanding_paise,
             COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?1), 0) AS overdue_paise,
             (SELECT count(DISTINCT student_id) FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?1) AS defaulters,
             (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM payments WHERE gateway IS NOT NULL AND reconciled_at IS NULL AND status = 'success') AS unreconciled,
             (SELECT count(*) FROM refunds WHERE status = 'pending') AS refunds_pending`).bind(t, rng.from, rng.to).first<Record<string, number>>()
    return ok({
      today_paise: p(k?.today_paise), month_paise: p(k?.month_paise), outstanding_paise: p(k?.outstanding_paise), overdue_paise: p(k?.overdue_paise),
      defaulters: p(k?.defaulters), invoices: p(k?.invoices), unreconciled: p(k?.unreconciled), refunds_pending: p(k?.refunds_pending),
      range: rangeJSON(rng),
      as_of_now: ['today_paise', 'outstanding_paise', 'overdue_paise', 'defaulters', 'invoices', 'unreconciled', 'refunds_pending'],
    })
  }))

  r.get('/finance/invoices', 'finance.invoices.read', fin(async (c) => {
    const q = c.url.searchParams
    const status = q.get('status') || null
    const overdue = q.get('overdue') === 'true' ? 1 : 0
    const rows = await c.db.prepare(`
      SELECT i.id, i.invoice_no, i.student_id, ${nameSQL('st')} AS student_name, st.admission_no, i.issued_on, i.due_on,
             i.net_paise, i.paid_paise, i.net_paise - i.paid_paise AS due_paise, i.status
        FROM invoices i JOIN students st ON st.id = i.student_id
       WHERE (?1 IS NULL OR i.status = ?1)
         AND (NOT ?2 OR (i.status IN ('unpaid','partial','overdue') AND i.due_on IS NOT NULL AND i.due_on < ?3))
       ORDER BY i.issued_on DESC, i.invoice_no LIMIT 300`).bind(status, overdue, today()).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omitNulls({ id: v.id, invoice_no: v.invoice_no, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      issued_on: v.issued_on, due_on: v.due_on, net_paise: p(v.net_paise), paid_paise: p(v.paid_paise), due_paise: p(v.due_paise), status: v.status }))))
  }))

  r.get('/finance/payments', 'finance.invoices.read', fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT p.id, p.receipt_no, ${nameSQL('st')} AS student_name, p.amount_paise, p.mode, p.paid_on, p.status, p.gateway, p.reconciled_at IS NOT NULL AS reconciled
        FROM payments p JOIN students st ON st.id = p.student_id ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 300`).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omitNulls({ id: v.id, receipt_no: v.receipt_no, student_name: v.student_name, amount_paise: p(v.amount_paise), mode: v.mode,
      paid_on: v.paid_on, status: v.status, gateway: v.gateway, reconciled: bool(v.reconciled) }))))
  }))
}
