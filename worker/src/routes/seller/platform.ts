import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, conflict, created, isUUID, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { tenantDb, type Institution } from '../../tenant'
import { requirePlatformAdmin } from './common'

/* Port of the vendor's platform desk under /seller: message_recharge.go
   (seller side), buy.go listSalesEnquiries, seller_crm.go, platform_log.go,
   platform_usage.go and platform_broadcast.go.

   Everything here is platform-level, so nothing touches c.db. Platform-wide
   tables (purchase_enquiries, purchase_enquiry_notes, platform_events,
   platform_costs, platform_broadcasts) live in CONTROL; people they refer to
   are platform_users. Message credit requests, balances and ledger entries are
   the school's own rows (requested_by is a tenant user), so they stay in each
   school's D1 and the seller's queue is the union over every school. */

const PERM = 'platform.tenants.write'

/** Every school on the platform, whichever status, as the Go queries joined institutions without a filter. */
async function allInstitutions(c: Ctx): Promise<Institution[]> {
  const rows = await c.env.CONTROL.prepare('SELECT * FROM institutions ORDER BY name').all<Institution>()
  return rows.results
}

/** The school's D1, or null when its binding is not deployed yet: one unprovisioned school must not blank the whole desk. */
function schoolDb(c: Ctx, inst: Institution): D1Database | null {
  try { return tenantDb(c.env, inst) } catch { return null }
}

/** 'YYYY-MM-DDTHH:MM' from an ISO timestamp, the shape to_char(..., 'YYYY-MM-DD"T"HH24:MI') gave. */
const minute = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 16) : null)

/** 'YYYY-MM-DD HH:MM' in Asia/Kolkata, as the notes list showed it. */
function kolkataMinute(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  const d = new Date(t.getTime() + 330 * 60_000)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

/* ── Recharges: schools asking for more messages ────────────────────────── */

interface RechargeRow {
  id: string; channel: string; messages: number; status: string; note: string | null; response: string | null
  requested_by: string | null; requested_at: string; granted: number | null; decided_at: string | null
}

function rechargeView(v: RechargeRow, school?: string) {
  return {
    id: v.id, channel: v.channel, messages: v.messages, status: v.status,
    ...(v.note != null ? { note: v.note } : {}),
    ...(v.response != null ? { response: v.response } : {}),
    ...(v.requested_by != null ? { requested_by: v.requested_by } : {}),
    requested_at: v.requested_at,
    ...(v.granted != null ? { granted: v.granted } : {}),
    ...(v.decided_at != null ? { decided_at: v.decided_at } : {}),
    ...(school ? { school } : {}),
  }
}

/* ── Sales pipeline ─────────────────────────────────────────────────────── */

const LEAD_STAGES = ['new', 'contacted', 'demo_booked', 'won', 'lost'] as const
const LEAD_MOVES: Record<string, string[]> = {
  new: ['contacted', 'lost'],
  contacted: ['demo_booked', 'won', 'lost'],
  demo_booked: ['won', 'lost', 'contacted'],
  won: ['contacted'],
  lost: ['new', 'contacted'],
}
const isStage = (s: string) => (LEAD_STAGES as readonly string[]).includes(s)
const canMove = (from: string, to: string) => (LEAD_MOVES[from] ?? []).includes(to)

/* ── Broadcast times ────────────────────────────────────────────────────── */

/** RFC3339, 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD'; the zoneless layouts are UTC as Go's time.Parse made them. */
function parseWhen(v: string | undefined): string | null | undefined {
  const s = (v ?? '').trim()
  if (s === '') return null
  let t: Date
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) t = new Date(s + 'T00:00:00Z')
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) t = new Date(s + ':00Z')
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) t = new Date(s)
  else return undefined
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString()
}

