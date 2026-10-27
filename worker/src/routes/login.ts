import type { Env } from '../env'
import { now } from '../env'
import { DUMMY_HASH, verifyPassword } from '../auth/password'
import { isCodedUsername } from '../services/sign_in_name'
import { issueSession } from '../auth/session'
import { chooserHTML, loginHTML, type Brand, type LoginLang } from '../auth/login-page'
import { isTelugu } from './admin/msg_templates'
import { askForCode } from '../pages/mfa'
import { studentLoginRefusal, studentOnlyAccount } from '../services/student_logins'
import { defaultAppId, institutionById, institutionByHost, institutionByPath, institutionBySlug, schoolPath, siteOf, slideUrl, SLUG, tenantDb, type Institution } from '../tenant'

const CSRF = 'erp_csrf'
const MAX_FAILS = 8
const WINDOW_MS = 5 * 60_000
const MAX_CANDIDATES = 5

function safeNext(n: string | null): string {
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/'
}

function csrfToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/* The sign-in page. The Go server renders login.gohtml with the school's
   branding; this is the same form with the same field names, unstyled until
   the template is ported. The client code posts identifier, password,
   csrf_token and next, and expects a redirect on success. */
const LANG = 'erp_lang'

/* The sign-in page's language: ?lang=en|te first (remembered in a cookie so
   the form's POST and its errors keep it), then that cookie, then Telugu for
   a school whose locale is Telugu, then a browser that prefers Telugu over
   English. English otherwise. */
