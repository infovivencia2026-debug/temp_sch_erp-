import type { Ctx, Router } from '../../router'
import type { Env } from '../../env'
import { badRequest, conflict, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import { SchoolPDF, inr, pdfResponse } from '../../services/document'
import { Messenger, SENT_BY_PLATFORM } from '../../services/messaging'
import { BUILTIN_TEMPLATES } from '../admin/msg_templates'
import { registerJob } from '../../services/jobs'
import { SCHEDULES } from '../../services/cron'
import { requirePlatformAdmin } from './common'

/* Seller billing: the vendor invoicing each school for its subscription.

   - Invoices are numbered per Indian financial year (April-March):
     <prefix>/<fy>/<seq>, e.g. INV/2026-27/0001. The sequence is taken inside
     the INSERT itself, so two invoices issued at once cannot share a number.
   - Amount: the one given, else the subscription's agreed price (yearly),
     else the plan's yearly or monthly price. One GST line at the configured
     rate, with the seller's GSTIN (Seller → Subscription ledger → Settings).
   - Payments: recorded by the seller (UPI, NEFT, cheque, cash with a
     reference) or taken online by the school through the platform gateway
     when PAYMENT_GATEWAY_SECRET is set. The gateway contract is signup.go's:
     HMAC-SHA256 of "order_ref|payment_ref" under the secret, verified in
     constant time. Outside production (APP_ENV set and not "production") the
     checkout is simulated exactly as Go's signup pay page was, so it can be
     tried without a gateway.
   - The daily job (billing:daily) moves an unpaid school from active to
     past_due once the oldest open invoice is due_on + grace_days old, to
     suspended after a further suspend_after_days, and back to active when
     the money arrives (only undoing what it did itself, per
     billing_status_log). The subscription gate (gates.ts) then shows the
     school the matching message. institutions.status is not touched, so the
     school's administrator can still sign in and pay.
   - Renewal reminders at 30, 7 and 1 days before renews_on, emailed to the
     school's administrator through the school's message queue from the
     platform's own channel. Nothing is queued outside production. */

const PERM = 'platform.tenants.write'

// ---------------------------------------------------------------------------
// messaging: templates the platform sends on a school's behalf

BUILTIN_TEMPLATES['billing.renewal'] = {
  subject: '{{school_name}}: your subscription renews in {{days}} day(s)',
  body: 'Dear {{admin_name}},\n\nThe {{plan}} subscription for {{school_name}} renews on {{renews_on}}.' +
    '{{balance_line}}\n\nYou can see and pay your invoices under Settings → School → Billing.\n\n{{seller_name}}',
}
BUILTIN_TEMPLATES['billing.invoice'] = {
  subject: '{{school_name}}: invoice {{number}} for {{total}}',
  body: 'Dear {{admin_name}},\n\nInvoice {{number}} for {{total}} ({{description}}) has been issued to {{school_name}} and is due on {{due_on}}.' +
    '\n\nYou can download it and pay under Settings → School → Billing.\n\n{{seller_name}}',
}
SENT_BY_PLATFORM['billing.renewal'] = true
SENT_BY_PLATFORM['billing.invoice'] = true

// ---------------------------------------------------------------------------
// small helpers

/** Outside production: APP_ENV set to anything other than "production". */
export function isDevelopment(env: Env): boolean {
  const v = env.APP_ENV
  return typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'production'
}

function gatewaySecret(env: Env): string {
  const v = env.PAYMENT_GATEWAY_SECRET
  return typeof v === 'string' ? v.trim() : ''
}

/** Today in India, the calendar invoices and due dates are kept in. */
export function todayIST(d = new Date()): string {
  try { return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) } catch { return d.toISOString().slice(0, 10) }
}
export function addDays(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10)
}
function addMonths(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + n); return t.toISOString().slice(0, 10)
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000)
}
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'))

/** Indian financial year of a date: 2026-09-27 -> "2026-27". */
export function financialYear(on: string): string {
  let y = Number(on.slice(0, 4)); if (Number(on.slice(5, 7)) < 4) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

/** 12345678 paise -> "Rs 1,23,456.78". */
export function rupees(paise: number): string {
  const neg = paise < 0; const p = Math.abs(Math.round(paise))
  const r = Math.floor(p / 100), ps = String(p % 100).padStart(2, '0')
  const s = String(r); const last3 = s.slice(-3); const rest = s.slice(0, -3)
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3
  return (neg ? '-' : '') + 'Rs ' + grouped + '.' + ps
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const METHODS = ['upi', 'neft', 'cheque', 'cash', 'online']

function gatewayRef(prefix: string): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const b = new Uint8Array(14); crypto.getRandomValues(b)
  return prefix + '_' + [...b].map((x) => a[x % a.length]).join('')
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)))
  return [...sig].map((x) => x.toString(16).padStart(2, '0')).join('')
}
/** Constant-time comparison, as hmac.Equal. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
/** The gateway signature for a payment: HMAC-SHA256("order|payment"), hex (signup.go sign). */
export const signPayment = (secret: string, orderRef: string, paymentRef: string) => hmacHex(secret, orderRef + '|' + paymentRef)

