import type { Ctx, Router } from '../../router'
import type { Env } from '../../env'
import { HttpError, badRequest, conflict, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { institutionById, tenantDb } from '../../tenant'
import { SchoolPDF, inr, pdfResponse } from '../../services/document'
import { registerJob } from '../../services/jobs'
import { SCHEDULES } from '../../services/cron'
import { auditDetail } from '../../services/seller_audit'
import { addDays, billingSettings, financialYear, issueInvoice, todayIST } from './billing'
import { startProvisioning, suggestSlug } from './provisioning'
import { requirePlatformAdmin } from './common'

/* The sales side of the seller console, next to the leads list
   (platform.ts /seller/enquiries):

   - Quotes (proformas) from a lead's value: numbered QT/<fy>/<seq>, one GST
     line at the billing rate, a PDF in the invoice's design, and "convert"
     issues the real invoice to the school (billing.ts issueInvoice). Money is
     only ever written by the server; the screen waits for it.
   - Demo schools for a lead in demo_booked: an ordinary provisioned school
     whose records are invented (services/demo_seed.ts), with an expiry date.
     The daily sweep suspends a demo once it has expired. */

const PERM = 'platform.tenants.write'
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))

interface QuoteRow {
  id: string; number: string; fy: string; seq: number; enquiry_id: string | null; institution_id: string | null; bill_to: string
  description: string; plan_code: string | null; students: number | null; amount_paise: number; gst_rate_bp: number; gst_paise: number
  total_paise: number; issued_on: string; valid_until: string; status: string; invoice_id: string | null; created_at: string
  invoice_number?: string | null
}

/** GST on a taxable amount at a rate in basis points, rounded to the paisa as on an invoice. */
export const gstOf = (amount: number, rateBp: number) => Math.round((amount * rateBp) / 10000)

async function quoteOr404(env: Env, id: string): Promise<QuoteRow> {
  const q = await env.CONTROL.prepare(`SELECT q.*, b.number AS invoice_number FROM seller_quotes q LEFT JOIN billing_invoices b ON b.id = q.invoice_id WHERE q.id = ?`)
    .bind(uuidParam(id)).first<QuoteRow>()
  if (!q) throw notFound('no such quote')
  return q
}

const quoteJSON = (q: QuoteRow, today = todayIST()) => ({ ...q, expired: q.status === 'open' && q.valid_until < today })

async function quotePDF(env: Env, q: QuoteRow): Promise<Uint8Array> {
  const s = await billingSettings(env)
  const pdf = await SchoolPDF.create(
    { name: s.seller_name || 'Seller name not set', accent: '#1f2937', address: s.seller_address || undefined,
      email: s.seller_email || undefined, affiliation: s.seller_gstin ? 'GSTIN ' + s.seller_gstin : undefined },
    { title: q.status === 'void' ? 'Quotation (void)' : 'Quotation', subtitle: q.bill_to, docNo: q.number, date: q.issued_on,
      watermark: q.status === 'void' ? 'VOID' : undefined },
  )
  const facts: [string, string][] = [['For', q.bill_to], ['Quote date', q.issued_on], ['Valid until', q.valid_until]]
  if (q.students) facts.push(['Students', String(q.students)])
  pdf.facts(facts)
  const pct = (q.gst_rate_bp / 100).toFixed(q.gst_rate_bp % 100 ? 2 : 0)
  pdf.table(
    [{ label: 'Description', width: 5 }, { label: 'SAC', width: 1.2 }, { label: 'Amount', width: 1.8, align: 'right' }],
    [[q.description, '998431', inr(q.amount_paise, true)], [`GST @ ${pct}%`, '', inr(q.gst_paise, true)], ['Total', '', inr(q.total_paise, true)]],
    { strong: new Set([2]) },
  )
  pdf.paragraph('This is a quotation, not a tax invoice. The tax invoice is issued when the order is confirmed.')
  return pdf.save()
}

/* --- demo schools ---------------------------------------------------------- */

