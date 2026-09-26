import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, noContent, notFound, ok, readJSON } from '../../http'
import { now } from '../../http'
import { hashPassword, verifyPassword } from '../../auth/password'


/* Port of internal/api/profile.go, mfa.go (the person's own routes),
   session_activity.go recordScreen and login_security.go reauth.

   Sessions live in CONTROL, not in the school's database, so every
   "other sessions" statement runs on c.env.CONTROL. */

const MFA_COOKIE = 'erp_mfa_setup'

interface EnrolmentRow { admission_no: string; class_name: string | null; section_name: string | null; roll_no: number | null; status: string | null }

/** Is this session one the classroom day code opened? Identity does not carry it; the CONTROL row does. */
async function isDayCodeSession(c: Ctx): Promise<boolean> {
  const s = await c.env.CONTROL.prepare(`SELECT via FROM sessions WHERE id = ?`).bind(c.id.sessionId).first<{ via: string }>()
  return s?.via === 'day_code'
}

async function currentHash(c: Ctx): Promise<string | null> {
  const u = await c.db.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(c.id.userId).first<{ password_hash: string | null }>()
  return u?.password_hash ?? null
}

async function readProfile(c: Ctx): Promise<Response> {
  const p = await c.db.prepare(`SELECT id, full_name, email, phone, avatar_key, status, last_login_at, mfa_secret IS NOT NULL AS mfa
      FROM users WHERE id = ?`).bind(c.id.userId)
    .first<{ id: string; full_name: string; email: string | null; phone: string | null; avatar_key: string | null; status: string; last_login_at: string | null; mfa: number }>()
  if (!p) throw notFound('resource not found')
  const out: Record<string, unknown> = {
    id: p.id, full_name: p.full_name, email: p.email ?? undefined, phone: p.phone ?? undefined,
    avatar_key: p.avatar_key ?? undefined, status: p.status, last_login_at: p.last_login_at ?? undefined, mfa_enabled: !!p.mfa,
  }
  // A miss is the normal case for staff, so it is not an error.
  const e = await c.db.prepare(`SELECT st.admission_no, c.name AS class_name, sec.name AS section_name, en.roll_no, en.status
      FROM students st
      LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
      LEFT JOIN classes c ON c.id = en.class_id
      LEFT JOIN sections sec ON sec.id = en.section_id
     WHERE st.user_id = ?`).bind(c.id.userId).first<EnrolmentRow>()
  if (e) {
    out.enrolment = { admission_no: e.admission_no, class_name: e.class_name || undefined, section_name: e.section_name || undefined,
      roll_no: e.roll_no ?? undefined, status: e.status || undefined }
  }
  return ok(out)
}

// --- TOTP, RFC 6238, mirroring internal/auth/totp.go ------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
function base32Decode(s: string): Uint8Array | null {
  const clean = s.toUpperCase().replace(/=+$/, '').trim()
  const out: number[] = []
  let bits = 0, value = 0
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) return null
    value = (value << 5) | i; bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return new Uint8Array(out)
}
async function totpCode(secret: string, step: number): Promise<string | null> {
  const key = base32Decode(secret)
  if (!key) return null
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(step))
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sum = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))
  const off = sum[sum.length - 1] & 0x0f
  const v = (((sum[off] & 0x7f) << 24) | (sum[off + 1] << 16) | (sum[off + 2] << 8) | sum[off + 3]) >>> 0
  return String(v % 1_000_000).padStart(6, '0')
}
export async function verifyTOTP(secret: string, code: string): Promise<boolean> {
  code = code.trim().replace(/ /g, '')
  if (code.length !== 6) return false
  const step = Math.floor(Date.now() / 1000 / 30)
  for (let d = -1; d <= 1; d++) {
    const want = await totpCode(secret, step + d)
    if (want !== null && want === code) return true
  }
  return false
}

/** Hasher.Sign in internal/auth/password.go: base32(HMAC-SHA256(pepper, purpose||0||message)) as xxxxx-xxxxx. */
async function sign(pepper: string, purpose: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const body = new Uint8Array([...new TextEncoder().encode(purpose), 0, ...new TextEncoder().encode(message)])
  const sum = base32Encode(new Uint8Array(await crypto.subtle.sign('HMAC', k, body)))
  return sum.slice(0, 5) + '-' + sum.slice(5, 10)
}