// ---------------------------------------------------------------------------
// settings

export interface BillingSettings {
  seller_name: string; seller_address: string; seller_gstin: string; seller_email: string
  bank_details: string; upi_vpa: string; invoice_prefix: string
  gst_rate_bp: number; due_days: number; grace_days: number; suspend_after_days: number
  updated_at: string
}

export async function billingSettings(env: Env): Promise<BillingSettings> {
  const r = await env.CONTROL.prepare(`SELECT seller_name, seller_address, seller_gstin, seller_email, bank_details, upi_vpa, invoice_prefix,
      gst_rate_bp, due_days, grace_days, suspend_after_days, updated_at FROM billing_settings WHERE id = 1`).first<BillingSettings>()
  return r ?? { seller_name: '', seller_address: '', seller_gstin: '', seller_email: '', bank_details: '', upi_vpa: '', invoice_prefix: 'INV',
    gst_rate_bp: 1800, due_days: 15, grace_days: 15, suspend_after_days: 30, updated_at: '' }
}

// ---------------------------------------------------------------------------
// invoices

interface InvoiceRow {
  id: string; institution_id: string; number: string; fy: string; seq: number; issued_on: string; due_on: string
  period_from: string | null; period_to: string | null; plan_code: string | null; billing_period: string; description: string
  school_gstin: string | null; amount_paise: number; gst_rate_bp: number; gst_paise: number; total_paise: number; paid_paise: number
  status: string; seller_gstin: string; notes: string | null; created_at: string; updated_at: string; school?: string
}

function invoiceJSON(r: InvoiceRow, today = todayIST()) {
  const balance = r.status === 'void' ? 0 : r.total_paise - r.paid_paise
  const open = r.status === 'issued' || r.status === 'partial'
  return { ...r, balance_paise: balance, overdue: open && r.due_on < today, days_overdue: open && r.due_on < today ? daysBetween(r.due_on, today) : 0 }
}

async function invoiceOr404(env: Env, id: string, inst?: string): Promise<InvoiceRow> {
  if (!isUUID(id)) throw badRequest('invalid invoice id')
  const r = await env.CONTROL.prepare(`SELECT b.*, i.name AS school FROM billing_invoices b JOIN institutions i ON i.id = b.institution_id WHERE b.id = ?`)
    .bind(id).first<InvoiceRow>()
  if (!r || (inst && r.institution_id !== inst)) throw notFound('no such invoice')
  return r
}

interface NewInvoice {
  institution_id?: string; billing_period?: string; amount_paise?: number | null; gst_rate_bp?: number | null
  description?: string; issued_on?: string; due_on?: string; period_from?: string; period_to?: string; school_gstin?: string; notes?: string
  notify?: boolean
}

