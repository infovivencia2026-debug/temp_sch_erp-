import type { Ctx, Handler, Router } from '../../router'
import type { Env } from '../../env'
import { HttpError, badRequest, clampInt, conflict, created, forbidden, notFound, now, ok, readJSON, uuid, uuidParam, uuidQuery } from '../../http'
import { can } from '../../identity'
import { institutionById, type Institution } from '../../tenant'
import { enqueue } from '../../services/jobs'
import { backupBucket } from '../../services/background/backup'
import { auditDetail, listSellerAudit, recordSellerAction } from '../../services/seller_audit'
import { requirePlatformAdmin } from './common'

/* The end of a school's life on the platform, and the safety nets under it:

   - Backups: the nightly SQL dumps (services/background/backup.ts), listed
     per school, downloadable through the Worker (never a public URL), and
     re-runnable on demand.
   - Restore to a point in time: D1 Time Travel through the Cloudflare API.
     The bookmark the database stood at just before is recorded, so any
     restore can itself be undone. The school's name must be typed back.
   - Export: every table as CSV plus a files manifest in one ZIP, for the
     seller or the school's own administrator, downloadable for 7 days.
   - Off-boarding: leaving -> export -> read-only (default 30 days; the
     gate below refuses writes and /school-status tells the app) -> archived
     (the school is out of every sweep and nobody signs in; the database is
     kept) -> deleted, only after a second, separately typed confirmation.
     Every step is a row in school_lifecycle_events and in seller_audit.

   The Cloudflare API is called only when CF_API_TOKEN and CF_ACCOUNT_ID are
   set AND D1_ADMIN_LIVE is "true". Otherwise restores and deletions are
   recorded as dry runs showing the exact call that would have been made. */

const PERM = 'platform.tenants.write'
const SCHOOL_EXPORT_PERM = 'institution.settings.write'
const SCHOOL_AUDIT_PERM = 'admin.audit.read'

type State = 'active' | 'leaving' | 'read_only' | 'archived' | 'delete_pending' | 'deleted'
interface LifecycleRow {
  institution_id: string; state: State; read_only_days: number; leaving_at: string | null; export_id: string | null
  read_only_at: string | null; read_only_until: string | null; archived_at: string | null; prior_status: string | null
  delete_requested_at: string | null; delete_requested_by: string | null; deleted_at: string | null; note: string | null; updated_at: string
}

const str = (env: Env, k: string) => (typeof env[k] === 'string' ? (env[k] as string) : undefined)

// --- Cloudflare D1 admin API -------------------------------------------------------

interface CfCall { method: string; url: string }
interface CfResult { live: boolean; call: CfCall; result?: Record<string, unknown> }

function cfLive(env: Env): boolean {
  return !!str(env, 'CF_API_TOKEN') && !!str(env, 'CF_ACCOUNT_ID') && str(env, 'D1_ADMIN_LIVE') === 'true'
}

async function cf(env: Env, method: string, path: string, query: Record<string, string> = {}): Promise<CfResult> {
  const account = str(env, 'CF_ACCOUNT_ID') ?? '<CF_ACCOUNT_ID>'
  const qs = new URLSearchParams(query).toString()
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}${path}${qs ? '?' + qs : ''}`
  const call = { method, url }
  if (!cfLive(env)) return { live: false, call }
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${str(env, 'CF_API_TOKEN')}`, 'content-type': 'application/json' } })
  const body = await res.json().catch(() => ({})) as { success?: boolean; errors?: { message: string }[]; result?: Record<string, unknown> }
  if (!res.ok || body.success === false) {
    throw new HttpError(502, 'Cloudflare API refused: ' + (body.errors?.map((e) => e.message).join('; ') || res.status))
  }
  return { live: true, call, result: body.result ?? {} }
}

/** The bookmark a database is at (or was at, at `timestamp`). */
const bookmarkAt = (env: Env, dbId: string, timestamp?: string) =>
  cf(env, 'GET', `/d1/database/${dbId}/time_travel/bookmark`, timestamp ? { timestamp } : {})
const restoreTo = (env: Env, dbId: string, target: { timestamp?: string; bookmark?: string }) =>
  cf(env, 'POST', `/d1/database/${dbId}/time_travel/restore`, target.bookmark ? { bookmark: target.bookmark } : { timestamp: target.timestamp! })

