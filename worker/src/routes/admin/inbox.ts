import type { Router, Ctx } from '../../router'
import { badRequest, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { institutionId, parseJSON } from './common'
import { enqueueMessageSends, longDateIST } from '../../services/messaging'
import { notifyStmt, scanAttachments } from '../misc/chat'
import { publish } from '../../services/live'

/* Port of admin_inbox.go: every conversation across the channels on the
   principal's desk. Every route needs comms.messages.read.all AND
   institution.settings.write; the reply also needs comms.messages.send. */

function gate(c: Ctx): void {
  if (!can(c.id, 'comms.messages.read.all')) throw forbidden('missing permission: comms.messages.read.all')
  if (!can(c.id, 'institution.settings.write')) throw forbidden('missing permission: institution.settings.write')
}

interface Recent { sender: string; from_school: boolean; body: string; at: string }
interface Item {
  channel: string; key: string; title: string; from: string; about: string | null; handler: string | null; last_body: string; last_at: string; pending: boolean; status: string | null
  student_id?: string; parent_user_id?: string; teacher_user_id?: string; acked?: number; asked?: number
  teacher_name?: string; teacher_code?: string; parent_name?: string; parent_relation?: string; child_name?: string; child_class?: string
  child_photo?: string; teacher_photo?: string; admission_no?: string; reply_by?: string; reply_body?: string; reply_at?: string; recent: Recent[]
}

const CHILD = `trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.middle_name,'') || ' ' || COALESCE(st.last_name,''))`

async function inbox(c: Ctx): Promise<Response> {
  gate(c)
  const q = c.url.searchParams
  const channel = q.get('channel') ?? ''
  const status = q.get('status') || 'all'
  const searchRaw = (q.get('q') ?? '').trim().toLowerCase()
  const search = '%' + searchRaw + '%'
  const fromDate = (q.get('from') ?? '').trim(), toDate = (q.get('to') ?? '').trim()
  const klass = (q.get('class') ?? '').trim().toLowerCase(), who = (q.get('person') ?? '').trim().toLowerCase()

  const counts = { parent_teacher: 0, staff_parent: 0, concerns: 0, staff: 0, circulars: 0, counsellor: 0, total: 0 }
  const items: Item[] = []
  const within = (it: Item) => {
    const day = it.last_at.slice(0, 10)
    if (fromDate && day < fromDate) return false
    if (toDate && day > toDate) return false
    if (klass && (it.child_class ?? '').toLowerCase() !== klass) return false
    if (who) {
      const hay = [it.title, it.from, it.teacher_name ?? '', it.parent_name ?? '', it.handler ?? '', it.child_name ?? ''].join(' ').toLowerCase()
      if (!hay.includes(who)) return false
    }
    return true
  }
  const keep = (it: Item) => {
    if (it.pending) {
      if (it.channel === 'parent_teacher') counts.parent_teacher++
      else if (it.channel === 'staff_parent') counts.staff_parent++
      else if (it.channel === 'concern') counts.concerns++
      else if (it.channel === 'staff') counts.staff++
      else if (it.channel === 'circular') counts.circulars++
    }
    if ((channel === '' || channel === it.channel) && within(it)) items.push(it)
  }

  // parent <-> teacher: one row per thread, the latest message on it.
  const pt = await c.db.prepare(`
    WITH last AS (
      SELECT m.* FROM parent_teacher_messages m
       WHERE m.sent_at = (SELECT max(m2.sent_at) FROM parent_teacher_messages m2 WHERE m2.student_id = m.student_id AND m2.parent_user_id = m.parent_user_id AND m2.teacher_user_id = m.teacher_user_id)
    ), reply AS (
      SELECT m.* FROM parent_teacher_messages m
       WHERE m.sender_user_id <> m.parent_user_id
         AND m.sent_at = (SELECT max(m2.sent_at) FROM parent_teacher_messages m2 WHERE m2.student_id = m.student_id AND m2.parent_user_id = m.parent_user_id AND m2.teacher_user_id = m.teacher_user_id AND m2.sender_user_id <> m2.parent_user_id)
    )
    SELECT l.student_id, l.parent_user_id, l.teacher_user_id, ${CHILD} AS child, st.admission_no,
           COALESCE(c.name || '-' || sec.name, c.name, '') AS klass, COALESCE(pu.full_name, '') AS parent, COALESCE(g.relation, '') AS rel,
           COALESCE(tu.full_name, '') AS teacher, COALESCE(emp.employee_code, '') AS code, st.photo_file_id AS child_photo, emp.photo_file_id AS teacher_photo,
           COALESCE(su.full_name, '') AS sender, l.body, l.sent_at, l.sender_user_id = l.parent_user_id AS parent_wrote, l.read_at IS NULL AS unread,
           ru.full_name AS reply_by, rp.body AS reply_body, rp.sent_at AS reply_at,
           (SELECT json_group_array(json_object('sender', COALESCE(xu.full_name, ''), 'from_school', x.sender_user_id <> x.parent_user_id, 'body', x.body, 'at', x.sent_at))
              FROM (SELECT m2.sender_user_id, m2.parent_user_id, m2.body, m2.sent_at FROM parent_teacher_messages m2
                     WHERE m2.student_id = l.student_id AND m2.parent_user_id = l.parent_user_id AND m2.teacher_user_id = l.teacher_user_id ORDER BY m2.sent_at DESC LIMIT 3) x
              LEFT JOIN users xu ON xu.id = x.sender_user_id) AS recent
      FROM last l JOIN students st ON st.id = l.student_id
      LEFT JOIN enrollments en ON en.id = (SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
      LEFT JOIN classes c ON c.id = en.class_id LEFT JOIN sections sec ON sec.id = en.section_id
      LEFT JOIN users pu ON pu.id = l.parent_user_id LEFT JOIN guardians g ON g.user_id = l.parent_user_id
      LEFT JOIN users tu ON tu.id = l.teacher_user_id LEFT JOIN employees emp ON emp.user_id = l.teacher_user_id
      LEFT JOIN users su ON su.id = l.sender_user_id
      LEFT JOIN reply rp ON rp.student_id = l.student_id AND rp.parent_user_id = l.parent_user_id AND rp.teacher_user_id = l.teacher_user_id
      LEFT JOIN users ru ON ru.id = rp.sender_user_id
     WHERE (? = '%%' OR lower(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'') || ' ' || st.admission_no || ' ' || COALESCE(pu.full_name,'') || ' ' || COALESCE(tu.full_name,'') || ' ' || l.body) LIKE ?)
     ORDER BY l.sent_at DESC LIMIT 300`).bind(search, search).all<Record<string, unknown>>()
  for (const r of pt.results) {
    const parentWrote = !!r.parent_wrote
    const child = String(r.child), teacher = String(r.teacher), parent = String(r.parent)
    const it: Item = {
      channel: parentWrote ? 'parent_teacher' : 'staff_parent', pending: parentWrote ? true : !!r.unread,
      key: `${r.student_id}|${r.parent_user_id}|${r.teacher_user_id}`, title: teacher, from: String(r.sender), about: child, handler: teacher,
      last_body: String(r.body), last_at: String(r.sent_at), status: null,
      student_id: String(r.student_id), parent_user_id: String(r.parent_user_id), teacher_user_id: String(r.teacher_user_id),
      teacher_name: teacher, parent_name: parent, child_name: child,
      teacher_code: r.code ? String(r.code) : undefined, parent_relation: r.rel ? String(r.rel) : undefined, child_class: r.klass ? String(r.klass) : undefined,
      admission_no: r.admission_no ? String(r.admission_no) : undefined, child_photo: r.child_photo ? String(r.child_photo) : undefined, teacher_photo: r.teacher_photo ? String(r.teacher_photo) : undefined,
      reply_by: (r.reply_by as string | null) ?? undefined, reply_body: (r.reply_body as string | null) ?? undefined, reply_at: (r.reply_at as string | null) ?? undefined,
      recent: parseJSON<Recent[]>(r.recent, []).map((x) => ({ ...x, from_school: !!x.from_school })),
    }
    keep(it)
  }

  // concerns
  const cn = await c.db.prepare(`
    SELECT t.id, t.subject, t.status, t.category, COALESCE(ru.full_name, '') AS raised, ${CHILD} AS child, au.full_name AS handler,
           COALESCE((SELECT g.body FROM grievance_updates g WHERE g.ticket_id = t.id ORDER BY g.created_at DESC LIMIT 1), t.body) AS last_body,
           COALESCE((SELECT max(g.created_at) FROM grievance_updates g WHERE g.ticket_id = t.id), t.created_at) AS last_at,
           t.status NOT IN ('resolved','closed') AND NOT EXISTS (SELECT 1 FROM grievance_updates g WHERE g.ticket_id = t.id AND g.visible_to_parent) AS pending
      FROM support_tickets t LEFT JOIN users ru ON ru.id = t.raised_by LEFT JOIN students st ON st.id = t.student_id LEFT JOIN users au ON au.id = t.assigned_to
     WHERE (? = '%%' OR lower(t.subject || ' ' || t.body || ' ' || COALESCE(ru.full_name,'') || ' ' || COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) LIKE ?)
     ORDER BY t.updated_at DESC LIMIT 300`).bind(search, search).all<Record<string, unknown>>()
  for (const r of cn.results) {
    const child = String(r.child ?? '').trim()
    keep({ channel: 'concern', key: String(r.id), title: String(r.subject) || String(r.category), from: String(r.raised), about: child || null,
      handler: (r.handler as string | null) ?? null, status: String(r.status), last_body: String(r.last_body), last_at: String(r.last_at), pending: !!r.pending, recent: [] })
  }

  // staff <-> staff
  const sm = await c.db.prepare(`
    WITH last AS (
      SELECT m.* FROM staff_messages m WHERE m.sent_at = (SELECT max(m2.sent_at) FROM staff_messages m2 WHERE m2.party_a = m.party_a AND m2.party_b = m.party_b)
    )
    SELECT l.party_a, l.party_b, COALESCE(ua.full_name, '') AS na, COALESCE(ub.full_name, '') AS nb, COALESCE(su.full_name, '') AS sender, l.body, l.sent_at, l.read_at IS NULL AS pending,
           (SELECT json_group_array(json_object('sender', COALESCE(xu.full_name, ''), 'from_school', x.sender_user_id = l.party_a, 'body', x.body, 'at', x.sent_at))
              FROM (SELECT m2.sender_user_id, m2.body, m2.sent_at FROM staff_messages m2 WHERE m2.party_a = l.party_a AND m2.party_b = l.party_b ORDER BY m2.sent_at DESC LIMIT 3) x
              LEFT JOIN users xu ON xu.id = x.sender_user_id) AS recent
      FROM last l LEFT JOIN users ua ON ua.id = l.party_a LEFT JOIN users ub ON ub.id = l.party_b LEFT JOIN users su ON su.id = l.sender_user_id
     WHERE (? = '%%' OR lower(COALESCE(ua.full_name,'') || ' ' || COALESCE(ub.full_name,'') || ' ' || l.body) LIKE ?)
     ORDER BY l.sent_at DESC LIMIT 300`).bind(search, search).all<Record<string, unknown>>()
  for (const r of sm.results) {
    keep({ channel: 'staff', key: `${r.party_a}|${r.party_b}`, title: `${r.na} ↔ ${r.nb}`, from: String(r.sender), about: null, handler: null, status: null,
      last_body: String(r.body), last_at: String(r.sent_at), pending: !!r.pending, recent: parseJSON<Recent[]>(r.recent, []).map((x) => ({ ...x, from_school: !!x.from_school })) })
  }

  // circulars
  const ci = await c.db.prepare(`
    SELECT a.id, a.title, a.kind, COALESCE(a.audience_role, '') AS audience, COALESCE(cu.full_name, '') AS author, substr(a.body, 1, 200) AS body,
           COALESCE(a.publish_at, a.created_at) AS at, a.requires_ack,
           (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id AND k.acked_at IS NOT NULL) AS acked,
           (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id) AS asked
      FROM announcements a LEFT JOIN users cu ON cu.id = a.created_by
     WHERE (? = '%%' OR lower(a.title || ' ' || a.body || ' ' || COALESCE(cu.full_name,'')) LIKE ?)
     ORDER BY COALESCE(a.publish_at, a.created_at) DESC LIMIT 200`).bind(search, search).all<Record<string, unknown>>()
  for (const r of ci.results) {
    const about = `${r.kind} ${r.audience}`.trim()
    const it: Item = { channel: 'circular', key: String(r.id), title: String(r.title), from: String(r.author), about: about || null, handler: null, status: null,
      last_body: String(r.body), last_at: String(r.at), pending: false, recent: [] }
    if (r.requires_ack) { it.acked = Number(r.acked); it.asked = Number(r.asked); it.pending = it.asked > it.acked }
    keep(it)
  }

  try {
    const cc = await c.db.prepare(`SELECT count(*) AS n FROM counselor_threads t WHERE t.status <> 'closed'`).first<{ n: number }>()
    counts.counsellor = cc?.n ?? 0
  } catch { counts.counsellor = 0 }

  let out = items
  if (status !== 'all') { const want = status === 'pending'; out = out.filter((it) => it.pending === want) }
  out.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0))
  counts.total = counts.parent_teacher + counts.staff_parent + counts.concerns + counts.staff + counts.circulars
  return ok({ items: out.map((it) => ({ ...it, about: it.about, handler: it.handler, status: it.status })), counts })
}

