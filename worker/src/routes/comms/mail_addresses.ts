/* Mail addresses (communication.mail_addresses): the school's mail domain and
   each member of staff's address. Assign, change, switch off. Nothing here
   reads or lists anyone's mail: mail_messages is never touched, by design. */
import type { Ctx, Router } from '../../router'
import { badRequest, conflict, notFound, readJSON, uuid } from '../../http'
import type { StaffMailAddress } from '@shared/api/feature_mail_addresses'
import { isDomain, isLocalPart, schoolDomain } from '../../services/mail'

const MANAGE = 'comms.mail.manage'

/** Staff: an active person holding a role other than student or parent, or on the staff roll. */
const STAFF = `u.status = 'active' AND (
  EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key NOT IN ('student', 'parent'))
  OR EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id))`

interface Row { user_id: string; full_name: string; login_email: string | null; address: string | null; status: 'active' | 'disabled' | null }

const SELECT = `SELECT u.id AS user_id, u.full_name, u.email AS login_email, ma.address, ma.status
  FROM users u LEFT JOIN mail_addresses ma ON ma.user_id = u.id`

async function staffRow(c: Ctx, userId: string): Promise<StaffMailAddress> {
  const row = await c.db.prepare(`${SELECT} WHERE u.id = ? AND ${STAFF}`).bind(userId).first<Row>()
  if (!row) throw notFound('no member of staff with that id')
  return row
}

export function registerMailAddresses(r: Router): void {
  r.typed('GET /comms/mail-addresses', MANAGE, async (c) => {
    const [domain, rows] = await Promise.all([
      schoolDomain(c.env, c.id.institution!.id),
      c.db.prepare(`${SELECT} WHERE ${STAFF} OR ma.user_id IS NOT NULL ORDER BY u.full_name COLLATE NOCASE, u.id`).all<Row>(),
    ])
    return { domain, items: rows.results }
  })

  r.typed('PUT /comms/mail-addresses/domain', MANAGE, async (c) => {
    const b = await readJSON<{ domain?: unknown }>(c.req)
    const domain = String(b.domain ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '')
    if (!isDomain(domain)) throw badRequest('enter a domain such as school.edu.in')
    const inst = c.id.institution!.id
    const taken = await c.env.CONTROL.prepare('SELECT institution_id FROM mail_domains WHERE domain = ?').bind(domain).first<{ institution_id: string }>()
    if (taken && taken.institution_id !== inst) throw conflict('that domain is already in use by another school')
    const at = new Date().toISOString()
    await c.env.CONTROL.batch([
      c.env.CONTROL.prepare('DELETE FROM mail_domains WHERE institution_id = ? AND domain <> ?').bind(inst, domain),
      c.env.CONTROL.prepare(`INSERT INTO mail_domains (domain, institution_id, created_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (domain) DO UPDATE SET updated_at = excluded.updated_at`).bind(domain, inst, at, at),
    ])
    // Every address moves to the new domain with its local part kept.
    await c.db.prepare(`UPDATE mail_addresses SET address = substr(address, 1, instr(address, '@')) || ?, updated_at = ?
        WHERE address NOT LIKE ? ESCAPE '\\'`).bind(domain, at, '%@' + domain.replace(/[%_\\]/g, (x) => '\\' + x)).run()
    return { domain }
  })

  r.typed('PUT /comms/mail-addresses/{user_id}', MANAGE, async (c) => {
    const userId = c.params.user_id
    const b = await readJSON<{ local_part?: unknown; status?: unknown }>(c.req)
    const current = await staffRow(c, userId)
    const at = new Date().toISOString()
    if (b.status !== undefined && b.status !== 'active' && b.status !== 'disabled') throw badRequest('status is active or disabled')
    const status = (b.status as 'active' | 'disabled' | undefined) ?? current.status ?? 'active'
    if (b.local_part === undefined) {
      if (!current.address) throw badRequest('give this person an address first')
      await c.db.prepare('UPDATE mail_addresses SET status = ?, updated_at = ? WHERE user_id = ?').bind(status, at, userId).run()
      return staffRow(c, userId)
    }
    const local = String(b.local_part).trim().toLowerCase().replace(/@.*$/, '')
    if (!isLocalPart(local)) throw badRequest('use letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit')
    const domain = await schoolDomain(c.env, c.id.institution!.id)
    if (!domain) throw conflict('set the school mail domain first')
    const address = `${local}@${domain}`
    const other = await c.db.prepare('SELECT user_id FROM mail_addresses WHERE address = ? AND user_id <> ?').bind(address, userId).first()
    if (other) throw conflict(`${address} already belongs to someone else`)
    await c.db.prepare(`INSERT INTO mail_addresses (id, user_id, address, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET address = excluded.address, status = excluded.status, updated_at = excluded.updated_at`)
      .bind(uuid(), userId, address, status, c.id.userId, at, at).run()
    return staffRow(c, userId)
  })
}