/** Suspends every demo school whose expiry date has passed. Returns the schools suspended. */
export async function suspendExpiredDemos(env: Env, today = todayIST()): Promise<string[]> {
  const due = (await env.CONTROL.prepare(`SELECT d.provisioning_id, d.institution_id FROM seller_demos d
      JOIN institutions i ON i.id = d.institution_id WHERE d.suspended_at IS NULL AND d.expires_on < ?`).bind(today)
    .all<{ provisioning_id: string; institution_id: string }>()).results
  const out: string[] = []
  for (const d of due) {
    const t = now()
    try {
      await env.CONTROL.batch([
        env.CONTROL.prepare(`UPDATE institutions SET status = 'suspended', updated_at = ? WHERE id = ?`).bind(t, d.institution_id),
        env.CONTROL.prepare(`UPDATE seller_demos SET suspended_at = ? WHERE provisioning_id = ?`).bind(t, d.provisioning_id),
        env.CONTROL.prepare(`INSERT INTO platform_events (id, kind, ok, institution_id, subject, detail, actor_id, at)
            SELECT ?, 'demo', 1, id, name, 'demo expired; suspended', NULL, ? FROM institutions WHERE id = ?`).bind(uuid(), t, d.institution_id),
      ])
      const inst = await institutionById(env, d.institution_id)
      if (inst) {
        try { await tenantDb(env, inst).prepare(`UPDATE institutions SET status = 'suspended', updated_at = ? WHERE id = ?`).bind(t, inst.id).run() } catch { /* database not reachable */ }
      }
      out.push(d.institution_id)
    } catch (e) { console.error('demo expiry', d.institution_id, e) }
  }
  return out
}

registerJob('seller:demo_expiry', async (env) => { await suspendExpiredDemos(env) })
SCHEDULES.push({ name: 'seller_demo_expiry', spec: '20 6 * * *', kind: 'seller:demo_expiry', perInstitution: false, payload: () => ({}) })

function randomTail(n: number): string {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789'
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => a[x % a.length]).join('')
}

async function leadOr404(c: Ctx, id: string) {
  const lead = await c.env.CONTROL.prepare(`SELECT id, school_name, contact_name, status, students, plan_code, value_paise, provisioned_institution_id
      FROM purchase_enquiries WHERE id = ?`).bind(uuidParam(id, 'enquiry_id'))
    .first<{ id: string; school_name: string; contact_name: string; status: string; students: number | null; plan_code: string | null; value_paise: number | null; provisioned_institution_id: string | null }>()
  if (!lead) throw notFound('no such lead')
  return lead
}

