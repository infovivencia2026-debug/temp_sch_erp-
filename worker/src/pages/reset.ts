import type { Env } from '../env'
import { now } from '../env'
import { hashPassword } from '../auth/password'
import { institutionById, tenantDb } from '../tenant'
import { forgotPage, resetPage } from './render'
import { kickDispatch, platformProviders } from '../services/messaging'
import { NO_STORE, badForm, field, formOf, html, sha256hex } from './http'

/* /forgot and /reset: internal/api/password_reset.go.

   Tokens live in CONTROL.password_resets (added to db/control.sql), not in the
   school's database: the /reset link arrives with no school attached, so the
   row has to say which school's users table to update. */

const RESET_WINDOW_MS = 15 * 60_000
const SAME_ANSWER = 'If that account exists, a reset link has been issued. It is good for fifteen minutes.'
const EXPIRED = 'That link has expired or has already been used. Ask for another.'

export function showForgot(): Response {
  return html(forgotPage({}), 200, NO_STORE)
}

interface Owner { institution_id: string | null; user_id: string; email: string | null; phone: string | null }

/** Active users of active schools (and active platform users) holding this
    identifier: the same set sign-in considers. */
async function owners(env: Env, who: string): Promise<Owner[]> {
  const idx = await env.CONTROL.prepare('SELECT DISTINCT institution_id, user_id FROM login_index WHERE value = ?')
    .bind(who).all<{ institution_id: string | null; user_id: string }>()
  const out: Owner[] = []
  for (const r of idx.results) {
    if (r.institution_id === null) {
      const u = await env.CONTROL.prepare(`SELECT email, phone FROM platform_users WHERE id = ? AND status = 'active'`)
        .bind(r.user_id).first<{ email: string | null; phone: string | null }>()
      if (u) out.push({ institution_id: null, user_id: r.user_id, ...u })
      continue
    }
    const inst = await institutionById(env, r.institution_id)
    if (!inst || inst.status !== 'active') continue
    const u = await tenantDb(env, inst).prepare(`SELECT email, phone FROM users WHERE id = ? AND status = 'active'`)
      .bind(r.user_id).first<{ email: string | null; phone: string | null }>()
    if (u) out.push({ institution_id: inst.id, user_id: r.user_id, ...u })
  }
  return out
}

