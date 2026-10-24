import type { Router } from '../../router'
import type { Env } from '../../env'
import { badRequest, conflict, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { auditDetail } from '../../services/seller_audit'
import { requirePlatformAdmin } from './common'

/* Resellers (Subscriptions & Billing → Partners).

   A partner brings schools and earns a percentage of what those schools pay.
   The commission is accrued once per invoice, when the invoice becomes paid
   in full (billing.ts recordPayment calls accrueCommission), on the invoice's
   taxable value (GST is the government's, not revenue), at the rate the
   partner had at that moment. A payout settles every accrual not yet paid,
   in one ledger row with the bank reference. Nothing here is optimistic: the
   screen shows what the server wrote. */

const PERM = 'platform.tenants.write'

/** Commission on a taxable amount at a rate in basis points, to the paisa. */
export const commissionOf = (base: number, rateBp: number) => Math.round((base * rateBp) / 10000)

/** Accrues the partner's commission on a paid invoice. Idempotent: one row per invoice. */
export async function accrueCommission(env: Env, invoiceId: string): Promise<void> {
  try {
    await env.CONTROL.prepare(`INSERT OR IGNORE INTO partner_commissions (id, partner_id, institution_id, invoice_id, base_paise, rate_bp, commission_paise, accrued_at)
        SELECT ?1, p.id, b.institution_id, b.id, b.amount_paise, p.commission_bp, CAST(ROUND(b.amount_paise * p.commission_bp / 10000.0) AS INTEGER), ?2
          FROM billing_invoices b JOIN partner_schools ps ON ps.institution_id = b.institution_id
          JOIN partners p ON p.id = ps.partner_id AND p.status = 'active'
         WHERE b.id = ?3 AND b.status = 'paid' AND p.commission_bp > 0`).bind(uuid(), now(), invoiceId).run()
  } catch (e) {
    // The payment stands whatever happens here; a missing accrual is visible on the partner's page.
    console.error('partner commission', invoiceId, e)
  }
}

function rateOf(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 5000) throw badRequest('commission_bp must be a whole number from 0 to 5000 (0-50%)')
  return n
}
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function registerSellerPartners(r: Router): void {
  r.get('/seller/partners', PERM, async (c) => {
    requirePlatformAdmin(c)
    const rows = await c.env.CONTROL.prepare(`SELECT p.id, p.name, p.email, p.phone, p.commission_bp, p.status, p.created_at,
        (SELECT count(*) FROM partner_schools s WHERE s.partner_id = p.id) AS schools,
        COALESCE((SELECT sum(commission_paise) FROM partner_commissions m WHERE m.partner_id = p.id), 0) AS accrued_paise,
        COALESCE((SELECT sum(commission_paise) FROM partner_commissions m WHERE m.partner_id = p.id AND m.payout_id IS NULL), 0) AS owed_paise,
        COALESCE((SELECT sum(amount_paise) FROM partner_payouts o WHERE o.partner_id = p.id), 0) AS paid_paise
      FROM partners p ORDER BY p.status = 'active' DESC, p.name`).all()
    return ok({ items: rows.results })
  })

  r.post('/seller/partners', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ name?: string; email?: string; phone?: string; commission_bp?: number }>(c.req)
    const name = text(req.name)
    if (!name) throw badRequest('the partner needs a name')
    const email = text(req.email).toLowerCase(), phone = text(req.phone, 30)
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('that email does not look right')
    const rate = rateOf(req.commission_bp)
    const id = uuid(), t = now()
    await c.env.CONTROL.prepare(`INSERT INTO partners (id, name, email, phone, commission_bp, status, created_at, updated_at) VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, 'active', ?, ?)`)
      .bind(id, name, email, phone, rate, t, t).run()
    return created({ id })
  })

  r.get('/seller/partners/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const id = uuidParam(c.params.id)
    const p = await c.env.CONTROL.prepare(`SELECT * FROM partners WHERE id = ?`).bind(id).first()
    if (!p) throw notFound('no such partner')
    const [schools, commissions, payouts] = await Promise.all([
      c.env.CONTROL.prepare(`SELECT i.id, i.name, s.created_at FROM partner_schools s JOIN institutions i ON i.id = s.institution_id WHERE s.partner_id = ? ORDER BY i.name`).bind(id).all(),
      c.env.CONTROL.prepare(`SELECT m.id, m.invoice_id, b.number AS invoice_number, i.name AS school, m.base_paise, m.rate_bp, m.commission_paise, m.accrued_at, m.payout_id
          FROM partner_commissions m JOIN billing_invoices b ON b.id = m.invoice_id JOIN institutions i ON i.id = m.institution_id
          WHERE m.partner_id = ? ORDER BY m.accrued_at DESC LIMIT 500`).bind(id).all(),
      c.env.CONTROL.prepare(`SELECT id, amount_paise, reference, paid_on, created_at FROM partner_payouts WHERE partner_id = ? ORDER BY paid_on DESC, created_at DESC`).bind(id).all(),
    ])
    return ok({ partner: p, schools: schools.results, commissions: commissions.results, payouts: payouts.results })
  })

  r.put('/seller/partners/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ name?: string; email?: string; phone?: string; commission_bp?: number; status?: string }>(c.req)
    const cur = await c.env.CONTROL.prepare(`SELECT name, email, phone, commission_bp, status FROM partners WHERE id = ?`).bind(id)
      .first<{ name: string; email: string | null; phone: string | null; commission_bp: number; status: string }>()
    if (!cur) throw notFound('no such partner')
    const status = req.status === undefined ? cur.status : req.status
    if (status !== 'active' && status !== 'inactive') throw badRequest('status must be active or inactive')
    const next = {
      name: req.name === undefined ? cur.name : text(req.name), email: req.email === undefined ? cur.email : text(req.email).toLowerCase() || null,
      phone: req.phone === undefined ? cur.phone : text(req.phone, 30) || null, commission_bp: req.commission_bp === undefined ? cur.commission_bp : rateOf(req.commission_bp), status,
    }
    if (!next.name) throw badRequest('the partner needs a name')
    await c.env.CONTROL.prepare(`UPDATE partners SET name = ?, email = ?, phone = ?, commission_bp = ?, status = ?, updated_at = ? WHERE id = ?`)
      .bind(next.name, next.email, next.phone, next.commission_bp, next.status, now(), id).run()
    auditDetail(c, { action: 'seller.partners.update', target: next.name, before: cur, after: next })
    return ok({ id, ...next })
  })

  // Link a school to this partner; a school has at most one, so this moves it from another.
  r.post('/seller/partners/{id}/schools', PERM, async (c) => {
    requirePlatformAdmin(c)
    const id = uuidParam(c.params.id)
    const inst = uuidParam((await readJSON<{ institution_id?: string }>(c.req)).institution_id ?? '', 'institution_id')
    if (!(await c.env.CONTROL.prepare(`SELECT 1 FROM partners WHERE id = ?`).bind(id).first())) throw notFound('no such partner')
    if (!(await c.env.CONTROL.prepare(`SELECT 1 FROM institutions WHERE id = ?`).bind(inst).first())) throw notFound('no such school')
    await c.env.CONTROL.prepare(`INSERT INTO partner_schools (institution_id, partner_id, created_at) VALUES (?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET partner_id = excluded.partner_id, created_at = excluded.created_at`).bind(inst, id, now()).run()
    auditDetail(c, { institution_id: inst, target: id })
    return ok({ partner_id: id, institution_id: inst })
  })

  r.del('/seller/partners/{id}/schools/{school}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const res = await c.env.CONTROL.prepare(`DELETE FROM partner_schools WHERE partner_id = ? AND institution_id = ?`)
      .bind(uuidParam(c.params.id), uuidParam(c.params.school, 'school')).run()
    if (!res.meta.changes) throw notFound('that school is not linked to this partner')
    return ok({ removed: true })
  })

  /* Pay out: one ledger row for everything accrued and not yet paid. The rows
     are claimed by id and payout_id IS NULL, so two presses cannot pay the
     same commission twice. */
  r.post('/seller/partners/{id}/payouts', PERM, async (c) => {
    requirePlatformAdmin(c)
    const id = uuidParam(c.params.id)
    const req = await readJSON<{ reference?: string; paid_on?: string }>(c.req)
    const reference = text(req.reference, 120)
    if (reference.length < 3) throw badRequest('give the bank or UPI reference of the payment')
    const paidOn = req.paid_on && /^\d{4}-\d{2}-\d{2}$/.test(req.paid_on) ? req.paid_on : new Date().toISOString().slice(0, 10)
    if (!(await c.env.CONTROL.prepare(`SELECT 1 FROM partners WHERE id = ?`).bind(id).first())) throw notFound('no such partner')
    const owed = (await c.env.CONTROL.prepare(`SELECT id, commission_paise FROM partner_commissions WHERE partner_id = ? AND payout_id IS NULL`).bind(id)
      .all<{ id: string; commission_paise: number }>()).results
    const amount = owed.reduce((a, m) => a + m.commission_paise, 0)
    if (!(amount > 0)) throw conflict('nothing is owed to this partner')
    const payout = uuid(), t = now()
    const ids = JSON.stringify(owed.map((m) => m.id))
    const res = await c.env.CONTROL.batch([
      c.env.CONTROL.prepare(`INSERT INTO partner_payouts (id, partner_id, amount_paise, reference, paid_on, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(payout, id, amount, reference, paidOn, c.id.userId, t),
      c.env.CONTROL.prepare(`UPDATE partner_commissions SET payout_id = ? WHERE partner_id = ? AND payout_id IS NULL AND id IN (SELECT value FROM json_each(?))`)
        .bind(payout, id, ids),
    ])
    if ((res[1].meta.changes ?? 0) !== owed.length) {
      // Another payout took some of these meanwhile: undo this one whole.
      await c.env.CONTROL.batch([
        c.env.CONTROL.prepare(`UPDATE partner_commissions SET payout_id = NULL WHERE payout_id = ?`).bind(payout),
        c.env.CONTROL.prepare(`DELETE FROM partner_payouts WHERE id = ?`).bind(payout),
      ])
      throw conflict('another payout was recorded at the same time; reload and check before paying again')
    }
    auditDetail(c, { action: 'seller.partners.payout', target: id, after: { amount_paise: amount, reference, commissions: owed.length } })
    return created({ id: payout, amount_paise: amount, commissions: owed.length })
  })
}
