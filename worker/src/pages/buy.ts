import type { Env } from '../env'
import { now } from '../env'
import { appsPage, buyPage, loadPlans, signupPage, type BuyForm, type BuyPlan, type SignupForm } from './render'
import { NO_STORE, badForm, field, formOf, html } from './http'

/* /buy (internal/api/buy.go), /signup screen one (internal/api/signup.go) and
   /apps (internal/api/apps.go, the branch with no APK_DIR). Plans, enquiries
   and signup orders all live in CONTROL: they exist before any school does. */

/** Go's http.Redirect with 303: a GET gets the one-line HTML body, a POST none. */
const see = (location: string, get = false) => get
  ? new Response(`<a href="${location}">See Other</a>.\n`, { status: 303, headers: { location, 'content-type': 'text/html; charset=utf-8' } })
  : new Response(null, { status: 303, headers: { location } })

function internal(err: unknown): Response {
  console.error(err)
  return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

export async function showBuy(env: Env, url: URL): Promise<Response> {
  let plans: BuyPlan[]
  try { plans = await loadPlans(env.CONTROL) } catch (err) { return internal(err) }
  return html(buyPage(plans, { form: { plan: url.searchParams.get('plan') ?? '' } }))
}

export async function submitBuy(env: Env, req: Request): Promise<Response> {
  const form = await formOf(req)
  if (!form) return badForm()
  const t = (k: string) => field(form, k).trim()
  const v: BuyForm = {
    school: t('school_name'), contact: t('contact_name'), email: t('email'), phone: t('phone'),
    district: t('district'), students: t('students'), plan: t('plan_code'), message: t('message'),
  }
  const plans = await loadPlans(env.CONTROL).catch(() => [] as BuyPlan[])
  let error = ''
  if (!v.school) error = 'Please tell us the name of your school.'
  else if (!v.contact) error = 'Please tell us who we should speak to.'
  else if (!v.email && !v.phone) error = 'Please leave an email address or a phone number so we can reply.'
  if (error) return html(buyPage(plans, { error, form: v }), 400)

  const n = /^[+-]?\d+$/.test(v.students) ? parseInt(v.students, 10) : 0
  const students = n > 0 && n <= 2147483647 ? n : null
  try {
    const ts = now()
    await env.CONTROL.prepare(`INSERT INTO purchase_enquiries (id, school_name, contact_name, email, phone, district, students,
        plan_code, message, source, created_at, updated_at)
        VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), NULLIF(?, ''), 'website', ?, ?)`)
      .bind(crypto.randomUUID(), v.school, v.contact, v.email, v.phone, v.district, students, v.plan, v.message, ts, ts).run()
  } catch (err) {
    console.error('buy: enquiry insert failed', err)
    return html(buyPage(plans, { error: 'Something went wrong at our end. Please try again, or email us directly.', form: v }), 500)
  }
  return html(buyPage(plans, { sent: true, form: { school: v.school } }))
}

function billingPeriod(v: string, plan: BuyPlan | null): string {
  if (v.trim().toLowerCase() === 'monthly' && (plan === null || plan.monthlyPaise > 0)) return 'monthly'
  return 'yearly'
}

export async function showSignup(env: Env, url: URL): Promise<Response> {
  let plans: BuyPlan[]
  try { plans = await loadPlans(env.CONTROL) } catch (err) { return internal(err) }
  const plan = plans.find((p) => p.code === (url.searchParams.get('plan') ?? ''))
  if (!plan) return see('/buy', true)
  return html(signupPage(plan, billingPeriod(url.searchParams.get('billing') ?? '', plan), {}), 200, NO_STORE)
}

function looksLikeEmail(s: string): boolean {
  const at = s.indexOf('@')
  if (at <= 0 || at === s.length - 1 || s.split('@').length !== 2) return false
  const dot = s.lastIndexOf('.')
  return dot > at + 1 && dot < s.length - 1 && !/[ \t\r\n]/.test(s)
}

const validUsername = (s: string) => s.length >= 4 && s.length <= 32 && /^[a-z0-9._]+$/.test(s)

/** Mirrors gatewayRef: prefix + 14 chars of [a-z0-9]. */
function gatewayRef(prefix: string): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const b = new Uint8Array(14); crypto.getRandomValues(b)
  return prefix + '_' + [...b].map((x) => a[x % a.length]).join('')
}

export async function startSignup(env: Env, req: Request): Promise<Response> {
  const form = await formOf(req)
  if (!form) return badForm()
  let plans: BuyPlan[]
  try { plans = await loadPlans(env.CONTROL) } catch (err) { return internal(err) }
  const t = (k: string) => field(form, k).trim()
  const v: SignupForm = {
    school: t('school_name'), contact: t('contact_name'), email: t('email'), phone: t('phone'), district: t('district'),
    state: t('state'), board: t('board'), students: t('students'), username: t('admin_username').toLowerCase(),
  }
  const plan = plans.find((p) => p.code === t('plan_code'))
  if (!plan) return see('/buy')
  const billing = billingPeriod(billingPeriod(field(form, 'billing'), null), plan)

  let error = ''
  if (!v.school) error = 'Please tell us the name of your school.'
  else if (!v.contact) error = 'Please tell us who will administer the system.'
  else if (!looksLikeEmail(v.email)) error = 'Please give a working email address. The sign-in details go there.'
  else if (v.username && !validUsername(v.username)) error = 'A username may use letters, numbers, dots and underscores, and must be at least four characters.'
  if (error) return html(signupPage(plan, billing, { error, form: v }), 400, NO_STORE)

  const ref = gatewayRef('order')
  const n = /^[+-]?\d+$/.test(v.students) ? parseInt(v.students, 10) : 0
  const amount = billing === 'monthly' && plan.monthlyPaise > 0 ? plan.monthlyPaise : plan.pricePaise
  try {
    const ts = now()
    await env.CONTROL.prepare(`INSERT INTO signup_orders (id, school_name, contact_name, email, phone, district, state, board,
        students, admin_username, plan_code, amount_paise, order_ref, billing_period, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), ?, ?, ?, ?, 'created', ?, ?)`)
      .bind(crypto.randomUUID(), v.school, v.contact, v.email, v.phone, v.district, v.state, v.board,
        n > 0 && n <= 2147483647 ? n : null, v.username, plan.code, amount, ref, billing, ts, ts).run()
  } catch (err) {
    console.error('signup: order insert failed', err)
    return html(signupPage(plan, billing, { error: 'Something went wrong at our end. Nothing has been charged. Please try again.', form: v }), 500, NO_STORE)
  }
  return see('/signup/pay/' + ref)
}

export function showApps(): Response {
  return html(appsPage(), 200, { 'x-robots-tag': 'noindex, nofollow' })
}
