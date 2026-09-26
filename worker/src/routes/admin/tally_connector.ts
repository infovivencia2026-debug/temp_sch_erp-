import type { Router, Ctx } from '../../router'
import { badRequest, bool, isUUID, now, ok, readJSON, uuid } from '../../http'
import { nowIST } from '../fees/common'
import { institutionId, notImplemented } from './common'
import { sealSecret } from './providers'

/* Port of mountTallyConnector (internal/api/tally.go): the platform-scoped
   connector under /admin, gated on platform.tenants.write throughout. The
   accountant's export (/finance/tally) is routes/fees/tally.ts; its helpers
   are module-private there, so the few this half needs (fyRange, fyLabel,
   currentFY) are repeated below with the same definitions.

   Nothing here talks to Tally (the Go handlers did not either). The one
   thing not ported is sealing a gateway secret (sealSecret, AES with a
   server key): a PUT carrying a non-empty secret is a 501. */

const VENDOR = 'platform.tenants.write'
const NEED_SCHOOL = 'choose the school to configure'

const fyRange = (fy: number): [string, string] => [`${fy}-04-01`, `${fy + 1}-03-31`]
const fyLabel = (fy: number): string => `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`
function currentFY(): number {
  const n = nowIST()
  return n.getUTCMonth() + 1 < 4 ? n.getUTCFullYear() - 1 : n.getUTCFullYear()
}
/** Go formats updated_at with time.RFC3339: second precision. */
const rfc3339 = (s: string) => s.replace(/\.\d+Z$/, 'Z')

const ERP_VOUCHER_TYPES = ['journal', 'receipt', 'payment', 'contra', 'purchase', 'sales',
  'depreciation', 'opening', 'closing']
const DELIVERIES = [
  { key: 'file', label: 'Download XML file', live_push: false },
  { key: 'gateway', label: 'Push to Tally on the LAN (not available)', live_push: false },
]

function school(c: Ctx, msg = NEED_SCHOOL): string {
  if (!c.id.institution) throw badRequest(msg)
  return institutionId(c)
}

/** tallyFail -> ledgerFail: a constraint refusal is a 400, the rest propagate. */
async function tallyWrite<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) {
    if (e instanceof Error && /(CHECK|FOREIGN KEY|NOT NULL) constraint failed/i.test(e.message)) {
      throw badRequest('the change was refused by a database rule: ' + e.message.replace(/^.*constraint failed:?\s*/i, ''))
    }
    throw e
  }
}

interface Settings {
  company_name: string; default_fy_start_year?: number; fy_label?: string
  delivery: string; is_enabled: boolean; updated_at?: string
}
async function loadSettings(c: Ctx, inst: string): Promise<Settings> {
  const r = await c.db.prepare(`SELECT company_name, default_fy_start_year, delivery, is_enabled, updated_at
    FROM tally_connector_settings WHERE institution_id = ?`).bind(inst).first<any>()
  if (!r) return { company_name: '', delivery: 'file', is_enabled: false }
  const out: Settings = { company_name: r.company_name ?? '', delivery: r.delivery, is_enabled: bool(r.is_enabled) }
  if (r.default_fy_start_year != null) {
    out.default_fy_start_year = Number(r.default_fy_start_year)
    out.fy_label = fyLabel(out.default_fy_start_year)
  }
  if (r.updated_at) out.updated_at = rfc3339(r.updated_at)
  // Key order as the Go struct.
  return { company_name: out.company_name, default_fy_start_year: out.default_fy_start_year, fy_label: out.fy_label,
    delivery: out.delivery, is_enabled: out.is_enabled, updated_at: out.updated_at }
}

async function getConnector(c: Ctx): Promise<Response> {
  const inst = school(c, 'choose the school to configure: the Tally mapping follows a school\'s own chart of accounts')
  const settings = await loadSettings(c, inst)
  const types = await c.db.prepare(`SELECT voucher_type, tally_voucher_type FROM tally_voucher_type_mappings
    WHERE institution_id = ? ORDER BY voucher_type`).bind(inst).all()
  const cnt = await c.db.prepare(`
    SELECT COUNT(m.id) AS mapped, COUNT(*) AS postable
      FROM ledger_accounts a
      LEFT JOIN tally_ledger_mappings m ON m.ledger_account_id = a.id AND m.institution_id = a.institution_id
     WHERE a.institution_id = ? AND a.is_group = 0 AND a.is_active = 1`).bind(inst).first<any>()
  const mapped = Number(cnt?.mapped ?? 0), postable = Number(cnt?.postable ?? 0)
  return ok({
    settings,
    voucher_types: types.results,
    mapped_accounts: mapped,
    postable_accounts: postable,
    unmapped_accounts: postable - mapped,
    deliveries: DELIVERIES,
    erp_voucher_types: ERP_VOUCHER_TYPES,
    live_push_available: false,
    live_push_note: 'Tally Prime has no cloud API. Its gateway runs on the ' +
      "accountant's own machine, on the school network, only while Tally is " +
      'open. A hosted server cannot reach it. Export the XML and import it ' +
      'in Tally: Gateway of Tally, then Import, then Vouchers.',
  })
}

