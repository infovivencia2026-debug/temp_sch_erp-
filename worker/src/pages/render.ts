import * as C from './captured'

/* Fills the pages captured in captured.ts. Every value is escaped the way
   Go's html/template escapes text and quoted attributes, so the bytes match
   what the Go server sends for the same data. */

/** The /static/app.css cache-buster the live site uses (same as auth/login-page.ts). */
export const ASSET_VERSION = 'b697c7b332'

export const esc = (s: string) => s.replace(/[&<>"'\0]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;', '\0': '�' }[c]!))

const ERROR_P = /<p class="error" role="alert"( id="login-error")?>@@ERROR@@<\/p>/

/** Replaces @@NAME@@ slots in one pass; values are escaped here. An empty
    error drops the whole {{if .Error}} paragraph, as the template does. */
function fill(page: string, vals: Record<string, string>, raw: Record<string, string> = {}): string {
  if (!vals.ERROR) page = page.replace(ERROR_P, '')
  return page.replace(/@@([A-Z]+)@@/g, (m, k: string) =>
    k === 'V' ? ASSET_VERSION : k in raw ? raw[k] : k in vals ? esc(vals[k]) : m)
}

export function forgotPage(v: { error?: string; notice?: string; sent?: string }): string {
  if (!v.notice) return fill(C.FORGOT_FORM, { ERROR: v.error ?? '' })
  let page = C.FORGOT_NOTICE
  if (!v.sent) page = page.replace('\n        <p class="fineprint">Sent to @@SENT@@.</p>\n      ', '')
  return fill(page, { ERROR: v.error ?? '', NOTICE: v.notice, SENT: v.sent ?? '' })
}

export function resetPage(v: { error?: string; token?: string; done?: boolean }): string {
  if (v.done) return fill(C.RESET_DONE, {})
  return fill(v.token ? C.RESET_FORM : C.RESET_NOTOKEN, { ERROR: v.error ?? '', TOKEN: v.token ?? '' })
}

export function mfaPage(v: { csrf: string; next: string; error?: string }): string {
  return fill(C.LOGIN_MFA, { CSRF: v.csrf, NEXT: v.next, ERROR: v.error ?? '' })
}

export function appsPage(): string {
  return fill(C.APPS, {})
}

// --- plans, as internal/api/buy.go builds them -------------------------------

export interface BuyPlan {
  code: string; name: string; rupees: string; pricePaise: number
  monthly: string; monthlyPaise: number; savingPct: number
  maxStudents: string; modules: string[]; featured: boolean
}

/** Groups by the Indian convention: 1,80,000. Mirrors indianRupees. */
export function indianRupees(n: number): string {
  const s = String(Math.trunc(n))
  if (s.length <= 3) return s
  let head = s.slice(0, -3)
  const tail = s.slice(-3)
  const parts: string[] = []
  while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2) }
  if (head) parts.unshift(head)
  return parts.join(',') + ',' + tail
}

const MODULE_LABELS: Record<string, string> = {
  students: 'Student records', academics: 'Classes, sections and timetable', attendance: 'Attendance',
  fees: 'Fee collection and receipts', communication: 'SMS, email and circulars',
  exams: 'Examinations and report cards', hr: 'Staff records and payroll', transport: 'Transport and routes',
  library: 'Library', hostel: 'Hostel', inventory: 'Stores and inventory',
}