export function loginLang(req: Request | undefined, school?: Institution | null): { lang: LoginLang; asked: boolean } {
  if (!req) return { lang: school && isTelugu(school.locale) ? 'te' : 'en', asked: false }
  const q = new URL(req.url).searchParams.get('lang')
  if (q === 'te' || q === 'en') return { lang: q, asked: true }
  const c = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${LANG}=(te|en)(?:;|$)`))?.[1]
  if (c === 'te' || c === 'en') return { lang: c, asked: false }
  if (school && isTelugu(school.locale)) return { lang: 'te', asked: false }
  for (const part of (req.headers.get('accept-language') ?? '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase()
    if (isTelugu(tag)) return { lang: 'te', asked: false }
    if (tag === 'en' || tag.startsWith('en-')) break
  }
  return { lang: 'en', asked: false }
}

/* The wrong-details message in the words of the tab the person used. */
const TAB_NOMATCH: Record<string, string> = {
  parent: 'That phone number and password do not match. Check both, or use Forgotten your password. New here? The school office issues logins.',
  student: 'That admission number and password do not match. Check both, or use Forgotten your password. New here? The school office issues logins.',
  staff: 'That school email or phone number and password do not match. Check both, or use Forgotten your password. New here? The school office issues logins.',
}

/* The errors this file shows, in Telugu. Anything not here stays English. */
const ERRORS_TE: Record<string, string> = {
  [TAB_NOMATCH.parent]: 'ఫోన్ నంబర్, పాస్‌వర్డ్ సరిపోలలేదు. రెండూ చూసుకోండి, లేదా "పాస్‌వర్డ్ మర్చిపోయారా?" వాడండి. కొత్తవారా? లాగిన్ స్కూల్ ఆఫీసు ఇస్తుంది.',
  [TAB_NOMATCH.student]: 'అడ్మిషన్ నంబర్, పాస్‌వర్డ్ సరిపోలలేదు. రెండూ చూసుకోండి, లేదా "పాస్‌వర్డ్ మర్చిపోయారా?" వాడండి. కొత్తవారా? లాగిన్ స్కూల్ ఆఫీసు ఇస్తుంది.',
  [TAB_NOMATCH.staff]: 'స్కూల్ ఈమెయిల్ లేదా ఫోన్ నంబర్, పాస్‌వర్డ్ సరిపోలలేదు. రెండూ చూసుకోండి, లేదా "పాస్‌వర్డ్ మర్చిపోయారా?" వాడండి. కొత్తవారా? లాగిన్ స్కూల్ ఆఫీసు ఇస్తుంది.',
  'Malformed form submission.': 'ఫారం సరిగా రాలేదు. మళ్ళీ ప్రయత్నించండి.',
  'Your sign-in form expired. Please try again.': 'సైన్ ఇన్ ఫారం గడువు ముగిసింది. దయచేసి మళ్ళీ ప్రయత్నించండి.',
  'That username, email or phone and password do not match. Check both, or use Forgotten your password. New here? The school office issues logins.':
    'యూజర్‌నేమ్/ఈమెయిల్/ఫోన్, పాస్‌వర్డ్ సరిపోలలేదు. రెండూ చూసుకోండి, లేదా "పాస్‌వర్డ్ మర్చిపోయారా?" వాడండి. కొత్తవారా? లాగిన్ స్కూల్ ఆఫీసు ఇస్తుంది.',
  "Your password is right, but this school's access is paused at the moment. Nothing has been lost. Ask the school office, or whoever runs XULO for the school, to switch it back on.":
    'మీ పాస్‌వర్డ్ సరైనదే, కానీ ఈ స్కూల్ యాక్సెస్ ప్రస్తుతం ఆపివేయబడింది. ఏ సమాచారం పోలేదు. మళ్ళీ ఆన్ చేయమని స్కూల్ ఆఫీసును అడగండి.',
  'That number or address, with that password, opens accounts at more than one school, so we cannot tell which you mean. Sign in with your email address or username instead.':
    'ఈ నంబర్/ఈమెయిల్, పాస్‌వర్డ్‌తో ఒకటి కంటే ఎక్కువ స్కూళ్ల అకౌంట్లు ఉన్నాయి. మీ ఈమెయిల్ లేదా యూజర్‌నేమ్‌తో సైన్ ఇన్ చేయండి.',
}
const TOO_MANY = /^Too many attempts\. Wait (\d+) minute\(s\), then try again\.$/
function errorIn(lang: LoginLang, msg: string | undefined): string | undefined {
  if (!msg || lang !== 'te') return msg
  const m = msg.match(TOO_MANY)
  if (m) return `చాలా సార్లు ప్రయత్నించారు. ${m[1]} నిమిషాలు ఆగి మళ్ళీ ప్రయత్నించండి.`
  return ERRORS_TE[msg] ?? msg
}

async function pageFor(env: Env, opts: { error?: string; next?: string; identifier?: string; status?: number; school?: Institution | null; action?: string; remember?: boolean; req?: Request }): Promise<Response> {
  const tok = csrfToken()
  const action = opts.action ?? '/login'
  const brand = opts.school ? brandOf(opts.school, action, await loginSlides(env, opts.school)) : undefined
  const { lang, asked } = loginLang(opts.req, opts.school)
  let switchHref: string | undefined
  if (opts.req) {
    const u = new URL(opts.req.url)
    u.searchParams.set('lang', lang === 'te' ? 'en' : 'te')
    switchHref = action + u.search
  }
  const html = loginHTML({ csrf: tok, next: opts.next ?? '/', identifier: opts.identifier, error: errorIn(lang, opts.error), brand, lang, switchHref })
  const secure = env.COOKIE_SECURE !== 'false' ? '; Secure' : ''
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-language': lang })
  if (asked) headers.append('set-cookie', `${LANG}=${lang}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`)
  headers.append('set-cookie', `${CSRF}=${tok}; Path=${action}; HttpOnly; SameSite=Lax; Max-Age=900${secure}`)
  /* A visit to a school's own page makes it this browser's home: /login and
     /logout send the browser back here, so a parent never meets the XULO page. */
  if (opts.school && action !== '/login' && opts.remember !== false) headers.append('set-cookie', `${HOME}=${encodeURIComponent(action)}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`)
  return new Response(html, { status: opts.status ?? 200, headers })
}

const HOME = 'erp_home'
const SCHOOL_PATH = /^\/[a-z]{2}\/[a-z0-9][a-z0-9-]{0,62}$/

/** The school page this browser last used, or null. Checked against the path shape, never trusted as a URL. */
export function homeOf(req: Request): string | null {
  const v = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${HOME}=([^;]+)`))?.[1]
  const p = v ? decodeURIComponent(v) : null
  return p && SCHOOL_PATH.test(p) ? p : null
}

