import type { Env } from '../env'
import { now } from '../env'
import { DUMMY_HASH, verifyPassword } from '../auth/password'
import { issueSession } from '../auth/session'
import { loginHTML } from '../auth/login-page'
import { askForCode } from '../pages/mfa'
import { institutionById, tenantDb } from '../tenant'

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
function page(env: Env, opts: { error?: string; next?: string; identifier?: string; status?: number }): Response {
  const tok = csrfToken()
  const html = loginHTML({ csrf: tok, next: opts.next ?? '/', identifier: opts.identifier, error: opts.error })
  const secure = env.COOKIE_SECURE !== 'false' ? '; Secure' : ''
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'set-cookie': `${CSRF}=${tok}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=900${secure}`,
    },
  })
}

export function showLogin(env: Env, req: Request): Response {
  return page(env, { next: safeNext(new URL(req.url).searchParams.get('next')) })
}

async function throttled(env: Env, key: string): Promise<number> {
  const row = await env.CONTROL.prepare('SELECT failures, window_started_at, locked_until FROM login_throttle WHERE key = ?')
    .bind(key).first<{ failures: number; window_started_at: string; locked_until: string | null }>()
  if (!row?.locked_until) return 0
  const left = Date.parse(row.locked_until) - Date.now()
  return left > 0 ? left : 0
}

async function failed(env: Env, key: string, weight = 1): Promise<void> {
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
async function authenticate(env: Env, identifier: string, password: string):
  Promise<{ ok: true; c: Candidate } | { ok: false; outcome: 'no_account' | 'wrong_password' | 'school_paused' | 'ambiguous' }> {
  const idx = await env.CONTROL.prepare(
    `SELECT DISTINCT institution_id, user_id FROM login_index WHERE value = ? LIMIT ?`)
    .bind(identifier, MAX_CANDIDATES).all<{ institution_id: string | null; user_id: string }>()
  const candidates: Candidate[] = []
  for (const r of idx.results) {
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

export async function login(env: Env, req: Request): Promise<Response> {
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

  const r = await authenticate(env, identifier, password)
  if (!r.ok) {
    await failed(env, idKey)
    await failed(env, 'ip:' + ip, 1 / 5)
    await record(env, req, identifier, r.outcome, null, null)
    let msg = 'That username, email or phone and password do not match. Check both, or use Forgotten your password. New here? The school office issues logins.'
    if (r.outcome === 'school_paused') msg = "Your password is right, but this school's access is paused at the moment. Nothing has been lost. Ask the school office, or whoever runs WISEN for the school, to switch it back on."
    if (r.outcome === 'ambiguous') msg = 'That number or address, with that password, opens accounts at more than one school, so we cannot tell which you mean. Sign in with your email address or username instead.'
    return page(env, { error: msg, next, identifier, status: 401 })
  }

  await env.CONTROL.prepare('DELETE FROM login_throttle WHERE key = ?').bind(idKey).run()

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