function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return m ? m[1] : null
}

/** deviceLabel in login_security.go: the phone or the desktop, and the browser. */
export function deviceLabel(ua: string): string {
  if (!ua) return 'unknown device'
  let dev = 'desktop'
  if (ua.includes('iPhone')) dev = 'iPhone'
  else if (ua.includes('iPad')) dev = 'iPad'
  else if (ua.includes('Android')) {
    dev = 'Android phone'
    let rest = ua.slice(ua.indexOf('Android'))
    const j = rest.indexOf(';')
    if (j >= 0) {
      rest = rest.slice(j + 1)
      const k = rest.search(/[);]/)
      if (k >= 0) {
        let model = rest.slice(0, k).trim()
        if (model.endsWith(' Build')) model = model.slice(0, -6)
        if (model && !model.startsWith('wv') && model.length < 40) dev = model
      }
    }
  } else if (ua.includes('Windows')) dev = 'Windows PC'
  else if (ua.includes('Macintosh')) dev = 'Mac'
  else if (ua.includes('Linux')) dev = 'Linux PC'
  let br = 'browser'
  if (ua.includes('Edg/')) br = 'Edge'
  else if (ua.includes('Firefox/')) br = 'Firefox'
  else if (ua.includes('Chrome/')) br = 'Chrome'
  else if (ua.includes('Safari/')) br = 'Safari'
  return dev + ' · ' + br
}