/** The school's sign-in pictures, in order, as public URLs. */
export async function loginSlides(env: Env, i: Institution): Promise<string[]> {
  const rows = await env.CONTROL.prepare('SELECT id, file_key FROM login_slides WHERE institution_id = ? ORDER BY position, created_at')
    .bind(i.id).all<{ id: string; file_key: string }>()
  return rows.results.map((s) => slideUrl(i, s))
}

export function brandOf(i: Institution, action: string, slides: string[] = []): Brand {
  return {
    name: i.name, action, slides,
    logoUrl: i.logo_key ? `${schoolPath(i)}/logo?v=${encodeURIComponent(i.logo_key.slice(-12))}` : null,
    primary: i.primary_color, accent: i.accent_color,
    eyebrow: i.tagline, headline: i.login_headline, message: i.login_message,
    supportEmail: i.support_email, supportPhone: i.support_phone,
  }
}

/** One sign-in picture, public like the logo. Another school's picture is a 404. */
export async function schoolSlide(env: Env, country: string, slug: string, id: string): Promise<Response | null> {
  const school = await institutionByPath(env, country, slug)
  if (!school) return null
  const row = await env.CONTROL.prepare('SELECT file_key FROM login_slides WHERE id = ? AND institution_id = ?').bind(id, school.id).first<{ file_key: string }>()
  if (!row) return null
  const obj = (await env.FILES_WRITE.get(row.file_key)) ?? (await env.FILES.get(row.file_key))
  if (!obj) return null
  return new Response(obj.body, { headers: {
    'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
    'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
  } })
}

/** The host the visitor typed: the Pages proxy passes it on, the Worker's own URL otherwise. */
const hostOf = (req: Request) => req.headers.get('x-forwarded-host') ?? new URL(req.url).host

export async function showLogin(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const next = safeNext(url.searchParams.get('next'))
  const school = await institutionByHost(env, hostOf(req))
  if (school) return pageFor(env, { next, school, req })
  const home = url.searchParams.has('any') ? null : homeOf(req)
  if (home) return new Response(null, { status: 302, headers: { location: next === '/' ? home : `${home}?next=${encodeURIComponent(next)}` } })
  return pageFor(env, { next, req })
}

/** /login on any host: which page it shows and whose accounts it takes depend on the host (tenant.ts siteOf). */
export async function loginAt(env: Env, req: Request): Promise<Response> {
  const site = await siteOf(env, hostOf(req))
  const get = req.method === 'GET'
  if (site.kind === 'school') {
    if (get) return pageFor(env, { next: safeNext(new URL(req.url).searchParams.get('next')), school: site.school, req })
    return login(env, req, site.school)
  }
  if (site.kind === 'chooser') return chooseSchool(env, req)
  if (site.kind === 'unknown') return chooserPage(env, req, { next: '/', code: site.code, error: noSchool(site.code), status: 404 })
  if (site.kind === 'vendor') return get ? pageFor(env, { next: safeNext(new URL(req.url).searchParams.get('next')), req }) : login(env, req, null, '/login', true)
  return get ? showLogin(env, req) : login(env, req)
}

const noSchool = (code: string) => `No school uses the code ${code}. Check it with the school office.`

/* school.<SCHOOL_DOMAIN>/login: ask for the school code (the school's slug), then send the
   browser to that school's own address, keeping where it was going. */
