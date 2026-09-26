import type { Router, Ctx } from '../../router'
import { badRequest, clampInt, isUUID, like, notFound, now, ok, readJSON, uuid } from '../../http'
import { inList, institutionId, parseJSON } from './common'
import { deviceLabel } from '../misc/profile'

/* Port of the audit, session and security routes under /admin: audit.go,
   admin.go (sessions), login_security.go, session_activity.go
   (getSessionActivity), interactions.go, day_code.go, privacy.go and
   year_rollover.go. Sessions and login_events are read from CONTROL. */

const MONEY_KEYS = ['finance.payments.write', 'finance.refunds.write', 'hr.payroll.write', 'finance.export', 'finance.wallet.manage']

interface SessionRow { id: string; user_id: string; ip: string | null; user_agent: string | null; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null; via: string; ended_reason: string | null }

function sessionView(s: SessionRow, fullName: string) {
  const revoked = s.revoked_at !== null || s.expires_at <= now()
  return { id: s.id, user_id: s.user_id, full_name: fullName, ip: s.ip ?? undefined, user_agent: s.user_agent ?? undefined, created_at: s.created_at, last_seen_at: s.last_seen_at,
    expires_at: s.expires_at, revoked, via: s.via || undefined, ended_reason: (s.ended_reason ?? (s.revoked_at === null && s.expires_at <= now() ? 'expired' : '')) || undefined,
    device: s.user_agent ? deviceLabel(s.user_agent) : undefined }
}

async function names(c: Ctx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const q = inList([...new Set(ids)])
  const rows = await c.db.prepare(`SELECT id, full_name FROM users WHERE id IN ${q.sql}`).bind(...q.args).all<{ id: string; full_name: string }>()
  return new Map(rows.results.map((u) => [u.id, u.full_name]))
}

const auditRow = (a: Record<string, unknown>, actor: string | null) => ({
  id: a.id, at: a.created_at, actor: actor ?? undefined, action: a.action, entity_type: a.entity_type, ip: a.ip ?? undefined,
  request: parseJSON<unknown>(a.before, undefined), response: parseJSON<unknown>(a.after, undefined),
})

// --- the day code (auth/daycode.go) ------------------------------------------

async function dayCode(secret: ArrayBuffer | Uint8Array, day: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sum = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(day)))
  const n = new DataView(sum.buffer).getUint32(0) % 1_000_000
  return String(n).padStart(6, '0')
}