async function issueInvoice(env: Env, req: NewInvoice, actor: string | null): Promise<InvoiceRow> {
  const instId = String(req.institution_id ?? '')
  if (!isUUID(instId)) throw badRequest('institution_id is required')
  const inst = await institutionById(env, instId)
  if (!inst) throw notFound('no such school')
  const s = await billingSettings(env)
  const sub = await env.CONTROL.prepare(`SELECT s.plan_code, s.agreed_price_paise, s.renews_on, p.name AS plan_name, p.price_paise, p.price_monthly_paise
      FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code WHERE s.institution_id = ?`).bind(instId)
    .first<{ plan_code: string; agreed_price_paise: number | null; renews_on: string | null; plan_name: string | null; price_paise: number | null; price_monthly_paise: number | null }>()
  const period = req.billing_period === 'monthly' ? 'monthly' : req.billing_period === 'one_off' ? 'one_off' : 'yearly'
  let amount = typeof req.amount_paise === 'number' ? Math.round(req.amount_paise) : 0
  if (!amount && sub) {
    if (period === 'yearly') amount = sub.agreed_price_paise ?? sub.price_paise ?? 0
    else if (period === 'monthly') amount = sub.price_monthly_paise ?? (sub.agreed_price_paise ? Math.round(sub.agreed_price_paise / 12) : 0)
  }
  if (!(amount > 0)) throw badRequest('no price to invoice: give amount_paise, or set a plan price or an agreed price on the subscription')
  const rate = typeof req.gst_rate_bp === 'number' ? Math.round(req.gst_rate_bp) : s.gst_rate_bp
  if (rate < 0 || rate > 5000) throw badRequest('gst_rate_bp must be between 0 and 5000 (0-50%)')
  const gst = Math.round((amount * rate) / 10000)
  const issued = isDate(req.issued_on) ? req.issued_on : todayIST()
  const due = isDate(req.due_on) ? req.due_on : addDays(issued, s.due_days)
  if (due < issued) throw badRequest('due_on is before issued_on')
  let from: string | null = null, to: string | null = null
  if (period !== 'one_off') {
    from = isDate(req.period_from) ? req.period_from : (sub?.renews_on && isDate(sub.renews_on.slice(0, 10)) ? sub.renews_on.slice(0, 10) : issued)
    to = isDate(req.period_to) ? req.period_to : addDays(period === 'monthly' ? addMonths(from, 1) : addMonths(from, 12), -1)
    if (to < from) throw badRequest('period_to is before period_from')
  }
  const gstin = (req.school_gstin ?? '').trim().toUpperCase()
  if (gstin && !GSTIN.test(gstin)) throw badRequest('the school GSTIN is not in the 15-character GSTIN format')
  const planName = sub?.plan_name ?? sub?.plan_code ?? 'Subscription'
  const desc = (req.description ?? '').trim() ||
    (period === 'one_off' ? 'Services' : `${planName} subscription, ${period === 'monthly' ? 'monthly' : 'yearly'} (${from} to ${to})`)
  const fy = financialYear(issued)
  const id = uuid(), t = now()
  const prefix = (s.invoice_prefix || 'INV').replace(/[^A-Za-z0-9-]/g, '') || 'INV'
  // Number and sequence in the same statement, so the sequence cannot be taken twice.
  await env.CONTROL.prepare(`INSERT INTO billing_invoices (id, institution_id, number, fy, seq, issued_on, due_on, period_from, period_to, plan_code,
        billing_period, description, school_gstin, amount_paise, gst_rate_bp, gst_paise, total_paise, paid_paise, status, seller_gstin, notes,
        created_by, created_at, updated_at)
      SELECT ?1, ?2, ?3 || '/' || ?4 || '/' || printf('%04d', n), ?4, n, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULLIF(?12, ''), ?13, ?14, ?15, ?16, 0, 'issued',
        ?17, NULLIF(?18, ''), ?19, ?20, ?20
      FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM billing_invoices WHERE fy = ?4)`)
    .bind(id, instId, prefix, fy, issued, due, from, to, sub?.plan_code ?? null, period, desc, gstin, amount, rate, gst, amount + gst,
      s.seller_gstin, (req.notes ?? '').trim(), actor, t).run()
  const inv = await invoiceOr404(env, id)
  if (req.notify) {
    await notifySchool(env, inst, 'billing.invoice', `billing.invoice:${inv.id}`, {
      number: inv.number, total: rupees(inv.total_paise), description: inv.description, due_on: inv.due_on, seller_name: s.seller_name,
    }).catch((e) => console.error('billing: invoice notice', inst.slug, e))
  }
  return inv
}

// ---------------------------------------------------------------------------
// payments and the status engine

async function recordPayment(env: Env, inv: InvoiceRow, p: { amount_paise: number; method: string; reference: string; paid_on: string; gateway_order_ref?: string | null }, actor: string | null) {
  if (inv.status === 'void') throw conflict('this invoice was voided')
  if (inv.status === 'paid') throw conflict('this invoice is already paid')
  const amount = Math.round(p.amount_paise)
  if (!(amount > 0)) throw badRequest('amount_paise must be positive')
  const balance = inv.total_paise - inv.paid_paise
  if (amount > balance) throw badRequest(`that is more than the ${rupees(balance)} still due on this invoice`)
  if (!METHODS.includes(p.method)) throw badRequest('method is one of upi, neft, cheque, cash, online')
  if (p.method !== 'cash' && p.method !== 'online' && !p.reference.trim()) throw badRequest('give the UTR, transaction or cheque number as the reference')
  const t = now(), id = uuid()
  const res = await env.CONTROL.batch([
    env.CONTROL.prepare(`INSERT INTO billing_payments (id, invoice_id, institution_id, amount_paise, method, reference, paid_on, gateway_order_ref, recorded_by, created_at)
        VALUES (?,?,?,?,?,NULLIF(?,''),?,?,?,?)`)
      .bind(id, inv.id, inv.institution_id, amount, p.method, p.reference.trim(), p.paid_on, p.gateway_order_ref ?? null, actor, t),
    // Guarded on the balance, so two recordings racing cannot overpay.
    env.CONTROL.prepare(`UPDATE billing_invoices SET paid_paise = paid_paise + ?1,
          status = CASE WHEN paid_paise + ?1 >= total_paise THEN 'paid' ELSE 'partial' END, updated_at = ?2
        WHERE id = ?3 AND status IN ('issued','partial') AND paid_paise + ?1 <= total_paise`).bind(amount, t, inv.id),
  ])
  if (!res[1].meta.changes) {
    await env.CONTROL.prepare(`DELETE FROM billing_payments WHERE id = ?`).bind(id).run()
    throw conflict('the invoice changed while this was being recorded; reload and try again')
  }
  const after = await invoiceOr404(env, inv.id)
  if (after.status === 'paid' && after.period_to) {
    // Paying for a period carries the renewal date to the end of it.
    const next = addDays(after.period_to, 1)
    await env.CONTROL.prepare(`UPDATE subscriptions SET renews_on = ?, updated_at = ? WHERE institution_id = ? AND (renews_on IS NULL OR substr(renews_on, 1, 10) < ?)`)
      .bind(next, t, inv.institution_id, next).run()
  }
  await reconcile(env, inv.institution_id, await billingSettings(env), todayIST(), after.status === 'paid')
  return { id, invoice: invoiceJSON(after) }
}