// --- helpers -------------------------------------------------------------------------

async function school(c: Ctx, id = c.params.id): Promise<Institution> {
  const inst = await institutionById(c.env, uuidParam(id))
  if (!inst) throw notFound('no such school')
  return inst
}

function confirmName(inst: Institution, typed: unknown): void {
  if (typeof typed !== 'string' || typed.trim() !== inst.name.trim()) {
    throw new HttpError(422, `Type the school's name exactly ("${inst.name}") to confirm.`, { code: 'confirmation_mismatch' })
  }
}

async function lifecycleOf(env: Env, instId: string): Promise<LifecycleRow | null> {
  return env.CONTROL.prepare(`SELECT * FROM school_lifecycle WHERE institution_id = ?`).bind(instId).first<LifecycleRow>()
}

function event(c: Ctx, instId: string, step: string, detail: unknown): D1PreparedStatement {
  return c.env.CONTROL.prepare(`INSERT INTO school_lifecycle_events (id, institution_id, step, detail, actor_id, actor_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(), instId, step, detail === undefined ? null : JSON.stringify(detail), c.id.userId, c.id.fullName, now())
}

function upsertLifecycle(c: Ctx, instId: string, set: Partial<LifecycleRow>): D1PreparedStatement {
  const cols = Object.keys(set)
  const vals = cols.map((k) => (set as Record<string, unknown>)[k] ?? null)
  return c.env.CONTROL.prepare(`INSERT INTO school_lifecycle (institution_id, ${cols.join(', ')}, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
      ON CONFLICT (institution_id) DO UPDATE SET ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`)
    .bind(instId, ...vals, now())
}

const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400_000).toISOString()

async function createExport(c: Ctx, inst: Institution, purpose: 'request' | 'offboarding'): Promise<Record<string, unknown>> {
  const running = await c.env.CONTROL.prepare(`SELECT id FROM school_exports WHERE institution_id = ? AND status IN ('queued','running') AND created_at > ?`)
    .bind(inst.id, addDays(now(), -1)).first<{ id: string }>()
  if (running) throw conflict('An export of this school is already being prepared.')
  const id = uuid()
  await c.env.CONTROL.prepare(`INSERT INTO school_exports (id, institution_id, purpose, status, requested_by, requested_by_name, requested_by_platform, created_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`).bind(id, inst.id, purpose, c.id.userId, c.id.fullName, c.id.platformAdmin ? 1 : 0, now()).run()
  await enqueue(c.env, 'export:school', { export_id: id }, { institution_id: inst.id })
  return { id, status: 'queued' }
}

async function listExports(env: Env, instId: string) {
  const r = await env.CONTROL.prepare(`SELECT id, purpose, status, size_bytes, tables, row_count, files, error, requested_by_name, requested_by_platform,
      created_at, finished_at, expires_at FROM school_exports WHERE institution_id = ? ORDER BY created_at DESC LIMIT 50`).bind(instId).all<Record<string, unknown>>()
  return (r.results ?? []).map((x) => ({ ...x, requested_by_platform: x.requested_by_platform === 1,
    download_url: x.status === 'ready' ? `/api/v1/exports/${x.id}/download` : null }))
}

function download(obj: R2ObjectBody, filename: string, type: string): Response {
  return new Response(obj.body, { headers: { 'content-type': type, 'content-length': String(obj.size),
    'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`, 'cache-control': 'no-store' } })
}

function lifecycleView(inst: Institution, l: LifecycleRow | null) {
  return { institution_id: inst.id, school: inst.name, slug: inst.slug, status: inst.status, state: l?.state ?? 'active',
    read_only_days: l?.read_only_days ?? 30, leaving_at: l?.leaving_at ?? null, export_id: l?.export_id ?? null,
    read_only_at: l?.read_only_at ?? null, read_only_until: l?.read_only_until ?? null, archived_at: l?.archived_at ?? null,
    delete_requested_at: l?.delete_requested_at ?? null, deleted_at: l?.deleted_at ?? null, note: l?.note ?? null }
}

// --- the gate --------------------------------------------------------------------------