export function registerAdminInbox(r: Router): void {
  r.get('/admin/inbox', 'auth', inbox)

  r.get('/admin/inbox/count', 'auth', async (c) => {
    gate(c)
    const row = await c.db.prepare(`
      SELECT (SELECT count(*) FROM parent_teacher_messages m WHERE m.sender_user_id = m.parent_user_id
                AND m.sent_at = (SELECT max(m2.sent_at) FROM parent_teacher_messages m2 WHERE m2.student_id = m.student_id AND m2.parent_user_id = m.parent_user_id AND m2.teacher_user_id = m.teacher_user_id))
           + (SELECT count(*) FROM support_tickets t WHERE t.status NOT IN ('resolved','closed') AND NOT EXISTS (SELECT 1 FROM grievance_updates g WHERE g.ticket_id = t.id AND g.visible_to_parent))
           + (SELECT count(*) FROM staff_messages m WHERE m.read_at IS NULL AND m.sent_at = (SELECT max(m2.sent_at) FROM staff_messages m2 WHERE m2.party_a = m.party_a AND m2.party_b = m.party_b))
           + (SELECT count(*) FROM announcements a WHERE a.requires_ack
                AND (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id AND k.acked_at IS NOT NULL) < (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id)) AS n`)
      .first<{ n: number }>()
    return ok({ pending: row?.n ?? 0 })
  })

  r.get('/admin/inbox/thread', 'auth', async (c) => {
    gate(c)
    const q = c.url.searchParams
    const sid = q.get('student_id'), pid = q.get('parent_user_id'), tid = q.get('teacher_user_id')
    if (!isUUID(sid) || !isUUID(pid) || !isUUID(tid)) throw badRequest('student_id, parent_user_id and teacher_user_id must be uuids')
    const rows = await c.db.prepare(`SELECT m.id, COALESCE(u.full_name, '') AS sender, m.sender_user_id <> m.parent_user_id AS from_school, m.body, m.sent_at, m.read_at, m.attachments
        FROM parent_teacher_messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.student_id = ? AND m.parent_user_id = ? AND m.teacher_user_id = ? ORDER BY m.sent_at`)
      .bind(sid, pid, tid).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((m) => ({ id: m.id, sender: m.sender, from_school: !!m.from_school, body: m.body, sent_at: m.sent_at, read_at: m.read_at ?? undefined, attachments: scanAttachments(m.attachments) })) })
  })

  r.get('/admin/inbox/staff-thread', 'auth', async (c) => {
    gate(c)
    const a = c.url.searchParams.get('a'), b = c.url.searchParams.get('b')
    if (!isUUID(a) || !isUUID(b)) throw badRequest('a and b must be user ids')
    const rows = await c.db.prepare(`SELECT m.id, COALESCE(u.full_name, '') AS sender, m.sender_user_id AS sender_id, m.body, m.sent_at, m.read_at, m.attachments
        FROM staff_messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.party_a = ? AND m.party_b = ? ORDER BY m.sent_at`)
      .bind(a < b ? a : b, a < b ? b : a).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((m) => ({ id: m.id, sender: m.sender, sender_id: m.sender_id, body: m.body, sent_at: m.sent_at, read_at: m.read_at ?? undefined, attachments: scanAttachments(m.attachments) })) })
  })

  r.get('/admin/inbox/concern', 'auth', async (c) => {
    gate(c)
    const tid = c.url.searchParams.get('id')
    if (!isUUID(tid)) throw badRequest('id must be the uuid of a concern')
    const t = await c.db.prepare(`SELECT COALESCE(t.subject,'') AS subject, COALESCE(t.body,'') AS body, t.status, COALESCE(t.category,'') AS category, COALESCE(ru.full_name,'') AS raised_by,
        au.full_name AS assigned_to, t.created_at, COALESCE(trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')), '') AS child
        FROM support_tickets t LEFT JOIN users ru ON ru.id = t.raised_by LEFT JOIN users au ON au.id = t.assigned_to LEFT JOIN students st ON st.id = t.student_id WHERE t.id = ?`).bind(tid)
      .first<Record<string, unknown>>()
    if (!t) throw notFound('resource not found')
    const notes = await c.db.prepare(`SELECT g.id, COALESCE(u.full_name,'') AS author, g.body, g.created_at AS at, g.visible_to_parent AS to_family, COALESCE(g.kind,'note') AS kind
        FROM grievance_updates g LEFT JOIN users u ON u.id = g.author_id WHERE g.ticket_id = ? ORDER BY g.created_at`).bind(tid).all<Record<string, unknown>>()
    return ok({ subject: t.subject, body: t.body, status: t.status, category: t.category, raised_by: t.raised_by, raised_at: t.created_at, assigned_to: t.assigned_to ?? null, child: t.child,
      notes: notes.results.map((n) => ({ ...n, to_family: !!n.to_family })) })
  })

  r.get('/admin/inbox/circular', 'auth', async (c) => {
    gate(c)
    const aid = c.url.searchParams.get('id')
    if (!isUUID(aid)) throw badRequest('id must be the uuid of a circular')
    const a = await c.db.prepare(`SELECT a.title, COALESCE(a.body,'') AS body, COALESCE(a.kind,'') AS kind, COALESCE(a.audience_role,'') AS audience, COALESCE(cu.full_name,'') AS author,
        COALESCE(a.publish_at, a.created_at) AS published_at, a.requires_ack,
        (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id AND k.acked_at IS NOT NULL) AS acked, (SELECT count(*) FROM announcement_acks k WHERE k.announcement_id = a.id) AS asked
        FROM announcements a LEFT JOIN users cu ON cu.id = a.created_by WHERE a.id = ?`).bind(aid).first<Record<string, unknown>>()
    if (!a) throw notFound('resource not found')
    let pending: string[] = []
    if (a.requires_ack) {
      const rows = await c.db.prepare(`SELECT COALESCE(u.full_name, trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')), '') AS who
          FROM announcement_acks k LEFT JOIN users u ON u.id = k.user_id LEFT JOIN students st ON st.id = k.student_id WHERE k.announcement_id = ? AND k.acked_at IS NULL ORDER BY 1 LIMIT 100`).bind(aid).all<{ who: string }>()
      pending = rows.results.map((x) => x.who).filter(Boolean)
    }
    return ok({ title: a.title, body: a.body, kind: a.kind, audience: a.audience, author: a.author, published_at: a.published_at, requires_ack: !!a.requires_ack, acked: a.acked, asked: a.asked, pending })
  })

  r.post('/admin/inbox/reply', 'auth', async (c) => {
    gate(c)
    if (!can(c.id, 'comms.messages.send')) throw forbidden('missing permission: comms.messages.send')
    const inst = institutionId(c)
    const req = await readJSON<{ student_id?: string; parent_user_id?: string; teacher_user_id?: string; body?: string }>(c.req)
    const sid = req.student_id ?? '', pid = req.parent_user_id ?? '', tid = req.teacher_user_id ?? ''
    if (!isUUID(sid) || !isUUID(pid) || !isUUID(tid)) throw badRequest('student_id, parent_user_id and teacher_user_id must be uuids')
    const body = (req.body ?? '').trim()
    if (body === '') throw badRequest('a reply needs some words')
    const exists = await c.db.prepare(`SELECT 1 AS x FROM parent_teacher_messages WHERE student_id = ? AND parent_user_id = ? AND teacher_user_id = ?`).bind(sid, pid, tid).first()
    if (!exists) throw notFound('resource not found')
    const child = (await c.db.prepare(`SELECT trim(first_name || ' ' || COALESCE(last_name,'')) AS n FROM students WHERE id = ?`).bind(sid).first<{ n: string }>())?.n
    if (child === undefined) throw notFound('resource not found')
    const from = c.id.fullName
    const msgId = uuid()
    const summary = body.length > 240 ? body.slice(0, 237) + '…' : body
    const stmts: D1PreparedStatement[] = [
      /* Trigger parent_teacher_messages_sender_check (00337): the sender must be the parent, the teacher, or a
         member of the school's staff. The desk is staff by the gate above, so the row is valid. */
      c.db.prepare(`INSERT INTO parent_teacher_messages (id, institution_id, student_id, parent_user_id, teacher_user_id, sender_user_id, body, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(msgId, inst, sid, pid, tid, c.id.userId, body, now()),
    ]
    const n1 = await notifyStmt(c, pid, sid, 'parent_message', 'Message from ' + from + ' about ' + child, summary, '/go/direct_teacher_messaging?student_id=' + sid + '&teacher_user_id=' + tid, 'parent_teacher_message', msgId)
    if (n1) stmts.push(n1)
    if (tid !== c.id.userId) {
      const n2 = await notifyStmt(c, tid, sid, 'parent_message', from + " replied to " + child + "'s family", summary, '/go/messages?box=parents&child=' + sid + '&with=' + pid, 'parent_teacher_message', msgId)
      if (n2) stmts.push(n2)
    }
    await c.db.batch(stmts)
    await publish(c.env, inst, { users: [pid, tid, c.id.userId], type: 'message', scope: 'parent', from: c.id.userId,
      keys: { student: sid, parent: pid, teacher: tid, from_name: from, child } })
    // The email to the parent (Go: TypeMessageSend student.remark); a failure is logged, the reply stands.
    try {
      await enqueueMessageSends(c.env, inst, [{ channel: 'email', template_key: 'student.remark', to_user_id: pid,
        vars: { title: 'About ' + child, summary: body, teacher: from, on_date: longDateIST() } }])
    } catch (e) { console.warn('inbox reply email not queued', e) }
    return ok({ ok: true })
  })
}
