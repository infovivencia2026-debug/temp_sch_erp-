import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { platformOnly } from './common'
import { PERM_VENDOR, NIL_UUID, connectorInstitution, fleetDbs, ledgerFail, rfc3339, sealedSecretFrom } from './connectors_common'

/* Port of internal/api/connectors.go and internal/connectors: the Meritto /
   LeadSquared CRM connector and the virtual-classroom meeting connector,
   mounted under /admin, every route gated on platform.tenants.write.

   Nothing here reaches the network, exactly as in Go: the only working CRM
   transport is the CSV file (rendered and parsed here), the API transports
   refuse by name with ErrCRMAPIUnavailable, and the meeting providers other
   than 'manual' record their refusal in virtual_meeting_requests.

   The platform-only tables (crm_api_credentials,
   virtual_meeting_platform_providers) live in each school's database here;
   installation-default rows (institution_id NULL) are kept in the acting
   school's database. */

// --- internal/connectors ------------------------------------------------------------

const LEAD_FIELDS = ['student_name', 'parent_name', 'phone', 'email', 'class_sought', 'source', 'campaign', 'status',
  'assigned_to', 'next_follow_up', 'notes', 'utm_source', 'utm_medium', 'utm_campaign', 'referred_by', 'created_at']
const LEAD_LABELS: Record<string, string> = {
  student_name: "Child's name", parent_name: "Parent's name", phone: 'Phone', email: 'Email', class_sought: 'Class sought',
  source: 'Source', campaign: 'Campaign', status: 'Status', assigned_to: 'Counsellor', next_follow_up: 'Next follow-up',
  notes: 'Notes', utm_source: 'UTM source', utm_medium: 'UTM medium', utm_campaign: 'UTM campaign', referred_by: 'Referred by',
  created_at: 'Enquiry date',
}
const isLeadField = (f: string) => LEAD_FIELDS.includes(f)
const CRM_SYSTEMS: Record<string, string> = { meritto: 'Meritto (formerly NoPaperForms)', leadsquared: 'LeadSquared' }
const isCRMSystem = (k: unknown): k is string => typeof k === 'string' && k in CRM_SYSTEMS
const MEETING_SYSTEMS: Record<string, string> = { zoom: 'Zoom', google_meet: 'Google Meet', ms_teams: 'Microsoft Teams' }
const isMeetingSystem = (k: unknown): k is string => typeof k === 'string' && k in MEETING_SYSTEMS
const AUTH_STYLES: Record<string, string> = {
  oauth_s2s: 'Server-to-server OAuth (Zoom)',
  service_account: 'Service account with domain-wide delegation (Google)',
  app_registration: 'App registration (Microsoft Entra)',
}
const EXTERNAL_ID = 'external_id'
const ENQUIRY_ID = 'enquiry_id'

const CRM_API_UNAVAILABLE = 'live CRM sync needs an API key for this school\'s own Meritto or LeadSquared ' +
  'account, which is a paid tier and is not configured on this installation. ' +
  'Export the CSV and use the CRM\'s bulk import instead'
const CSV_PULL_IS_UPLOAD = 'a CSV pull is a file upload, not a poll: export the leads from the CRM and upload that file here'
const MANUAL_URL_REQUIRED = 'paste the meeting link from Zoom, Meet or Teams: no provider on this installation can create one for you yet'
const MEETING_API_UNAVAILABLE = 'creating a meeting automatically needs this installation\'s own Zoom, Google ' +
  'Workspace or Microsoft 365 account with an API credential configured, and none is. Paste the meeting link into the session instead'

const CRM_LIVE_NOTE = 'No CRM API key is configured on this installation, and no request ' +
  'is made to Meritto or LeadSquared. The CSV route is the working one: export ' +
  "here, import in the CRM's own bulk upload, and bring the file back the same way."
const MEETING_LIVE_NOTE = 'No meeting provider credential is configured on this ' +
  'installation, so no meeting is created automatically. Teachers paste the join ' +
  'link into the session as they do today, and the launcher works exactly as before.'

const crmTransports = () => [
  { key: 'csv', label: 'CSV export and import', live_sync: false },
  { key: 'meritto', label: 'Meritto API (not available)', live_sync: false },
  { key: 'leadsquared', label: 'LeadSquared API (not available)', live_sync: false },
]
const meetingRoutes: { key: string; label: string; live_create: boolean; needs?: string }[] = [
  { key: 'manual', label: 'Paste a meeting link', live_create: false },
  { key: 'zoom', label: 'Zoom (not available)', live_create: false, needs: 'a server-to-server OAuth app' },
  { key: 'google_meet', label: 'Google Meet (not available)', live_create: false, needs: 'a Workspace service account with domain-wide delegation' },
  { key: 'ms_teams', label: 'Microsoft Teams (not available)', live_create: false, needs: 'an Entra app registration with OnlineMeetings.ReadWrite.All' },
]

interface Mapping { local_field: string; crm_field: string; direction: string; is_required: boolean }
interface Lead { enquiryId: string; externalId: string; updatedAt: string; values: Record<string, string> }
interface Link { enquiryId: string; lastSynced: string | null; localUpdated: string | null }
interface ImportRow { line: number; externalId: string; enquiryId: string; values: Record<string, string> }
type Action = 'created' | 'updated' | 'skipped' | 'conflict' | 'failed'

const oneOf = (v: unknown, ...xs: string[]): v is string => typeof v === 'string' && xs.includes(v)

function forDirection(ms: Mapping[], dir: string): Mapping[] {
  const idx = (f: string) => { const i = LEAD_FIELDS.indexOf(f); return i < 0 ? LEAD_FIELDS.length : i }
  return ms.filter((m) => m.direction === 'both' || m.direction === dir)
    .map((m, i) => ({ m, i })).sort((a, b) => idx(a.m.local_field) - idx(b.m.local_field) || a.i - b.i).map((x) => x.m)
}

