import type { Ctx, Router } from '../../router'
import { Messenger, MessagingError, scopeOf } from '../../services/messaging'
import { sendAtFor } from '../../services/message_rules'
import { HttpError, badRequest, bool, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { IST, allowsValue, initcap, isUUIDish, isUniqueViolation, istDate, istMinute, notImplemented, nz, optionsForKind, placeholders, js, resolveRange, round2, str, todayIST, truncate } from './util'

/* Port of admissions_growth.go sections 2 and 3: multi-touch campaign
   sequences and the lost-lead reason analysis. */

const READ = 'admissions.read', WRITE = 'admissions.write'
const channels = ['email', 'sms', 'whatsapp', 'in_app']

const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}
const optionalUUID = (raw: unknown, name: string): string | null => {
  const v = str(raw).trim()
  if (v === '') return null
  if (!isUUIDish(v)) throw badRequest(`${name} must be a uuid`)
  return v
}

/** stopEnrolment: close an enrolment and cancel everything still pending. Returns the statements; the caller batches them. */
export function stopEnrolmentStmts(db: D1Database, enrolID: string, reason: string): D1PreparedStatement[] {
  const t = now()
  return [
    db.prepare(`UPDATE admission_campaign_enrolments SET status = 'stopped', stopped_at = ?, stopped_reason = ? WHERE id = ? AND status = 'active'`).bind(t, truncate(reason, 200), enrolID),
    db.prepare(`UPDATE admission_campaign_sends SET status = 'skipped', note = ? WHERE enrolment_id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM admission_campaign_enrolments e WHERE e.id = ? AND e.status = 'stopped' AND e.stopped_at = ?)`).bind(truncate(reason, 200), enrolID, enrolID, t),
  ]
}

export async function stopEnrolmentsForLead(db: D1Database, leadID: string, reason: string): Promise<D1PreparedStatement[]> {
  const rows = await db.prepare(`SELECT id FROM admission_campaign_enrolments WHERE enquiry_id = ? AND status = 'active'`).bind(leadID).all<{ id: string }>()
  return rows.results.flatMap((e) => stopEnrolmentStmts(db, e.id, reason))
}