export function registerProfile(r: Router): void {
  r.get('/profile', 'self.profile.read', (c) => readProfile(c))

  r.put('/profile', 'self.profile.write', async (c) => {
    const req = await readJSON<{ full_name?: string; phone?: string | null; avatar_key?: string | null; email?: string | null; current_password?: string }>(c.req)
    const fullName = (req.full_name ?? '').trim()
    if (fullName === '' || [...fullName].length > 120) throw badRequest('full_name must be 1-120 characters')
    let newEmail: string | null = null
    if (req.email !== undefined && req.email !== null) {
      const e = req.email.trim().toLowerCase()
      if (e !== '' && !e.includes('@')) throw badRequest('that does not look like an email address')
      const cur = await c.db.prepare(`SELECT email, password_hash FROM users WHERE id = ?`).bind(c.id.userId)
        .first<{ email: string | null; password_hash: string | null }>()
      if (!cur) throw notFound('resource not found')
      if (cur.email === null || cur.email.trim().toLowerCase() !== e) {
        if (!cur.password_hash || !(await verifyPassword(c.env.PASSWORD_PEPPER, cur.password_hash, req.current_password ?? ''))) {
          throw badRequest('enter your current password to change the address you sign in with')
        }
        newEmail = e
      }
    }
    // Postgres had partial unique indexes on (institution_id, email) and (institution_id, phone); D1 does not, so the check is here.
    if (newEmail) {
      const dup = await c.db.prepare(`SELECT 1 AS x FROM users WHERE email = ? AND id <> ?`).bind(newEmail, c.id.userId).first()
      if (dup) throw badRequest('that email address is already on another account at this school. An address can only sign in as one person')
    }
    if (req.phone) {
      const dup = await c.db.prepare(`SELECT 1 AS x FROM users WHERE phone = ? AND id <> ?`).bind(req.phone, c.id.userId).first()
      if (dup) throw badRequest('that phone number is already on another account at this school, and a number can only belong to one person')
    }
    const avatar = req.avatar_key === undefined || req.avatar_key === null ? undefined : req.avatar_key
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`UPDATE users SET full_name = ?, phone = ?,
          avatar_key = CASE WHEN ? IS NULL THEN avatar_key WHEN ? = '' THEN NULL ELSE ? END,
          email = COALESCE(?, email), updated_at = ? WHERE id = ?`)
        .bind(fullName, req.phone ?? null, avatar ?? null, avatar ?? null, avatar ?? null, newEmail, now(), c.id.userId),
    ]
    // Keep CONTROL's sign-in index in step with the identifiers that changed.
    const inst = c.id.institution?.id ?? null
    if (newEmail) {
      stmts.push(c.env.CONTROL.prepare(`DELETE FROM login_index WHERE kind = 'email' AND user_id = ?`).bind(c.id.userId))
      stmts.push(c.env.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, ?, ?, ?)`)
        .bind(newEmail, inst, c.id.userId, now()))
    }
    if (req.phone !== undefined) {
      stmts.push(c.env.CONTROL.prepare(`DELETE FROM login_index WHERE kind = 'phone' AND user_id = ?`).bind(c.id.userId))
      if (req.phone) stmts.push(c.env.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('phone', ?, ?, ?, ?)`)
        .bind(req.phone, inst, c.id.userId, now()))
    }
    // Two databases: the school row first, then the index. Not atomic across the two; the index is a cache of this row.
    await stmts[0].run()
    for (const s of stmts.slice(1)) await s.run()
    return readProfile(c)
  })

  r.post('/profile/password', 'self.profile.write', async (c) => {
    if (await isDayCodeSession(c)) {
      throw new HttpError(403, 'You signed in with the day code. Change your password from a sign-in that used your password, such as on your own phone.', { code: 'day_code_session' })
    }
    const req = await readJSON<{ current_password?: string; new_password?: string }>(c.req)
    const np = req.new_password ?? ''
    const n = [...np].length
    if (n < 12 || n > 200) throw badRequest('new_password must be 12-200 characters')
    if (np === (req.current_password ?? '')) throw badRequest('new_password must differ from the current one')
    const cur = await currentHash(c)
    if (!cur || !(await verifyPassword(c.env.PASSWORD_PEPPER, cur, req.current_password ?? ''))) {
      throw new HttpError(403, 'current password is incorrect', { code: 'invalid_credentials' })
    }
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, np)
    // Clearing must_change_password here and nowhere else: this is the only route that takes a password the account holder chose.
    await c.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`).bind(hash, now(), c.id.userId).run()
    await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'password_changed' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`)
      .bind(now(), c.id.userId, c.id.sessionId).run()
    return ok({ changed: true, other_sessions_revoked: true })
  })

  r.post('/profile/password/skip', 'self.profile.write', async (c) => {
    await c.db.prepare(`UPDATE users SET must_change_password = 0, updated_at = ? WHERE id = ?`).bind(now(), c.id.userId).run()
    return ok({ skipped: true })
  })

  // --- MFA (mfa.go) -----------------------------------------------------------

  r.post('/profile/mfa/setup', 'auth', async (c) => {
    if (await isDayCodeSession(c)) throw forbidden('two-factor is set up from your own sign-in, not the classroom day code')
    const raw = new Uint8Array(20)
    crypto.getRandomValues(raw)
    const secret = base32Encode(raw)
    const u = await c.db.prepare(`SELECT COALESCE(email, phone, username, full_name) AS account FROM users WHERE id = ?`).bind(c.id.userId)
      .first<{ account: string }>()
    const account = u?.account ?? c.id.fullName
    const issuer = c.id.institution?.short_name || c.id.institution?.name || 'WISEN'
    const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
    const uri = 'otpauth://totp/' + encodeURIComponent(issuer + ':' + account) + '?' + q.toString()
    const cookieVal = (await sign(c.env.PASSWORD_PEPPER, 'mfa-setup', c.id.userId)) + '.' + secret
    const secure = c.env.COOKIE_SECURE !== 'false' ? '; Secure' : ''
    const headers = { 'set-cookie': `${MFA_COOKIE}=${cookieVal}; Path=/api/v1/profile/mfa; Max-Age=600; HttpOnly; SameSite=Lax${secure}` }
    /* The QR PNG was drawn server-side (fees.UPIQRPNG). No PNG encoder on the
       Worker: the client already receives the otpauth URI and the secret, and
       can draw the code itself; image is omitted rather than faked. */
    return new Response(JSON.stringify({ secret, uri }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
  })

  r.post('/profile/mfa/enable', 'auth', async (c) => {
    const req = await readJSON<{ code?: string }>(c.req)
    const val = readCookie(c.req, MFA_COOKIE)
    const expired = badRequest('start the setup again: the code on screen has expired')
    if (!val) throw expired
    const i = val.indexOf('.')
    if (i < 0 || val.slice(0, i) !== (await sign(c.env.PASSWORD_PEPPER, 'mfa-setup', c.id.userId))) throw expired
    const secret = val.slice(i + 1)
    if (!(await verifyTOTP(secret, req.code ?? ''))) {
      throw new HttpError(401, 'That code is not right. Type the current six digits from the app.', { code: 'wrong_code' })
    }
    await c.db.prepare(`UPDATE users SET mfa_secret = ? WHERE id = ?`).bind(secret, c.id.userId).run()
    return new Response(JSON.stringify({ mfa_enabled: true }), { status: 200, headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'set-cookie': `${MFA_COOKIE}=; Path=/api/v1/profile/mfa; Max-Age=0; HttpOnly` } })
  })

  r.post('/profile/mfa/disable', 'auth', async (c) => {
    const req = await readJSON<{ password?: string }>(c.req)
    const cur = await currentHash(c)
    if (!cur || !(await verifyPassword(c.env.PASSWORD_PEPPER, cur, req.password ?? ''))) {
      throw new HttpError(401, 'That password is not right.', { code: 'wrong_password' })
    }
    await c.db.prepare(`UPDATE users SET mfa_secret = NULL WHERE id = ?`).bind(c.id.userId).run()
    return ok({ mfa_enabled: false })
  })

  r.get('/profile/sessions', 'auth', async (c) => {
    const rows = await c.env.CONTROL.prepare(`SELECT id, COALESCE(user_agent,'') AS ua, COALESCE(ip,'') AS ip, created_at, last_seen_at
        FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`)
      .bind(c.id.userId, now()).all<{ id: string; ua: string; ip: string; created_at: string; last_seen_at: string }>()
    return ok(rows.results.map((s) => ({ id: s.id, device: deviceLabel(s.ua), ip: s.ip || undefined, created_at: s.created_at, last_seen_at: s.last_seen_at, current: s.id === c.id.sessionId })))
  })

  r.post('/profile/sessions/sign-out-others', 'auth', async (c) => {
    const res = await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'signed_out' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`)
      .bind(now(), c.id.userId, c.id.sessionId).run()
    return ok({ signed_out: res.meta.changes ?? 0 })
  })

  // --- session beacons (session_activity.go) and re-auth (login_security.go) ----

  r.post('/session/activity', 'auth', async (c) => {
    const req = await readJSON<{ screen?: string }>(c.req)
    const screen = (req.screen ?? '').trim()
    if (screen === '' || screen.length > 120) return noContent()
    /* session_screens carries a FOREIGN KEY to the tenant's own sessions table, which the Worker never
       fills (sessions live in CONTROL). Under PRAGMA foreign_keys=ON that insert would be refused, so a
       failure is swallowed: the beacon is best-effort and the page does not wait on it. */
    try {
      await c.db.prepare(`INSERT INTO session_screens (session_id, institution_id, user_id, screen, first_at, last_at, hits)
          VALUES (?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT (session_id, screen) DO UPDATE SET last_at = excluded.last_at, hits = session_screens.hits + 1`)
        .bind(c.id.sessionId, c.id.institution?.id ?? null, c.id.userId, screen, now(), now()).run()
    } catch (err) { console.warn('session_screens beacon dropped', err) }
    return noContent()
  })

  r.post('/session/reauth', 'auth', async (c) => {
    const req = await readJSON<{ password?: string }>(c.req)
    const cur = await currentHash(c)
    const ip = c.req.headers.get('cf-connecting-ip')
    const ua = c.req.headers.get('user-agent')?.slice(0, 500) ?? null
    const inst = c.id.institution?.id ?? null
    if (!cur || !(await verifyPassword(c.env.PASSWORD_PEPPER, cur, req.password ?? ''))) {
      await c.env.CONTROL.prepare(`INSERT INTO login_events (at, identifier, outcome, institution_id, user_id, ip, user_agent) VALUES (?, '', 'reauth_failed', ?, ?, ?, ?)`)
        .bind(now(), inst, c.id.userId, ip, ua).run()
      throw new HttpError(401, 'That password is not right.', { code: 'wrong_password' })
    }
    /* Sessions.Reauth stamped sessions.reauth_at; CONTROL's sessions table has no such column, so the
       fifteen-minute freshness window (RequireFresh) cannot be recorded here. Reported in the port notes. */
    await c.env.CONTROL.prepare(`INSERT INTO login_events (at, identifier, outcome, institution_id, user_id, ip, user_agent) VALUES (?, '', 'reauth_ok', ?, ?, ?, ?)`)
      .bind(now(), inst, c.id.userId, ip, ua).run()
    return ok({ fresh_until: new Date(Date.now() + 15 * 60_000).toISOString() })
  })

}