async function saveConnector(c: Ctx): Promise<Response> {
  const inst = school(c)
  const b = await readJSON<any>(c.req)
  const company = typeof b.company_name === 'string' ? b.company_name.trim() : ''
  let delivery = typeof b.delivery === 'string' ? b.delivery.trim() : ''
  if (delivery === '') delivery = 'file'
  if (delivery !== 'file' && delivery !== 'gateway') throw badRequest('delivery must be file or gateway')
  const fy = b.default_fy_start_year == null ? null : Number(b.default_fy_start_year)
  if (fy !== null && !Number.isInteger(fy)) throw badRequest('default_fy_start_year must be an integer')
  const enabled = b.is_enabled === true
  if (enabled && company === '') {
    throw badRequest('name the Tally company before enabling the connector: an import with no company named lands in whichever company happens to be open')
  }
  await tallyWrite(c.db.prepare(`
    INSERT INTO tally_connector_settings
        (institution_id, company_name, default_fy_start_year, delivery, is_enabled, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (institution_id) DO UPDATE
       SET company_name = excluded.company_name, default_fy_start_year = excluded.default_fy_start_year,
           delivery = excluded.delivery, is_enabled = excluded.is_enabled,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(inst, company === '' ? null : company, fy, delivery, enabled ? 1 : 0, c.id.userId, now()).run())
  return ok({ ok: true })
}

async function listAccounts(c: Ctx): Promise<Response> {
  const inst = school(c)
  const set = await loadSettings(c, inst)
  let fy = set.default_fy_start_year ?? currentFY()
  const q = c.url.searchParams.get('fy') ?? ''
  if (/^[+-]?\d+$/.test(q) && Number(q) > 2000) fy = Number(q)
  const [from, to] = fyRange(fy)
  const rows = await c.db.prepare(`
    SELECT a.id, a.code, a.name, a.type,
           m.tally_ledger_name, m.tally_parent_group, m.cost_centre,
           COUNT(DISTINCT e.id) AS vouchers
      FROM ledger_accounts a
      LEFT JOIN tally_ledger_mappings m ON m.ledger_account_id = a.id AND m.institution_id = a.institution_id
      LEFT JOIN journal_lines l ON l.account_id = a.id AND l.institution_id = a.institution_id
      LEFT JOIN journal_entries e ON e.id = l.entry_id AND substr(e.entry_date,1,10) BETWEEN ? AND ?
     WHERE a.institution_id = ? AND a.is_group = 0 AND a.is_active = 1
     GROUP BY a.id, a.code, a.name, a.type, m.tally_ledger_name, m.tally_parent_group, m.cost_centre
     ORDER BY COUNT(DISTINCT e.id) DESC, a.code`).bind(from, to, inst).all<any>()
  const items = rows.results.map((r) => {
    const o: Record<string, unknown> = { id: r.id, code: r.code, name: r.name, type: r.type }
    if (r.tally_ledger_name != null) o.tally_ledger_name = r.tally_ledger_name
    if (r.tally_parent_group != null) o.tally_parent_group = r.tally_parent_group
    if (r.cost_centre != null) o.cost_centre = r.cost_centre
    o.vouchers = Number(r.vouchers)
    return o
  })
  return ok({ items, fy, fy_label: fyLabel(fy) })
}

const trimStr = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

async function saveMappings(c: Ctx): Promise<Response> {
  const inst = school(c)
  const b = await readJSON<{ mappings?: any[] }>(c.req)
  const list = Array.isArray(b.mappings) ? b.mappings : []
  if (list.length === 0) throw badRequest('no mappings supplied')
  const at = now()
  const stmts: D1PreparedStatement[] = []
  for (const m of list) {
    const acc = trimStr(m?.account_id)
    if (!isUUID(acc)) throw badRequest(`account_id "${m?.account_id ?? ''}" is not a uuid`)
    const name = trimStr(m?.tally_ledger_name)
    if (name === '') {
      stmts.push(c.db.prepare('DELETE FROM tally_ledger_mappings WHERE institution_id = ? AND ledger_account_id = ?')
        .bind(inst, acc))
      continue
    }
    const pg = trimStr(m?.tally_parent_group), cc = trimStr(m?.cost_centre)
    stmts.push(c.db.prepare(`
      INSERT INTO tally_ledger_mappings
          (id, institution_id, ledger_account_id, tally_ledger_name, tally_parent_group, cost_centre, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (institution_id, ledger_account_id) DO UPDATE
         SET tally_ledger_name = excluded.tally_ledger_name, tally_parent_group = excluded.tally_parent_group,
             cost_centre = excluded.cost_centre, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(uuid(), inst, acc, name, pg || null, cc || null, c.id.userId, at))
  }
  await tallyWrite(c.db.batch(stmts))
  return ok({ ok: true, saved: list.length })
}

async function saveVoucherTypes(c: Ctx): Promise<Response> {
  const inst = school(c)
  const b = await readJSON<{ voucher_types?: any[] }>(c.req)
  const list = Array.isArray(b.voucher_types) ? b.voucher_types : []
  const at = now()
  const stmts = list.map((t) => {
    const src = trimStr(t?.voucher_type), dst = trimStr(t?.tally_voucher_type)
    if (dst === '') {
      return c.db.prepare('DELETE FROM tally_voucher_type_mappings WHERE institution_id = ? AND voucher_type = ?')
        .bind(inst, src)
    }
    return c.db.prepare(`
      INSERT INTO tally_voucher_type_mappings (id, institution_id, voucher_type, tally_voucher_type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (institution_id, voucher_type) DO UPDATE
         SET tally_voucher_type = excluded.tally_voucher_type, updated_at = excluded.updated_at`)
      .bind(uuid(), inst, src, dst, at)
  })
  if (stmts.length) await tallyWrite(c.db.batch(stmts))
  return ok({ ok: true })
}

async function seedVoucherTypes(c: Ctx): Promise<Response> {
  const inst = school(c)
  const defaults: [string, string][] = [
    ['journal', 'Journal'], ['receipt', 'Receipt'], ['payment', 'Payment'],
    ['contra', 'Contra'], ['purchase', 'Purchase'], ['sales', 'Sales'],
    ['depreciation', 'Journal'], ['opening', 'Journal'], ['closing', 'Journal'],
  ]
  const at = now()
  const res = await tallyWrite(c.db.batch(defaults.map(([k, v]) => c.db.prepare(`
    INSERT INTO tally_voucher_type_mappings (id, institution_id, voucher_type, tally_voucher_type, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (institution_id, voucher_type) DO NOTHING`).bind(uuid(), inst, k, v, at))))
  const added = res.reduce((n, r) => n + (r.meta.changes ?? 0), 0)
  return ok({ ok: true, added })
}

/* The gateway row. In Go a platform operator with no school chosen reads and
   writes the platform-wide row (institution_id NULL). Each school has its own
   D1 database here and there is no such table in CONTROL, so a school must
   be chosen (x-acting-institution). */
async function getGateway(c: Ctx): Promise<Response> {
  const inst = school(c)
  const r = await c.db.prepare(`SELECT gateway_url, notes,
      (credentials IS NOT NULL AND length(credentials) > 0) AS has_secret, updated_at
      FROM tally_gateway_credentials WHERE institution_id = ?`).bind(inst).first<any>()
  const out: Record<string, unknown> = {
    gateway_url: r?.gateway_url ?? '',
    notes: r?.notes ?? '',
    has_credentials: bool(r?.has_secret),
    live_push_available: false,
    note: "Recorded for an on-site relay only. Tally's gateway listens on the " +
      "school's own network while Tally is open; this server cannot reach it, " +
      'and no request is made to this address today.',
  }
  if (r?.updated_at) out.updated_at = rfc3339(r.updated_at)
  return ok(out)
}

async function saveGateway(c: Ctx): Promise<Response> {
  const inst = school(c)
  const b = await readJSON<any>(c.req)
  const url = trimStr(b.gateway_url), notes = trimStr(b.notes)
  /* Absent keeps the stored secret, empty clears it, anything else is
     sealed (AES-256-GCM under CREDENTIAL_KEY, as messaging.go does). */
  let clear = false
  let sealed: Uint8Array | null = null
  if (b.secret !== undefined && b.secret !== null) {
    if (typeof b.secret !== 'string') throw badRequest('secret must be a string')
    if (b.secret.trim() === '') clear = true
    else sealed = await sealSecret(c, b.secret)
  }
  const at = now()
  await tallyWrite(c.db.prepare(`
    INSERT INTO tally_gateway_credentials (id, institution_id, gateway_url, credentials, notes, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000')) DO UPDATE
       SET gateway_url = excluded.gateway_url,
           credentials = CASE WHEN ? THEN NULL WHEN excluded.credentials IS NOT NULL THEN excluded.credentials
                              ELSE tally_gateway_credentials.credentials END,
           notes = excluded.notes, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(uuid(), inst, url || null, sealed, notes || null, c.id.platformAdmin ? null : c.id.userId, at, clear ? 1 : 0).run())
  return ok({ ok: true })
}

export function registerTallyConnector(r: Router): void {
  r.get('/admin/tally/connector', VENDOR, getConnector)
  r.put('/admin/tally/connector', VENDOR, saveConnector)
  r.get('/admin/tally/connector/accounts', VENDOR, listAccounts)
  r.put('/admin/tally/connector/mappings', VENDOR, saveMappings)
  r.put('/admin/tally/connector/voucher-types', VENDOR, saveVoucherTypes)
  r.post('/admin/tally/connector/voucher-types/defaults', VENDOR, seedVoucherTypes)
  r.get('/admin/tally/connector/gateway', VENDOR, getGateway)
  r.put('/admin/tally/connector/gateway', VENDOR, saveGateway)
}
