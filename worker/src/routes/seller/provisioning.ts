import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { hashPassword } from '../../auth/password'
import { enqueue } from '../../services/jobs'
import {
  PROVISION_JOB, SLUG_RE, STAGES, bindingFor, dbNameFor, discardProvision, provisionDeps, type ProvisionRow,
} from '../../services/provision'
import { requirePlatformAdmin } from './common'

/* Seller → Schools → New school: create a school in one click.

   POST /seller/provisioning           accept the request, reserve the slug, queue the job
   GET  /seller/provisioning           recent requests (the console lists unfinished ones)
   GET  /seller/provisioning/slug?slug= is this slug free
   GET  /seller/provisioning/{id}      progress, polled by the console
   POST /seller/provisioning/{id}/retry  resume a failed request
   DELETE /seller/provisioning/{id}    discard a failed request (and its database, when safe)

   The work itself is src/services/provision.ts. The one-time password is
   made here, returned once in the POST response and stored only as a hash;
   the console keeps it in memory and shows it when the school is ready. */

const PERM = 'platform.tenants.write'
const RESERVED = new Set(['api', 'seller', 'static', 'files', 'login', 'logout', 'signup', 'buy', 'apps', 'admin', 'www', 'control', 'demo'])

function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const b = crypto.getRandomValues(new Uint8Array(12))
  const out = Array.from(b, (v) => alphabet[v % alphabet.length]).join('')
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`
}

function deriveShortName(name: string): string {
  return name.split(/[ ,.-]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 6) || 'SCHOOL'
}

export function suggestSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'school'
}

/** Why a slug cannot be used, or null. */
async function slugProblem(c: Ctx, slug: string): Promise<string | null> {
  if (!SLUG_RE.test(slug)) return 'the address must be 1-40 lowercase letters, digits and hyphens, not starting or ending with a hyphen'
  if (RESERVED.has(slug)) return 'that address is reserved'
  const binding = bindingFor(slug)
  const taken = await c.env.CONTROL.prepare(`SELECT 1 FROM institutions WHERE slug = ? OR d1_binding = ?
      UNION ALL SELECT 1 FROM provisioning WHERE slug = ? OR d1_binding = ? LIMIT 1`).bind(slug, binding, slug, binding).first()
  // A binding of that name on this Worker belongs to some other database: reusing it would point the new school at it.
  if (taken || c.env[binding] !== undefined) return 'a school already uses that address'
  return null
}

function view(p: ProvisionRow, env: Ctx['env']) {
  const b = env[p.d1_binding]
  const live = !!b && typeof b === 'object' && 'prepare' in b
  return {
    id: p.id, slug: p.slug, country: p.country, name: p.name, short_name: p.short_name, plan_code: p.plan_code,
    admin_name: p.admin_name, sign_in_as: p.admin_username || p.admin_email || p.admin_phone,
    institution_id: p.institution_id, d1_binding: p.d1_binding, d1_database_id: p.d1_database_id,
    stage: p.stage, failed_stage: p.failed_stage, error: p.error,
    stages: STAGES.slice(1),
    schema_done: p.schema_done, schema_total: p.schema_total, attempts: p.attempts,
    // false until a deploy carries TENANT_<SLUG>; the school is served over the D1 API meanwhile.
    binding_live: live,
    sign_in_path: `/${p.country}/${p.slug}`,
    created_at: p.created_at, updated_at: p.updated_at, finished_at: p.finished_at,
  }
}

async function loadRow(c: Ctx): Promise<ProvisionRow> {
  const id = uuidParam(c.params.id)
  const p = await c.env.CONTROL.prepare('SELECT * FROM provisioning WHERE id = ?').bind(id).first<ProvisionRow>()
  if (!p) throw notFound('no such request')
  return p
}

export function registerSellerProvisioning(r: Router): void {
  r.get('/seller/provisioning/slug', PERM, async (c) => {
    requirePlatformAdmin(c)
    const raw = (c.url.searchParams.get('slug') ?? '').trim().toLowerCase()
    const name = c.url.searchParams.get('name') ?? ''
    const slug = raw || suggestSlug(name)
    const problem = await slugProblem(c, slug)
    return ok({ slug, available: problem === null, reason: problem })
  })

  r.get('/seller/provisioning', PERM, async (c) => {
    requirePlatformAdmin(c)
    const rows = await c.env.CONTROL.prepare(`SELECT * FROM provisioning
        WHERE stage <> 'ready' OR created_at > ? ORDER BY created_at DESC LIMIT 50`)
      .bind(new Date(Date.now() - 7 * 86400_000).toISOString()).all<ProvisionRow>()
    return ok({ items: rows.results.map((p) => view(p, c.env)) })
  })

  r.get('/seller/provisioning/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    return ok(view(await loadRow(c), c.env))
  })

  r.post('/seller/provisioning', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const s = (k: string) => (typeof req[k] === 'string' ? (req[k] as string).trim() : '')
    const orNull = (v: string) => (v === '' ? null : v)
    const name = s('school_name') || s('name')
    const adminName = s('admin_name')
    const adminEmail = s('admin_email').toLowerCase(), adminPhone = s('admin_phone'), adminUsername = s('admin_username').toLowerCase()
    const slug = (s('slug') || suggestSlug(name)).toLowerCase()
    const country = (s('country') || 'in').toLowerCase()
    const planCode = s('plan_code')
    const trialDays = Math.max(1, Math.min(365, Math.trunc(Number(req.trial_days) || 30)))

    if (!name) throw badRequest('the school needs a name')
    if (!adminName) throw badRequest('the first administrator needs a name')
    if (!adminEmail && !adminPhone && !adminUsername) {
      throw badRequest('give the administrator an email, a phone number or a username - without one of the three they cannot sign in')
    }
    if (!/^[a-z]{2}$/.test(country)) throw badRequest('country must be a two-letter code')
    const problem = await slugProblem(c, slug)
    if (problem) throw new HttpError(409, problem, { code: 'slug_taken', field: 'slug' })
    if (planCode && !(await c.env.CONTROL.prepare('SELECT 1 FROM plans WHERE code = ?').bind(planCode).first())) {
      throw badRequest('that plan does not exist')
    }
    // One sign-in name must lead to one school, or login cannot tell which.
    for (const [kind, value] of [['email', adminEmail], ['phone', adminPhone], ['username', adminUsername]] as const) {
      if (value && await c.env.CONTROL.prepare('SELECT 1 FROM login_index WHERE kind = ? AND value = ?').bind(kind, value).first()) {
        throw badRequest(`that ${kind} is already used to sign in elsewhere`, { field: 'admin_' + kind })
      }
    }
    const b = (req.branding && typeof req.branding === 'object' ? req.branding : {}) as Record<string, unknown>
    const branding: Record<string, string> = {}
    for (const k of ['primary_color', 'accent_color', 'tagline', 'support_email', 'support_phone']) {
      const v = typeof b[k] === 'string' ? (b[k] as string).trim() : ''
      if (!v) continue
      if (k.endsWith('_color') && !/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest(`${k} must look like #1e40af`)
      branding[k] = v.slice(0, 300)
    }

    const id = uuid(), t = now()
    const password = temporaryPassword()
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, password)
    try {
      await c.env.CONTROL.prepare(`INSERT INTO provisioning (id, slug, country, name, short_name, plan_code, trial_days, district, state, affiliation_board,
          admin_name, admin_email, admin_phone, admin_username, admin_password_hash, branding, institution_id, admin_user_id,
          db_name, d1_binding, stage, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`)
        .bind(id, slug, country, name, s('short_name') || deriveShortName(name), orNull(planCode), trialDays,
          orNull(s('district')), orNull(s('state')), orNull(s('affiliation_board')),
          adminName, orNull(adminEmail), orNull(adminPhone), orNull(adminUsername), hash, JSON.stringify(branding),
          uuid(), uuid(), dbNameFor(slug, id), bindingFor(slug), c.id.userId, t, t).run()
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
        throw new HttpError(409, 'a school already uses that address', { code: 'slug_taken', field: 'slug' })
      }
      throw e
    }
    const jobId = await enqueue(c.env, PROVISION_JOB, { provisioning_id: id })
    await c.env.CONTROL.prepare('UPDATE provisioning SET job_id = ? WHERE id = ?').bind(jobId, id).run()
    const row = await c.env.CONTROL.prepare('SELECT * FROM provisioning WHERE id = ?').bind(id).first<ProvisionRow>()
    return created({
      ...view(row!, c.env),
      password,
      note: 'The password is shown once and is not stored. If it is lost, reset it from the school row rather than looking it up. They are asked to change it on first sign-in.',
    })
  })

  r.post('/seller/provisioning/{id}/retry', PERM, async (c) => {
    requirePlatformAdmin(c)
    const p = await loadRow(c)
    if (p.stage !== 'failed') throw new HttpError(409, p.stage === 'ready' ? 'that school is already ready' : 'that request is still running')
    await c.env.CONTROL.prepare(`UPDATE provisioning SET stage = 'queued', error = NULL, failed_stage = NULL, finished_at = NULL, updated_at = ? WHERE id = ? AND stage = 'failed'`)
      .bind(now(), p.id).run()
    const jobId = await enqueue(c.env, PROVISION_JOB, { provisioning_id: p.id })
    await c.env.CONTROL.prepare('UPDATE provisioning SET job_id = ? WHERE id = ?').bind(jobId, p.id).run()
    return ok(view((await c.env.CONTROL.prepare('SELECT * FROM provisioning WHERE id = ?').bind(p.id).first<ProvisionRow>())!, c.env))
  })

  r.del('/seller/provisioning/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const p = await loadRow(c)
    if (p.stage !== 'failed') throw new HttpError(409, 'only a failed request can be discarded')
    let deleted = false
    if (p.d1_database_id && p.db_created) {
      deleted = await discardProvision(provisionDeps(c.env), p)
    } else {
      await c.env.CONTROL.prepare('DELETE FROM provisioning WHERE id = ?').bind(p.id).run()
    }
    return ok({ ok: true, database_deleted: deleted })
  })
}
