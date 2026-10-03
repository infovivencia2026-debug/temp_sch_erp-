/* QUICK ASSIST: "Let support see my screen".

   A person of a school asks for a six-digit code (valid 15 minutes, used
   once) and reads it to XULO support. Entering it at the desk STARTS the
   support session that already exists (impersonation_grants, the recorded,
   time-limited access a school's administrator can read and end), marked
   read_only and naming who agreed to it. While it runs, index.ts refuses
   every write (identity.ts readOnly), the person sees a banner with End now,
   and the school's register lists it. Codes are in CONTROL because the desk
   does not yet know which school a code belongs to; wrong codes are counted
   per agent, ten in 15 minutes and the desk must wait. */
import type { Router } from '../../router'
import { HttpError, badRequest, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { SUPPORT_DESK } from '../../identity'
import { tenantDb, type Institution } from '../../tenant'
import { platformOnly } from '../admin/common'
import { auditDetail } from '../../services/seller_audit'
import { schoolUser } from './requests'

const CODE_MINUTES = 15
const SESSION_MINUTES = 30
const MAX_FAILURES = 10

function sixDigits(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return String(n).padStart(6, '0')
}

export function registerAssist(r: Router): void {
  r.post('/help/assist/code', 'auth', async (c) => {
    const { inst, userId } = schoolUser(c)
    /* Staff only. The session opens the school to support, not one person's
       view of it, which is not a family's to give. */
    if (c.id.roles.every((r) => r === 'parent' || r === 'student')) throw new HttpError(403, 'a parent or student asks the school office for help instead', { code: 'assist_staff_only' })
    const t = now()
    // One live code per person: asking again replaces it.
    await c.env.CONTROL.prepare(`DELETE FROM assist_codes WHERE institution_id = ? AND user_id = ? AND used_at IS NULL`).bind(inst, userId).run()
    let code = ''
    for (let i = 0; i < 5 && !code; i++) {
      const cand = sixDigits()
      const res = await c.env.CONTROL.prepare(`INSERT OR IGNORE INTO assist_codes (code, institution_id, user_id, user_name, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(cand, inst, userId, c.id.fullName, c.id.roles[0] ?? null, t, new Date(Date.now() + CODE_MINUTES * 60_000).toISOString()).run()
      if (res.meta.changes) code = cand
    }
    if (!code) throw new HttpError(503, 'could not make a code just now. Try again.')
    return created({ code, expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(), minutes: CODE_MINUTES })
  })

  /* The person's own live session, for the banner. */
  r.get('/help/assist/active', 'auth', async (c) => {
    const { userId } = schoolUser(c)
    const g = await c.db.prepare(`SELECT id, operator_name, started_at, expires_at FROM impersonation_grants
        WHERE consent_user_id = ? AND read_only = 1 AND ended_at IS NULL AND expires_at > ? ORDER BY started_at DESC LIMIT 1`)
      .bind(userId, now()).first<{ id: string; operator_name: string; started_at: string; expires_at: string }>()
    return ok(g ? { session: { id: g.id, operator: g.operator_name, started_at: g.started_at, expires_at: g.expires_at } } : {})
  })

  r.post('/help/assist/{id}/end', 'auth', async (c) => {
    schoolUser(c)
    const id = uuidParam(c.params.id)
    const res = await c.db.prepare(`UPDATE impersonation_grants SET ended_at = ?, ended_by = ?, ended_by_name = ?, ended_reason = 'ended by the person who shared their screen'
        WHERE id = ? AND consent_user_id = ? AND ended_at IS NULL`).bind(now(), c.id.userId, c.id.fullName, id, c.id.userId).run()
    if (!(res.meta.changes ?? 0)) throw notFound()
    return ok({ ended: true })
  })

  r.post('/admin/platform/assist/redeem', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const code = String((await readJSON<{ code?: string }>(c.req)).code ?? '').replace(/\D/g, '')
    if (code.length !== 6) throw badRequest('a code is six digits')
    const t = now()
    const att = await c.env.CONTROL.prepare(`SELECT failures, window_started_at FROM assist_attempts WHERE user_id = ?`).bind(c.id.userId).first<{ failures: number; window_started_at: string }>()
    const fresh = att && Date.parse(att.window_started_at) > Date.now() - CODE_MINUTES * 60_000
    if (fresh && att!.failures >= MAX_FAILURES) throw new HttpError(429, 'too many wrong codes. Wait 15 minutes, or ask the person for a new one.', { code: 'assist_throttled' })
    const row = await c.env.CONTROL.prepare(`SELECT * FROM assist_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?`).bind(code, t)
      .first<{ code: string; institution_id: string; user_id: string; user_name: string }>()
    if (!row) {
      await c.env.CONTROL.prepare(`INSERT INTO assist_attempts (user_id, window_started_at, failures) VALUES (?, ?, 1)
          ON CONFLICT (user_id) DO UPDATE SET failures = CASE WHEN window_started_at > ? THEN failures + 1 ELSE 1 END,
            window_started_at = CASE WHEN window_started_at > ? THEN window_started_at ELSE excluded.window_started_at END`)
        .bind(c.id.userId, t, new Date(Date.now() - CODE_MINUTES * 60_000).toISOString(), new Date(Date.now() - CODE_MINUTES * 60_000).toISOString()).run()
      throw new HttpError(404, 'that code is wrong or has run out. Codes last 15 minutes and work once.', { code: 'assist_code_invalid' })
    }
    // Used once, by whoever claims it first.
    const claim = await c.env.CONTROL.prepare(`UPDATE assist_codes SET used_at = ?, used_by = ?, used_by_name = ? WHERE code = ? AND used_at IS NULL`).bind(t, c.id.userId, c.id.fullName, code).run()
    if (!(claim.meta.changes ?? 0)) throw new HttpError(404, 'that code has just been used', { code: 'assist_code_invalid' })
    const inst = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ? AND status = 'active'`).bind(row.institution_id).first<Institution>()
    if (!inst) throw notFound()
    const db = tenantDb(c.env, inst)
    const id = uuid()
    const expires = new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString()
    await db.batch([
      db.prepare(`UPDATE impersonation_grants SET ended_at = ?, ended_by = NULL, ended_by_name = ?, ended_reason = 'superseded by a new session' WHERE operator_user_id = ? AND ended_at IS NULL`).bind(t, c.id.fullName, c.id.userId),
      db.prepare(`INSERT INTO impersonation_grants (id, institution_id, operator_user_id, operator_name, reason, started_at, expires_at, read_only, consent_user_id, consent_user_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, inst.id, c.id.userId, c.id.fullName, `Quick Assist: ${row.user_name} read out a code to let support see their screen. Read-only.`, t, expires, row.user_id, row.user_name),
    ])
    await c.env.CONTROL.batch([c.env.CONTROL.prepare(`UPDATE assist_codes SET grant_id = ? WHERE code = ?`).bind(id, code), c.env.CONTROL.prepare(`DELETE FROM assist_attempts WHERE user_id = ?`).bind(c.id.userId)])
    auditDetail(c, { action: 'assist.start', institution_id: inst.id, institution_name: inst.name, target: id })
    return created({ id, institution_id: inst.id, school: inst.name, person: row.user_name, expires_at: expires, read_only: true })
  })
}