export interface ReconcileResult { institution_id: string; from: string; to: string; reason: string }

/** Moves one school's subscription status to match its oldest unpaid invoice. */
export async function reconcile(env: Env, instId: string, s: BillingSettings, today: string, justPaid = false): Promise<ReconcileResult | null> {
  const sub = await env.CONTROL.prepare(`SELECT status FROM subscriptions WHERE institution_id = ?`).bind(instId).first<{ status: string }>()
  if (!sub) return null
  const oldest = await env.CONTROL.prepare(`SELECT MIN(due_on) AS due_on FROM billing_invoices WHERE institution_id = ? AND status IN ('issued','partial')`)
    .bind(instId).first<{ due_on: string | null }>()
  const late = oldest?.due_on ? daysBetween(oldest.due_on, today) : -1
  let target: 'ok' | 'past_due' | 'suspended' = 'ok'
  if (oldest?.due_on && late > s.grace_days + s.suspend_after_days) target = 'suspended'
  else if (oldest?.due_on && late > s.grace_days) target = 'past_due'
  const last = await env.CONTROL.prepare(`SELECT to_status FROM billing_status_log WHERE institution_id = ? ORDER BY id DESC LIMIT 1`)
    .bind(instId).first<{ to_status: string }>()
  const ours = last?.to_status === sub.status // the current status is one this engine set
  const cur = sub.status
  let to: string | null = null, reason = ''
  if (target === 'suspended' && (cur === 'active' || cur === 'past_due')) { to = 'suspended'; reason = `invoice due ${oldest!.due_on} unpaid ${late} days` }
  else if (target === 'past_due' && cur === 'active') { to = 'past_due'; reason = `invoice due ${oldest!.due_on} unpaid ${late} days` }
  else if (target === 'past_due' && cur === 'suspended' && ours) { to = 'past_due'; reason = 'part paid' }
  else if (target === 'ok' && (cur === 'past_due' || cur === 'suspended') && ours) { to = 'active'; reason = 'overdue invoices paid' }
  else if (target === 'ok' && cur === 'trial' && justPaid) { to = 'active'; reason = 'subscription invoice paid' }
  if (!to || to === cur) return null
  const t = now()
  await env.CONTROL.batch([
    env.CONTROL.prepare(`UPDATE subscriptions SET status = ?, updated_at = ? WHERE institution_id = ?`).bind(to, t, instId),
    env.CONTROL.prepare(`INSERT INTO billing_status_log (institution_id, from_status, to_status, reason, at) VALUES (?,?,?,?,?)`).bind(instId, cur, to, reason, t),
  ])
  return { institution_id: instId, from: cur, to, reason }
}

// ---------------------------------------------------------------------------
// messages to the school's administrator

export async function schoolAdmin(db: D1Database): Promise<{ id: string; email: string; full_name: string } | null> {
  return db.prepare(`SELECT u.id, u.email, u.full_name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.key = 'institution_admin' AND u.status = 'active' AND u.email IS NOT NULL AND u.email <> ''
      ORDER BY u.created_at LIMIT 1`).first<{ id: string; email: string; full_name: string }>()
}

/** Queues one email to the school's administrator from the platform's channel. Nothing is queued outside production. */
export async function notifySchool(env: Env, inst: Institution, code: string, occurrence: string, vars: Record<string, unknown>):
  Promise<{ queued: boolean; recipient: string | null; reason?: string }> {
  const db = tenantDb(env, inst)
  const admin = await schoolAdmin(db)
  if (!admin) return { queued: false, recipient: null, reason: 'the school has no administrator with an email address' }
  if (isDevelopment(env)) {
    console.log('billing: not sent in development', code, inst.slug, admin.email)
    return { queued: false, recipient: admin.email, reason: 'development: nothing is sent' }
  }
  const m = new Messenger({ env, db, inst: inst.id })
  const r = await m.queue({ channel: 'email', template_code: code, recipient: admin.email, to_user_id: admin.id,
    vars: { admin_name: admin.full_name, school_name: inst.name, ...vars }, source_kind: 'platform_billing', occurrence_key: occurrence })
  await m.kick()
  return { queued: !r.duplicate, recipient: admin.email, reason: r.duplicate ? 'already sent' : undefined }
}

const REMINDER_DAYS = [1, 7, 30]

