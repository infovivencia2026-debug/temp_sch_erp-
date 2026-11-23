/* Yajur Connect, Students & parents (read only): every active student with
   class, section and each guardian's number, and whether a message can go to
   it. Status uses the same rules as GET /comms/yajur-connect/send/people: a
   number normalisePhone can read, and no scope 'all' opt-out for it. The ERP
   cannot tell who is on WhatsApp, so "has_number" means only that. Filters:
   q (student, admission no, parent, number), class_id, status. */
import type { Router } from '../../router'
import { badRequest, isUUID, like, ok } from '../../http'
import { normalisePhone, normaliseRecipient } from '../admin/msg_guard'

export type ConnectPeopleStatus = 'has_number' | 'no_number' | 'opted_out'
const STATUSES: ConnectPeopleStatus[] = ['has_number', 'no_number', 'opted_out']
const CAP = 3000

export function registerYajurConnectPeople(r: Router, perm: string): void {
  r.get('/comms/yajur-connect/people', perm, async (c) => {
    const sp = c.url.searchParams
    const q = (sp.get('q') ?? '').trim().slice(0, 60)
    const classId = sp.get('class_id') || ''
    if (classId && !isUUID(classId)) throw badRequest('invalid class id')
    const status = sp.get('status') || ''
    if (status && !STATUSES.includes(status as ConnectPeopleStatus)) throw badRequest('unknown status')
    const digits = q.replace(/[^0-9]/g, '')

    // Three numbered placeholders, three binds.
    const rows = await c.db.prepare(`SELECT s.id AS student_id, trim(s.first_name || ' ' || coalesce(s.last_name, '')) AS student_name, s.admission_no,
          en.class_id, cl.name AS class_name, se.name AS section_name,
          g.id AS guardian_id, g.full_name AS guardian_name, g.relation, g.phone
        FROM students s
        LEFT JOIN enrollments en ON en.id = (SELECT e2.id FROM enrollments e2 WHERE e2.student_id = s.id AND e2.status = 'active' ORDER BY e2.enrolled_on DESC LIMIT 1)
        LEFT JOIN classes cl ON cl.id = en.class_id LEFT JOIN sections se ON se.id = en.section_id
        LEFT JOIN student_guardians sg ON sg.student_id = s.id LEFT JOIN guardians g ON g.id = sg.guardian_id
        WHERE s.status = 'active' AND (?3 = '' OR en.class_id = ?3)
          AND (?1 = '%%' OR s.first_name || ' ' || coalesce(s.last_name, '') LIKE ?1 ESCAPE '\\' OR s.admission_no LIKE ?1 ESCAPE '\\'
            OR g.full_name LIKE ?1 ESCAPE '\\' OR (?2 <> '' AND replace(replace(g.phone, ' ', ''), '-', '') LIKE ?2))
        ORDER BY cl.level, cl.name, se.name, s.first_name, s.last_name, sg.is_primary DESC, g.full_name
        LIMIT ${CAP + 1}`).bind(like(q), digits.length >= 4 ? `%${digits}%` : '', classId)
      .all<{ student_id: string; student_name: string; admission_no: string | null; class_id: string | null; class_name: string | null; section_name: string | null
        guardian_id: string | null; guardian_name: string | null; relation: string | null; phone: string | null }>()
    const opts = new Set((await c.db.prepare(`SELECT contact FROM message_opt_outs WHERE scope = 'all'`).all<{ contact: string }>()).results.map((x) => x.contact))
    const truncated = rows.results.length > CAP
    const items = rows.results.slice(0, CAP).map((p) => {
      const phone = p.phone?.trim() ?? ''
      const st: ConnectPeopleStatus = !normalisePhone(phone) ? 'no_number' : opts.has(normaliseRecipient(phone)) ? 'opted_out' : 'has_number'
      return { ...p, phone: phone || null, status: st }
    }).filter((p) => !status || p.status === status)
    const classes = (await c.db.prepare(`SELECT id, name FROM classes ORDER BY level, name`).all<{ id: string; name: string }>()).results
    return ok({ items, classes, truncated })
  })
}