export function registerSellerSales(r: Router): void {
  /* --- quotes ----------------------------------------------------------------- */

  r.get('/seller/quotes', PERM, async (c) => {
    requirePlatformAdmin(c)
    const lead = c.url.searchParams.get('enquiry_id')
    const rows = await c.env.CONTROL.prepare(`SELECT q.*, b.number AS invoice_number FROM seller_quotes q LEFT JOIN billing_invoices b ON b.id = q.invoice_id
        ${lead ? 'WHERE q.enquiry_id = ?' : ''} ORDER BY q.issued_on DESC, q.seq DESC LIMIT 200`).bind(...(lead ? [uuidParam(lead, 'enquiry_id')] : []))
      .all<QuoteRow>()
    const today = todayIST()
    return ok({ items: rows.results.map((q) => quoteJSON(q, today)) })
  })

  r.post('/seller/quotes', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ enquiry_id?: string; institution_id?: string; amount_paise?: number | null; gst_rate_bp?: number | null
      description?: string; valid_days?: number; students?: number | null }>(c.req)
    let billTo = '', planCode: string | null = null, students: number | null = null, amount = 0, enquiry: string | null = null, inst: string | null = null
    if (req.enquiry_id) {
      const lead = await leadOr404(c, req.enquiry_id)
      enquiry = lead.id; billTo = lead.school_name; planCode = lead.plan_code; students = lead.students; amount = lead.value_paise ?? 0
      inst = lead.provisioned_institution_id
    } else if (req.institution_id) {
      const school = await institutionById(c.env, uuidParam(req.institution_id, 'institution_id'))
      if (!school) throw notFound('no such school')
      inst = school.id; billTo = school.name
    } else throw badRequest('a quote is for a lead (enquiry_id) or a school (institution_id)')
    if (typeof req.amount_paise === 'number') amount = Math.round(req.amount_paise)
    if (!(amount > 0)) throw badRequest('the quote needs an amount: set the lead\'s value, or give amount_paise')
    if (typeof req.students === 'number') students = Math.trunc(req.students)
    const s = await billingSettings(c.env)
    const rate = typeof req.gst_rate_bp === 'number' ? Math.round(req.gst_rate_bp) : s.gst_rate_bp
    if (rate < 0 || rate > 5000) throw badRequest('gst_rate_bp must be between 0 and 5000 (0-50%)')
    const days = Math.trunc(Number(req.valid_days ?? 30))
    if (!(days >= 1 && days <= 180)) throw badRequest('valid_days must be from 1 to 180')
    let planName: string | null = null
    if (planCode) planName = (await c.env.CONTROL.prepare('SELECT name FROM plans WHERE code = ?').bind(planCode).first<{ name: string }>())?.name ?? null
    const desc = (req.description ?? '').trim().slice(0, 300) ||
      `${planName ?? 'School ERP'} subscription, one year${students ? `, up to ${students} students` : ''}`
    const gst = gstOf(amount, rate)
    const issued = todayIST(), fy = financialYear(issued), id = uuid(), t = now()
    await c.env.CONTROL.prepare(`INSERT INTO seller_quotes (id, number, fy, seq, enquiry_id, institution_id, bill_to, description, plan_code, students,
        amount_paise, gst_rate_bp, gst_paise, total_paise, issued_on, valid_until, status, created_by, created_at, updated_at)
        SELECT ?1, 'QT/' || ?2 || '/' || printf('%04d', n), ?2, n, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'open', ?15, ?16, ?16
        FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM seller_quotes WHERE fy = ?2)`)
      .bind(id, fy, enquiry, inst, billTo, desc, planCode, students, amount, rate, gst, amount + gst, issued, addDays(issued, days), c.id.userId, t).run()
    if (enquiry) {
      await c.env.CONTROL.prepare(`INSERT INTO purchase_enquiry_notes (id, enquiry_id, kind, body, author_id, created_at) VALUES (?, ?, 'note', ?, ?, ?)`)
        .bind(uuid(), enquiry, `Quote ${(await quoteOr404(c.env, id)).number} for ${inr(amount + gst, true)} including GST`, c.id.userId, t).run()
    }
    return created(quoteJSON(await quoteOr404(c.env, id)))
  })

  r.get('/seller/quotes/{id}/pdf', PERM, async (c) => {
    requirePlatformAdmin(c)
    const q = await quoteOr404(c.env, c.params.id)
    return pdfResponse(await quotePDF(c.env, q), q.number)
  })

  r.post('/seller/quotes/{id}/void', PERM, async (c) => {
    requirePlatformAdmin(c)
    const q = await quoteOr404(c.env, c.params.id)
    const res = await c.env.CONTROL.prepare(`UPDATE seller_quotes SET status = 'void', updated_at = ? WHERE id = ? AND status = 'open'`).bind(now(), q.id).run()
    if (!res.meta.changes) throw conflict('only an open quote can be voided')
    return ok(quoteJSON(await quoteOr404(c.env, q.id)))
  })

  /* Convert: the school's tax invoice for the quoted amount. The quote is
     claimed first (open -> converted), so two presses issue one invoice. */
  r.post('/seller/quotes/{id}/convert', PERM, async (c) => {
    requirePlatformAdmin(c)
    const q = await quoteOr404(c.env, c.params.id)
    const req = await readJSON<{ institution_id?: string }>(c.req).catch(() => ({} as { institution_id?: string }))
    let inst = q.institution_id
    if (!inst && q.enquiry_id) inst = (await leadOr404(c, q.enquiry_id)).provisioned_institution_id
    if (!inst && req.institution_id) inst = uuidParam(req.institution_id, 'institution_id')
    if (!inst) throw new HttpError(409, 'this lead has no school yet: set up the school first, then convert the quote', { code: 'no_school' })
    if (!(await institutionById(c.env, inst))) throw notFound('no such school')
    const claim = await c.env.CONTROL.prepare(`UPDATE seller_quotes SET status = 'converted', institution_id = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
      .bind(inst, now(), q.id).run()
    if (!claim.meta.changes) throw conflict(q.status === 'converted' ? 'this quote is already an invoice' : 'only an open quote can be converted')
    try {
      const inv = await issueInvoice(c.env, { institution_id: inst, billing_period: 'yearly', amount_paise: q.amount_paise, gst_rate_bp: q.gst_rate_bp,
        description: q.description, notes: `From quote ${q.number}` }, c.id.userId)
      await c.env.CONTROL.prepare(`UPDATE seller_quotes SET invoice_id = ?, updated_at = ? WHERE id = ?`).bind(inv.id, now(), q.id).run()
      auditDetail(c, { action: 'seller.quotes.convert', institution_id: inst, target: q.number, after: { invoice: inv.number, total_paise: inv.total_paise } })
      return created({ quote: quoteJSON(await quoteOr404(c.env, q.id)), invoice: { id: inv.id, number: inv.number, total_paise: inv.total_paise } })
    } catch (e) {
      await c.env.CONTROL.prepare(`UPDATE seller_quotes SET status = 'open', institution_id = ?, updated_at = ? WHERE id = ? AND invoice_id IS NULL`)
        .bind(q.institution_id, now(), q.id).run()
      throw e
    }
  })

  /* --- demo schools ------------------------------------------------------------- */

  r.get('/seller/demos', PERM, async (c) => {
    requirePlatformAdmin(c)
    const lead = c.url.searchParams.get('enquiry_id')
    const rows = await c.env.CONTROL.prepare(`SELECT d.provisioning_id, d.institution_id, d.enquiry_id, d.expires_on, d.seeded_at, d.suspended_at, d.created_at,
          p.name, p.slug, p.country, p.stage, p.error, p.admin_username AS sign_in_as
        FROM seller_demos d JOIN provisioning p ON p.id = d.provisioning_id
        ${lead ? 'WHERE d.enquiry_id = ?' : ''} ORDER BY d.created_at DESC LIMIT 100`).bind(...(lead ? [uuidParam(lead, 'enquiry_id')] : []))
      .all<Record<string, unknown>>()
    const today = todayIST()
    return ok({ items: rows.results.map((d) => ({ ...d, expired: String(d.expires_on) < today, sign_in_path: `/${d.country}/${d.slug}` })) })
  })

  /* One click: a demo school for a lead in demo_booked. Invented records, an
     administrator login to hand to the prospect, suspended after `days`. */
  r.post('/seller/demos', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ enquiry_id?: string; days?: number }>(c.req)
    if (!req.enquiry_id) throw badRequest('a demo school is for a lead: enquiry_id')
    const lead = await leadOr404(c, req.enquiry_id)
    if (lead.status !== 'demo_booked') throw new HttpError(409, 'book the demo first: move the lead to Demo booked', { code: 'not_demo_booked' })
    const live = await c.env.CONTROL.prepare(`SELECT 1 FROM seller_demos WHERE enquiry_id = ? AND suspended_at IS NULL AND expires_on >= ?`).bind(lead.id, todayIST()).first()
    if (live) throw conflict('this lead already has a demo school that has not expired')
    const days = Math.trunc(Number(req.days ?? 14))
    if (!(days >= 1 && days <= 30)) throw badRequest('a demo lasts from 1 to 30 days')
    const expires = addDays(todayIST(), days)
    const tail = randomTail(5)
    const res = await startProvisioning(c, {
      school_name: `${lead.school_name} (demo)`.slice(0, 120), slug: `demo-${suggestSlug(lead.school_name).slice(0, 24).replace(/-+$/, '')}-${tail}`,
      admin_name: 'Demo Administrator', admin_username: `demo.${tail}`, plan_code: lead.plan_code ?? '', trial_days: days,
    }, { demo: { enquiryId: lead.id, expiresOn: expires } })
    await c.env.CONTROL.prepare(`INSERT INTO purchase_enquiry_notes (id, enquiry_id, kind, body, author_id, created_at) VALUES (?, ?, 'note', ?, ?, ?)`)
      .bind(uuid(), lead.id, `Demo school ${res.sign_in_path} set up, open until ${expires}`, c.id.userId, now()).run()
    return created({ ...res, expires_on: expires })
  })
}