const READ_ONLY_STATES = new Set(['read_only', 'archived', 'delete_pending', 'deleted'])
/** Writes that stay open in a read-only school: signing in/out, one's own password, taking the data away. */
const OPEN_WRITES = [/^\/session/, /^\/profile\/password/, /^\/admin\/data-export$/, /^\/seller\//]

async function gate(c: Ctx, method: string, pattern: string): Promise<void> {
  const inst = c.id?.institution
  if (!inst || pattern.startsWith('/seller')) return
  if (inst.status === 'archived' || inst.status === 'deleted') {
    if (c.id.platformAdmin && method === 'GET') return
    throw new HttpError(403, `${inst.name} has left the platform; its records are archived.`, { code: 'school_archived' })
  }
  if (method === 'GET' || OPEN_WRITES.some((re) => re.test(pattern))) return
  const l = await c.env.CONTROL.prepare(`SELECT state, read_only_until FROM school_lifecycle WHERE institution_id = ?`)
    .bind(inst.id).first<{ state: string; read_only_until: string | null }>()
  if (l && READ_ONLY_STATES.has(l.state)) {
    throw new HttpError(423, `${inst.name} is read-only while it leaves the platform${l.read_only_until ? ' (until ' + l.read_only_until.slice(0, 10) + ')' : ''}. Records can be viewed and exported but not changed.`,
      { code: 'school_read_only', read_only_until: l.read_only_until })
  }
}

/** The off-boarding gate, wrapped round every route at registration (routes/index.ts). */
export function withLifecycleGate(r: Router): Router {
  const on = r.on.bind(r)
  r.on = (method, pattern, perm, handler: Handler) =>
    on(method, pattern, perm, async (c) => { await gate(c, method, pattern); return handler(c) })
  return r
}

// --- routes ------------------------------------------------------------------------------

export function registerSellerLifecycle(r: Router): void {
  // --- backups ---
  r.get('/seller/backups/fleet', PERM, async (c) => {
    requirePlatformAdmin(c)
    const rows = await c.env.CONTROL.prepare(`
      SELECT i.id AS institution_id, i.name AS school, i.slug, i.status,
             (SELECT max(finished_at) FROM backups b WHERE b.institution_id = i.id AND b.status = 'succeeded') AS last_good_at,
             (SELECT size_bytes FROM backups b WHERE b.institution_id = i.id AND b.status = 'succeeded' ORDER BY finished_at DESC LIMIT 1) AS last_size_bytes,
             (SELECT count(*) FROM backups b WHERE b.institution_id = i.id AND b.status = 'succeeded') AS kept,
             (SELECT count(*) FROM backups b WHERE b.institution_id = i.id AND b.status = 'failed' AND b.started_at > ?) AS failed_7d,
             COALESCE(l.state, 'active') AS lifecycle
        FROM institutions i LEFT JOIN school_lifecycle l ON l.institution_id = i.id
       WHERE i.status <> 'deleted' ORDER BY i.name`).bind(addDays(now(), -7)).all<Record<string, unknown>>()
    const control = await c.env.CONTROL.prepare(`SELECT max(finished_at) AS last_good_at, count(*) AS kept FROM backups WHERE scope = 'control' AND status = 'succeeded'`)
      .first<Record<string, unknown>>()
    const stale = (at: unknown) => !at || Date.now() - Date.parse(String(at)) > 36 * 3600_000
    return ok({ items: (rows.results ?? []).map((x) => ({ ...x, stale: stale(x.last_good_at) })),
      control: { ...control, stale: stale(control?.last_good_at) },
      retention: { daily: 30, monthly: 12 }, restore_live: cfLive(c.env) })
  })

  r.get('/seller/backups', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = uuidQuery(c.url.searchParams.get('institution_id'))
    const control = c.url.searchParams.get('scope') === 'control'
    if (!inst && !control) throw badRequest('institution_id or scope=control is required')
    const r = await c.env.CONTROL.prepare(`SELECT id, institution_id, scope, kind, backup_date, object_key, status, tables, row_count, size_bytes, sha256, error,
        started_at, finished_at, pruned_at FROM backups WHERE ${control ? `scope = 'control'` : 'institution_id = ?'} ORDER BY started_at DESC LIMIT ?`)
      .bind(...(control ? [] : [inst]), clampInt(c.url.searchParams.get('limit'), 100, 1, 500)).all<Record<string, unknown>>()
    return ok({ items: (r.results ?? []).map((x) => ({ ...x, download_url: x.status === 'succeeded' ? `/api/v1/seller/backups/${x.id}/download` : null })) })
  })

  r.post('/seller/backups/run', PERM, async (c) => {
    requirePlatformAdmin(c)
    const b = await readJSON<{ institution_id?: string; scope?: string }>(c.req)
    if (b.scope === 'control') {
      auditDetail(c, { action: 'backup.run', target: 'CONTROL' })
      const job = await enqueue(c.env, 'backup:database', { scope: 'control', kind: 'manual', requested_by: c.id.userId })
      return created({ job_id: job })
    }
    const inst = await school(c, b.institution_id)
    auditDetail(c, { action: 'backup.run', institution_id: inst.id, institution_name: inst.name })
    const job = await enqueue(c.env, 'backup:database', { scope: 'school', kind: 'manual', institution_id: inst.id, requested_by: c.id.userId }, { institution_id: inst.id })
    return created({ job_id: job })
  })

  r.get('/seller/backups/{id}/download', PERM, async (c) => {
    requirePlatformAdmin(c)
    const b = await c.env.CONTROL.prepare(`SELECT b.*, i.name AS school FROM backups b LEFT JOIN institutions i ON i.id = b.institution_id WHERE b.id = ?`)
      .bind(uuidParam(c.params.id)).first<{ object_key: string; status: string; institution_id: string | null; school: string | null; backup_date: string }>()
    if (!b || b.status !== 'succeeded') throw notFound('no such backup')
    const obj = await backupBucket(c.env).get(b.object_key)
    if (!obj) throw notFound('the backup file is missing from storage')
    await recordSellerAction(c.env, { actor_id: c.id.userId, actor_name: c.id.fullName, actor_roles: c.id.roles, method: 'GET', path: c.url.pathname,
      route: '/seller/backups/{id}/download', action: 'backup.download', institution_id: b.institution_id, institution_name: b.school,
      target: b.object_key, status: 200, ip: c.req.headers.get('cf-connecting-ip') })
    return download(obj, b.object_key.split('/').slice(-2).join('-'), 'application/gzip')
  })

  // --- point-in-time restore ---
  r.get('/seller/tenants/{id}/restores', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = await school(c)
    const r = await c.env.CONTROL.prepare(`SELECT * FROM restores WHERE institution_id = ? ORDER BY created_at DESC LIMIT 50`).bind(inst.id).all<Record<string, unknown>>()
    return ok({ items: r.results ?? [], live: cfLive(c.env), database_id: inst.d1_database_id })
  })

  const doRestore = async (c: Ctx, inst: Institution, target: { timestamp?: string; bookmark?: string }, reason: string, undoes: string | null) => {
    // Where the database is now: the bookmark that undoes this restore.
    const pre = await bookmarkAt(c.env, inst.d1_database_id)
    const id = uuid()
    let status = 'dry_run', resultBookmark: string | null = null, error: string | null = null
    let call = pre.call
    try {
      const res = await restoreTo(c.env, inst.d1_database_id, target)
      call = res.call
      if (res.live) { status = 'succeeded'; resultBookmark = String(res.result?.bookmark ?? '') || null }
    } catch (e) {
      status = 'failed'; error = e instanceof Error ? e.message : String(e)
    }
    const preBookmark = pre.live ? String(pre.result?.bookmark ?? '') || null : null
    await c.env.CONTROL.prepare(`INSERT INTO restores (id, institution_id, d1_database_id, target_timestamp, target_bookmark, pre_bookmark, result_bookmark,
        undoes_restore_id, status, error, reason, actor_id, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst.id, inst.d1_database_id, target.timestamp ?? null, target.bookmark ?? null, preBookmark, resultBookmark, undoes,
        status, error, reason || null, c.id.userId, c.id.fullName, now()).run()
    auditDetail(c, { action: undoes ? 'restore.undo' : 'restore.point_in_time', institution_id: inst.id, institution_name: inst.name,
      target: inst.d1_database_id, before: { bookmark: preBookmark }, after: { ...target, status, result_bookmark: resultBookmark, reason } })
    if (status === 'failed') throw new HttpError(502, error ?? 'restore failed', { restore_id: id })
    return ok({ id, status, pre_bookmark: preBookmark, result_bookmark: resultBookmark,
      dry_run: status === 'dry_run' ? { would_call: [pre.call, call], note: 'Set CF_API_TOKEN, CF_ACCOUNT_ID and D1_ADMIN_LIVE=true to restore for real.' } : undefined })
  }

  r.post('/seller/tenants/{id}/restore', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = await school(c)
    const b = await readJSON<{ timestamp?: string; bookmark?: string; confirm_name?: string; reason?: string }>(c.req)
    confirmName(inst, b.confirm_name)
    let target: { timestamp?: string; bookmark?: string }
    if (b.bookmark) target = { bookmark: String(b.bookmark) }
    else {
      const t = Date.parse(String(b.timestamp ?? ''))
      if (isNaN(t)) throw badRequest('timestamp (ISO-8601) or bookmark is required')
      if (t > Date.now()) throw badRequest('that time is in the future')
      if (Date.now() - t > 30 * 86400_000) throw badRequest('D1 Time Travel reaches back 30 days at most')
      target = { timestamp: new Date(t).toISOString() }
    }
    return doRestore(c, inst, target, String(b.reason ?? ''), null)
  })

  r.post('/seller/restores/{id}/undo', PERM, async (c) => {
    requirePlatformAdmin(c)
    const prev = await c.env.CONTROL.prepare(`SELECT * FROM restores WHERE id = ?`).bind(uuidParam(c.params.id)).first<{ institution_id: string; pre_bookmark: string | null; status: string }>()
    if (!prev) throw notFound('no such restore')
    if (prev.status !== 'succeeded' || !prev.pre_bookmark) throw conflict('Only a restore that ran and recorded its starting bookmark can be undone.')
    const inst = await school(c, prev.institution_id)
    const b = await readJSON<{ confirm_name?: string }>(c.req)
    confirmName(inst, b.confirm_name)
    return doRestore(c, inst, { bookmark: prev.pre_bookmark }, 'undo', c.params.id)
  })

  // --- exports ---
  r.get('/seller/tenants/{id}/exports', PERM, async (c) => {
    requirePlatformAdmin(c)
    return ok({ items: await listExports(c.env, (await school(c)).id) })
  })
  r.post('/seller/tenants/{id}/exports', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = await school(c)
    auditDetail(c, { action: 'export.request', institution_id: inst.id, institution_name: inst.name })
    return created(await createExport(c, inst, 'request'))
  })

  // The school's own administrator: request and list their school's export.
  r.get('/admin/data-export', SCHOOL_EXPORT_PERM, async (c) => {
    const inst = c.id.institution
    if (!inst) throw forbidden('no school in scope')
    return ok({ items: await listExports(c.env, inst.id), ttl_days: 7 })
  })
  r.post('/admin/data-export', SCHOOL_EXPORT_PERM, async (c) => {
    const inst = c.id.institution
    if (!inst) throw forbidden('no school in scope')
    return created(await createExport(c, inst, 'request'))
  })

  r.get('/exports/{id}/download', 'auth', async (c) => {
    const ex = await c.env.CONTROL.prepare(`SELECT * FROM school_exports WHERE id = ?`).bind(uuidParam(c.params.id))
      .first<{ institution_id: string; status: string; object_key: string | null; expires_at: string | null; created_at: string }>()
    if (!ex) throw notFound()
    const mine = c.id.institution?.id === ex.institution_id && can(c.id, SCHOOL_EXPORT_PERM)
    if (!(c.id.platformAdmin && can(c.id, PERM)) && !mine) throw forbidden()
    if (ex.status === 'expired' || (ex.expires_at && ex.expires_at < now())) throw new HttpError(410, 'This export has expired. Request a new one.')
    if (ex.status !== 'ready' || !ex.object_key) throw conflict('This export is not ready yet.')
    const obj = await backupBucket(c.env).get(ex.object_key)
    if (!obj) throw new HttpError(410, 'This export is no longer stored. Request a new one.')
    const inst = await institutionById(c.env, ex.institution_id)
    if (c.id.platformAdmin) {
      await recordSellerAction(c.env, { actor_id: c.id.userId, actor_name: c.id.fullName, actor_roles: c.id.roles, method: 'GET', path: c.url.pathname,
        route: '/exports/{id}/download', action: 'export.download', institution_id: ex.institution_id, institution_name: inst?.name, status: 200 })
    }
    return download(obj, `${inst?.slug ?? 'school'}-export-${ex.created_at.slice(0, 10)}.zip`, 'application/zip')
  })

  // --- off-boarding ---
  r.get('/seller/lifecycle', PERM, async (c) => {
    requirePlatformAdmin(c)
    const r = await c.env.CONTROL.prepare(`SELECT i.*, l.state AS l_state FROM institutions i LEFT JOIN school_lifecycle l ON l.institution_id = i.id ORDER BY i.name`)
      .all<Institution & { l_state: string | null }>()
    const all = await c.env.CONTROL.prepare(`SELECT * FROM school_lifecycle`).all<LifecycleRow>()
    const by = new Map((all.results ?? []).map((l) => [l.institution_id, l]))
    return ok({ items: (r.results ?? []).map((i) => lifecycleView(i, by.get(i.id) ?? null)) })
  })

  r.get('/seller/tenants/{id}/lifecycle', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = await school(c)
    const [l, ev] = await Promise.all([lifecycleOf(c.env, inst.id),
      c.env.CONTROL.prepare(`SELECT * FROM school_lifecycle_events WHERE institution_id = ? ORDER BY at DESC LIMIT 100`).bind(inst.id).all<Record<string, unknown>>()])
    return ok({ ...lifecycleView(inst, l), events: ev.results ?? [], exports: await listExports(c.env, inst.id), live: cfLive(c.env) })
  })

  r.post('/seller/tenants/{id}/lifecycle/{step}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = await school(c)
    const b = await readJSON<{ read_only_days?: number; confirm_name?: string; confirm_phrase?: string; note?: string; force?: boolean }>(c.req)
    const l = await lifecycleOf(c.env, inst.id)
    const state: State = l?.state ?? 'active'
    const step = c.params.step
    const before = { state, status: inst.status, read_only_until: l?.read_only_until ?? null }
    const t = now()
    const stmts: D1PreparedStatement[] = []
    const need = (...s: State[]) => { if (!s.includes(state)) throw conflict(`That step is not possible while the school is ${state.replace('_', ' ')}.`) }
    let after: Record<string, unknown> = {}

    switch (step) {
      case 'leaving': {
        need('active')
        const days = clampInt(String(b.read_only_days ?? ''), 30, 1, 365)
        const ex = await createExport(c, inst, 'offboarding')
        stmts.push(upsertLifecycle(c, inst.id, { state: 'leaving', read_only_days: days, leaving_at: t, export_id: String(ex.id), note: b.note ?? null }))
        after = { state: 'leaving', read_only_days: days, export_id: ex.id }
        break
      }
      case 'read-only': {
        need('leaving')
        const ex = l?.export_id ? await c.env.CONTROL.prepare(`SELECT status FROM school_exports WHERE id = ?`).bind(l.export_id).first<{ status: string }>() : null
        if (ex?.status !== 'ready' && !b.force) throw conflict('The off-boarding export is not ready yet. Wait for it (or pass force).')
        const days = clampInt(String(b.read_only_days ?? l?.read_only_days ?? ''), 30, 1, 365)
        const until = addDays(t, days)
        stmts.push(upsertLifecycle(c, inst.id, { state: 'read_only', read_only_days: days, read_only_at: t, read_only_until: until }))
        after = { state: 'read_only', read_only_until: until }
        break
      }
      case 'archive': {
        need('read_only')
        confirmName(inst, b.confirm_name)
        if (l?.read_only_until && l.read_only_until > t && !b.force) throw conflict(`The read-only period runs until ${l.read_only_until.slice(0, 10)}. Archive then, or pass force.`)
        stmts.push(upsertLifecycle(c, inst.id, { state: 'archived', archived_at: t, prior_status: inst.status }))
        stmts.push(c.env.CONTROL.prepare(`UPDATE institutions SET status = 'archived', updated_at = ? WHERE id = ?`).bind(t, inst.id))
        stmts.push(c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'school_archived' WHERE institution_id = ? AND revoked_at IS NULL`).bind(t, inst.id))
        after = { state: 'archived', status: 'archived' }
        break
      }
      case 'delete-request': {
        need('archived')
        confirmName(inst, b.confirm_name)
        stmts.push(upsertLifecycle(c, inst.id, { state: 'delete_pending', delete_requested_at: t, delete_requested_by: c.id.userId }))
        after = { state: 'delete_pending', confirm_with: `DELETE ${inst.slug}` }
        break
      }
      case 'delete-confirm': {
        need('delete_pending')
        confirmName(inst, b.confirm_name)
        if (b.confirm_phrase !== `DELETE ${inst.slug}`) throw new HttpError(422, `Type "DELETE ${inst.slug}" to confirm.`, { code: 'confirmation_mismatch' })
        const recent = await c.env.CONTROL.prepare(`SELECT id, object_key FROM backups WHERE institution_id = ? AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`)
          .bind(inst.id).first<{ id: string; object_key: string }>()
        if (!recent) throw conflict('There is no backup of this school to keep. Run one (Backups) before deleting.')
        const res = await cf(c.env, 'DELETE', `/d1/database/${inst.d1_database_id}`)
        stmts.push(upsertLifecycle(c, inst.id, { state: res.live ? 'deleted' : 'delete_pending', deleted_at: res.live ? t : null }))
        if (res.live) {
          stmts.push(c.env.CONTROL.prepare(`UPDATE institutions SET status = 'deleted', updated_at = ? WHERE id = ?`).bind(t, inst.id))
          stmts.push(c.env.CONTROL.prepare(`DELETE FROM login_index WHERE institution_id = ?`).bind(inst.id))
        }
        after = { state: res.live ? 'deleted' : 'delete_pending', database: res.live ? 'deleted' : 'dry run, not deleted', call: res.call,
          kept_backup: recent.object_key, binding_to_remove: inst.d1_binding }
        break
      }
      case 'cancel': {
        need('leaving', 'read_only', 'archived', 'delete_pending')
        stmts.push(upsertLifecycle(c, inst.id, { state: 'active', read_only_until: null, delete_requested_at: null, delete_requested_by: null }))
        if (state === 'archived' || state === 'delete_pending') {
          stmts.push(c.env.CONTROL.prepare(`UPDATE institutions SET status = ?, updated_at = ? WHERE id = ?`).bind(l?.prior_status || 'active', t, inst.id))
        }
        after = { state: 'active' }
        break
      }
      default:
        throw notFound('unknown step')
    }
    stmts.push(event(c, inst.id, step, { before, after, note: b.note }))
    await c.env.CONTROL.batch(stmts)
    auditDetail(c, { action: `lifecycle.${step}`, institution_id: inst.id, institution_name: inst.name, before, after })
    return ok({ ...lifecycleView(inst, await lifecycleOf(c.env, inst.id)), step, result: after })
  })

  // What the app shows a school on its way out (a banner; writes answer 423).
  r.get('/school-status', 'auth', async (c) => {
    const inst = c.id.institution
    if (!inst) return ok({ state: 'active' })
    const l = await lifecycleOf(c.env, inst.id)
    const state = l?.state ?? 'active'
    const notice = state === 'leaving' ? `${inst.name} is leaving the platform. A full export of its records is being prepared.`
      : READ_ONLY_STATES.has(state) ? `${inst.name} is read-only${l?.read_only_until ? ' until ' + l.read_only_until.slice(0, 10) : ''}: records can be viewed and exported, not changed.`
      : null
    return ok({ state, read_only: READ_ONLY_STATES.has(state), read_only_until: l?.read_only_until ?? null, notice })
  })

  // --- the audit register ---
  const filters = (c: Ctx) => ({
    actor: c.url.searchParams.get('actor'), action: c.url.searchParams.get('action'),
    from: c.url.searchParams.get('from'), to: c.url.searchParams.get('to'), q: c.url.searchParams.get('q'),
    limit: clampInt(c.url.searchParams.get('limit'), 50, 1, 200), offset: clampInt(c.url.searchParams.get('offset'), 0, 0, 1_000_000),
  })
  r.get('/seller/audit', PERM, async (c) => {
    requirePlatformAdmin(c)
    return ok(await listSellerAudit(c.env, { ...filters(c), institution_id: uuidQuery(c.url.searchParams.get('institution_id')) }))
  })
  // A school's administrator reads what the vendor did in and to their school.
  r.get('/admin/security/seller-audit', SCHOOL_AUDIT_PERM, async (c) => {
    const inst = c.id.institution
    if (!inst) throw forbidden('no school in scope')
    return ok(await listSellerAudit(c.env, { ...filters(c), institution_id: inst.id }))
  })
}