export function registerSellerPlatform(r: Router): void {
  /* --- the recharge queue -------------------------------------------- */

  r.get('/seller/recharges', PERM, async (c) => {
    requirePlatformAdmin(c)
    const out: Array<ReturnType<typeof rechargeView>> = []
    for (const inst of await allInstitutions(c)) {
      const db = schoolDb(c, inst)
      if (!db) continue
      const rows = await db.prepare(`
        SELECT q.id, q.channel, q.messages, q.status, q.note, q.response,
               u.full_name AS requested_by, q.requested_at, q.granted, q.decided_at
          FROM message_credit_requests q
          LEFT JOIN users u ON u.id = q.requested_by
         ORDER BY (q.status = 'pending') DESC, q.requested_at DESC
         LIMIT 200`).all<RechargeRow>()
      for (const v of rows.results) out.push(rechargeView(v, inst.name))
    }
    out.sort((a, b) => {
      const pa = a.status === 'pending' ? 1 : 0, pb = b.status === 'pending' ? 1 : 0
      if (pa !== pb) return pb - pa
      return b.requested_at.localeCompare(a.requested_at)
    })
    return ok({ items: out.slice(0, 200) })
  })

  r.post('/seller/recharges/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const reqID = uuidParam(c.params.id)
    const body = await readJSON<{ decision?: string; messages?: number | null; response?: string }>(c.req)
    if (body.decision !== 'grant' && body.decision !== 'decline') throw badRequest('decision must be grant or decline')
    const response = (body.response ?? '').trim()

    // The id alone does not say which school's database holds it.
    let found: { db: D1Database; inst: Institution; channel: string; messages: number } | null = null
    for (const inst of await allInstitutions(c)) {
      const db = schoolDb(c, inst)
      if (!db) continue
      const row = await db.prepare(`SELECT channel, messages FROM message_credit_requests WHERE id = ? AND status = 'pending'`)
        .bind(reqID).first<{ channel: string; messages: number }>()
      if (row) { found = { db, inst, ...row }; break }
    }
    if (!found) throw new HttpError(409, 'That request has already been dealt with.')

    let granted = 0
    if (body.decision === 'grant') {
      granted = found.messages
      if (typeof body.messages === 'number' && Number.isInteger(body.messages) && body.messages >= 0) granted = body.messages
    }
    const status = body.decision === 'decline' ? 'declined' : 'granted'
    const ts = now()
    const stillPending = `EXISTS (SELECT 1 FROM message_credit_requests WHERE id = ? AND status = 'pending')`
    const stmts: D1PreparedStatement[] = []
    if (body.decision === 'grant') {
      /* addCredits (message_credits.go): the balance row is made or raised and
         the ledger gets a line, in the same batch as the decision so a grant
         and its credits cannot part company. Each write is conditioned on the
         request still being pending, which is what FOR UPDATE guaranteed. */
      stmts.push(found.db.prepare(`
        INSERT INTO message_credits (institution_id, channel, balance, updated_at)
        SELECT ?, ?, ?, ? WHERE ${stillPending}
        ON CONFLICT (institution_id, channel) DO UPDATE
           SET balance = MAX(message_credits.balance + excluded.balance, 0), updated_at = excluded.updated_at`)
        .bind(found.inst.id, found.channel, Math.max(granted, 0), ts, reqID))
      if (granted !== 0) {
        stmts.push(found.db.prepare(`
          INSERT INTO message_credit_entries (id, institution_id, channel, delta, reason, actor_id, note, created_at)
          SELECT ?, ?, ?, ?, 'topup', NULL, NULLIF(?, ''), ? WHERE ${stillPending}`)
          .bind(uuid(), found.inst.id, found.channel, granted, response, ts, reqID))
      }
    }
    stmts.push(found.db.prepare(`
      UPDATE message_credit_requests
         SET status = ?, granted = ?, response = NULLIF(?, ''), decided_by = NULL, decided_at = ?
       WHERE id = ? AND status = 'pending'`).bind(status, granted, response, ts, reqID))
    const res = await found.db.batch(stmts)
    if ((res[res.length - 1].meta.changes ?? 0) === 0) throw new HttpError(409, 'That request has already been dealt with.')
    return ok({ ok: true })
  })

  /* --- the sales desk ------------------------------------------------ */

  r.get('/seller/enquiries', PERM, async (c) => {
    requirePlatformAdmin(c)
    const rows = await c.env.CONTROL.prepare(`
      SELECT e.id, e.school_name, e.contact_name, e.email, e.phone,
             e.district, e.students, e.plan_code, e.message, e.status, e.source,
             substr(e.created_at, 1, 10) AS created_at,
             (e.provisioned_institution_id IS NOT NULL) AS provisioned,
             u.full_name AS owner, e.owner_user_id, e.next_follow_up,
             e.lost_reason, e.value_paise,
             (SELECT COUNT(*) FROM purchase_enquiry_notes n WHERE n.enquiry_id = e.id) AS notes
        FROM purchase_enquiries e
        LEFT JOIN platform_users u ON u.id = e.owner_user_id
       ORDER BY (e.next_follow_up IS NULL), e.next_follow_up, e.created_at DESC
       LIMIT 200`).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const o: Record<string, unknown> = {
        id: v.id, school_name: v.school_name, contact_name: v.contact_name,
      }
      for (const k of ['email', 'phone', 'district', 'students', 'plan_code', 'message'] as const) if (v[k] != null) o[k] = v[k]
      o.status = v.status; o.source = v.source; o.created_at = v.created_at; o.provisioned = bool(v.provisioned)
      if (v.owner != null) o.owner = v.owner
      if (v.owner_user_id != null) o.owner_user_id = v.owner_user_id
      if (v.next_follow_up != null) o.next_follow_up = String(v.next_follow_up).slice(0, 10)
      if (v.lost_reason != null) o.lost_reason = v.lost_reason
      if (v.value_paise != null) o.value_paise = v.value_paise
      o.notes = v.notes ?? 0
      return o
    })
    return ok({ items })
  })

  r.get('/seller/enquiries/pipeline', PERM, async (c) => {
    requirePlatformAdmin(c)
    const [counts, work] = await Promise.all([
      c.env.CONTROL.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(value_paise), 0) AS v FROM purchase_enquiries GROUP BY status`)
        .all<{ status: string; n: number; v: number }>(),
      c.env.CONTROL.prepare(`
        SELECT SUM(next_follow_up = date('now')) AS due_today,
               SUM(next_follow_up < date('now')) AS overdue,
               SUM(owner_user_id IS NULL) AS unowned
          FROM purchase_enquiries WHERE status NOT IN ('won','lost')`)
        .first<{ due_today: number | null; overdue: number | null; unowned: number | null }>(),
    ])
    const by = new Map(counts.results.map((r) => [r.status, r]))
    // Every stage, including the empty ones, in pipeline order.
    const stages = LEAD_STAGES.map((stage) => ({ stage, count: by.get(stage)?.n ?? 0, value_paise: by.get(stage)?.v ?? 0 }))
    return ok({ stages, due_today: work?.due_today ?? 0, overdue: work?.overdue ?? 0, unowned: work?.unowned ?? 0 })
  })

  r.get('/seller/enquiries/{id}/notes', PERM, async (c) => {
    requirePlatformAdmin(c)
    const leadID = c.params.id
    if (!isUUID(leadID)) throw badRequest('invalid lead id')
    const rows = await c.env.CONTROL.prepare(`
      SELECT n.kind, n.body, u.full_name AS author, n.created_at
        FROM purchase_enquiry_notes n
        LEFT JOIN platform_users u ON u.id = n.author_id
       WHERE n.enquiry_id = ?
       ORDER BY n.created_at DESC
       LIMIT 200`).bind(leadID).all<{ kind: string; body: string; author: string | null; created_at: string }>()
    return ok({ items: rows.results.map((v) => ({ kind: v.kind, body: v.body, ...(v.author != null ? { author: v.author } : {}), at: kolkataMinute(v.created_at) })) })
  })

  r.put('/seller/enquiries/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const leadID = c.params.id
    if (!isUUID(leadID)) throw badRequest('invalid lead id')
    const req = await readJSON<{
      from?: string; status?: string; owner_user_id?: string | null; next_follow_up?: string | null
      lost_reason?: string; value_paise?: number | null; note?: string
    }>(c.req)
    const status = (req.status ?? '').trim()
    const from = (req.from ?? '').trim()
    const lostReason = (req.lost_reason ?? '').trim()
    const note = (req.note ?? '').trim()
    const moving = status !== '' && status !== from

    if (moving) {
      if (!isStage(status) || (from !== '' && !isStage(from))) throw badRequest('stage must be one of new, contacted, demo_booked, won, lost')
      if (from === '') throw badRequest('from is required when changing the stage')
      if (!canMove(from, status)) throw badRequest(`a lead cannot go from ${from} to ${status}`)
      if (status === 'lost' && lostReason === '' && note === '') throw badRequest('say why it was lost -- a reason or a note')
    }

    const hasOwner = req.owner_user_id !== undefined
    let owner: string | null = null
    if (req.owner_user_id != null && req.owner_user_id.trim() !== '') {
      owner = req.owner_user_id.trim()
      if (!isUUID(owner)) throw badRequest('owner_user_id must be a uuid')
    }
    const hasFollow = req.next_follow_up !== undefined
    let follow: string | null = null
    if (req.next_follow_up != null && req.next_follow_up.trim() !== '') {
      follow = req.next_follow_up.trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(follow) || Number.isNaN(new Date(follow + 'T00:00:00Z').getTime())) throw badRequest('next_follow_up must be YYYY-MM-DD')
    }
    const hasValue = req.value_paise !== undefined
    const value = req.value_paise ?? null

    const ts = now()
    /* The guard: status = from in the WHERE settles two people pressing at
       once. Every later statement is conditioned on that update having landed
       (status and the timestamp it stamped), so a raced request writes nothing,
       as the rolled-back transaction did. */
    const landed = moving ? `AND EXISTS (SELECT 1 FROM purchase_enquiries WHERE id = ? AND status = ? AND updated_at = ?)` : ''
    const landedArgs = moving ? [leadID, status, ts] : []
    const stmts: D1PreparedStatement[] = []
    if (moving) {
      stmts.push(c.env.CONTROL.prepare(`
        UPDATE purchase_enquiries
           SET status = ?, lost_reason = CASE WHEN ? = 'lost' THEN NULLIF(?, '') ELSE lost_reason END, updated_at = ?
         WHERE id = ? AND status = ?`).bind(status, status, lostReason, ts, leadID, from))
      stmts.push(c.env.CONTROL.prepare(`
        INSERT INTO purchase_enquiry_notes (id, enquiry_id, kind, body, author_id, created_at)
        SELECT ?, ?, 'stage', ?, ?, ? WHERE 1 ${landed}`).bind(uuid(), leadID, `${from} -> ${status}`, c.id.userId, ts, ...landedArgs))
    }
    if (hasOwner || hasFollow || hasValue) {
      stmts.push(c.env.CONTROL.prepare(`
        UPDATE purchase_enquiries
           SET owner_user_id  = CASE WHEN ? THEN ? ELSE owner_user_id END,
               next_follow_up = CASE WHEN ? THEN ? ELSE next_follow_up END,
               value_paise    = CASE WHEN ? THEN ? ELSE value_paise END,
               updated_at = ?
         WHERE id = ? ${landed}`).bind(hasOwner ? 1 : 0, owner, hasFollow ? 1 : 0, follow, hasValue ? 1 : 0, value, ts, leadID, ...landedArgs))
    }
    if (note !== '') {
      stmts.push(c.env.CONTROL.prepare(`
        INSERT INTO purchase_enquiry_notes (id, enquiry_id, kind, body, author_id, created_at)
        SELECT ?, ?, 'note', ?, ?, ? WHERE 1 ${landed}`).bind(uuid(), leadID, note, c.id.userId, ts, ...landedArgs))
    }
    if (stmts.length) {
      const res = await c.env.CONTROL.batch(stmts)
      if (moving && (res[0].meta.changes ?? 0) === 0) {
        throw new HttpError(409, `this lead is no longer in ${from} -- reload to see where it is`)
      }
    }
    return ok({ ok: true })
  })

  /* --- the provisioning and error log -------------------------------- */

  r.get('/seller/events', PERM, async (c) => {
    requirePlatformAdmin(c)
    const onlyFailures = c.url.searchParams.get('failures') === '1'
    const rows = await c.env.CONTROL.prepare(`
      SELECT e.id, e.kind, e.ok, i.name AS school, e.subject, e.detail, u.full_name AS actor, e.at
        FROM platform_events e
        LEFT JOIN institutions i ON i.id = e.institution_id
        LEFT JOIN platform_users u ON u.id = e.actor_id
       WHERE (? = 0 OR e.ok = 0)
       ORDER BY e.at DESC
       LIMIT 200`).bind(onlyFailures ? 1 : 0)
      .all<{ id: string; kind: string; ok: number; school: string | null; subject: string; detail: string; actor: string | null; at: string }>()
    let failures = 0
    const items = rows.results.map((v) => {
      const okv = bool(v.ok)
      if (!okv) failures++
      return {
        id: v.id, kind: v.kind, ok: okv,
        ...(v.school != null ? { school: v.school } : {}),
        subject: v.subject,
        ...(v.detail ? { detail: v.detail } : {}),
        ...(v.actor != null ? { actor: v.actor } : {}),
        at: minute(v.at),
      }
    })
    return ok({ items, failures })
  })

  /* --- usage against costs ------------------------------------------- */

  r.get('/seller/usage', PERM, async (c) => {
    requirePlatformAdmin(c)
    const costRow = await c.env.CONTROL.prepare(`
      SELECT c.infra_paise, c.storage_paise_per_gb, c.sms_paise, c.email_paise, c.whatsapp_paise, c.notes, c.updated_at,
             COALESCE((SELECT full_name FROM platform_users u WHERE u.id = c.updated_by), '') AS updated_by
        FROM platform_costs c WHERE c.id = 1`)
      .first<{ infra_paise: number; storage_paise_per_gb: number; sms_paise: number; email_paise: number; whatsapp_paise: number; notes: string; updated_at: string; updated_by: string }>()
    const costs = {
      infra_paise: costRow?.infra_paise ?? 0,
      storage_paise_per_gb: costRow?.storage_paise_per_gb ?? 0,
      sms_paise: costRow?.sms_paise ?? 0,
      email_paise: costRow?.email_paise ?? 0,
      whatsapp_paise: costRow?.whatsapp_paise ?? 0,
      ...(costRow?.notes ? { notes: costRow.notes } : {}),
      ...(costRow?.updated_at ? { updated_at: minute(costRow.updated_at) } : {}),
      ...(costRow?.updated_by ? { updated_by: costRow.updated_by } : {}),
    }

    interface Usage {
      institution_id: string; school: string; status: string; students: number; staff: number
      stored_bytes: number; file_count: number; rows: number; messages: number
      share_pct: number; infra_paise: number; storage_paise: number; cost_paise: number; revenue_paise: number; margin_paise: number
    }
    const blank = (id: string, school: string, status: string): Usage => ({
      institution_id: id, school, status, students: 0, staff: 0, stored_bytes: 0, file_count: 0, rows: 0, messages: 0,
      share_pct: 0, infra_paise: 0, storage_paise: 0, cost_paise: 0, revenue_paise: 0, margin_paise: 0,
    })

    /* One pass per school over the things that actually grow; with a
       database per school the pass is one query in each school's D1. */
    const items: Usage[] = []
    for (const inst of await allInstitutions(c)) {
      const it = blank(inst.id, inst.name, inst.status)
      const db = schoolDb(c, inst)
      if (db) {
        const u = await db.prepare(`
          SELECT (SELECT COUNT(*) FROM students WHERE status = 'active') AS students,
                 (SELECT COUNT(*) FROM employees WHERE status = 'active') AS staff,
                 COALESCE((SELECT SUM(size_bytes) FROM files WHERE deleted_at IS NULL), 0) AS stored_bytes,
                 (SELECT COUNT(*) FROM files WHERE deleted_at IS NULL) AS file_count,
                 (SELECT COUNT(*) FROM student_attendance) + (SELECT COUNT(*) FROM marks)
                 + (SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM notifications) AS rows_n,
                 (SELECT COUNT(*) FROM message_log) AS messages`)
          .first<{ students: number; staff: number; stored_bytes: number; file_count: number; rows_n: number; messages: number }>()
        if (u) {
          it.students = u.students; it.staff = u.staff; it.stored_bytes = u.stored_bytes
          it.file_count = u.file_count; it.rows = u.rows_n; it.messages = u.messages
        }
      }
      items.push(it)
    }

    // The allocation: by roll, with a floor of one so a new school divides by nothing.
    let totalRoll = 0
    for (const it of items) totalRoll += Math.max(it.students, 1)
    const bytesPerGB = 1024 * 1024 * 1024
    const totals = blank('', 'All schools', '')
    for (const it of items) {
      const share = Math.max(it.students, 1) / Math.max(totalRoll, 1)
      it.share_pct = share * 100
      it.infra_paise = Math.trunc(costs.infra_paise * share)
      it.storage_paise = Math.trunc((it.stored_bytes * costs.storage_paise_per_gb) / bytesPerGB)
      it.cost_paise = it.infra_paise + it.storage_paise
      totals.students += it.students; totals.staff += it.staff; totals.stored_bytes += it.stored_bytes
      totals.file_count += it.file_count; totals.rows += it.rows; totals.messages += it.messages
      totals.cost_paise += it.cost_paise; totals.storage_paise += it.storage_paise; totals.infra_paise += it.infra_paise
    }

    return ok({
      costs, items, totals,
      not_measured: 'CPU, memory and bandwidth are not attributed per school: ' +
        'one process serves every tenant and nothing tags a request with the school ' +
        'it was for. The fixed monthly bill below is therefore apportioned by roll, ' +
        'not measured. It is an allocation, and a school doing nothing this month ' +
        'still carries its share.',
    })
  })

  r.put('/seller/costs', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ infra_paise?: number; storage_paise_per_gb?: number; sms_paise?: number; email_paise?: number; whatsapp_paise?: number; notes?: string }>(c.req)
    const vals = [req.infra_paise ?? 0, req.storage_paise_per_gb ?? 0, req.sms_paise ?? 0, req.email_paise ?? 0, req.whatsapp_paise ?? 0]
    for (const v of vals) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest('costs must be numbers')
      if (v < 0) throw badRequest('costs cannot be negative')
    }
    // One row, id = 1; made if the seed is missing, else replaced.
    await c.env.CONTROL.prepare(`
      INSERT INTO platform_costs (id, infra_paise, storage_paise_per_gb, sms_paise, email_paise, whatsapp_paise, notes, updated_by, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE
         SET infra_paise = excluded.infra_paise, storage_paise_per_gb = excluded.storage_paise_per_gb,
             sms_paise = excluded.sms_paise, email_paise = excluded.email_paise, whatsapp_paise = excluded.whatsapp_paise,
             notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(...vals.map(Math.trunc), req.notes ?? '', c.id.userId, now()).run()
    return ok({ saved: true })
  })

  /* --- one notice to every school ------------------------------------ */

  r.get('/seller/broadcasts', PERM, async (c) => {
    requirePlatformAdmin(c)
    const ts = now()
    const rows = await c.env.CONTROL.prepare(`
      SELECT b.id, b.severity, b.title, b.body, b.starts_at, b.ends_at, u.full_name AS created_by,
             (b.retired_at IS NULL AND b.starts_at <= ? AND (b.ends_at IS NULL OR b.ends_at > ?)) AS live
        FROM platform_broadcasts b
        LEFT JOIN platform_users u ON u.id = b.created_by
       ORDER BY b.starts_at DESC
       LIMIT 100`).bind(ts, ts)
      .all<{ id: string; severity: string; title: string; body: string; starts_at: string; ends_at: string | null; created_by: string | null; live: number }>()
    const items = rows.results.map((v) => ({
      id: v.id, severity: v.severity, title: v.title,
      ...(v.body ? { body: v.body } : {}),
      starts_at: minute(v.starts_at),
      ...(v.ends_at != null ? { ends_at: minute(v.ends_at) } : {}),
      ...(v.created_by != null ? { created_by: v.created_by } : {}),
      live: bool(v.live),
    }))
    return ok({ items })
  })

  r.post('/seller/broadcasts', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ severity?: string; title?: string; body?: string; starts_at?: string; ends_at?: string }>(c.req)
    const title = (req.title ?? '').trim()
    if (title === '') throw badRequest('a notice needs a title. It is the only part most people read')
    let severity = req.severity ?? ''
    if (severity === '' || severity === 'info') severity = 'info'
    else if (severity !== 'warning' && severity !== 'critical') throw badRequest('severity must be info, warning or critical')

    const startsAt = parseWhen(req.starts_at)
    if (startsAt === undefined) throw badRequest('starts_at must be a date and time')
    const endsAt = parseWhen(req.ends_at)
    if (endsAt === undefined) throw badRequest('ends_at must be a date and time')
    const ts = now()
    const starts = startsAt ?? ts
    // platform_broadcasts_window_check, done here since SQLite has no CHECK to name.
    if (endsAt !== null && endsAt <= starts) throw badRequest('that notice ends before it starts, so nobody would ever see it')

    const id = uuid()
    await c.env.CONTROL.prepare(`
      INSERT INTO platform_broadcasts (id, severity, title, body, starts_at, ends_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, severity, title, (req.body ?? '').trim(), starts, endsAt, c.id.userId, ts).run()
    return created({ id })
  })

  r.del('/seller/broadcasts/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const bid = c.params.id
    if (!isUUID(bid)) throw badRequest('invalid broadcast id')
    // Retired, not deleted: "which schools were told, and when" is asked afterwards.
    const res = await c.env.CONTROL.prepare(`UPDATE platform_broadcasts SET retired_at = ? WHERE id = ? AND retired_at IS NULL`)
      .bind(now(), bid).run()
    if ((res.meta.changes ?? 0) === 0) throw conflict('that notice is already down, or there is no such notice')
    return ok({ retired: true })
  })
}