/** The daily sweep: status changes for every school, then renewal reminders. */
export async function runBillingDaily(env: Env, today = todayIST()) {
  const s = await billingSettings(env)
  const subs = (await env.CONTROL.prepare(`SELECT s.institution_id, s.status, s.renews_on, p.name AS plan
      FROM subscriptions s JOIN institutions i ON i.id = s.institution_id LEFT JOIN plans p ON p.code = s.plan_code
      WHERE i.status = 'active'`).all<{ institution_id: string; status: string; renews_on: string | null; plan: string | null }>()).results
  const changes: ReconcileResult[] = []
  const reminders: { institution_id: string; days_before: number; recipient: string | null; queued: boolean; reason?: string }[] = []
  for (const sub of subs) {
    try {
      const ch = await reconcile(env, sub.institution_id, s, today)
      if (ch) changes.push(ch)
      if (!sub.renews_on || sub.status === 'cancelled') continue
      const renews = sub.renews_on.slice(0, 10)
      const left = daysBetween(today, renews)
      if (left < 0) continue
      const step = REMINDER_DAYS.find((d) => left <= d)
      if (step === undefined) continue
      // A renewal already paid for (renews_on moved) produces a new key; a step missed is sent once, late.
      const seen = await env.CONTROL.prepare(`SELECT 1 FROM billing_reminders WHERE institution_id = ? AND renews_on = ? AND days_before = ?`)
        .bind(sub.institution_id, renews, step).first()
      if (seen) continue
      const inst = await institutionById(env, sub.institution_id)
      if (!inst) continue
      const bal = await env.CONTROL.prepare(`SELECT COALESCE(SUM(total_paise - paid_paise), 0) AS b FROM billing_invoices WHERE institution_id = ? AND status IN ('issued','partial')`)
        .bind(inst.id).first<{ b: number }>()
      const balance = Number(bal?.b ?? 0)
      const res = await notifySchool(env, inst, 'billing.renewal', `billing.renewal:${renews}:${step}`, {
        days: left, renews_on: renews, plan: sub.plan ?? 'school', seller_name: s.seller_name,
        balance_line: balance > 0 ? `\n\nOutstanding on your account: ${rupees(balance)}.` : '',
      })
      reminders.push({ institution_id: inst.id, days_before: step, ...res })
      if (res.queued || res.reason === 'already sent') {
        await env.CONTROL.prepare(`INSERT OR IGNORE INTO billing_reminders (institution_id, renews_on, days_before, recipient, sent_at) VALUES (?,?,?,?,?)`)
          .bind(inst.id, renews, step, res.recipient, now()).run()
      }
    } catch (e) {
      console.error('billing daily: school failed', sub.institution_id, e)
    }
  }
  return { today, schools: subs.length, status_changes: changes, reminders }
}

registerJob('billing:daily', async (env) => { await runBillingDaily(env) })
SCHEDULES.push({ name: 'billing_daily', spec: '15 6 * * *', kind: 'billing:daily', perInstitution: false, payload: () => ({}) })

// ---------------------------------------------------------------------------
// PDF

export async function invoicePDF(env: Env, inv: InvoiceRow): Promise<Uint8Array> {
  const s = await billingSettings(env)
  /* The seller's own tax invoice to a school, so the letterhead is the
     seller's, in the shared document design (services/document.ts). */
  const gstin = inv.seller_gstin || s.seller_gstin
  const pdf = await SchoolPDF.create(
    { name: s.seller_name || 'Seller name not set', accent: '#1f2937', address: s.seller_address || undefined,
      email: s.seller_email || undefined, affiliation: gstin ? 'GSTIN ' + gstin : undefined },
    { title: inv.status === 'void' ? 'Tax invoice (void)' : 'Tax invoice', subtitle: inv.school ?? undefined, docNo: inv.number,
      date: inv.issued_on, watermark: inv.status === 'void' ? 'VOID' : undefined },
  )
  const facts: [string, string][] = [['Bill to', inv.school ?? '-']]
  if (inv.school_gstin) facts.push(['School GSTIN', inv.school_gstin])
  facts.push(['Invoice date', inv.issued_on], ['Due date', inv.due_on])
  if (inv.period_from && inv.period_to) facts.push(['Period', `${inv.period_from} to ${inv.period_to}`])
  pdf.facts(facts)
  const pct = (inv.gst_rate_bp / 100).toFixed(inv.gst_rate_bp % 100 ? 2 : 0)
  pdf.table(
    [{ label: 'Description', width: 5 }, { label: 'SAC', width: 1.2 }, { label: 'Amount', width: 1.8, align: 'right' }],
    [[inv.description, '998431', inr(inv.amount_paise, true)],
     [`GST @ ${pct}%`, '', inr(inv.gst_paise, true)],
     ['Total', '', inr(inv.total_paise, true)]],
    { strong: new Set([2]) },
  )
  if (inv.paid_paise > 0) pdf.total('Paid', inr(inv.paid_paise, true))
  if (inv.status !== 'void') pdf.total('Balance due', inr(inv.total_paise - inv.paid_paise, true), true)
  if (s.bank_details || s.upi_vpa) {
    pdf.heading('How to pay')
    if (s.upi_vpa) pdf.paragraph('UPI: ' + s.upi_vpa)
    if (s.bank_details) pdf.paragraph(s.bank_details)
    pdf.paragraph(`Quote ${inv.number} as the reference.`)
  }
  if (inv.notes) { pdf.heading('Notes'); pdf.paragraph(inv.notes) }
  return pdf.save()
}

// ---------------------------------------------------------------------------
// routes