/** plans.modules is TEXT: a JSON array, or a Postgres `{a,b}` literal left by the migration. */
function parseModules(raw: unknown): string[] {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '' || s === '{}' || s === '[]') return []
  if (s.startsWith('[')) { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  if (s.startsWith('{')) return s.slice(1, -1).split(',').map((m) => m.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return []
}

export async function loadPlans(db: D1Database): Promise<BuyPlan[]> {
  // Go read every row, retired or not; kept the same.
  const rows = await db.prepare(
    'SELECT code, name, price_paise, price_monthly_paise, max_students, modules FROM plans ORDER BY sequence, price_paise')
    .all<{ code: string; name: string; price_paise: number; price_monthly_paise: number | null; max_students: number | null; modules: string }>()
  const out = rows.results.map((r): BuyPlan => {
    const paise = Number(r.price_paise)
    const p: BuyPlan = { code: r.code, name: r.name, rupees: indianRupees(Math.trunc(paise / 100)), pricePaise: paise,
      monthly: '', monthlyPaise: 0, savingPct: 0, maxStudents: '', modules: [], featured: false }
    const m = r.price_monthly_paise == null ? null : Number(r.price_monthly_paise)
    if (m != null && m > 0) {
      p.monthlyPaise = m
      p.monthly = indianRupees(Math.trunc(m / 100))
      const year = m * 12
      if (year > paise && year > 0) p.savingPct = Math.trunc(((year - paise) * 100) / year)
    }
    p.maxStudents = r.max_students == null ? 'Unlimited students' : `Up to ${indianRupees(Number(r.max_students))} students`
    const mods = parseModules(r.modules)
    p.modules = mods.length === 0 ? ['Every module, including hostel, stores and health'] : mods.map((k) => MODULE_LABELS[k] ?? k)
    return p
  })
  if (out.length === 3) out[1].featured = true
  return out
}

/** One {{range .Plans}} body of buy.gohtml. */
function tier(p: BuyPlan): string {
  const f = p.featured
  let save = ''
  if (p.monthly && p.savingPct) save = `\n          <p class="tier-save" data-saving="${p.savingPct}">Paying yearly saves ${p.savingPct}%</p>\n        `
  else if (!p.monthly) save = '\n          <p class="tier-save">Sold by the year</p>\n        '
  const code = esc(p.code)
  return `\n    <article class="tier tier-${code}${f ? ' featured' : ''}">\n      ${f ? '<span class="ribbon">Most schools choose this</span>' : ''}\n\n` +
    `      <div class="tier-head">\n        <h2>${esc(p.name)}</h2>\n        <p class="amount">\n` +
    `          <span class="rupee">₹</span><span class="figure"\n            data-yearly="${esc(p.rupees)}"\n` +
    `            data-monthly="${esc(p.monthly || p.rupees)}">${esc(p.rupees)}</span>\n` +
    `          <span class="per" data-yearly="per year" data-monthly="${p.monthly ? 'per month' : 'per year'}">per year</span>\n        </p>\n` +
    `        <p class="cap">${esc(p.maxStudents)}</p>\n        ${save}\n` +
    `        <a class="tier-cta" href="/signup?plan=${esc(encodeURIComponent(p.code))}" data-plan="${code}">Get started</a>\n      </div>\n\n` +
    `      <div class="tier-body">\n        ${f ? '<p class="tier-eyebrow">Everything in Starter, plus</p>' : ''}\n        <ul>\n` +
    `          ${p.modules.map((m) => `<li>${esc(m)}</li>`).join('')}\n        </ul>\n      </div>\n    </article>\n    `
}

export interface BuyForm { school: string; contact: string; email: string; phone: string; district: string; students: string; plan: string; message: string }

export function buyPage(plans: BuyPlan[], v: { sent?: boolean; error?: string; form?: Partial<BuyForm> }): string {
  const f = v.form ?? {}
  let page = v.sent ? C.BUY_SENT : C.BUY_FORM
  page = page.replace('aria-label="Plans">\n    ', 'aria-label="Plans">\n    @@TIERS@@')
  if (!v.sent) {
    page = page.replace('Not sure yet</option>\n            ', 'Not sure yet</option>\n            @@OPTIONS@@')
  }
  const options = plans.map((p) => `<option value="${esc(p.code)}" ${f.plan === p.code ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
  return fill(page, {
    ERROR: v.error ?? '', SCHOOL: f.school ?? '', CONTACT: f.contact ?? '', EMAIL: f.email ?? '', PHONE: f.phone ?? '',
    DISTRICT: f.district ?? '', STUDENTS: f.students ?? '', MESSAGE: f.message ?? '',
  }, { TIERS: plans.map(tier).join(''), OPTIONS: options })
}

export interface SignupForm { school: string; contact: string; email: string; phone: string; district: string; state: string; board: string; students: string; username: string }

export function signupPage(plan: BuyPlan, billing: string, v: { error?: string; form?: Partial<SignupForm> }): string {
  const f = v.form ?? {}
  return fill(billing === 'monthly' ? C.SIGNUP_MONTHLY : C.SIGNUP_YEARLY, {
    ERROR: v.error ?? '', CODE: plan.code, NAME: plan.name, RUPEES: plan.rupees, MONTHLY: plan.monthly, MAX: plan.maxStudents,
    SCHOOL: f.school ?? '', CONTACT: f.contact ?? '', EMAIL: f.email ?? '', PHONE: f.phone ?? '', DISTRICT: f.district ?? '',
    STATE: f.state ?? '', BOARD: f.board ?? '', STUDENTS: f.students ?? '', USERNAME: f.username ?? '',
  })
}