/** LocalDay: today and its end in the school's timezone. */
function localDay(tz: string): { day: string; end: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))
  const day = `${parts.year}-${parts.month}-${parts.day}`
  // The end of the local day is midnight local; work out the UTC instant by subtracting the elapsed local seconds from now.
  const elapsed = Number(parts.hour === '24' ? 0 : parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
  const end = new Date(Math.floor(Date.now() / 1000) * 1000 - elapsed * 1000 + 86_400_000)
  return { day, end: end.toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

async function dayCodeState(c: Ctx): Promise<Record<string, unknown>> {
  const inst = await c.env.CONTROL.prepare(`SELECT teacher_day_code_secret, timezone FROM institutions WHERE id = ?`).bind(institutionId(c))
    .first<{ teacher_day_code_secret: ArrayBuffer | null; timezone: string }>()
  const secret = inst?.teacher_day_code_secret
  if (!secret || secret.byteLength === 0) return { enabled: false }
  const { day, end } = localDay(inst.timezone)
  return { enabled: true, code: await dayCode(secret, day), date: day, expires_at: end }
}

// --- year rollover ---------------------------------------------------------------

const ROLLOVER_ORDER = ['sections', 'fee_structure', 'transport', 'hostel', 'timetable', 'subjects']
interface RolloverItem { requested: boolean; copied: number; in_source: number; already_rolled?: boolean; rolled_at?: string; shared?: boolean; note?: string }

async function runYearRollover(c: Ctx, req: Record<string, unknown>, preview: boolean): Promise<Response> {
  const inst = institutionId(c)
  if (!isUUID(c.params.id)) throw badRequest('invalid academic year id')
  const sourceId = c.params.id
  const targetId = String(req.target_year_id ?? '').trim()
  if (!isUUID(targetId)) throw badRequest('target_year_id must be a uuid, create the new year first, then roll into it')
  if (targetId === sourceId) throw badRequest('a year cannot be rolled into itself')
  const years = await c.db.prepare(`SELECT id, name, starts_on, ends_on, is_current FROM academic_years WHERE id IN (?, ?)`).bind(sourceId, targetId)
    .all<{ id: string; name: string; starts_on: string; ends_on: string; is_current: number }>()
  if (years.results.length !== 2) throw badRequest('both years must exist in this school. Create the new year under School setup first')
  const src = years.results.find((y) => y.id === sourceId)!, tgt = years.results.find((y) => y.id === targetId)!
  if (tgt.is_current) throw badRequest('the target is the current year. Roll into the year that has not started yet')
  const wants = (k: string) => !!req[k]
  const items: Record<string, RolloverItem> = {}
  const stmts: D1PreparedStatement[] = []
  for (const item of ROLLOVER_ORDER) {
    const it: RolloverItem = { requested: wants(item), copied: 0, in_source: 0 }
    items[item] = it
    let countSql = '', args: unknown[] = [sourceId]
    switch (item) {
      case 'sections': countSql = `SELECT count(*) AS n FROM sections WHERE academic_year_id = ?`; break
      case 'fee_structure': countSql = `SELECT count(*) AS n FROM fee_structures WHERE academic_year_id = ? AND is_active`; break
      case 'transport': countSql = `SELECT count(*) AS n FROM transport_allocations ta WHERE ta.academic_year_id = ? AND ta.valid_to IS NULL
          AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ta.student_id AND e.academic_year_id = ? AND e.status = 'active')`; args = [sourceId, targetId]; break
      case 'timetable': countSql = `SELECT count(*) AS n FROM timetable_entries WHERE academic_year_id = ?`; break
      case 'hostel': it.shared = true; it.note = 'Hostel rooms and beds are not per year. A boarder keeps the bed until vacated, so there is nothing to copy.'
        countSql = `SELECT count(*) AS n FROM hostel_allocations WHERE vacated_on IS NULL`; args = []; break
      case 'subjects': it.shared = true; it.note = 'The subjects each class takes are not per year. Both years already read the same map.'
        countSql = `SELECT count(*) AS n FROM class_subjects`; args = []; break
    }
    it.in_source = (await c.db.prepare(countSql).bind(...args).first<{ n: number }>())?.n ?? 0
    if (it.shared || !it.requested) continue
    const rolled = await c.db.prepare(`SELECT substr(replace(run_at, 'T', ' '), 1, 16) AS at FROM rollover_log WHERE target_year_id = ? AND item = ?`).bind(targetId, item).first<{ at: string }>()
    if (rolled) { it.already_rolled = true; it.rolled_at = rolled.at; continue }
    /* No interactive transaction: the preview counts what a copy WOULD write with SELECTs; the real run
       appends the same statements to one batch. */
    switch (item) {
      case 'sections': {
        const n = await c.db.prepare(`SELECT count(*) AS n FROM sections s WHERE s.academic_year_id = ? AND NOT EXISTS (SELECT 1 FROM sections t WHERE t.class_id = s.class_id AND t.academic_year_id = ? AND t.name = s.name)`).bind(sourceId, targetId).first<{ n: number }>()
        it.copied = n?.n ?? 0
        stmts.push(c.db.prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name, capacity, room, created_at)
            SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), institution_id, campus_id, class_id, ?, name, capacity, room, ?
              FROM sections WHERE academic_year_id = ?`).bind(targetId, now(), sourceId))
        break
      }
      case 'fee_structure': {
        const todo = await c.db.prepare(`SELECT fs.id, fs.campus_id, fs.class_id, fs.name, fs.applies_to,
            (SELECT v.id FROM fee_structure_versions v WHERE v.fee_structure_id = fs.id AND v.status = 'active' ORDER BY v.effective_from DESC LIMIT 1) AS active_ver
            FROM fee_structures fs WHERE fs.academic_year_id = ? AND fs.is_active
             AND NOT EXISTS (SELECT 1 FROM fee_structures t WHERE t.academic_year_id = ? AND t.name = fs.name AND t.class_id IS fs.class_id) ORDER BY fs.name`).bind(sourceId, targetId)
          .all<{ id: string; campus_id: string; class_id: string | null; name: string; applies_to: string | null; active_ver: string | null }>()
        it.copied = todo.results.length
        const shift = `date(?, '+' || CAST(julianday(due_on) - julianday((SELECT starts_on FROM academic_years WHERE id = ?)) AS INTEGER) || ' days')`
        for (const st of todo.results) {
          const newId = uuid(), verId = uuid()
          stmts.push(c.db.prepare(`INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, class_id, name, applies_to, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
            .bind(newId, inst, st.campus_id, targetId, st.class_id, st.name, st.applies_to, now()))
          stmts.push(c.db.prepare(`INSERT INTO fee_structure_items (id, institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise, due_on)
              SELECT lower(hex(randomblob(16))), ?, ?, fee_head_id, instalment_no, amount_paise, CASE WHEN due_on IS NULL THEN NULL ELSE ${shift} END FROM fee_structure_items WHERE fee_structure_id = ?`)
            .bind(inst, newId, tgt.starts_on, sourceId, st.id))
          stmts.push(c.db.prepare(`INSERT INTO fee_structure_versions (id, institution_id, fee_structure_id, version_no, status, effective_from, revision_note, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?)`)
            .bind(verId, inst, newId, tgt.starts_on, 'Rolled over from ' + src.name + '. Review the amounts and activate.', c.id.userId, now(), now()))
          if (st.active_ver) {
            stmts.push(c.db.prepare(`INSERT INTO fee_structure_version_items (id, institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
                SELECT lower(hex(randomblob(16))), ?, ?, fee_head_id, instalment_no, amount_paise, CASE WHEN due_on IS NULL THEN NULL ELSE ${shift} END FROM fee_structure_version_items WHERE version_id = ?`)
              .bind(inst, verId, tgt.starts_on, sourceId, st.active_ver))
          } else {
            stmts.push(c.db.prepare(`INSERT INTO fee_structure_version_items (id, institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
                SELECT lower(hex(randomblob(16))), ?, ?, fee_head_id, instalment_no, amount_paise, CASE WHEN due_on IS NULL THEN NULL ELSE ${shift} END FROM fee_structure_items WHERE fee_structure_id = ?`)
              .bind(inst, verId, tgt.starts_on, sourceId, st.id))
          }
        }
        break
      }
      case 'transport': {
        const carry = `ta.academic_year_id = ? AND ta.valid_to IS NULL AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ta.student_id AND e.academic_year_id = ? AND e.status = 'active')`
        const n = await c.db.prepare(`SELECT count(DISTINCT ta.student_id) AS n FROM transport_allocations ta WHERE ${carry}
            AND NOT EXISTS (SELECT 1 FROM transport_allocations t2 WHERE t2.student_id = ta.student_id AND t2.academic_year_id = ?)`).bind(sourceId, targetId, targetId).first<{ n: number }>()
        it.copied = n?.n ?? 0
        stmts.push(c.db.prepare(`UPDATE transport_allocations SET valid_to = (SELECT ends_on FROM academic_years WHERE id = ?) WHERE id IN (SELECT ta.id FROM transport_allocations ta WHERE ${carry})`).bind(sourceId, sourceId, targetId))
        stmts.push(c.db.prepare(`INSERT INTO transport_allocations (id, institution_id, student_id, academic_year_id, route_id, pickup_stop_id, drop_stop_id, valid_from)
            SELECT lower(hex(randomblob(16))), ?, ta.student_id, ?, ta.route_id, ta.pickup_stop_id, ta.drop_stop_id, (SELECT starts_on FROM academic_years WHERE id = ?)
              FROM transport_allocations ta
             WHERE ta.id IN (SELECT t.id FROM transport_allocations t WHERE t.academic_year_id = ? AND t.valid_to = (SELECT ends_on FROM academic_years WHERE id = ?)
                                AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = t.student_id AND e.academic_year_id = ? AND e.status = 'active')
                                AND NOT EXISTS (SELECT 1 FROM transport_allocations t2 WHERE t2.student_id = t.student_id AND t2.academic_year_id = ?)
                              GROUP BY t.student_id HAVING t.valid_from = max(t.valid_from))`)
          .bind(inst, targetId, targetId, sourceId, sourceId, targetId, targetId))
        break
      }
      case 'timetable': {
        const n = await c.db.prepare(`SELECT count(*) AS n FROM timetable_entries te JOIN sections os ON os.id = te.section_id
            JOIN sections ns ON ns.class_id = os.class_id AND ns.name = os.name AND ns.academic_year_id = ?
            WHERE te.academic_year_id = ? AND NOT EXISTS (SELECT 1 FROM timetable_entries x WHERE x.section_id = ns.id AND x.weekday = te.weekday AND x.period_id = te.period_id)`).bind(targetId, sourceId).first<{ n: number }>()
        it.copied = n?.n ?? 0
        stmts.push(c.db.prepare(`INSERT OR IGNORE INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id, room, created_at)
            SELECT lower(hex(randomblob(16))), te.institution_id, ?, ns.id, te.period_id, te.weekday, te.class_subject_id, NULL, te.room, ?
              FROM timetable_entries te JOIN sections os ON os.id = te.section_id JOIN sections ns ON ns.class_id = os.class_id AND ns.name = os.name AND ns.academic_year_id = ?
             WHERE te.academic_year_id = ?`).bind(targetId, now(), targetId, sourceId))
        break
      }
    }
    stmts.push(c.db.prepare(`INSERT INTO rollover_log (id, institution_id, source_year_id, target_year_id, item, copied, run_by, run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst, sourceId, targetId, item, it.copied, c.id.userId, now()))
  }
  if (!preview && stmts.length) await c.db.batch(stmts)
  const yv = (y: typeof src) => ({ id: y.id, name: y.name, starts_on: y.starts_on, is_current: !!y.is_current })
  return ok({ source: yv(src), target: yv(tgt), preview, items, promotion_path: '/lifecycle/promote' })
}

// --- routes ----------------------------------------------------------------------

export function registerAdminSecurity(r: Router): void {
  r.get('/admin/academic-years/{id}/rollover', 'institution.settings.write', (c) => {
    const q = c.url.searchParams
    const on = (k: string) => { const v = q.get(k); return v === '1' || v === 'true' }
    return runYearRollover(c, { target_year_id: q.get('target_year_id') ?? '', sections: on('sections'), fee_structure: on('fee_structure'), transport: on('transport'), hostel: on('hostel'), timetable: on('timetable'), subjects: on('subjects') }, true)
  })
  r.post('/admin/academic-years/{id}/rollover', 'institution.settings.write', async (c) => runYearRollover(c, await readJSON(c.req), false))

  r.get('/admin/day-code', 'access.users.read', async (c) => ok(await dayCodeState(c)))
  r.put('/admin/day-code', 'access.users.write', async (c) => {
    const req = await readJSON<{ enabled?: boolean; rotate?: boolean }>(c.req)
    const inst = institutionId(c)
    if (!req.enabled) {
      await c.env.CONTROL.prepare(`UPDATE institutions SET teacher_day_code_secret = NULL, updated_at = ? WHERE id = ?`).bind(now(), inst).run()
    } else {
      const secret = new Uint8Array(32)
      crypto.getRandomValues(secret)
      if (req.rotate) await c.env.CONTROL.prepare(`UPDATE institutions SET teacher_day_code_secret = ?, updated_at = ? WHERE id = ?`).bind(secret, now(), inst).run()
      else await c.env.CONTROL.prepare(`UPDATE institutions SET teacher_day_code_secret = COALESCE(teacher_day_code_secret, ?), updated_at = ? WHERE id = ?`).bind(secret, now(), inst).run()
    }
    return ok(await dayCodeState(c))
  })

  r.get('/admin/privacy', 'access.users.read', async (c) => {
    const row = await c.db.prepare(`SELECT alerts_primary_only, credentials_by_email_only FROM institutions WHERE id = ?`).bind(institutionId(c)).first<{ alerts_primary_only: number; credentials_by_email_only: number }>()
    return ok({ alerts_primary_only: !!(row?.alerts_primary_only ?? 1), credentials_by_email_only: !!(row?.credentials_by_email_only ?? 1) })
  })
  r.put('/admin/privacy', 'access.users.write', async (c) => {
    const req = await readJSON<{ alerts_primary_only?: boolean; credentials_by_email_only?: boolean }>(c.req)
    await c.db.prepare(`UPDATE institutions SET alerts_primary_only = ?, credentials_by_email_only = ?, updated_at = ? WHERE id = ?`)
      .bind(req.alerts_primary_only ? 1 : 0, req.credentials_by_email_only ? 1 : 0, now(), institutionId(c)).run()
    return ok({ alerts_primary_only: !!req.alerts_primary_only, credentials_by_email_only: !!req.credentials_by_email_only })
  })

  // audit.go ------------------------------------------------------------------------
  r.get('/admin/audit/summary', 'admin.audit.read', async (c) => {
    const rows = await c.db.prepare(`SELECT entity_type, count(*) AS count, max(created_at) AS last_at FROM audit_log WHERE created_at >= datetime('now', '-90 days') AND (institution_id IS NOT NULL OR ?) GROUP BY entity_type ORDER BY 2 DESC`)
      .bind(c.id.platformAdmin ? 1 : 0).all<{ entity_type: string; count: number; last_at: string }>()
    return ok({ items: rows.results })
  })
  r.get('/admin/audit/events', 'admin.audit.read', async (c) => {
    const q = c.url.searchParams
    const limit = clampInt(q.get('limit'), 100, 1, 500)
    const beforeId = Number(q.get('before_id')) > 0 ? Number(q.get('before_id')) : null
    const search = q.get('q') || null
    const rows = await c.db.prepare(`SELECT e.id, e.at, e.level, e.message, e.source, e.request_id, u.full_name AS actor, e.attrs
        FROM app_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE (e.institution_id IS NOT NULL OR ?7) AND (?1 IS NULL OR e.level = ?1) AND (?2 IS NULL OR e.message LIKE ?2 ESCAPE '\\')
         AND (?3 IS NULL OR date(e.at, '+330 minutes') >= ?3) AND (?4 IS NULL OR date(e.at, '+330 minutes') <= ?4) AND (?5 IS NULL OR e.id < ?5)
       ORDER BY e.id DESC LIMIT ?6`).bind(q.get('level') || null, search ? like(search) : null, q.get('since') || null, q.get('until') || null, beforeId, limit, c.id.platformAdmin ? 1 : 0)
      .all<Record<string, unknown>>()
    const items = rows.results.map((e) => ({ id: e.id, at: e.at, level: e.level, message: e.message, source: e.source, request_id: e.request_id ?? undefined, actor: e.actor ?? undefined, attrs: parseJSON<unknown>(e.attrs, undefined) }))
    const out: Record<string, unknown> = { items }
    if (items.length === limit) out.next_before = items[items.length - 1].id
    return ok(out)
  })
  r.get('/admin/audit', 'admin.audit.read', async (c) => {
    const q = c.url.searchParams
    const limit = clampInt(q.get('limit'), 100, 1, 500)
    const beforeId = Number(q.get('before_id')) > 0 ? Number(q.get('before_id')) : null
    const search = q.get('q') || null
    const rows = await c.db.prepare(`SELECT a.id, a.created_at, u.full_name AS actor, a.action, a.entity_type, a.ip, a.before, a.after
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE (a.institution_id IS NOT NULL OR ?8) AND (?1 IS NULL OR a.entity_type = ?1) AND (?2 IS NULL OR a.actor_user_id = ?2) AND (?3 IS NULL OR a.action LIKE ?3 ESCAPE '\\')
         AND (?5 IS NULL OR date(a.created_at, '+330 minutes') >= ?5) AND (?6 IS NULL OR date(a.created_at, '+330 minutes') <= ?6) AND (?7 IS NULL OR a.id < ?7)
       ORDER BY a.id DESC LIMIT ?4`)
      .bind(q.get('entity') || null, q.get('actor') || null, search ? like(search) : null, limit, q.get('since') || null, q.get('until') || null, beforeId, c.id.platformAdmin ? 1 : 0)
      .all<Record<string, unknown>>()
    const items = rows.results.map((a) => auditRow(a, (a.actor as string | null) ?? null))
    const out: Record<string, unknown> = { items }
    if (items.length === limit) out.next_before = items[items.length - 1].id
    return ok(out)
  })

  // sessions (admin.go, login_security.go, session_activity.go) --------------------------
  r.get('/admin/sessions/live', 'admin.audit.read', async (c) => {
    const inst = institutionId(c)
    const all = c.url.searchParams.get('all') === 'true'
    const rows = await c.env.CONTROL.prepare(`SELECT * FROM sessions WHERE institution_id = ? AND (? OR (revoked_at IS NULL AND expires_at > ?)) ORDER BY last_seen_at DESC LIMIT 500`)
      .bind(inst, all ? 1 : 0, now()).all<SessionRow>()
    const userIds = [...new Set(rows.results.map((s) => s.user_id))]
    if (userIds.length === 0) return ok({ items: [] })
    const uq = inList(userIds), mq = inList(MONEY_KEYS)
    const users = await c.db.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.username,
        EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key IN ${mq.sql}) AS money,
        EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id) AS staff,
        (EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id) OR EXISTS (SELECT 1 FROM students st WHERE st.user_id = u.id) OR EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id)) AS has_record,
        (SELECT group_concat(ro.name, '\u001f') FROM (SELECT ro.name FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id = u.id ORDER BY ro.name) ro) AS roles
        FROM users u WHERE u.id IN ${uq.sql}`).bind(...mq.args, ...uq.args)
      .all<{ id: string; full_name: string; email: string | null; phone: string | null; username: string | null; money: number; staff: number; has_record: number; roles: string | null }>()
    const byUser = new Map(users.results.map((u) => [u.id, u]))
    const live = await c.env.CONTROL.prepare(`SELECT user_id, count(*) AS n FROM sessions WHERE institution_id = ? AND revoked_at IS NULL AND expires_at > ? GROUP BY user_id`).bind(inst, now()).all<{ user_id: string; n: number }>()
    const liveCount = new Map(live.results.map((x) => [x.user_id, x.n]))
    const tz = c.id.institution?.timezone || 'Asia/Kolkata'
    const hourIn = (iso: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(iso))) % 24
    const out = []
    for (const s of rows.results) {
      const u = byUser.get(s.user_id)
      if (!u) continue
      const idents = [u.email, u.phone, u.username].filter((x): x is string => !!x)
      const iq = inList(idents.length ? idents : ['\u0000'])
      const [failed, newDev] = await Promise.all([
        c.env.CONTROL.prepare(`SELECT count(*) AS n FROM login_events WHERE identifier <> '' AND user_id IS NULL AND outcome IN ('wrong_password','locked')
            AND at BETWEEN datetime(?, '-30 minutes') AND ? AND identifier IN ${iq.sql}`).bind(s.created_at, s.created_at, ...iq.args).first<{ n: number }>(),
        c.env.CONTROL.prepare(`SELECT NOT EXISTS (SELECT 1 FROM sessions y WHERE y.user_id = ? AND y.user_agent IS ? AND y.id <> ? AND y.created_at > datetime('now', '-90 days')) AS nd`)
          .bind(s.user_id, s.user_agent, s.id).first<{ nd: number }>(),
      ])
      const flags: string[] = []
      const hr = hourIn(s.created_at)
      if (u.staff && (hr >= 22 || hr < 6)) flags.push('after_hours')
      if ((liveCount.get(s.user_id) ?? 0) > 3) flags.push('many_devices')
      if (u.money && newDev?.nd) flags.push('new_device')
      if (!u.has_record) flags.push('no_record')
      if ((failed?.n ?? 0) >= 3) flags.push('failed_first')
      const v = sessionView(s, u.full_name)
      out.push({ ...v, device: v.device ?? '', via: s.via, roles: u.roles ? u.roles.split('\u001f') : [], flags })
    }
    return ok(out)
  })

  r.get('/admin/sessions', 'admin.audit.read', async (c) => {
    const inst = institutionId(c)
    const onlyActive = c.url.searchParams.get('active') === 'true'
    const user = (c.url.searchParams.get('user') ?? '').trim()
    if (user !== '' && !isUUID(user)) throw badRequest('invalid user id')
    const rows = await c.env.CONTROL.prepare(`SELECT * FROM sessions WHERE institution_id = ? AND (NOT ? OR (revoked_at IS NULL AND expires_at > ?)) AND (? IS NULL OR user_id = ?) ORDER BY last_seen_at DESC LIMIT 200`)
      .bind(inst, onlyActive ? 1 : 0, now(), user || null, user || null).all<SessionRow>()
    const nm = await names(c, rows.results.map((s) => s.user_id))
    return ok(rows.results.filter((s) => nm.has(s.user_id)).map((s) => sessionView(s, nm.get(s.user_id)!)))
  })

  r.del('/admin/sessions', 'access.sessions.revoke', async (c) => {
    if (c.url.searchParams.get('all') !== 'true') throw badRequest('pass all=true to sign everyone out')
    const res = await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'all_signed_out' WHERE institution_id = ? AND revoked_at IS NULL AND expires_at > ? AND id <> ?`)
      .bind(now(), institutionId(c), now(), c.id.sessionId).run()
    return ok({ signed_out: res.meta.changes ?? 0 })
  })

  r.get('/admin/sessions/{id}/activity', 'admin.audit.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid session id')
    const s = await c.env.CONTROL.prepare(`SELECT * FROM sessions WHERE id = ? AND institution_id = ?`).bind(c.params.id, institutionId(c)).first<SessionRow>()
    if (!s) throw notFound('resource not found')
    const u = await c.db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(s.user_id).first<{ full_name: string }>()
    if (!u) throw notFound('resource not found')
    const [screens, changes] = await c.db.batch<Record<string, unknown>>([
      c.db.prepare(`SELECT screen, first_at, last_at, hits FROM session_screens WHERE session_id = ? ORDER BY first_at`).bind(s.id),
      c.db.prepare(`SELECT a.id, a.created_at, u.full_name AS actor, a.action, a.entity_type, a.ip, a.before, a.after FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.session_id = ? ORDER BY a.id LIMIT 500`).bind(s.id),
    ])
    return ok({ session: sessionView(s, u.full_name), screens: screens.results, changes: changes.results.map((a) => auditRow(a, (a.actor as string | null) ?? null)) })
  })

  r.del('/admin/sessions/{id}', 'access.sessions.revoke', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid session id')
    const res = await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND institution_id = ? AND revoked_at IS NULL`).bind(now(), c.params.id, institutionId(c)).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
    return ok({ id: c.params.id, revoked: true })
  })

  r.get('/admin/login-events', 'admin.audit.read', async (c) => {
    const q = c.url.searchParams
    const user = (q.get('user') ?? '').trim()
    if (user !== '' && !isUUID(user)) throw badRequest('invalid user id')
    const days = clampInt(q.get('days'), 30, 1, 365)
    const limit = clampInt(q.get('limit'), 200, 1, 1000)
    const failedOnly = q.get('failed') === 'true'
    const inst = institutionId(c)
    // Identifiers of this school's users, so a failure that named no account can be matched to one.
    const idents = await c.db.prepare(`SELECT id, full_name, email, phone, username FROM users`).all<{ id: string; full_name: string; email: string | null; phone: string | null; username: string | null }>()
    const byIdent = new Map<string, { id: string; full_name: string }>()
    const byId = new Map<string, string>()
    for (const u of idents.results) {
      byId.set(u.id, u.full_name)
      for (const k of [u.email, u.phone, u.username]) if (k && !byIdent.has(k)) byIdent.set(k, { id: u.id, full_name: u.full_name })
    }
    const rows = await c.env.CONTROL.prepare(`SELECT id, at, outcome, identifier, user_id, ip, user_agent FROM login_events
        WHERE at > datetime('now', '-' || ? || ' days') AND (institution_id = ? OR institution_id IS NULL)
          AND (NOT ? OR outcome NOT IN ('success','reauth_ok','mfa_required')) ORDER BY id DESC LIMIT ?`)
      .bind(String(days), inst, failedOnly ? 1 : 0, limit * 4).all<{ id: number; at: string; outcome: string; identifier: string | null; user_id: string | null; ip: string | null; user_agent: string | null }>()
    const out = []
    for (const e of rows.results) {
      let uid = e.user_id, name = uid ? byId.get(uid) : undefined
      if (!uid && e.identifier) { const m = byIdent.get(e.identifier); if (m) { uid = m.id; name = m.full_name } }
      if (uid && !byId.has(uid)) continue
      if (!uid && e.identifier && !byIdent.has(e.identifier)) continue
      if (user && uid !== user) continue
      out.push({ id: e.id, at: e.at, outcome: e.outcome, identifier: e.identifier || undefined, user_id: uid ?? undefined, full_name: name, via: 'password', ip: e.ip ?? undefined, device: deviceLabel(e.user_agent ?? ''), session_id: undefined })
      if (out.length >= limit) break
    }
    return ok({ items: out })
  })

  // interactions.go -------------------------------------------------------------
  r.get('/admin/interactions/people', 'admin.audit.read', async (c) => {
    const search = (c.url.searchParams.get('q') ?? '').trim()
    const rows = await c.db.prepare(`SELECT u.id, u.full_name,
        CASE WHEN EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id) THEN 'staff' WHEN EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id) THEN 'guardian'
             WHEN EXISTS (SELECT 1 FROM students st WHERE st.user_id = u.id) THEN 'student' ELSE 'staff' END AS side
        FROM users u WHERE u.status = 'active' AND (? = '' OR u.full_name LIKE ? ESCAPE '\\') ORDER BY u.full_name LIMIT 30`).bind(search, like(search))
      .all<{ id: string; full_name: string; side: string }>()
    return ok({ items: rows.results })
  })

  r.get('/admin/interactions', 'admin.audit.read', async (c) => {
    const q = c.url.searchParams
    const a = (q.get('a') ?? '').trim() || null, b = (q.get('b') ?? '').trim() || null
    if ((a && !isUUID(a)) || (b && !isUUID(b))) throw badRequest('a and b must be user ids')
    const kind = (q.get('kind') ?? '').trim()
    const days = clampInt(q.get('days'), 30, 1, 730)
    const limit = clampInt(q.get('limit'), 300, 1, 2000)
    const search = (q.get('q') ?? '').trim()
    const rows = await c.db.prepare(`
      WITH fam AS (
        SELECT sg.student_id, group_concat(g.full_name, ', ') AS names,
               (SELECT g2.user_id FROM student_guardians s2 JOIN guardians g2 ON g2.id = s2.guardian_id WHERE s2.student_id = sg.student_id ORDER BY s2.is_primary DESC LIMIT 1) AS user_id
          FROM (SELECT * FROM student_guardians ORDER BY is_primary DESC) sg JOIN guardians g ON g.id = sg.guardian_id GROUP BY sg.student_id
      ), src AS (
        SELECT m.sent_at AS at, 'staff_message' AS kind, m.sender_user_id AS from_id, su.full_name AS from_name,
               CASE WHEN m.sender_user_id = m.party_a THEN m.party_b ELSE m.party_a END AS to_id, ou.full_name AS to_name,
               NULL AS student_name, m.body AS summary, json_array_length(m.attachments) AS files, '/go/messages?box=staff' AS link, m.id AS ref
          FROM staff_messages m JOIN users su ON su.id = m.sender_user_id JOIN users ou ON ou.id = CASE WHEN m.sender_user_id = m.party_a THEN m.party_b ELSE m.party_a END
        UNION ALL
        SELECT m.sent_at, 'parent_message', m.sender_user_id, su.full_name,
               CASE WHEN m.sender_user_id = m.parent_user_id THEN m.teacher_user_id ELSE m.parent_user_id END, ou.full_name,
               trim(st.first_name || ' ' || COALESCE(st.last_name,'')), m.body, json_array_length(m.attachments), '/go/messages?box=parents', m.id
          FROM parent_teacher_messages m JOIN users su ON su.id = m.sender_user_id
          JOIN users ou ON ou.id = CASE WHEN m.sender_user_id = m.parent_user_id THEN m.teacher_user_id ELSE m.parent_user_id END
          LEFT JOIN students st ON st.id = m.student_id
        UNION ALL
        SELECT m.created_at, 'counselor_message', m.sender_id, COALESCE(su.full_name, 'Unknown'), fam.user_id, COALESCE(fam.names, 'the family'),
               trim(st.first_name || ' ' || COALESCE(st.last_name,'')), COALESCE(t.subject, '') || ': ' || m.body, json_array_length(m.attachments), '/go/counselor_channel', m.id
          FROM counselor_messages m JOIN counselor_threads t ON t.id = m.thread_id LEFT JOIN users su ON su.id = m.sender_id
          LEFT JOIN students st ON st.id = t.student_id LEFT JOIN fam ON fam.student_id = t.student_id
        UNION ALL
        SELECT rm.created_at, 'remark', rm.recorded_by, COALESCE(ru.full_name, 'Unknown'), fam.user_id, COALESCE(fam.names, 'the family'),
               trim(st.first_name || ' ' || COALESCE(st.last_name,'')), rm.kind || ': ' || rm.body, 0, '/go/remarks', rm.id
          FROM student_remarks rm LEFT JOIN users ru ON ru.id = rm.recorded_by LEFT JOIN students st ON st.id = rm.student_id LEFT JOIN fam ON fam.student_id = rm.student_id
         WHERE rm.visible_to_family
        UNION ALL
        SELECT p.paid_on, 'payment', p.collected_by, COALESCE(cu.full_name, 'Office'), fam.user_id, COALESCE(fam.names, 'the family'),
               trim(st.first_name || ' ' || COALESCE(st.last_name,'')),
               'Receipt ' || COALESCE(p.receipt_no, '') || ' · ₹' || printf('%.2f', p.amount_paise / 100.0) || ' by ' || COALESCE(p.mode, ''), 0, '/go/fee_counter', p.id
          FROM payments p LEFT JOIN users cu ON cu.id = p.collected_by LEFT JOIN students st ON st.id = p.student_id LEFT JOIN fam ON fam.student_id = p.student_id
         WHERE p.status IN ('success', 'refunded')
      )
      SELECT src.at, src.kind, src.from_id, src.from_name, src.to_id, src.to_name, src.student_name, substr(src.summary, 1, 300) AS summary, src.files, src.link, src.ref
        FROM src
       WHERE src.at > datetime('now', '-' || ?1 || ' days')
         AND (?2 IS NULL OR src.from_id = ?2 OR src.to_id = ?2) AND (?3 IS NULL OR src.from_id = ?3 OR src.to_id = ?3)
         AND (?4 = '' OR src.kind = ?4)
         AND (?5 = '' OR src.summary LIKE ?6 ESCAPE '\\' OR src.from_name LIKE ?6 ESCAPE '\\' OR src.to_name LIKE ?6 ESCAPE '\\' OR src.student_name LIKE ?6 ESCAPE '\\')
       ORDER BY src.at DESC LIMIT ?7`).bind(String(days), a, b, kind, search, like(search), limit)
      .all<{ at: string; kind: string; from_id: string | null; from_name: string; to_id: string | null; to_name: string; student_name: string | null; summary: string; files: number; link: string; ref: string }>()
    return ok({ items: rows.results.map((v) => ({ at: v.at, kind: v.kind, from_id: v.from_id ?? undefined, from_name: v.from_name, to_id: v.to_id ?? undefined, to_name: v.to_name,
      student_name: v.student_name ?? undefined, summary: v.summary, files: v.files, link: v.link || undefined, ref_id: v.ref })) })
  })

  // session policies ---------------------------------------------------------------
  const DEFAULTS = (key: string): [number, number, number] => {
    switch (key) {
      case 'institution_admin': case 'principal': case 'vice_principal': case 'accounts': case 'accountant': case 'hr': case 'admin_office': return [12, 30, 2]
      case 'faculty': case 'teacher': case 'hod': case 'class_teacher': case 'librarian': case 'counselor': case 'transport': case 'nurse': return [30 * 24, 7 * 24 * 60, 2]
      case 'parent': case 'guardian': return [90 * 24, 30 * 24 * 60, 3]
      case 'student': return [8, 30, 1]
      case 'super_admin': case 'seller_admin': case 'support_admin': return [8, 15, 1]
      default: return [12, 120, 2]
    }
  }
  r.get('/admin/session-policies', 'access.roles.read', async (c) => {
    const rows = await c.db.prepare(`SELECT ro.key, ro.name, sp.absolute_hours, sp.idle_minutes, sp.max_devices FROM roles ro
        LEFT JOIN session_policies sp ON sp.role_key = ro.key AND sp.institution_id = ro.institution_id WHERE ro.institution_id IS NOT NULL ORDER BY ro.is_system DESC, ro.name`)
      .all<{ key: string; name: string; absolute_hours: number | null; idle_minutes: number | null; max_devices: number | null }>()
    return ok({ items: rows.results.map((v) => {
      const [h, i, d] = DEFAULTS(v.key)
      const over = v.absolute_hours !== null
      return { role_key: v.key, role_name: v.name, absolute_hours: over ? v.absolute_hours : h, idle_minutes: over ? v.idle_minutes : i, max_devices: over ? v.max_devices : d, overridden: over }
    }) })
  })
  r.put('/admin/session-policies/{role}', 'access.roles.write', async (c) => {
    const role = c.params.role
    const req = await readJSON<{ absolute_hours?: number; idle_minutes?: number; max_devices?: number; reset?: boolean }>(c.req)
    const inst = institutionId(c)
    if (!req.reset) {
      const h = req.absolute_hours ?? 0, i = req.idle_minutes ?? 0, d = req.max_devices ?? 0
      if (h < 1 || h > 24 * 180) throw badRequest('a session can live between 1 hour and 180 days')
      if (i < 5 || i > 60 * 24 * 60) throw badRequest('the idle limit is between 5 minutes and 60 days')
      if (d < 1 || d > 20) throw badRequest('between 1 and 20 devices')
    }
    const exists = await c.db.prepare(`SELECT 1 AS x FROM roles WHERE key = ? AND institution_id = ?`).bind(role, inst).first()
    if (!exists) throw notFound('resource not found')
    if (req.reset) await c.db.prepare(`DELETE FROM session_policies WHERE institution_id = ? AND role_key = ?`).bind(inst, role).run()
    else await c.db.prepare(`INSERT INTO session_policies (institution_id, role_key, absolute_hours, idle_minutes, max_devices, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id, role_key) DO UPDATE SET absolute_hours = excluded.absolute_hours, idle_minutes = excluded.idle_minutes, max_devices = excluded.max_devices, updated_at = excluded.updated_at`)
      .bind(inst, role, req.absolute_hours, req.idle_minutes, req.max_devices, now()).run()
    return ok({ role_key: role, saved: true })
  })
}