/** encoding/csv's quoting rule. */
function csvField(s: string): string {
  if (s === '') return s
  if (/[",\r\n]/.test(s) || s[0] === ' ' || s[0] === '\t') return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function renderLeadCSV(ms: Mapping[], leads: Lead[]): string {
  const cols = forDirection(ms, 'push')
  if (cols.length === 0) throw badRequest('no fields are mapped for this direction')
  for (const m of cols) {
    if (!m.is_required) continue
    for (const l of leads) {
      if ((l.values[m.local_field] ?? '').trim() === '') {
        throw badRequest(`lead ${l.enquiryId} has no ${LEAD_LABELS[m.local_field]}, and that field is marked required: fill it in or clear the requirement`)
      }
    }
  }
  const lines = [[EXTERNAL_ID, ENQUIRY_ID, ...cols.map((m) => m.crm_field)]]
  for (const l of leads) lines.push([l.externalId, l.enquiryId, ...cols.map((m) => l.values[m.local_field] ?? '')])
  return lines.map((r) => r.map(csvField).join(',') + '\n').join('')
}

/** A strict-quote CSV reader, as encoding/csv with FieldsPerRecord = -1. */
function parseCSV(data: string): string[][] {
  const out: string[][] = []
  let rec: string[] = [], field = '', i = 0, line = 1
  const n = data.length
  let atStart = true
  while (i < n) {
    const ch = data[i]
    if (atStart && ch === '"') {
      i++
      for (;;) {
        if (i >= n) throw new Error(`record on line ${line}: extraneous or missing " in quoted-field`)
        if (data[i] === '"') {
          if (data[i + 1] === '"') { field += '"'; i += 2; continue }
          i++; break
        }
        if (data[i] === '\n') line++
        field += data[i++]
      }
      if (i < n && data[i] !== ',' && data[i] !== '\n' && data[i] !== '\r') throw new Error(`record on line ${line}: extraneous or missing " in quoted-field`)
      atStart = false
      continue
    }
    if (ch === ',') { rec.push(field); field = ''; atStart = true; i++; continue }
    if (ch === '\r' && data[i + 1] === '\n') { i++; continue }
    if (ch === '\n') {
      rec.push(field)
      if (!(rec.length === 1 && rec[0] === '')) out.push(rec)
      rec = []; field = ''; atStart = true; i++; line++; continue
    }
    if (ch === '"') throw new Error(`record on line ${line}: bare " in non-quoted-field`)
    field += ch; atStart = false; i++
  }
  if (field !== '' || rec.length > 0) { rec.push(field); out.push(rec) }
  return out
}

function parseLeadCSV(ms: Mapping[], data: string): ImportRow[] {
  const cols = forDirection(ms, 'pull')
  if (cols.length === 0) throw badRequest('no fields are mapped for this direction')
  let records: string[][]
  try { records = parseCSV(data) } catch (e) { throw badRequest('this file is not readable as CSV: ' + (e as Error).message) }
  if (records.length === 0) throw badRequest('the file is empty')
  const head = new Map<string, number>()
  records[0].forEach((h, i) => head.set(h.trim().toLowerCase(), i))
  const extIdx = head.get(EXTERNAL_ID)
  if (extIdx === undefined) {
    throw badRequest(`the file has no ${EXTERNAL_ID} column. Without it every row reads as a new lead, ` +
      'and a second import gives one child two leads and two counsellors. Export from this screen first and keep that column')
  }
  const enqIdx = head.get(ENQUIRY_ID)
  const at = (rec: string[], i: number | undefined) => (i === undefined || i < 0 || i >= rec.length ? '' : rec[i].trim())
  const out: ImportRow[] = []
  records.slice(1).forEach((rec, n) => {
    const row: ImportRow = { line: n + 2, externalId: at(rec, extIdx), enquiryId: at(rec, enqIdx), values: {} }
    for (const m of cols) { const i = head.get(m.crm_field.toLowerCase()); if (i !== undefined) row.values[m.local_field] = at(rec, i) }
    if (row.externalId === '' && row.enquiryId === '' && Object.values(row.values).every((v) => v.trim() === '')) return
    out.push(row)
  })
  return out
}

const movedSince = (at: string | null, since: string | null) => at === null || since === null || Date.parse(at) > Date.parse(since)

function decideImport(row: ImportRow, link: Link | null, policy: string): [Action, string] {
  if (row.externalId.trim() === '') return ['failed', `row ${row.line} has no ${EXTERNAL_ID}`]
  if (!link) return ['created', '']
  // The file route never carries a remote timestamp: unknown is treated as moved.
  const localMoved = movedSince(link.localUpdated, link.lastSynced)
  if (!localMoved) return ['updated', '']
  switch (policy) {
    case 'theirs': return ['updated', 'both sides changed; the CRM wins by policy']
    case 'ours': return ['skipped', "both sides changed; this school's record wins by policy"]
    case 'newest': return ['updated', "both sides changed; the CRM's record is newer"]
    default: return ['conflict', 'changed here and in the CRM since the last sync']
  }
}

function decidePush(lead: Lead, link: Link | undefined): [Action, string] {
  if (!link || lead.externalId.trim() === '') return ['created', '']
  if (!movedSince(lead.updatedAt, link.lastSynced)) return ['skipped', 'already sent and unchanged here']
  return ['updated', '']
}

// --- plumbing -----------------------------------------------------------------------

async function loadMappings(c: Ctx, inst: string): Promise<Mapping[]> {
  const rs = await c.db.prepare(`SELECT local_field, crm_field, direction, is_required FROM crm_field_mappings WHERE institution_id = ?`)
    .bind(inst).all<{ local_field: string; crm_field: string; direction: string; is_required: number }>()
  return rs.results.map((m) => ({ ...m, is_required: bool(m.is_required) }))
}

async function loadLeads(c: Ctx, inst: string, provider: string, limit: number): Promise<{ leads: Lead[]; links: Map<string, Link> }> {
  const rs = await c.db.prepare(`
    SELECT e.id, COALESCE(k.external_id, '') AS external_id, e.updated_at, e.student_name,
           COALESCE(e.parent_name, '') AS parent_name, e.phone, COALESCE(e.email, '') AS email,
           COALESCE(c.name, '') AS class_sought, e.source, COALESCE(e.campaign, '') AS campaign, e.status,
           COALESCE(u.full_name, '') AS assigned_to, COALESCE(substr(e.next_follow_up, 1, 10), '') AS next_follow_up,
           COALESCE(e.notes, '') AS notes, COALESCE(e.utm_source, '') AS utm_source, COALESCE(e.utm_medium, '') AS utm_medium,
           COALESCE(e.utm_campaign, '') AS utm_campaign, COALESCE(e.referred_by, '') AS referred_by,
           substr(e.created_at, 1, 10) AS created_on, k.last_pushed_at, k.local_updated_at
      FROM enquiries e
      LEFT JOIN classes c ON c.id = e.class_sought AND c.institution_id = e.institution_id
      LEFT JOIN users u ON u.id = e.assigned_to
      LEFT JOIN crm_lead_links k ON k.enquiry_id = e.id AND k.institution_id = e.institution_id AND k.provider = ?
     WHERE e.institution_id = ?
     ORDER BY e.created_at DESC
     LIMIT ?`).bind(provider, inst, limit).all<Record<string, string | null>>()
  const leads: Lead[] = []
  const links = new Map<string, Link>()
  for (const r of rs.results) {
    const s = (k: string) => String(r[k] ?? '')
    const l: Lead = {
      enquiryId: s('id'), externalId: s('external_id'), updatedAt: s('updated_at'),
      values: {
        student_name: s('student_name'), parent_name: s('parent_name'), phone: s('phone'), email: s('email'),
        class_sought: s('class_sought'), source: s('source'), campaign: s('campaign'), status: s('status'),
        assigned_to: s('assigned_to'), next_follow_up: s('next_follow_up'), notes: s('notes'), utm_source: s('utm_source'),
        utm_medium: s('utm_medium'), utm_campaign: s('utm_campaign'), referred_by: s('referred_by'), created_at: s('created_on'),
      },
    }
    if (l.externalId !== '') links.set(l.enquiryId, { enquiryId: l.enquiryId, lastSynced: r.last_pushed_at ?? null, localUpdated: r.local_updated_at ?? null })
    leads.push(l)
  }
  return { leads, links }
}

/** crmSettings: refuses rather than guessing when the school has not chosen a CRM. */
async function crmSettings(c: Ctx, inst: string): Promise<{ provider: string; direction: string; policy: string; transport: string }> {
  const r = await c.db.prepare(`SELECT provider, direction, conflict_policy, transport FROM crm_connector_settings WHERE institution_id = ?`)
    .bind(inst).first<{ provider: string | null; direction: string; conflict_policy: string; transport: string }>()
  if (!r) throw badRequest('this school has no CRM connector configured yet')
  if (!r.provider) throw badRequest('choose the CRM (Meritto or LeadSquared) before syncing')
  return { provider: r.provider, direction: r.direction, policy: r.conflict_policy, transport: r.transport }
}

const countsOf = () => ({} as Record<string, number>)
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }

// --- routes ---------------------------------------------------------------------------

export function registerConnectors(r: Router): void {
  // getCRMConnector
  r.get('/admin/connectors/crm', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const set: Record<string, unknown> = { provider: '', direction: 'push', conflict_policy: 'flag', transport: 'csv', is_enabled: false }
    const [srow, maps, links, enq] = await c.db.batch<Record<string, string | number | null>>([
      c.db.prepare(`SELECT provider, direction, conflict_policy, transport, is_enabled, last_synced_at, updated_at
          FROM crm_connector_settings WHERE institution_id = ?`).bind(inst),
      c.db.prepare(`SELECT local_field, crm_field, direction, is_required FROM crm_field_mappings WHERE institution_id = ?`).bind(inst),
      c.db.prepare(`SELECT sum(CASE WHEN conflict_at IS NULL THEN 1 ELSE 0 END) AS linked,
          sum(CASE WHEN conflict_at IS NOT NULL THEN 1 ELSE 0 END) AS conflicts FROM crm_lead_links WHERE institution_id = ?`).bind(inst),
      c.db.prepare(`SELECT count(*) AS n FROM enquiries WHERE institution_id = ?`).bind(inst),
    ])
    const s = srow.results[0]
    if (s) {
      set.provider = s.provider ?? ''
      set.direction = s.direction; set.conflict_policy = s.conflict_policy; set.transport = s.transport
      set.is_enabled = bool(s.is_enabled)
      const ls = rfc3339(s.last_synced_at); if (ls) set.last_synced_at = ls
      const up = rfc3339(s.updated_at); if (up) set.updated_at = up
    }
    const mapped = new Map<string, Record<string, unknown>>()
    for (const m of maps.results) {
      mapped.set(String(m.local_field), { local_field: m.local_field, label: '', crm_field: m.crm_field, direction: m.direction, is_required: bool(m.is_required), mapped: true })
    }
    const fields = LEAD_FIELDS.map((f) => {
      const m = mapped.get(f)
      if (m) return { ...m, label: LEAD_LABELS[f] }
      return { local_field: f, label: LEAD_LABELS[f], crm_field: '', direction: 'both', is_required: false, mapped: false }
    })
    return ok({
      settings: set,
      fields,
      systems: Object.entries(CRM_SYSTEMS).map(([key, name]) => ({ key, name })),
      transports: crmTransports(),
      mapped_fields: mapped.size,
      total_fields: LEAD_FIELDS.length,
      linked_leads: Number(links.results[0]?.linked ?? 0),
      conflicts: Number(links.results[0]?.conflicts ?? 0),
      enquiries: Number(enq.results[0]?.n ?? 0),
      live_sync_available: false,
      live_sync_note: CRM_LIVE_NOTE,
    })
  })

  // saveCRMConnector
  r.put('/admin/connectors/crm', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const req = await readJSON<{ provider?: string; direction?: string; conflict_policy?: string; transport?: string; is_enabled?: boolean }>(c.req)
    const provider = String(req.provider ?? '').trim()
    if (provider !== '' && !isCRMSystem(provider)) throw badRequest('the CRM must be Meritto or LeadSquared')
    if (!oneOf(req.direction, 'push', 'pull', 'both')) throw badRequest('direction must be push, pull or both')
    if (!oneOf(req.conflict_policy, 'ours', 'theirs', 'newest', 'flag')) throw badRequest('the conflict rule must be ours, theirs, newest or flag')
    if (!oneOf(req.transport, 'csv', 'api')) throw badRequest('transport must be csv or api')
    const enabled = req.is_enabled === true
    if (enabled && provider === '') throw badRequest('choose the CRM before switching the connector on')
    const at = now()
    await c.db.prepare(`INSERT INTO crm_connector_settings (institution_id, provider, direction, conflict_policy, transport, is_enabled, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET provider = excluded.provider, direction = excluded.direction,
          conflict_policy = excluded.conflict_policy, transport = excluded.transport, is_enabled = excluded.is_enabled,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(inst, provider === '' ? null : provider, req.direction, req.conflict_policy, req.transport, enabled ? 1 : 0, at, c.id.userId)
      .run().catch(ledgerFail)
    return ok({ ok: true })
  })

  // saveCRMMappings: replaces the whole mapping atomically.
  r.put('/admin/connectors/crm/mappings', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const req = await readJSON<{ mappings?: { local_field?: string; crm_field?: string; direction?: string; is_required?: boolean }[] }>(c.req)
    const keep: Mapping[] = []
    const seen = new Set<string>()
    for (const m of req.mappings ?? []) {
      const local = String(m.local_field ?? '').trim()
      const crm = String(m.crm_field ?? '').trim()
      if (crm === '') continue
      if (!isLeadField(local)) throw badRequest(`${JSON.stringify(local)} is not a lead field this connector can read`)
      if (seen.has(local)) throw badRequest(`${LEAD_LABELS[local]} is mapped twice; one field maps to one CRM field`)
      const dir = m.direction || 'both'
      if (!oneOf(dir, 'push', 'pull', 'both')) throw badRequest("a mapping's direction must be push, pull or both")
      seen.add(local)
      keep.push({ local_field: local, crm_field: crm, direction: dir, is_required: m.is_required === true })
    }
    const at = now()
    await c.db.batch([
      c.db.prepare(`DELETE FROM crm_field_mappings WHERE institution_id = ?`).bind(inst),
      ...keep.map((m) => c.db.prepare(`INSERT INTO crm_field_mappings (id, institution_id, local_field, crm_field, direction, is_required, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, m.local_field, m.crm_field, m.direction, m.is_required ? 1 : 0, at)),
    ]).catch(ledgerFail)
    return ok({ ok: true, mapped: keep.length })
  })

  // listCRMQueue: what a push would send. A read; writes no run.
  r.get('/admin/connectors/crm/queue', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const { provider } = await crmSettings(c, inst)
    const { leads, links } = await loadLeads(c, inst, provider, 500)
    const counts = countsOf()
    const items = leads.map((l) => {
      const [action, why] = decidePush(l, links.get(l.enquiryId))
      bump(counts, action)
      const row: Record<string, unknown> = { enquiry_id: l.enquiryId, student_name: l.values.student_name, phone: l.values.phone, status: l.values.status, action }
      if (l.externalId) row.external_id = l.externalId
      if (why) row.why = why
      return row
    })
    return ok({ items, counts })
  })

  // exportCRMLeads: records a run and claims the leads; the file is fetched by run.
  r.post('/admin/connectors/crm/export', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const { provider, transport } = await crmSettings(c, inst)
    const ms = await loadMappings(c, inst)
    if (forDirection(ms, 'push').length === 0) throw badRequest('no field is mapped for pushing; map at least the child\'s name and phone')
    const { leads, links } = await loadLeads(c, inst, provider, 5000)
    const counts = countsOf()
    const outcomes: { lead: Lead; action: Action; why: string }[] = []
    const send: Lead[] = []
    for (const l of leads) {
      const [action, why] = decidePush(l, links.get(l.enquiryId))
      outcomes.push({ lead: l, action, why }); bump(counts, action)
      if (action !== 'skipped') send.push(l)
    }
    // CRMProviderFor(transport, provider).Push: only the CSV route renders; the API routes refuse.
    if (transport === 'api') throw badRequest(CRM_API_UNAVAILABLE)
    renderLeadCSV(ms, send)

    const status = (counts.failed ?? 0) > 0 ? 'partial' : 'ok'
    const runID = uuid()
    const at = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO crm_sync_runs (id, institution_id, provider, direction, transport, status, considered,
          created_count, updated_count, skipped_count, failed_count, detail, started_at, finished_at, run_by)
          VALUES (?, ?, ?, 'push', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(runID, inst, provider, transport, status, leads.length, counts.created ?? 0, counts.updated ?? 0, counts.skipped ?? 0,
          counts.failed ?? 0, 'Exported as CSV for the CRM\'s bulk import. Nothing was sent over the network.', at, at, c.id.userId),
    ]
    for (const o of outcomes) {
      stmts.push(c.db.prepare(`INSERT INTO crm_sync_run_items (id, institution_id, run_id, enquiry_id, external_id, action, message)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, runID, o.lead.enquiryId, o.lead.externalId || null, o.action, o.why || null))
      if (o.action !== 'skipped' && o.lead.externalId !== '') {
        stmts.push(c.db.prepare(`UPDATE crm_lead_links SET last_pushed_at = ?, local_updated_at = ?
            WHERE institution_id = ? AND provider = ? AND enquiry_id = ?`).bind(at, o.lead.updatedAt, inst, provider, o.lead.enquiryId))
      }
    }
    await c.db.batch(stmts).catch(ledgerFail)
    return ok({
      run_id: runID, considered: leads.length, counts,
      download_url: '/api/v1/admin/connectors/crm/runs/' + runID + '/file',
      note: `Upload this file in the CRM's bulk import screen. Keep the ${EXTERNAL_ID} column: it is what stops the next import creating a second lead for the same child.`,
    })
  })

  // downloadCRMExport: re-renders exactly the rows a recorded run acted on.
  r.get('/admin/connectors/crm/runs/{id}/file', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const runID = c.params.id
    if (!isUUID(runID)) throw badRequest('invalid run id')
    const run = await c.db.prepare(`SELECT provider, transport, started_at FROM crm_sync_runs WHERE id = ? AND institution_id = ?`)
      .bind(runID, inst).first<{ provider: string; transport: string; started_at: string }>()
    if (!run) throw notFound()
    const ms = await loadMappings(c, inst)
    const wanted = new Set((await c.db.prepare(`SELECT enquiry_id FROM crm_sync_run_items
        WHERE run_id = ? AND institution_id = ? AND action <> 'skipped' AND enquiry_id IS NOT NULL`).bind(runID, inst)
      .all<{ enquiry_id: string }>()).results.map((x) => x.enquiry_id))
    const { leads } = await loadLeads(c, inst, run.provider, 5000)
    const body = renderLeadCSV(ms, leads.filter((l) => wanted.has(l.enquiryId)))
    const filename = `${run.provider}-leads-${String(run.started_at).slice(0, 10)}.csv`
    return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` } })
  })

  // importCRMLeads: applies a file the CRM produced. Never creates an enquiry.
  r.post('/admin/connectors/crm/import', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const req = await readJSON<{ csv?: string }>(c.req)
    const csv = String(req.csv ?? '')
    if (csv.trim() === '') throw badRequest('upload the file the CRM exported')
    const { provider, policy, transport } = await crmSettings(c, inst)
    const ms = await loadMappings(c, inst)
    if (transport === 'api') throw badRequest(CRM_API_UNAVAILABLE)
    if (csv.length === 0) throw badRequest(CSV_PULL_IS_UPLOAD)
    const rows = parseLeadCSV(ms, csv)

    const existing = new Map((await c.db.prepare(`SELECT external_id, enquiry_id, last_pulled_at, local_updated_at
        FROM crm_lead_links WHERE institution_id = ? AND provider = ?`).bind(inst, provider)
      .all<{ external_id: string; enquiry_id: string; last_pulled_at: string | null; local_updated_at: string | null }>()).results
      .map((k) => [k.external_id, { enquiryId: k.enquiry_id, lastSynced: k.last_pulled_at, localUpdated: k.local_updated_at } as Link]))
    const enquiryIds = new Set<string>()
    const named = [...new Set(rows.map((x) => x.enquiryId).filter(isUUID))]
    for (let i = 0; i < named.length; i += 90) {
      const chunk = named.slice(i, i + 90)
      const rs = await c.db.prepare(`SELECT id FROM enquiries WHERE institution_id = ? AND id IN (SELECT value FROM json_each(?))`)
        .bind(inst, JSON.stringify(chunk)).all<{ id: string }>()
      for (const x of rs.results) enquiryIds.add(x.id)
    }

    const runID = uuid()
    const at = now()
    const counts = countsOf()
    const writes: D1PreparedStatement[] = []
    const items: D1PreparedStatement[] = []
    for (const row of rows) {
      const link = existing.get(row.externalId) ?? null
      let [action, why] = decideImport(row, link, policy)
      if (action === 'created') {
        const match = row.enquiryId
        if (match === '') {
          action = 'failed'; why = `row ${row.line} matches no enquiry here: it has no ${ENQUIRY_ID} and is not linked`
        } else if (!isUUID(match)) {
          action = 'failed'; why = `row ${row.line}: ${ENQUIRY_ID} is not an enquiry in this school`
        } else if (!enquiryIds.has(match)) {
          action = 'failed'; why = `row ${row.line}: no enquiry here with that id`
        } else {
          writes.push(c.db.prepare(`INSERT INTO crm_lead_links (id, institution_id, provider, enquiry_id, external_id, external_status,
              remote_updated_at, last_pulled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
              ON CONFLICT (institution_id, provider, external_id) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`)
            .bind(uuid(), inst, provider, match, row.externalId, row.values.status || null, at, at))
          // A second row for the same external id in this file sees the link, as in Go's transaction.
          existing.set(row.externalId, { enquiryId: match, lastSynced: at, localUpdated: null })
        }
      }
      if (action === 'updated') {
        writes.push(c.db.prepare(`UPDATE crm_lead_links SET external_status = ?, remote_updated_at = NULL, last_pulled_at = ?,
            conflict_at = NULL, conflict_note = NULL WHERE institution_id = ? AND provider = ? AND external_id = ?`)
          .bind(row.values.status || null, at, inst, provider, row.externalId))
        const l = existing.get(row.externalId); if (l) l.lastSynced = at
      }
      if (action === 'conflict') {
        writes.push(c.db.prepare(`UPDATE crm_lead_links SET conflict_at = ?, conflict_note = ?, external_status = ?, remote_updated_at = NULL
            WHERE institution_id = ? AND provider = ? AND external_id = ?`)
          .bind(at, why, row.values.status || null, inst, provider, row.externalId))
      }
      bump(counts, action)
      const enq = link ? link.enquiryId : row.enquiryId
      items.push(c.db.prepare(`INSERT INTO crm_sync_run_items (id, institution_id, run_id, enquiry_id, external_id, action, message)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, runID, isUUID(enq) ? enq : null, row.externalId, action, why || null))
    }
    const status = (counts.failed ?? 0) > 0 || (counts.conflict ?? 0) > 0 ? 'partial' : 'ok'
    await c.db.batch([
      c.db.prepare(`INSERT INTO crm_sync_runs (id, institution_id, provider, direction, transport, status, considered, created_count,
          updated_count, skipped_count, conflict_count, failed_count, started_at, finished_at, run_by)
          VALUES (?, ?, ?, 'pull', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(runID, inst, provider, transport, status, rows.length, counts.created ?? 0, counts.updated ?? 0, counts.skipped ?? 0,
          counts.conflict ?? 0, counts.failed ?? 0, at, at, c.id.userId),
      ...writes, ...items,
      c.db.prepare(`UPDATE crm_connector_settings SET last_synced_at = ? WHERE institution_id = ?`).bind(at, inst),
    ]).catch(ledgerFail)
    return ok({ run_id: runID, considered: rows.length, counts })
  })

  // listCRMRuns
  r.get('/admin/connectors/crm/runs', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const rs = await c.db.prepare(`SELECT id, provider, direction, transport, status, considered, created_count, updated_count,
        skipped_count, conflict_count, failed_count, detail, started_at FROM crm_sync_runs WHERE institution_id = ?
        ORDER BY started_at DESC LIMIT 100`).bind(inst).all<Record<string, string | number | null>>()
    return ok({
      items: rs.results.map((v) => {
        const o: Record<string, unknown> = {
          id: v.id, provider: v.provider, direction: v.direction, transport: v.transport, status: v.status,
          considered: Number(v.considered), created_count: Number(v.created_count), updated_count: Number(v.updated_count),
          skipped_count: Number(v.skipped_count), conflict_count: Number(v.conflict_count), failed_count: Number(v.failed_count),
        }
        if (v.detail !== null) o.detail = v.detail
        o.started_at = rfc3339(v.started_at) ?? ''
        return o
      }),
    })
  })

  // listCRMRunItems
  r.get('/admin/connectors/crm/runs/{id}/items', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    if (!isUUID(c.params.id)) throw badRequest('invalid run id')
    const rs = await c.db.prepare(`SELECT i.action, i.external_id, i.enquiry_id, e.student_name, i.message
        FROM crm_sync_run_items i LEFT JOIN enquiries e ON e.id = i.enquiry_id AND e.institution_id = i.institution_id
       WHERE i.run_id = ? AND i.institution_id = ?
       ORDER BY i.action, e.student_name IS NULL, e.student_name LIMIT 1000`).bind(c.params.id, inst).all<Record<string, string | null>>()
    return ok({
      items: rs.results.map((v) => {
        const o: Record<string, unknown> = { action: v.action }
        if (v.external_id !== null) o.external_id = v.external_id
        if (v.enquiry_id !== null) o.enquiry_id = v.enquiry_id
        if (v.student_name !== null) o.student_name = v.student_name
        if (v.message !== null) o.message = v.message
        return o
      }),
    })
  })

  // listCRMConflicts
  r.get('/admin/connectors/crm/conflicts', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const rs = await c.db.prepare(`SELECT k.id, k.enquiry_id, k.external_id, e.student_name, e.phone, e.status, k.external_status,
        k.conflict_at, k.conflict_note, k.remote_updated_at, k.local_updated_at
        FROM crm_lead_links k JOIN enquiries e ON e.id = k.enquiry_id AND e.institution_id = k.institution_id
       WHERE k.institution_id = ? AND k.conflict_at IS NOT NULL ORDER BY k.conflict_at DESC LIMIT 200`)
      .bind(inst).all<Record<string, string | null>>()
    return ok({
      items: rs.results.map((v) => {
        const o: Record<string, unknown> = {
          id: v.id, enquiry_id: v.enquiry_id, external_id: v.external_id, student_name: v.student_name, phone: v.phone, our_status: v.status,
        }
        if (v.external_status !== null) o.their_status = v.external_status
        o.conflict_at = rfc3339(v.conflict_at) ?? ''
        if (v.conflict_note !== null) o.conflict_note = v.conflict_note
        const ru = rfc3339(v.remote_updated_at); if (ru) o.remote_updated_at = ru
        const lu = rfc3339(v.local_updated_at); if (lu) o.local_updated_at = lu
        return o
      }),
    })
  })

  // resolveCRMConflict: a human's decision clears the flag.
  r.post('/admin/connectors/crm/conflicts/{id}/resolve', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    if (!isUUID(c.params.id)) throw badRequest('invalid link id')
    const req = await readJSON<{ keep?: string }>(c.req)
    if (!oneOf(req.keep, 'ours', 'theirs')) throw badRequest('say which side to keep: ours or theirs')
    const at = now()
    const res = await c.db.prepare(`UPDATE crm_lead_links SET conflict_at = NULL, conflict_note = NULL,
        last_pulled_at = CASE WHEN ? = 'theirs' THEN ? ELSE last_pulled_at END,
        last_pushed_at = CASE WHEN ? = 'ours' THEN ? ELSE last_pushed_at END
        WHERE id = ? AND institution_id = ? AND conflict_at IS NOT NULL`)
      .bind(req.keep, at, req.keep, at, c.params.id, inst).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound()
    return ok({ ok: true })
  })

  // getCRMCredentials: metadata only, never the key.
  r.get('/admin/connectors/crm/credentials', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const items: Record<string, unknown>[] = []
    if (c.id.institution) {
      const rs = await c.db.prepare(`SELECT provider, base_url, notes,
          (credentials IS NOT NULL AND length(credentials) > 0) AS has_secret, (institution_id IS NULL) AS is_default, updated_at
          FROM crm_api_credentials WHERE COALESCE(institution_id, ?) = ? ORDER BY provider`)
        .bind(NIL_UUID, c.id.institution.id).all<Record<string, string | number | null>>()
      for (const v of rs.results) {
        items.push({
          provider: v.provider, base_url: v.base_url ?? '', notes: v.notes ?? '', has_credentials: bool(v.has_secret),
          is_installation_default: bool(v.is_default), updated_at: rfc3339(v.updated_at) ?? '',
        })
      }
    }
    return ok({ items, live_sync_available: false, note: CRM_LIVE_NOTE })
  })

  // saveCRMCredentials
  r.put('/admin/connectors/crm/credentials', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const inst = connectorInstitution(c)
    const req = await readJSON<{ provider?: string; base_url?: string; secret?: string | null; notes?: string }>(c.req)
    if (!isCRMSystem(req.provider)) throw badRequest('the CRM must be Meritto or LeadSquared')
    const { sealed, clear } = await sealedSecretFrom(c, req.secret)
    const baseURL = String(req.base_url ?? '').trim() || null
    const notes = String(req.notes ?? '').trim() || null
    const at = now()
    const cur = await c.db.prepare(`SELECT id FROM crm_api_credentials WHERE provider = ? AND institution_id = ?`)
      .bind(req.provider, inst).first<{ id: string }>()
    if (cur) {
      await c.db.prepare(`UPDATE crm_api_credentials SET base_url = ?,
          credentials = CASE WHEN ? THEN NULL ELSE COALESCE(?, credentials) END, notes = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
        .bind(baseURL, clear ? 1 : 0, sealed, notes, at, c.id.userId, cur.id).run()
    } else {
      await c.db.prepare(`INSERT INTO crm_api_credentials (id, institution_id, provider, base_url, credentials, notes, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, req.provider, baseURL, sealed, notes, at, c.id.userId).run().catch(ledgerFail)
    }
    return ok({ ok: true })
  })

  // getMeetingConnector
  r.get('/admin/connectors/meetings', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const accounts: Record<string, unknown>[] = []
    let pending = 0, joinable = 0
    if (c.id.institution) {
      const inst = c.id.institution.id
      const [acc, sess] = await c.db.batch<Record<string, string | number | null>>([
        c.db.prepare(`SELECT id, provider, display_name, account_ref, auth_style, base_url,
            (credentials IS NOT NULL AND length(credentials) > 0) AS has_credentials, is_enabled,
            (institution_id IS NULL) AS is_default, notes, updated_at
            FROM virtual_meeting_platform_providers WHERE institution_id IS NULL OR institution_id = ?
            ORDER BY institution_id IS NULL DESC, provider`).bind(inst),
        c.db.prepare(`SELECT sum(CASE WHEN join_url IS NULL THEN 1 ELSE 0 END) AS pending,
            sum(CASE WHEN join_url IS NOT NULL THEN 1 ELSE 0 END) AS joinable
            FROM virtual_class_sessions WHERE institution_id = ? AND status <> 'cancelled'`).bind(inst),
      ])
      for (const v of acc.results) {
        const o: Record<string, unknown> = { id: v.id, provider: v.provider, display_name: v.display_name }
        if (v.account_ref !== null) o.account_ref = v.account_ref
        o.auth_style = v.auth_style
        if (v.base_url !== null) o.base_url = v.base_url
        o.has_credentials = bool(v.has_credentials); o.is_enabled = bool(v.is_enabled); o.is_installation_default = bool(v.is_default)
        if (v.notes !== null) o.notes = v.notes
        o.updated_at = rfc3339(v.updated_at) ?? ''
        accounts.push(o)
      }
      pending = Number(sess.results[0]?.pending ?? 0); joinable = Number(sess.results[0]?.joinable ?? 0)
    }
    // count(DISTINCT institution_id) FROM virtual_class_providers WHERE is_active, across every school.
    let schoolsUsing = 0
    for (const { db } of await fleetDbs(c)) {
      const r1 = await db.prepare(`SELECT count(DISTINCT institution_id) AS n FROM virtual_class_providers WHERE is_active = 1`).first<{ n: number }>()
      schoolsUsing += Number(r1?.n ?? 0)
    }
    return ok({
      accounts,
      routes: meetingRoutes.map(({ key, label, live_create }) => ({ key, label, live_create })),
      systems: Object.entries(MEETING_SYSTEMS).map(([key, name]) => ({ key, name })),
      auth_styles: Object.entries(AUTH_STYLES).map(([key, name]) => ({ key, name })),
      sessions_awaiting_url: pending,
      sessions_joinable: joinable,
      schools_using: schoolsUsing,
      live_create_available: false,
      live_create_note: MEETING_LIVE_NOTE,
    })
  })

  // saveMeetingProvider
  r.put('/admin/connectors/meetings/providers', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ provider?: string; display_name?: string; account_ref?: string; auth_style?: string; base_url?: string;
      secret?: string | null; is_enabled?: boolean; notes?: string; is_installation_default?: boolean }>(c.req)
    if (!isMeetingSystem(req.provider)) throw badRequest('the provider must be Zoom, Google Meet or Microsoft Teams')
    const displayName = String(req.display_name ?? '').trim()
    if (displayName === '') throw badRequest('name the account, so support knows which one this is')
    const authStyle = req.auth_style || 'oauth_s2s'
    if (!(authStyle in AUTH_STYLES)) throw badRequest('unknown authentication style')
    const isDefault = req.is_installation_default === true
    if (!c.id.institution) {
      // The installation default is kept in the acting school's database: with no school there is nowhere to write it.
      throw badRequest('choose the school this account belongs to, or mark it the installation default')
    }
    const { sealed, clear } = await sealedSecretFrom(c, req.secret)
    const scope = isDefault ? null : c.id.institution.id
    const nz = (s: unknown) => String(s ?? '').trim() || null
    const at = now()
    const cur = await c.db.prepare(`SELECT id FROM virtual_meeting_platform_providers WHERE provider = ? AND COALESCE(institution_id, ?) = ?`)
      .bind(req.provider, NIL_UUID, scope ?? NIL_UUID).first<{ id: string }>()
    if (cur) {
      await c.db.prepare(`UPDATE virtual_meeting_platform_providers SET display_name = ?, account_ref = ?, auth_style = ?, base_url = ?,
          credentials = CASE WHEN ? THEN NULL ELSE COALESCE(?, credentials) END, is_enabled = ?, notes = ?, updated_at = ?, updated_by = ?
          WHERE id = ?`)
        .bind(displayName, nz(req.account_ref), authStyle, nz(req.base_url), clear ? 1 : 0, sealed, req.is_enabled === true ? 1 : 0,
          nz(req.notes), at, c.id.userId, cur.id).run().catch(ledgerFail)
    } else {
      await c.db.prepare(`INSERT INTO virtual_meeting_platform_providers (id, institution_id, provider, display_name, account_ref, auth_style,
          base_url, credentials, is_enabled, notes, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), scope, req.provider, displayName, nz(req.account_ref), authStyle, nz(req.base_url), sealed,
          req.is_enabled === true ? 1 : 0, nz(req.notes), at, c.id.userId).run().catch(ledgerFail)
    }
    return ok({ ok: true })
  })

  // deleteMeetingProvider
  r.del('/admin/connectors/meetings/providers/{id}', PERM_VENDOR, async (c) => {
    platformOnly(c)
    if (!isUUID(c.params.id)) throw badRequest('invalid provider id')
    const res = await c.db.prepare(`DELETE FROM virtual_meeting_platform_providers WHERE id = ?`).bind(c.params.id).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound()
    return ok({ ok: true })
  })

  // listMeetingRequests
  r.get('/admin/connectors/meetings/requests', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const rs = await c.db.prepare(`SELECT q.id, q.session_id, v.topic, v.scheduled_at, q.provider, q.status, q.detail, q.join_url, q.requested_at
        FROM virtual_meeting_requests q JOIN virtual_class_sessions v ON v.id = q.session_id AND v.institution_id = q.institution_id
       WHERE q.institution_id = ? ORDER BY q.requested_at DESC LIMIT 200`).bind(inst).all<Record<string, string | null>>()
    return ok({
      items: rs.results.map((v) => {
        const o: Record<string, unknown> = {
          id: v.id, session_id: v.session_id, topic: v.topic, scheduled_at: rfc3339(v.scheduled_at) ?? '', provider: v.provider, status: v.status,
        }
        if (v.detail !== null) o.detail = v.detail
        if (v.join_url !== null) o.join_url = v.join_url
        o.requested_at = rfc3339(v.requested_at) ?? ''
        return o
      }),
    })
  })

  // requestMeeting: the seam. Only 'manual' yields a meeting; the others record their refusal.
  r.post('/admin/connectors/meetings/sessions/{id}/meeting', PERM_VENDOR, async (c) => {
    const inst = connectorInstitution(c)
    const sessionID = c.params.id
    if (!isUUID(sessionID)) throw badRequest('invalid session id')
    const req = await readJSON<{ provider?: string; join_url?: string }>(c.req)
    const provider = req.provider || 'manual'
    if (provider !== 'manual' && !isMeetingSystem(provider)) throw badRequest('unknown meeting provider')
    const sess = await c.db.prepare(`SELECT topic FROM virtual_class_sessions WHERE id = ? AND institution_id = ?`)
      .bind(sessionID, inst).first<{ topic: string }>()
    if (!sess) throw notFound()

    let status: string, detail: string, joinURL = ''
    if (provider === 'manual') {
      const url = String(req.join_url ?? '').trim()
      if (url === '') throw badRequest(MANUAL_URL_REQUIRED)
      if (!url.startsWith('https://') && !url.startsWith('http://')) {
        status = 'manual'; detail = `${JSON.stringify(url)} is not a meeting link: it should begin with https://`
      } else {
        status = 'manual'; detail = 'Link supplied by hand. No meeting was created through a provider API.'; joinURL = url
      }
    } else {
      // The live providers refuse by name; nothing reaches Zoom, Meet or Teams.
      const route = meetingRoutes.find((x) => x.key === provider)!
      status = 'manual'; detail = `${MEETING_API_UNAVAILABLE} (this provider needs ${route.needs})`
    }
    const queueStatus: string = status === 'manual' || status === 'created' ? status : status === '' ? 'manual' : 'failed'
    const at = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO virtual_meeting_requests (id, institution_id, session_id, provider, status, detail, join_url, meeting_ref,
          requested_at, requested_by, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
        .bind(uuid(), inst, sessionID, provider, queueStatus, detail || null, joinURL || null, at, c.id.userId, at),
    ]
    if (joinURL !== '') {
      stmts.push(c.db.prepare(`UPDATE virtual_class_sessions SET join_url = ?,
          status = CASE WHEN status = 'provider_pending' THEN 'scheduled' ELSE status END, updated_at = ?
          WHERE id = ? AND institution_id = ?`).bind(joinURL, at, sessionID, inst))
    }
    await c.db.batch(stmts).catch(ledgerFail)
    return ok({ status, detail, join_url: joinURL, live_create_available: false })
  })
}