async function chooseSchool(env: Env, req: Request): Promise<Response> {
  // The page posts its form; a link with ?code= works too. Only a lookup, so no CSRF check.
  const q = req.method === 'POST' ? await req.formData().catch(() => new FormData()) : new URL(req.url).searchParams
  if (req.method !== 'GET' && req.method !== 'POST') return chooserPage(env, req, { next: '/', status: 405 })
  const next = safeNext(String(q.get('next') ?? ''))
  const code = String(q.get('code') ?? '').trim().toLowerCase()
  if (!code) return chooserPage(env, req, { next })
  const school = SLUG.test(code) ? await institutionBySlug(env, code) : null
  if (!school) return chooserPage(env, req, { next, code, error: noSchool(code), status: 404 })
  const to = `https://${school.slug.toLowerCase()}.${env.SCHOOL_DOMAIN}/login` + (next === '/' ? '' : `?next=${encodeURIComponent(next)}`)
  return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } })
}

function chooserPage(env: Env, req: Request, o: { next: string; code?: string; error?: string; status?: number }): Response {
  const { lang } = loginLang(req, null)
  const html = chooserHTML({ csrf: csrfToken(), next: o.next, code: o.code, error: o.error, lang })
  return new Response(html, { status: o.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-language': lang } })
}

/* A school's own sign-in page: /<country>/<slug>. GET shows it, POST signs in,
   and only that school's accounts can sign in there. */
export async function schoolLogin(env: Env, req: Request, country: string, slug: string): Promise<Response | null> {
  const school = await institutionByPath(env, country, slug)
  if (!school) return null
  const action = schoolPath(school)
  const q = new URL(req.url).searchParams
  // ?preview: the seller's Branding screen, which must not become the seller's home.
  if (req.method === 'GET') return pageFor(env, { next: safeNext(q.get('next')), school, action, remember: !q.has('preview'), req })
  if (req.method === 'POST') return login(env, req, school, action)
  return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
}

/* Everything a school's own app is built from, public and in one place, so
   scripts/apps/build-school.sh needs only this address. Nothing about a
   school is written into the app sources: change it in Tenants → Branding
   and the next build picks it up. Name, colours and logo also show inside
   the running app without a rebuild, because the app shows this page. */
export async function schoolAppConfig(env: Env, req: Request, country: string, slug: string): Promise<Response | null> {
  const s = await institutionByPath(env, country, slug)
  if (!s) return null
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '')
  const origin = s.custom_domain ? `https://${s.custom_domain}` : `${proto}://${hostOf(req)}`
  const path = schoolPath(s)
  const body = {
    name: s.name,
    short_name: s.short_name || s.name,
    app_id: s.app_id ?? defaultAppId(s),
    portal_url: s.custom_domain ? origin : origin + path,
    // On its own domain the shared host is the other name the school answers on.
    portal_aliases: s.custom_domain ? [hostOf(req)] : [],
    primary_color: s.primary_color,
    accent_color: s.accent_color ?? s.primary_color,
    logo_url: s.logo_key ? `${origin}${path}/logo?v=${encodeURIComponent(s.logo_key.slice(-12))}` : null,
  }
  return new Response(JSON.stringify(body, null, 2), { headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
}

/** The school's logo, public: it is on the sign-in page. */
export async function schoolLogo(env: Env, country: string, slug: string): Promise<Response | null> {
  const school = await institutionByPath(env, country, slug)
  if (!school?.logo_key) return null
  const obj = (await env.FILES_WRITE.get(school.logo_key)) ?? (await env.FILES.get(school.logo_key))
  if (!obj) return null
  return new Response(obj.body, { headers: {
    'content-type': obj.httpMetadata?.contentType ?? 'image/png',
    'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
  } })
}

export async function throttled(env: Env, key: string): Promise<number> {
  const row = await env.CONTROL.prepare('SELECT failures, window_started_at, locked_until FROM login_throttle WHERE key = ?')
    .bind(key).first<{ failures: number; window_started_at: string; locked_until: string | null }>()
  if (!row?.locked_until) return 0
  const left = Date.parse(row.locked_until) - Date.now()
  return left > 0 ? left : 0
}

export async function failed(env: Env, key: string, weight = 1): Promise<void> {
  const t = now()
  const row = await env.CONTROL.prepare('SELECT failures, window_started_at FROM login_throttle WHERE key = ?')
    .bind(key).first<{ failures: number; window_started_at: string }>()
  const fresh = !row || Date.now() - Date.parse(row.window_started_at) > WINDOW_MS
  const failures = (fresh ? 0 : row!.failures) + weight
  const locked = failures >= MAX_FAILS ? new Date(Date.now() + WINDOW_MS).toISOString() : null
  await env.CONTROL.prepare(`INSERT INTO login_throttle (key, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`)
    .bind(key, failures, fresh ? t : row!.window_started_at, locked).run()
}

interface Candidate { institution_id: string | null; user_id: string; hash: string | null; paused: boolean }

/* Postgres found candidates with one query over every school's users. Here
   the login_index in CONTROL says which schools hold that identifier, and
   each school's own database is asked for the hash. Same rules as
   internal/auth/handler.go: the password chooses between candidates, a
   paused school is reported only after the password matches, and a genuine
   tie is an error. */
/* Staff usernames are "<phone>.<SCHOOLCODE>", four capitals (setup/staff.ts). The bare
   number, or a username typed without its ".CODE", also finds that account:
   on a school's page only within that school; on the shared page across
   schools, where the password then chooses and a tie stays ambiguous.
   A school email (an active Staff Inbox address, mail_addresses) finds its
   holder too: the domain's school comes from CONTROL mail_domains. */
async function extraRows(env: Env, identifier: string, onlySchool?: string): Promise<{ institution_id: string | null; user_id: string }[]> {
  const out: { institution_id: string | null; user_id: string }[] = []
  if (identifier.includes('@')) {
    const domain = identifier.slice(identifier.lastIndexOf('@') + 1)
    if (!domain) return out
    const md = await env.CONTROL.prepare('SELECT institution_id FROM mail_domains WHERE domain = ?').bind(domain)
      .first<{ institution_id: string }>().catch(() => null)
    if (!md || (onlySchool && md.institution_id !== onlySchool)) return out
    const inst = await institutionById(env, md.institution_id)
    if (!inst) return out
    const a = await tenantDb(env, inst).prepare(`SELECT user_id FROM mail_addresses WHERE address = ? AND status = 'active'`)
      .bind(identifier).first<{ user_id: string }>().catch(() => null)
    if (a) out.push({ institution_id: inst.id, user_id: a.user_id })
    return out
  }
  if (identifier === '' || identifier.includes('.')) return out
  const lo = identifier + '.', hi = identifier + '/'
  const res = await env.CONTROL.prepare(
    `SELECT DISTINCT institution_id, user_id, value FROM login_index WHERE kind = 'username' AND value >= ? AND value < ? AND institution_id IS NOT NULL ${onlySchool ? 'AND institution_id = ?' : ''} LIMIT ?`)
    .bind(...(onlySchool ? [lo, hi, onlySchool, MAX_CANDIDATES] : [lo, hi, MAX_CANDIDATES]))
    .all<{ institution_id: string; user_id: string; value: string }>()
  for (const r of res.results) {
    const suffix = r.value.slice(lo.length)
    if (r.value.slice(0, lo.length).toLowerCase() === lo.toLowerCase() && /^[A-Z]{4}$/.test(suffix)) {
      out.push({ institution_id: r.institution_id, user_id: r.user_id })
    }
  }
  return out
}

async function authenticate(env: Env, identifier: string, password: string, onlySchool?: string | null):
  Promise<{ ok: true; c: Candidate } | { ok: false; outcome: 'no_account' | 'wrong_password' | 'school_paused' | 'ambiguous' }> {
  /* "<number>.<CODE>" no longer signs anyone in (owner, 2026-10-26: "Block it
     fully"); the bare number does. Same answer and cost as an unknown name. */
  if (isCodedUsername(identifier)) {
    await verifyPassword(env.PASSWORD_PEPPER, DUMMY_HASH, password)
    return { ok: false, outcome: 'no_account' }
  }
  const idx = await env.CONTROL.prepare(
    `SELECT DISTINCT institution_id, user_id FROM login_index WHERE value = ? ${onlySchool ? 'AND institution_id = ?' : onlySchool === null ? 'AND institution_id IS NULL' : ''} LIMIT ?`)
    .bind(...(onlySchool ? [identifier, onlySchool, MAX_CANDIDATES] : [identifier, MAX_CANDIDATES])).all<{ institution_id: string | null; user_id: string }>()
  const rows = [...idx.results]
  if (onlySchool !== null) rows.push(...await extraRows(env, identifier, onlySchool))
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const r of rows) {
    const k = `${r.institution_id ?? ''}|${r.user_id}`
    if (seen.has(k)) continue
    seen.add(k)
    if (r.institution_id === null) {
      const u = await env.CONTROL.prepare(`SELECT password_hash FROM platform_users WHERE id = ? AND status = 'active'`)
        .bind(r.user_id).first<{ password_hash: string | null }>()
      if (u) candidates.push({ institution_id: null, user_id: r.user_id, hash: u.password_hash, paused: false })
      continue
    }
    const inst = await institutionById(env, r.institution_id)
    if (!inst) continue
    const u = await tenantDb(env, inst).prepare(`SELECT password_hash FROM users WHERE id = ? AND status = 'active'`)
      .bind(r.user_id).first<{ password_hash: string | null }>()
    if (u) candidates.push({ institution_id: inst.id, user_id: r.user_id, hash: u.password_hash, paused: inst.status !== 'active' })
  }
  if (candidates.length === 0) {
    await verifyPassword(env.PASSWORD_PEPPER, DUMMY_HASH, password)
    return { ok: false, outcome: 'no_account' }
  }
  const matched: Candidate[] = []
  for (const c of candidates) {
    if (c.hash && await verifyPassword(env.PASSWORD_PEPPER, c.hash, password)) matched.push(c)
  }
  if (matched.length === 0) return { ok: false, outcome: 'wrong_password' }
  const live = matched.filter((c) => !c.paused)
  if (live.length === 0) return { ok: false, outcome: 'school_paused' }
  if (live.length > 1) return { ok: false, outcome: 'ambiguous' }
  return { ok: true, c: live[0] }
}

export async function login(env: Env, req: Request, school?: Institution | null, action = '/login', vendorOnly = false): Promise<Response> {
  /* On a school's own domain /login is that school's page too. */
  if (school === undefined) school = await institutionByHost(env, hostOf(req))
  const page = (_: Env, o: Parameters<typeof pageFor>[1]) => pageFor(env, { ...o, school, action, req })
  const form = await req.formData().catch(() => null)
  if (!form) return page(env, { error: 'Malformed form submission.', status: 400 })
  const cookieTok = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${CSRF}=([^;]+)`))?.[1]
  if (!cookieTok || cookieTok !== form.get('csrf_token')) {
    return page(env, { error: 'Your sign-in form expired. Please try again.', status: 403 })
  }
  const identifier = String(form.get('identifier') ?? '').trim()
  const password = String(form.get('password') ?? '')
  const next = safeNext(String(form.get('next') ?? ''))
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'

  /* login_index matches the identifier without regard to case, so the throttle must too: keyed
     on the raw string, "Admin", "ADMIN" and "admin" were three separate budgets for one account. */
  const idKey = 'id:' + identifier.toLowerCase()
  const wait = Math.max(await throttled(env, idKey), await throttled(env, 'ip:' + ip))
  if (wait > 0) {
    await record(env, req, identifier, 'locked', null, null)
    return page(env, { error: `Too many attempts. Wait ${Math.ceil(wait / 60000)} minute(s), then try again.`, next, identifier, status: 429 })
  }

  const r = await authenticate(env, identifier, password, vendorOnly ? null : school?.id)
  /* The vendor's address takes only platform accounts; a school account whose password
     is right is told where its own page is, not that the password is wrong. */
  if (!r.ok && vendorOnly && r.outcome !== 'wrong_password' && (await authenticate(env, identifier, password)).ok) {
    await record(env, req, identifier, 'wrong_site', null, null)
    return page(env, { error: `This page is for XULO staff. Sign in at your school's own address, such as yourschool.${env.SCHOOL_DOMAIN}, or find it at school.${env.SCHOOL_DOMAIN}.`, next, identifier, status: 403 })
  }
  if (!r.ok) {
    await failed(env, idKey)
    await failed(env, 'ip:' + ip, 1 / 5)
    await record(env, req, identifier, r.outcome, null, null)
    let msg = 'That username, email or phone and password do not match. Check both, or use Forgotten your password. New here? The school office issues logins.'
    const tab = String(form.get('tab') ?? '')
    if (TAB_NOMATCH[tab]) msg = TAB_NOMATCH[tab]
    if (r.outcome === 'school_paused') msg = "Your password is right, but this school's access is paused at the moment. Nothing has been lost. Ask the school office, or whoever runs XULO for the school, to switch it back on."
    if (r.outcome === 'ambiguous') msg = 'That number or address, with that password, opens accounts at more than one school, so we cannot tell which you mean. Sign in with your email address or username instead.'
    return page(env, { error: msg, next, identifier, status: 401 })
  }

  await env.CONTROL.prepare('DELETE FROM login_throttle WHERE key = ?').bind(idKey).run()

  /* A child's own login works only while the school allows student logins
     (services/student_logins.ts). The password was right, so say why. */
  if (r.c.institution_id) {
    const inst = await institutionById(env, r.c.institution_id)
    if (inst) {
      const db = tenantDb(env, inst)
      const sid = await studentOnlyAccount(db, r.c.user_id)
      const why = sid ? await studentLoginRefusal(db, sid) : null
      if (why) {
        await record(env, req, identifier, 'student_logins_off', r.c.institution_id, r.c.user_id)
        return page(env, { error: why.replace('An administrator can switch them on under Staff, Logins & access.', 'Ask your class teacher or the school office.'), next, identifier, status: 403 })
      }
    }
  }

  /* Two-factor: a school user with an authenticator set up gets the code
     step (pages/mfa.ts) instead of a session, as internal/auth does. */
  if (r.c.institution_id) {
    const inst = await institutionById(env, r.c.institution_id)
    const u = inst ? await tenantDb(env, inst).prepare('SELECT mfa_secret FROM users WHERE id = ?')
      .bind(r.c.user_id).first<{ mfa_secret: string | null }>() : null
    if (u?.mfa_secret) return askForCode(env, req, r.c.user_id, r.c.institution_id, 'password', next)
  }
  const cookie = await issueSession(env, req, r.c.user_id, r.c.institution_id)
  await record(env, req, identifier, 'ok', r.c.institution_id, r.c.user_id)
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } })
}

async function record(env: Env, req: Request, identifier: string, outcome: string, inst: string | null, user: string | null) {
  await env.CONTROL.prepare(`INSERT INTO login_events (at, identifier, outcome, institution_id, user_id, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(now(), identifier, outcome, inst, user, req.headers.get('cf-connecting-ip'), req.headers.get('user-agent')?.slice(0, 512) ?? null).run()
}