export function registerAdmissionCampaigns(r: Router) {
  r.get('/admissions/campaigns', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT c.id, c.name, c.description, c.is_active, c.auto_enrol_source AS auto_enrol_source,
             (SELECT count(*) FROM admission_campaign_steps st WHERE st.campaign_id = c.id) AS steps,
             (SELECT count(*) FROM admission_campaign_enrolments e WHERE e.campaign_id = c.id AND e.status = 'active') AS active_leads,
             (SELECT count(*) FROM admission_campaign_enrolments e WHERE e.campaign_id = c.id AND e.status = 'stopped') AS stopped_leads,
             (SELECT count(*) FROM admission_campaign_sends sn JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id WHERE e.campaign_id = c.id AND sn.status = 'queued') AS messages_queued,
             (SELECT count(*) FROM admission_campaign_sends sn JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id WHERE e.campaign_id = c.id AND sn.status = 'pending' AND sn.due_at <= ?) AS touches_due
        FROM admission_campaigns c ORDER BY c.is_active DESC, lower(c.name)`).bind(now()).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_active: bool(v.is_active) })) })
  })

  r.post('/admissions/campaigns', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const name = str(req.name).trim()
    if (name === '') throw badRequest('the sequence needs a name')
    const cid = optionalUUID(req.id, 'id')
    try {
      if (cid) {
        const res = await c.db.prepare(`UPDATE admission_campaigns SET name = ?, description = NULLIF(?,''), is_active = ?, auto_enrol_source = NULLIF(?,''), updated_at = ? WHERE id = ?`)
          .bind(name, str(req.description), req.is_active ? 1 : 0, str(req.auto_enrol_source), now(), cid).run()
        if (res.meta.changes === 0) throw notFound()
        return ok({ id: cid })
      }
      const id = uuid(), t = now()
      await c.db.prepare(`INSERT INTO admission_campaigns (id, institution_id, name, description, is_active, auto_enrol_source, created_by, created_at, updated_at)
        VALUES (?,?,?,NULLIF(?,''),?,NULLIF(?,''),?,?,?)`)
        .bind(id, c.id.institution!.id, name, str(req.description), req.is_active ? 1 : 0, str(req.auto_enrol_source), c.id.userId, t, t).run()
      return ok({ id })
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'a sequence with that name already exists', { code: 'duplicate' })
      throw e
    }
  })

  r.get('/admissions/campaigns/outbox', READ, async (c) => {
    const status = (c.url.searchParams.get('status') ?? '').trim()
    const rows = await c.db.prepare(`
      SELECT sn.id, c.name AS campaign, st.name AS step, q.student_name, q.phone, st.channel,
             ${istMinute('sn.due_at')} AS due_at, sn.status, sn.note
        FROM admission_campaign_sends sn
        JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id
        JOIN admission_campaigns c ON c.id = e.campaign_id
        JOIN admission_campaign_steps st ON st.id = sn.step_id
        JOIN enquiries q ON q.id = e.enquiry_id
       WHERE (? IS NULL OR sn.status = ?)
       ORDER BY sn.due_at DESC LIMIT 300`).bind(nz(status), nz(status)).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/admissions/campaigns/run', WRITE, async (c) => ok(await runCampaigns(c)))

  r.get('/admissions/campaigns/{id}/steps', READ, async (c) => {
    const cid = uuidParam(c.params.id)
    const rows = await c.db.prepare(`
      SELECT st.id, st.step_no, st.name, st.offset_days, st.channel, st.template_code, st.quiet_from, st.quiet_to, st.is_active,
             (SELECT count(*) FROM admission_campaign_sends sn WHERE sn.step_id = st.id AND sn.status = 'queued') AS queued,
             (SELECT count(*) FROM admission_campaign_sends sn WHERE sn.step_id = st.id AND sn.status IN ('skipped','failed')) AS skipped
        FROM admission_campaign_steps st WHERE st.campaign_id = ? ORDER BY st.step_no`).bind(cid).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, is_active: bool(v.is_active) })) })
  })

  r.post('/admissions/campaigns/{id}/steps', WRITE, async (c) => {
    const cid = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const name = str(req.name).trim(), template = str(req.template_code).trim()
    if (name === '' || template === '') throw badRequest('a touch needs a name and a message template code')
    const channel = str(req.channel)
    if (!channels.includes(channel)) throw badRequest('channel must be one of sms, email, whatsapp, push, in_app')
    const stepNo = typeof req.step_no === 'number' ? req.step_no : 0
    if (stepNo < 1 || stepNo > 50) throw badRequest('step_no must be between 1 and 50')
    const offset = typeof req.offset_days === 'number' ? req.offset_days : 0
    if (offset < 0 || offset > 365) throw badRequest('offset_days must be between 0 and 365')
    const qf = str(req.quiet_from), qt = str(req.quiet_to)
    if ((qf === '') !== (qt === '')) throw badRequest('set both ends of the quiet window or neither. A half-set window is one the author thinks they set')
    const stepID = optionalUUID(req.id, 'id')
    try {
      if (stepID) {
        const res = await c.db.prepare(`UPDATE admission_campaign_steps SET step_no = ?, name = ?, offset_days = ?, channel = ?, template_code = ?, quiet_from = NULLIF(?,''), quiet_to = NULLIF(?,''), is_active = ?
          WHERE id = ? AND campaign_id = ?`).bind(stepNo, name, offset, channel, template, qf, qt, req.is_active ? 1 : 0, stepID, cid).run()
        if (res.meta.changes === 0) throw notFound()
        return ok({ id: stepID })
      }
      const camp = await c.db.prepare(`SELECT institution_id FROM admission_campaigns WHERE id = ?`).bind(cid).first<{ institution_id: string }>()
      if (!camp) throw notFound()
      const id = uuid()
      await c.db.prepare(`INSERT INTO admission_campaign_steps (id, institution_id, campaign_id, step_no, name, offset_days, channel, template_code, quiet_from, quiet_to, is_active)
        VALUES (?,?,?,?,?,?,?,?,NULLIF(?,''),NULLIF(?,''),?)`).bind(id, camp.institution_id, cid, stepNo, name, offset, channel, template, qf, qt, req.is_active ? 1 : 0).run()
      return ok({ id })
    } catch (e) {
      if (e instanceof HttpError) throw e
      if (isUniqueViolation(e)) throw new HttpError(409, 'this sequence already has a touch numbered that', { code: 'duplicate' })
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
  })

  r.del('/admissions/campaign-steps/{id}', WRITE, async (c) => {
    const stepID = uuidParam(c.params.id)
    const queued = await c.db.prepare(`SELECT count(*) AS n FROM admission_campaign_sends WHERE step_id = ? AND status = 'queued'`).bind(stepID).first<{ n: number }>()
    const res = (queued?.n ?? 0) > 0
      ? await c.db.prepare(`UPDATE admission_campaign_steps SET is_active = 0 WHERE id = ?`).bind(stepID).run()
      : await c.db.prepare(`DELETE FROM admission_campaign_steps WHERE id = ?`).bind(stepID).run()
    if (res.meta.changes === 0) throw notFound()
    return ok({ id: stepID })
  })

  r.get('/admissions/campaigns/{id}/enrolments', READ, async (c) => {
    const cid = uuidParam(c.params.id)
    const rows = await c.db.prepare(`
      SELECT e.id, e.enquiry_id, q.student_name, q.parent_name, q.phone, q.status AS lead_status, e.status,
             ${istDate('e.enrolled_at')} AS enrolled_at, ${istDate('e.stopped_at')} AS stopped_at, e.stopped_reason,
             (SELECT count(*) FROM admission_campaign_sends sn WHERE sn.enrolment_id = e.id AND sn.status = 'queued') AS touches_done,
             (SELECT count(*) FROM admission_campaign_sends sn WHERE sn.enrolment_id = e.id AND sn.status = 'pending') AS touches_remaining,
             date((SELECT min(sn.due_at) FROM admission_campaign_sends sn WHERE sn.enrolment_id = e.id AND sn.status = 'pending'), ${IST}) AS next_due
        FROM admission_campaign_enrolments e JOIN enquiries q ON q.id = e.enquiry_id
       WHERE e.campaign_id = ? ORDER BY e.status, e.enrolled_at DESC LIMIT 500`).bind(cid).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/admissions/campaigns/{id}/enrol', WRITE, async (c) => {
    const cid = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const rawIds = Array.isArray(req.enquiry_ids) ? (req.enquiry_ids as unknown[]) : []
    const source = str(req.source).trim()
    if (rawIds.length === 0 && source === '') throw badRequest('name the leads to enrol, or a source to sweep')
    const ids: string[] = []
    for (const raw of rawIds) {
      const v = str(raw).trim()
      if (!isUUIDish(v)) throw badRequest('enquiry_ids must all be uuids')
      ids.push(v)
    }
    const camp = await c.db.prepare(`SELECT institution_id, is_active FROM admission_campaigns WHERE id = ?`).bind(cid).first<{ institution_id: string; is_active: number }>()
    if (!camp) throw notFound()
    if (!camp.is_active) throw badRequest('this sequence is paused. Activate it before enrolling anyone')
    const steps = await c.db.prepare(`SELECT id, offset_days FROM admission_campaign_steps WHERE campaign_id = ? AND is_active = 1 ORDER BY step_no`).bind(cid).all<{ id: string; offset_days: number }>()
    if (steps.results.length === 0) throw badRequest('this sequence has no touches yet. Add at least one before enrolling anyone')

    const where = [`status NOT IN ('applied','lost')`, `marketing_opt_out = 0`]
    const args: unknown[] = []
    if (ids.length > 0) { where.push(`id IN (${placeholders(ids.length)})`); args.push(js(ids)) }
    if (source !== '') { where.push(`source = ?`); args.push(source) }
    const leads = await c.db.prepare(`SELECT id FROM enquiries WHERE ${where.join(' AND ')}`).bind(...args).all<{ id: string }>()
    const already = await c.db.prepare(`SELECT enquiry_id FROM admission_campaign_enrolments WHERE campaign_id = ?`).bind(cid).all<{ enquiry_id: string }>()
    const have = new Set(already.results.map((x) => x.enquiry_id))
    let enrolled = 0, alreadyN = 0
    const stmts: D1PreparedStatement[] = []
    const t = now()
    for (const lead of leads.results) {
      if (have.has(lead.id)) { alreadyN++; continue }
      const enrolID = uuid()
      stmts.push(c.db.prepare(`INSERT INTO admission_campaign_enrolments (id, institution_id, campaign_id, enquiry_id, enrolled_at, enrolled_by, status) VALUES (?,?,?,?,?,?,'active')`)
        .bind(enrolID, camp.institution_id, cid, lead.id, t, c.id.userId))
      // The schedule is written at enrolment: due_at = enrolled_at + offset days.
      for (const st of steps.results) {
        const due = new Date(Date.parse(t) + st.offset_days * 86_400_000).toISOString()
        stmts.push(c.db.prepare(`INSERT OR IGNORE INTO admission_campaign_sends (id, institution_id, enrolment_id, step_id, due_at, status) VALUES (?,?,?,?,?,'pending')`)
          .bind(uuid(), camp.institution_id, enrolID, st.id, due))
      }
      enrolled++
    }
    if (stmts.length > 0) await c.db.batch(stmts)
    return ok({ enrolled, already_enrolled: alreadyN })
  })

  r.post('/admissions/campaign-enrolments/{id}/stop', WRITE, async (c) => {
    const enrolID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    let reason = str(req.reason).trim()
    if (reason === '') reason = 'stopped by the office'
    const res = await c.db.batch(stopEnrolmentStmts(c.db, enrolID, reason))
    if ((res[0]?.meta.changes ?? 0) === 0) throw notFound()
    return ok({ id: enrolID, status: 'stopped' })
  })

  // --- lost lead reason analysis ----------------------------------------------------

  r.get('/admissions/lost-leads/reasons', READ, async (c) => ok({ items: await optionsForKind(c.db, 'lost_reason') }))

  r.get('/admissions/lost-leads/analysis', READ, async (c) => {
    const by = (c.url.searchParams.get('by') ?? '').trim() || 'reason'
    const reasonLabel = `COALESCE(NULLIF(co.label,''), REPLACE(COALESCE(e.lost_reason,'Not recorded'),'_',' '))`
    let groupSQL: string
    switch (by) {
      case 'reason': groupSQL = reasonLabel; break
      case 'class': groupSQL = `COALESCE(c.name, 'Not stated')`; break
      case 'source': groupSQL = `COALESCE(NULLIF(TRIM(e.source),''), 'Not recorded')`; break
      case 'counsellor': groupSQL = `COALESCE(u.full_name, 'Unassigned')`; break
      case 'month': groupSQL = `strftime('%Y-%m', e.created_at, ${IST})`; break
      case 'lost_month': groupSQL = `COALESCE(strftime('%Y-%m', e.lost_month), 'Not dated')`; break
      default: throw badRequest('by must be one of reason, class, source, counsellor, month, lost_month')
    }
    const rng = resolveRange(c.url.searchParams)
    const rows = await c.db.prepare(`
      WITH scoped AS (
        SELECT e.status, e.lost_reason, ${reasonLabel} AS reason_label, ${groupSQL} AS grp
          FROM enquiries e
          LEFT JOIN classes c ON c.id = e.class_sought
          LEFT JOIN users u ON u.id = e.assigned_to
          LEFT JOIN custom_options co ON co.kind = 'lost_reason' AND co.value = e.lost_reason AND co.institution_id = e.institution_id
         WHERE ${istDate('e.created_at')} BETWEEN ? AND ?)
      SELECT s.grp AS "group",
             SUM(CASE WHEN s.status = 'lost' THEN 1 ELSE 0 END) AS lost,
             count(*) AS total,
             (SELECT x.reason_label FROM scoped x WHERE x.status = 'lost' AND x.grp IS s.grp GROUP BY x.reason_label ORDER BY count(*) DESC, x.reason_label LIMIT 1) AS top_reason,
             COALESCE((SELECT count(*) FROM scoped x WHERE x.status = 'lost' AND x.grp IS s.grp GROUP BY x.reason_label ORDER BY count(*) DESC, x.reason_label LIMIT 1), 0) AS top_reason_count
        FROM scoped s GROUP BY s.grp HAVING SUM(CASE WHEN s.status = 'lost' THEN 1 ELSE 0 END) > 0
       ORDER BY lost DESC, s.grp`).bind(rng.from, rng.to).all<{ group: string; lost: number; total: number; top_reason: string | null; top_reason_count: number }>()
    return ok({ items: rows.results.map((v) => {
      const out: Record<string, unknown> = { group: by === 'reason' ? initcap(v.group) : v.group, lost: v.lost, total: v.total }
      if (v.total >= 5 && by !== 'lost_month') out.share_percent = round2(100 * v.lost / v.total)
      if (v.top_reason !== null) out.top_reason = initcap(v.top_reason)
      if (v.top_reason_count) out.top_reason_count = v.top_reason_count
      return out
    }) })
  })

  r.get('/admissions/lost-leads', READ, async (c) => {
    const q = c.url.searchParams
    const rng = resolveRange(q)
    const rows = await c.db.prepare(`
      SELECT e.id, e.student_name, e.parent_name, c.name AS class_sought, e.source, u.full_name AS counsellor, e.lost_reason AS reason,
             COALESCE(NULLIF(co.label,''), REPLACE(COALESCE(e.lost_reason,'not recorded'),'_',' ')) AS reason_label,
             e.lost_reason_note AS note, ${istDate('e.lost_at')} AS lost_on,
             MAX(0, CAST(julianday(COALESCE(e.lost_at, ?)) - julianday(e.created_at) AS INTEGER)) AS days_worked
        FROM enquiries e
        LEFT JOIN classes c ON c.id = e.class_sought
        LEFT JOIN users u ON u.id = e.assigned_to
        LEFT JOIN custom_options co ON co.kind = 'lost_reason' AND co.value = e.lost_reason AND co.institution_id = e.institution_id
       WHERE e.status = 'lost'
         AND (e.lost_at IS NULL OR ${istDate('e.lost_at')} BETWEEN ? AND ?)
         AND (? IS NULL OR e.lost_reason = ?)
         AND (? IS NULL OR e.class_sought = ?)
       ORDER BY e.lost_at IS NULL, e.lost_at DESC, e.created_at DESC LIMIT 500`)
      .bind(now(), rng.from, rng.to, nz(q.get('reason')), nz(q.get('reason')), nz(q.get('class_sought')), nz(q.get('class_sought'))).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, reason_label: initcap(str(v.reason_label)) })) })
  })

  r.post('/admissions/leads/{id}/lost', WRITE, async (c) => {
    const leadID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const reason = str(req.reason).trim()
    const note = str(req.note).trim()
    if (reason === '') throw badRequest('say why this lead was lost. The reason is the whole point of closing it here rather than deleting it')
    if (reason === 'other' && note === '') throw badRequest('"Other" needs a note saying what actually happened')
    if (!(await allowsValue(c.db, 'lost_reason', reason))) {
      throw badRequest('that is not one of the reasons your school records. Add it to the list first if it is a real one.')
    }
    const t = now()
    // lost_month was a generated column in Postgres: the first of the month (India) the lead was lost in.
    const lostMonth = todayIST().slice(0, 8) + '01'
    const res = await c.db.prepare(`UPDATE enquiries SET status = 'lost', lost_reason = ?, lost_reason_note = NULLIF(?,''), lost_at = ?, lost_by = ?, lost_month = ?, updated_at = ? WHERE id = ?`)
      .bind(reason, note, t, c.id.userId, lostMonth, t, leadID).run()
    if (res.meta.changes === 0) throw notFound()
    const stops = await stopEnrolmentsForLead(c.db, leadID, 'the lead was closed as lost')
    if (stops.length > 0) await c.db.batch(stops)
    return ok({ id: leadID, status: 'lost', reason })
  })

  r.post('/admissions/leads/{id}/reopen', WRITE, async (c) => {
    const leadID = uuidParam(c.params.id)
    const res = await c.db.prepare(`UPDATE enquiries SET status = 'contacted', lost_reason = NULL, lost_reason_note = NULL, lost_at = NULL, lost_by = NULL, lost_month = NULL, updated_at = ?
      WHERE id = ? AND status = 'lost'`).bind(now(), leadID).run()
    if (res.meta.changes === 0) throw new HttpError(409, 'that lead is not closed as lost', { code: 'not_lost' })
    return ok({ id: leadID, status: 'contacted' })
  })

  r.post('/admissions/leads/{id}/opt-out', WRITE, async (c) => {
    const leadID = uuidParam(c.params.id)
    const t = now()
    const res = await c.db.prepare(`UPDATE enquiries SET marketing_opt_out = 1, opted_out_at = ?, updated_at = ? WHERE id = ?`).bind(t, t, leadID).run()
    if (res.meta.changes === 0) throw notFound()
    const stops = await stopEnrolmentsForLead(c.db, leadID, 'the parent asked not to be contacted')
    if (stops.length > 0) await c.db.batch(stops)
    return ok({ id: leadID, opted_out: true })
  })
}



/** runCampaigns (admissions_growth.go): queue every nurture touch that has come due. */
async function runCampaigns(c: Ctx) {
  const db = c.db
  const out = { considered: 0, queued: 0, skipped: 0, enrolments_stopped: 0, enrolments_completed: 0 }
  const batch = (await db.prepare(`SELECT sn.id AS send_id, e.id AS enrol_id, st.channel, st.template_code, st.name AS step, st.quiet_from, st.quiet_to,
        q.student_name, q.parent_name, q.phone, q.email, q.status AS lead_status, q.marketing_opt_out AS opt_out, c.name AS campaign,
        EXISTS (SELECT 1 FROM applications a WHERE a.enquiry_id = q.id AND a.status IN ('accepted','offered')) AS converted
      FROM admission_campaign_sends sn
      JOIN admission_campaign_enrolments e ON e.id = sn.enrolment_id AND e.status = 'active'
      JOIN admission_campaign_steps st ON st.id = sn.step_id AND st.is_active = 1
      JOIN admission_campaigns c ON c.id = e.campaign_id AND c.is_active = 1
      JOIN enquiries q ON q.id = e.enquiry_id
     WHERE sn.status = 'pending' AND sn.due_at <= ? ORDER BY sn.due_at LIMIT 500`).bind(now())
    .all<{ send_id: string; enrol_id: string; channel: string; template_code: string; step: string; quiet_from: string | null; quiet_to: string | null
      student_name: string; parent_name: string | null; phone: string | null; email: string | null; lead_status: string; opt_out: number; campaign: string; converted: number }>()).results
  out.considered = batch.length
  const mark = (id: string, status: string, msgId: string | null, note: string) => db.prepare(`UPDATE admission_campaign_sends
      SET status = ?2, message_id = ?3, note = NULLIF(?4, ''), queued_at = CASE WHEN ?2 = 'queued' THEN ?5 ELSE queued_at END WHERE id = ?1`)
    .bind(id, status, msgId, note, now()).run()
  const stopped = new Set<string>()
  const ms = new Messenger(scopeOf(c))
  for (const d of batch) {
    if (stopped.has(d.enrol_id)) continue
    let reason = ''
    if (Number(d.opt_out)) reason = 'the parent asked not to be contacted'
    else if (Number(d.converted)) reason = 'the parent has been offered a seat or accepted one'
    else if (d.lead_status === 'applied') reason = 'the lead converted. An application was made'
    else if (d.lead_status === 'lost') reason = 'the lead was closed as lost'
    if (reason) {
      await db.batch(stopEnrolmentStmts(db, d.enrol_id, reason))
      stopped.add(d.enrol_id); out.enrolments_stopped++
      continue
    }
    const address = ((d.channel === 'email' ? d.email : d.phone) ?? '').trim()
    if (address === '') { await mark(d.send_id, 'skipped', null, `no ${d.channel} address on the enquiry`); out.skipped++; continue }
    const name = d.parent_name ? d.parent_name : d.student_name
    const when = d.quiet_from !== null && d.quiet_to !== null ? sendAtFor({ lead_minutes: 0, quiet_from: d.quiet_from, quiet_to: d.quiet_to }) : null
    try {
      const res = await ms.queue({ channel: d.channel, template_code: d.template_code, recipient: address,
        vars: { recipient_name: name, student_name: d.student_name, campaign: d.campaign, step: d.step },
        source_kind: 'campaign_step', source_id: d.send_id, occurrence_key: d.send_id, send_after: when })
      await mark(d.send_id, 'queued', res.duplicate ? null : res.id, '')
      out.queued++
    } catch (e) {
      const soft = e instanceof MessagingError && (e.code === 'provider_not_configured' || e.code === 'no_recipient')
      await mark(d.send_id, soft ? 'skipped' : 'failed', null, (e as Error).message.trim().slice(0, 200))
      out.skipped++
    }
  }
  await ms.kick()
  const done = await db.prepare(`UPDATE admission_campaign_enrolments SET status = 'completed', stopped_at = ?, stopped_reason = 'sequence finished'
      WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM admission_campaign_sends sn WHERE sn.enrolment_id = admission_campaign_enrolments.id AND sn.status = 'pending')
        AND EXISTS (SELECT 1 FROM admission_campaign_sends sn WHERE sn.enrolment_id = admission_campaign_enrolments.id)`).bind(now()).run()
  out.enrolments_completed = done.meta.changes ?? 0
  return out
}
