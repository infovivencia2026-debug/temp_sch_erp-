/* Mail addresses (communication.mail_addresses): the school's mail domain and
   each member of staff's address. Assign, change, switch off. Nothing here
   reads or lists anyone's mail: mail_messages is never touched, by design. */
import type { Ctx, Router } from '../../router'
import { badRequest, conflict, notFound, readJSON, uuid } from '../../http'
import type { MailImportPreview, MailImportPreviewRow, MailImportRow, StaffMailAddress } from '@shared/api/feature_mail_addresses'
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

  r.typed('POST /comms/mail-addresses/import/preview', MANAGE, async (c) => planImport(c, await readImport(c)))

  r.typed('POST /comms/mail-addresses/import', MANAGE, async (c) => {
    const plan = await planImport(c, await readImport(c))
    if (!plan.domain) throw conflict('set the school mail domain first')
    const at = new Date().toISOString()
    const todo = plan.rows.filter((p) => p.result === 'assign')
    if (todo.length) {
      await c.db.batch(todo.map((p) => c.db.prepare(`INSERT INTO mail_addresses (id, user_id, address, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET address = excluded.address, updated_at = excluded.updated_at`)
        .bind(uuid(), p.user_id, p.email, c.id.userId, at, at)))
    }
    return { ...plan, assigned: todo.length }
  })
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
/** A name's words, two letters or more (initials dropped), for order-free matching. */
const nameWords = (s: string) => (s.toLowerCase().match(/[a-z]{2,}/g) ?? [])
const MAX_IMPORT = 2000

/** Reads only line, code, name and email from each row; anything else in the
    body is dropped unread. */
async function readImport(c: Ctx): Promise<MailImportRow[]> {
  const b = await readJSON<{ rows?: unknown }>(c.req)
  if (!Array.isArray(b.rows) || b.rows.length === 0) throw badRequest('the file has no lines to import')
  if (b.rows.length > MAX_IMPORT) throw badRequest(`import at most ${MAX_IMPORT} lines at a time`)
  return b.rows.map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>
    const line = Number(r.line)
    return {
      line: Number.isInteger(line) && line > 0 ? line : i + 1,
      code: String(r.code ?? '').trim().slice(0, 100),
      name: String(r.name ?? '').trim().slice(0, 200),
      email: String(r.email ?? '').trim().toLowerCase().slice(0, 320),
    }
  })
}

/** What each line of the file would do. Reads users, employees and
    mail_addresses only. */
async function planImport(c: Ctx, rows: MailImportRow[]): Promise<MailImportPreview> {
  const domain = await schoolDomain(c.env, c.id.institution!.id)
  const [staff, codes, held] = await Promise.all([
    c.db.prepare(`${SELECT} WHERE ${STAFF}`).all<Row>(),
    c.db.prepare(`SELECT e.employee_code, e.user_id FROM employees e WHERE e.user_id IS NOT NULL`).all<{ employee_code: string; user_id: string }>(),
    c.db.prepare('SELECT address, user_id FROM mail_addresses').all<{ address: string; user_id: string }>(),
  ])
  const byId = new Map(staff.results.map((s) => [s.user_id, s]))
  const byCode = new Map<string, Row>()
  for (const e of codes.results) {
    const s = byId.get(e.user_id)
    if (s) byCode.set(norm(e.employee_code), s)
  }
  const byName = new Map<string, Row[]>()
  for (const s of staff.results) {
    const k = norm(s.full_name)
    byName.set(k, [...(byName.get(k) ?? []), s])
  }
  const holder = new Map(held.results.map((h) => [h.address, h.user_id]))
  const count = (key: (r: MailImportRow) => string) => {
    const m = new Map<string, number>()
    for (const r of rows) { const k = key(r); if (k) m.set(k, (m.get(k) ?? 0) + 1) }
    return m
  }
  const codeUses = count((r) => norm(r.code))
  const emailUses = count((r) => r.email)

  const domains = new Set<string>()
  const planned = rows.map((r): MailImportPreviewRow => {
    const code = norm(r.code)
    let match: Row | undefined
    let by: 'code' | 'name' | null = null
    if (code && codeUses.get(code) === 1 && byCode.has(code)) { match = byCode.get(code); by = 'code' }
    else {
      const named = r.name ? byName.get(norm(r.name)) : undefined
      if (named?.length === 1) { match = named[0]; by = 'name' }
      else {
        // Names are written in any order and with extra words ("Sarada Sriramoju"
        // for "SRIRAMOJU SARADA"); then the parts of the email id. Only a single
        // person holding every word counts.
        const at = r.email.indexOf('@')
        for (const words of [nameWords(r.name), nameWords(at > 0 ? r.email.slice(0, at) : '')]) {
          if (!words.length) continue
          const hits = staff.results.filter((s) => { const have = new Set(nameWords(s.full_name)); return words.every((w) => have.has(w)) })
          if (hits.length === 1) { match = hits[0]; by = 'name'; break }
        }
      }
    }
    const out = { ...r, user_id: match?.user_id ?? null, full_name: match?.full_name ?? null, matched_by: by, current: match?.address ?? null }
    const at = r.email.lastIndexOf('@')
    const local = at > 0 ? r.email.slice(0, at) : ''
    const dom = at > 0 ? r.email.slice(at + 1) : ''
    if (!isLocalPart(local) || !isDomain(dom)) return { ...out, result: 'invalid' }
    domains.add(dom)
    if (!match) return { ...out, result: 'unmatched' }
    if (dom !== domain) return { ...out, result: 'domain' }
    if (match.address === r.email) return { ...out, result: 'already' }
    const owner = holder.get(r.email)
    if (emailUses.get(r.email)! > 1 || (owner && owner !== match.user_id)) return { ...out, result: 'duplicate' }
    return { ...out, result: 'assign' }
  })
  // One person on two lines: neither line is applied.
  const people = new Map<string, number>()
  for (const p of planned) if (p.result === 'assign') people.set(p.user_id!, (people.get(p.user_id!) ?? 0) + 1)
  for (const p of planned) if (p.result === 'assign' && people.get(p.user_id!)! > 1) p.result = 'duplicate'
  const suggested = !domain && domains.size === 1 ? [...domains][0] : null
  return { domain, suggested_domain: suggested, rows: planned }
}