function schoolAdminOnly(c: Ctx): string {
  const inst = c.id.institution
  if (!inst) throw forbidden('no school in scope')
  if (!(c.id.platformAdmin || c.id.roles.includes('institution_admin'))) throw forbidden('only the school administrator sees billing')
  return inst.id
}

async function listInvoices(env: Env, where: string, binds: unknown[]) {
  const today = todayIST()
  const r = await env.CONTROL.prepare(`SELECT b.*, i.name AS school FROM billing_invoices b JOIN institutions i ON i.id = b.institution_id
      ${where} ORDER BY b.issued_on DESC, b.seq DESC LIMIT 500`).bind(...binds).all<InvoiceRow>()
  return r.results.map((x) => invoiceJSON(x, today))
}

async function paymentsOf(env: Env, invoiceId: string) {
  return (await env.CONTROL.prepare(`SELECT id, amount_paise, method, reference, paid_on, gateway_order_ref, created_at FROM billing_payments
      WHERE invoice_id = ? ORDER BY paid_on, created_at`).bind(invoiceId).all()).results
}

export function registerSellerBilling(r: Router): void {
  r.get('/seller/billing/settings', PERM, async (c) => {
    requirePlatformAdmin(c)
    return ok({ ...(await billingSettings(c.env)), online_gateway: gatewaySecret(c.env) !== '', development: isDevelopment(c.env) })
  })

  r.put('/seller/billing/settings', PERM, async (c) => {
    requirePlatformAdmin(c)
    const b = await readJSON<Partial<BillingSettings>>(c.req)
    const cur = await billingSettings(c.env)
    const str = (v: unknown, d: string) => (typeof v === 'string' ? v.trim() : d)
    const num = (v: unknown, d: number, lo: number, hi: number, what: string) => {
      if (v === undefined || v === null) return d
      const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw badRequest(`${what} must be a whole number from ${lo} to ${hi}`)
      return n
    }
    const next = {
      seller_name: str(b.seller_name, cur.seller_name), seller_address: str(b.seller_address, cur.seller_address),
      seller_gstin: str(b.seller_gstin, cur.seller_gstin).toUpperCase(), seller_email: str(b.seller_email, cur.seller_email),
      bank_details: str(b.bank_details, cur.bank_details), upi_vpa: str(b.upi_vpa, cur.upi_vpa),
      invoice_prefix: str(b.invoice_prefix, cur.invoice_prefix).replace(/[^A-Za-z0-9-]/g, '') || 'INV',
      gst_rate_bp: num(b.gst_rate_bp, cur.gst_rate_bp, 0, 5000, 'gst_rate_bp'),
      due_days: num(b.due_days, cur.due_days, 0, 365, 'due_days'),
      grace_days: num(b.grace_days, cur.grace_days, 0, 365, 'grace_days'),
      suspend_after_days: num(b.suspend_after_days, cur.suspend_after_days, 0, 365, 'suspend_after_days'),
    }
    if (next.seller_gstin && !GSTIN.test(next.seller_gstin)) throw badRequest('the GSTIN is not in the 15-character GSTIN format')
    await c.env.CONTROL.prepare(`INSERT INTO billing_settings (id, seller_name, seller_address, seller_gstin, seller_email, bank_details, upi_vpa,
        invoice_prefix, gst_rate_bp, due_days, grace_days, suspend_after_days, updated_by, updated_at)
        VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (id) DO UPDATE SET seller_name = excluded.seller_name, seller_address = excluded.seller_address,
          seller_gstin = excluded.seller_gstin, seller_email = excluded.seller_email, bank_details = excluded.bank_details,
          upi_vpa = excluded.upi_vpa, invoice_prefix = excluded.invoice_prefix, gst_rate_bp = excluded.gst_rate_bp,
          due_days = excluded.due_days, grace_days = excluded.grace_days, suspend_after_days = excluded.suspend_after_days,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(next.seller_name, next.seller_address, next.seller_gstin, next.seller_email, next.bank_details, next.upi_vpa, next.invoice_prefix,
        next.gst_rate_bp, next.due_days, next.grace_days, next.suspend_after_days, c.id.platformAdmin ? c.id.userId : null, now()).run()
    return ok(await billingSettings(c.env))
  })

  // Every school with its subscription and balance: the ledger.
  r.get('/seller/billing/schools', PERM, async (c) => {
    requirePlatformAdmin(c)
    const today = todayIST()
    const rows = (await c.env.CONTROL.prepare(`SELECT i.id AS institution_id, i.name AS school, i.status AS school_status,
          s.plan_code, p.name AS plan_name, s.status AS subscription_status, s.renews_on, s.agreed_price_paise, p.price_paise, p.price_monthly_paise,
          COALESCE((SELECT SUM(total_paise) FROM billing_invoices b WHERE b.institution_id = i.id AND b.status <> 'void'), 0) AS invoiced_paise,
          COALESCE((SELECT SUM(paid_paise) FROM billing_invoices b WHERE b.institution_id = i.id AND b.status <> 'void'), 0) AS paid_paise,
          (SELECT MIN(due_on) FROM billing_invoices b WHERE b.institution_id = i.id AND b.status IN ('issued','partial')) AS oldest_due_on,
          (SELECT MAX(issued_on) FROM billing_invoices b WHERE b.institution_id = i.id) AS last_invoiced_on
        FROM institutions i LEFT JOIN subscriptions s ON s.institution_id = i.id LEFT JOIN plans p ON p.code = s.plan_code
        ORDER BY i.name`).all<Record<string, unknown>>()).results
    const items = rows.map((x) => {
      const outstanding = Number(x.invoiced_paise) - Number(x.paid_paise)
      const due = x.oldest_due_on as string | null
      return { ...x, outstanding_paise: outstanding, days_overdue: due && due < today ? daysBetween(due, today) : 0,
        renews_in_days: x.renews_on ? daysBetween(today, String(x.renews_on).slice(0, 10)) : null }
    })
    return ok({ items, total_outstanding_paise: items.reduce((a, x) => a + x.outstanding_paise, 0), today })
  })

  r.get('/seller/billing/invoices', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = c.url.searchParams.get('institution_id') ?? ''
    const status = c.url.searchParams.get('status') ?? ''
    const conds: string[] = [], binds: unknown[] = []
    if (inst) { if (!isUUID(inst)) throw badRequest('invalid institution_id'); conds.push('b.institution_id = ?'); binds.push(inst) }
    if (status === 'open') conds.push(`b.status IN ('issued','partial')`)
    else if (status) { conds.push('b.status = ?'); binds.push(status) }
    return ok({ items: await listInvoices(c.env, conds.length ? 'WHERE ' + conds.join(' AND ') : '', binds) })
  })

  r.post('/seller/billing/invoices', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inv = await issueInvoice(c.env, await readJSON<NewInvoice>(c.req), c.id.userId)
    return created(invoiceJSON(inv))
  })

  r.get('/seller/billing/invoices/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inv = await invoiceOr404(c.env, c.params.id)
    return ok({ ...invoiceJSON(inv), payments: await paymentsOf(c.env, inv.id) })
  })

  r.get('/seller/billing/invoices/{id}/pdf', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inv = await invoiceOr404(c.env, c.params.id)
    return pdfResponse(await invoicePDF(c.env, inv), inv.number)
  })

  r.post('/seller/billing/invoices/{id}/payments', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inv = await invoiceOr404(c.env, c.params.id)
    const b = await readJSON<{ amount_paise?: number; method?: string; reference?: string; paid_on?: string }>(c.req)
    const res = await recordPayment(c.env, inv, {
      amount_paise: Number(b.amount_paise ?? inv.total_paise - inv.paid_paise), method: String(b.method ?? '').toLowerCase(),
      reference: String(b.reference ?? ''), paid_on: isDate(b.paid_on) ? b.paid_on : todayIST(),
    }, c.id.userId)
    return created(res)
  })

  r.post('/seller/billing/invoices/{id}/void', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inv = await invoiceOr404(c.env, c.params.id)
    if (inv.paid_paise > 0) throw conflict('money has been recorded against this invoice; it cannot be voided')
    const b = await readJSON<{ reason?: string }>(c.req).catch(() => ({} as { reason?: string }))
    await c.env.CONTROL.prepare(`UPDATE billing_invoices SET status = 'void', notes = TRIM(COALESCE(notes, '') || ' Voided: ' || ?), updated_at = ? WHERE id = ? AND paid_paise = 0`)
      .bind(String(b.reason ?? '').trim() || 'no reason given', now(), inv.id).run()
    await reconcile(c.env, inv.institution_id, await billingSettings(c.env), todayIST())
    return ok(invoiceJSON(await invoiceOr404(c.env, inv.id)))
  })

  r.post('/seller/billing/invoices/{id}/send', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inv = await invoiceOr404(c.env, c.params.id)
    const inst = await institutionById(c.env, inv.institution_id)
    if (!inst) throw notFound('no such school')
    const s = await billingSettings(c.env)
    return ok(await notifySchool(c.env, inst, 'billing.invoice', `billing.invoice:${inv.id}:${Date.now()}`, {
      number: inv.number, total: rupees(inv.total_paise), description: inv.description, due_on: inv.due_on, seller_name: s.seller_name,
    }))
  })

  r.get('/seller/billing/status-log', PERM, async (c) => {
    requirePlatformAdmin(c)
    return ok({ items: (await c.env.CONTROL.prepare(`SELECT l.*, i.name AS school FROM billing_status_log l JOIN institutions i ON i.id = l.institution_id
        ORDER BY l.id DESC LIMIT 200`).all()).results })
  })

  // Runs the daily sweep now (status changes and reminders); the cron runs it at 06:15.
  r.post('/seller/billing/run', PERM, async (c) => {
    requirePlatformAdmin(c)
    return ok(await runBillingDaily(c.env))
  })

  // ---- the school's own view (Settings → School → Billing) ----------------
  // Open while the subscription is locked (gates.ts), so a school can pay.

  r.get('/school-billing', 'auth', async (c) => {
    const inst = schoolAdminOnly(c)
    const invoices = await listInvoices(c.env, 'WHERE b.institution_id = ? AND b.status <> \'void\'', [inst])
    const sub = await c.env.CONTROL.prepare(`SELECT s.plan_code, p.name AS plan_name, s.status, s.renews_on, s.trial_ends_on
        FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code WHERE s.institution_id = ?`).bind(inst).first()
    const s = await billingSettings(c.env)
    return ok({
      subscription: sub ?? null, invoices,
      outstanding_paise: invoices.reduce((a, x) => a + x.balance_paise, 0),
      online_available: gatewaySecret(c.env) !== '',
      simulated_checkout: isDevelopment(c.env),
      pay_to: { seller_name: s.seller_name, upi_vpa: s.upi_vpa, bank_details: s.bank_details, gstin: s.seller_gstin },
    })
  })

  r.get('/school-billing/invoices/{id}/pdf', 'auth', async (c) => {
    const inst = schoolAdminOnly(c)
    const inv = await invoiceOr404(c.env, c.params.id, inst)
    if (inv.status === 'void') throw notFound('no such invoice')
    return pdfResponse(await invoicePDF(c.env, inv), inv.number)
  })

  // Starts an online payment for the invoice's balance.
  r.post('/school-billing/invoices/{id}/checkout', 'auth', async (c) => {
    const inst = schoolAdminOnly(c)
    if (!gatewaySecret(c.env)) throw badRequest('online payment is not set up; pay by UPI or bank transfer and quote the invoice number')
    const inv = await invoiceOr404(c.env, c.params.id, inst)
    if (inv.status !== 'issued' && inv.status !== 'partial') throw conflict('this invoice has nothing left to pay')
    const ref = gatewayRef('order'), amount = inv.total_paise - inv.paid_paise
    await c.env.CONTROL.prepare(`INSERT INTO billing_gateway_orders (order_ref, invoice_id, institution_id, amount_paise, status, created_by, created_at)
        VALUES (?,?,?,?,'created',?,?)`).bind(ref, inv.id, inst, amount, c.id.userId, now()).run()
    return created({ order_ref: ref, amount_paise: amount, invoice_number: inv.number, simulated: isDevelopment(c.env) })
  })

  /* The gateway's callback: {payment_ref, signature} as the checkout returned
     them, verified against HMAC-SHA256(order|payment). Outside production the
     body may instead be {outcome: "success"|"failed"} and the payment id and
     signature are minted here, then verified as a stranger's (signup.go). */
  r.post('/school-billing/checkout/{order}/callback', 'auth', async (c) => {
    const inst = schoolAdminOnly(c)
    const secret = gatewaySecret(c.env)
    if (!secret) throw badRequest('online payment is not set up')
    const o = await c.env.CONTROL.prepare(`SELECT * FROM billing_gateway_orders WHERE order_ref = ? AND institution_id = ?`).bind(c.params.order, inst)
      .first<{ order_ref: string; invoice_id: string; amount_paise: number; status: string }>()
    if (!o) throw notFound('no such payment')
    if (o.status === 'paid') return ok({ status: 'paid', invoice: invoiceJSON(await invoiceOr404(c.env, o.invoice_id)) })
    const b = await readJSON<{ payment_ref?: string; signature?: string; outcome?: string; reason?: string }>(c.req)
    let paymentRef = String(b.payment_ref ?? ''), signature = String(b.signature ?? '')
    if (!paymentRef && isDevelopment(c.env)) {
      if (b.outcome !== 'success') {
        await c.env.CONTROL.prepare(`UPDATE billing_gateway_orders SET status = 'failed', failure_reason = ? WHERE order_ref = ? AND status = 'created'`)
          .bind(String(b.reason ?? '').trim() || 'Payment was not completed.', o.order_ref).run()
        return ok({ status: 'failed' })
      }
      paymentRef = gatewayRef('pay'); signature = await signPayment(secret, o.order_ref, paymentRef)
    }
    if (!paymentRef || !safeEqual(await signPayment(secret, o.order_ref, paymentRef), signature)) {
      console.error('billing: gateway signature verification failed', o.order_ref)
      throw badRequest('we could not verify that payment with the gateway; nothing has been recorded')
    }
    const claim = await c.env.CONTROL.prepare(`UPDATE billing_gateway_orders SET status = 'paid', payment_ref = ?, paid_at = ? WHERE order_ref = ? AND status <> 'paid'`)
      .bind(paymentRef, now(), o.order_ref).run()
    if (!claim.meta.changes) return ok({ status: 'paid', invoice: invoiceJSON(await invoiceOr404(c.env, o.invoice_id)) })
    const inv = await invoiceOr404(c.env, o.invoice_id)
    const amount = Math.min(o.amount_paise, inv.total_paise - inv.paid_paise)
    const res = await recordPayment(c.env, inv, { amount_paise: amount, method: 'online', reference: paymentRef, paid_on: todayIST(), gateway_order_ref: o.order_ref }, c.id.userId)
    return ok({ status: 'paid', ...res })
  })
}