export async function forgot(env: Env, req: Request): Promise<Response> {
  const form = await formOf(req)
  if (!form) return badForm()
  const who = field(form, 'identifier').trim()
  if (!who) {
    return html(forgotPage({ error: 'Enter the email address, username or phone number you sign in with.' }), 400, NO_STORE)
  }
  const channel = ['phone', 'sms', 'whatsapp'].includes(field(form, 'channel').trim()) ? 'phone' : 'email'

  let queued = false, ready = false
  const raw = new Uint8Array(32); crypto.getRandomValues(raw)
  const token = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
  try {
    const found = await owners(env, who)
    if (found.length > 1) console.warn('password reset: identifier matches more than one live account', { matches: found.length })
    if (found.length === 1) {
      const o = found[0]
      await env.CONTROL.prepare(`INSERT INTO password_resets (id, institution_id, user_id, token_hash, expires_at, requested_ip, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), o.institution_id, o.user_id, await sha256hex(token),
          new Date(Date.now() + RESET_WINDOW_MS).toISOString(), req.headers.get('cf-connecting-ip'), now()).run()
      /* Delivery, as password_reset.go: the seller's channels (platformProviders),
         what the person asked for first, then whatever else can carry it. The
         row is queued under the account's school, or the oldest school for a
         platform account, and the dispatcher sends password_reset through
         the platform providers whatever school it names. */
      // The platform rows (integrations, institution_id NULL) are read from the account's
      // school database, or the oldest school's for a platform account (every copy holds them).
      const anchorId = o.institution_id
        ?? (await env.CONTROL.prepare(`SELECT id FROM institutions WHERE status = 'active' ORDER BY created_at LIMIT 1`).first<{ id: string }>())?.id ?? null
      const anchor = anchorId ? await institutionById(env, anchorId) : null
      const enabled = await platformProviders(env, anchor ? tenantDb(env, anchor) : null)
      const mail = (o.email ?? '').trim(), mobile = (o.phone ?? '').trim()
      const routes: [string, string][] = channel === 'phone'
        ? [['sms', mobile], ['whatsapp', mobile], ['email', mail]]
        : [['email', mail], ['sms', mobile], ['whatsapp', mobile]]
      let to = '', ch = channel
      for (const [rc, rt] of routes) if (rt !== '' && enabled[rc]?.configured) { to = rt; ch = rc; break }
      console.log('password reset: choosing a channel', { institution: o.institution_id ?? 'platform', asked: channel,
        has_email: mail !== '', has_mobile: mobile !== '', enabled_email: !!enabled.email?.configured,
        enabled_sms: !!enabled.sms?.configured, enabled_whatsapp: !!enabled.whatsapp?.configured, picked: ch })
      if (to === '') for (const [rc, rt] of routes) if (rt !== '') { to = rt; ch = rc; break }
      const ownerInst = anchor
      if (ownerInst && to !== '') {
        const link = new URL(req.url).origin + '/reset?token=' + token
        const body = ch === 'email'
          ? 'Open this link within fifteen minutes to choose a new password:\n' + link + '\n\nIf you did not ask for this, ignore it and nothing changes.'
          : 'Reset your password within 15 minutes: ' + link + ' If you did not ask for this, ignore it.'
        await tenantDb(env, ownerInst).prepare(`INSERT INTO message_log (id, institution_id, channel, template_code, recipient, user_id,
            subject, body, status, queued_at, attempts) VALUES (?, ?, ?, 'password_reset', ?, ?, 'Reset your password', ?, 'queued', ?, 0)`)
          .bind(crypto.randomUUID(), ownerInst.id, ch, to, o.institution_id ? o.user_id : null, body, now()).run()
        await kickDispatch(env, ownerInst.id)
        queued = true
        ready = !!enabled[ch]?.configured
      }
    }
  } catch (err) {
    console.error('password reset: forgot failed', err)
    return html(forgotPage({ error: 'Something went wrong at our end. Please try again.' }), 500, NO_STORE)
  }
  // Said the same way whether or not the account exists, unless nothing could be sent (Go's second notice).
  if (!queued || !ready) {
    return html(forgotPage({ notice: 'We could not send a reset link, either this school has ' +
      'no email or WhatsApp set up, or there is no address or mobile on ' +
      'the account. Please ask your school office to reset your password.' }), 200, NO_STORE)
  }
  return html(forgotPage({ notice: SAME_ANSWER }), 200, NO_STORE)
}

interface ResetRow { institution_id: string | null; user_id: string }

async function userForToken(env: Env, token: string): Promise<ResetRow | null> {
  if (token.length < 32) return null
  return env.CONTROL.prepare(`SELECT institution_id, user_id FROM password_resets
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(await sha256hex(token), now()).first<ResetRow>()
}

export async function showReset(env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get('token') ?? ''
  if (!(await userForToken(env, token))) return html(resetPage({ error: EXPIRED }), 200, NO_STORE)
  return html(resetPage({ token }), 200, NO_STORE)
}

export async function reset(env: Env, req: Request): Promise<Response> {
  const form = await formOf(req)
  if (!form) return badForm()
  const token = field(form, 'token')
  const pw = field(form, 'password')
  const bad = (error: string) => html(resetPage({ token, error }), 400, NO_STORE)
  // Go's len() counts bytes, not characters.
  if (new TextEncoder().encode(pw).length < 10) return bad("Use at least ten characters. A short password on a school system is everybody's problem, not just yours.")
  if (pw !== field(form, 'password2')) return bad('Those two do not match.')

  const row = await userForToken(env, token)
  if (!row) return bad(EXPIRED)
  /* Spend the token before using it. Go did both in one transaction; D1 cannot span the two
     databases, and checking then spending afterwards let two submissions of one link both
     set a password. Only the request whose UPDATE claims the row goes on. */
  const claim = await env.CONTROL.prepare(`UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(now(), await sha256hex(token), now()).run()
  if ((claim.meta.changes ?? 0) === 0) return bad(EXPIRED)
  try {
    const hash = await hashPassword(env.PASSWORD_PEPPER, pw)
    const t = now()
    // The password lives in the school's database (or CONTROL for a platform
    // account); tokens and sessions live in CONTROL. D1 cannot batch across
    // databases, so the password goes first and the spend + revoke follow in
    // one CONTROL batch.
    if (row.institution_id === null) {
      await env.CONTROL.prepare(`UPDATE platform_users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`)
        .bind(hash, t, row.user_id).run()
    } else {
      const inst = await institutionById(env, row.institution_id)
      if (!inst) return bad(EXPIRED)
      await tenantDb(env, inst).prepare(`UPDATE users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`)
        .bind(hash, t, row.user_id).run()
    }
    await env.CONTROL.batch([
      env.CONTROL.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(t, row.user_id),
      env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'password_reset' WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(t, row.user_id),
    ])
  } catch (err) {
    console.error('password reset: reset failed', err)
    return bad('Something went wrong at our end. Please try again.')
  }
  return html(resetPage({ done: true }), 200, NO_STORE)
}
