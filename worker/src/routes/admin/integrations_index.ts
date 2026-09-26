import type { Router, Ctx } from '../../router'
import { bool, ok } from '../../http'
import { can } from '../../identity'
import { integrationRows, loadProviders } from './providers'
import { fleetAll, rfc3339 } from './platform_fleet'
import { school } from '../school'

/* Port of internal/api/integrations_index.go: one read-only index over every
   connector, each reporting its own state. The per-school half reads the
   acting school's database; the platform half (CRM keys, meeting accounts,
   Child Info portals) reads every school's database, as AsPlatform read the
   one shared Postgres, and only for platform staff holding
   platform.tenants.write. */

const CANNOT_JUDGE = 'This connector records no success or failure of its own. ' +
  'What is shown is the last run it filed; an empty history means nothing has run, ' +
  'not that everything is well.'
const TALLY_STALE_AFTER_DAYS = 14
const CRM_LIVE_NOTE = 'No CRM API key is configured on this installation, and no request ' +
  "is made to Meritto or LeadSquared. The CSV route is the working one: export " +
  "here, import in the CRM's own bulk upload, and bring the file back the same way."
const MEETING_LIVE_NOTE = 'No meeting provider credential is configured on this ' +
  'installation, so no meeting is created automatically. Teachers paste the join ' +
  'link into the session as they do today, and the launcher works exactly as before.'

interface Entry {
  key: string; label: string; group: string; scope: string; provider?: string
  enabled: boolean; configured: boolean; reason?: string
  health: string; health_note?: string
  last_ok_at?: string; last_ok_label?: string; last_error?: string | null; last_error_at?: string
  silent_days?: number; stale_after_days?: number; failed_recently?: number
  live_available?: boolean; live_note?: string
  fix_key: string; fix_label: string
}

function humanDays(days: number): string {
  if (days <= 1) return 'a day'
  if (days < 14) return `${days} days`
  if (days < 60) return `${Math.trunc(days / 7)} weeks`
  return `${Math.trunc(days / 30)} months`
}

async function institutionIntegrations(c: Ctx): Promise<Entry[]> {
  const out: Entry[] = []
  const rows = await integrationRows(c)
  const set = await loadProviders(c, rows)
  const stored = new Map(rows.map((r) => [r.provider, r]))
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const failed = new Map((await c.db.prepare(`SELECT channel, sum(CASE WHEN status = 'failed' AND queued_at > ? THEN 1 ELSE 0 END) AS failed
      FROM message_log GROUP BY channel`).bind(cutoff).all<{ channel: string; failed: number }>()).results.map((r) => [r.channel, Number(r.failed ?? 0)]))

  for (const ch of [
    { key: 'email', label: 'Email (SMTP)', fixKey: 'super_admin.messaging.email_server_smtp_integration', fixLabel: 'Email Server (SMTP)' },
    { key: 'sms', label: 'SMS', fixKey: 'super_admin.messaging.sms_gateway_integration', fixLabel: 'SMS gateway' },
    { key: 'whatsapp', label: 'WhatsApp', fixKey: 'super_admin.messaging.whatsapp_api_integration', fixLabel: 'WhatsApp API' },
  ]) {
    const st = stored.get(ch.key)
    const p = set[ch.key]
    const e: Entry = { key: 'messaging.' + ch.key, label: ch.label, group: 'Messaging', scope: 'institution', fix_key: ch.fixKey, fix_label: ch.fixLabel,
      enabled: st ? bool(st.enabled) : false, configured: false, health: '' }
    if (p) { e.provider = p.name || undefined; e.configured = p.configured; e.reason = p.why || undefined }
    e.last_ok_at = rfc3339(st?.last_ok_at)
    e.last_error = st?.last_error ?? null
    e.last_ok_label = 'last successful Test connection. Not a delivery receipt'
    const f = failed.get(ch.key) ?? 0
    e.failed_recently = f
    if (!e.configured) e.health = 'not_configured'
    else if (st?.last_error) e.health = 'failing'
    else if (f > 0) { e.health = 'failing'; e.health_note = 'the provider reports itself ready, but messages failed in the last 24 hours' }
    else if (!st?.last_ok_at) { e.health = 'idle'; e.health_note = 'set up, but the connection has never been tested' }
    else e.health = 'ok'
    out.push(e)
  }

  // --- Tally ---
  const t: Entry = { key: 'tally', label: 'Tally ERP / Prime', group: 'Finance', scope: 'institution',
    fix_key: 'super_admin.payments_devices.tally_erp_prime_connector', fix_label: 'Tally connector', enabled: false, configured: false, health: '' }
  const set2 = await c.db.prepare(`SELECT company_name, delivery, is_enabled FROM tally_connector_settings WHERE institution_id = ?`)
    .bind(school(c).id).first<{ company_name: string | null; delivery: string; is_enabled: number }>()
  t.enabled = bool(set2?.is_enabled)
  t.provider = set2?.delivery ?? 'file'
  t.configured = (set2?.company_name ?? '') !== ''
  if (!t.configured) t.reason = 'No Tally company is configured. Set it on the Tally connector before exporting.'
  else if (!t.enabled) t.reason = 'configured but switched off'
  t.live_available = false
  t.live_note = 'Tally Prime has no cloud API. Export the XML and import it in Tally: Gateway of Tally, then Import, then Vouchers.'
  const last = await c.db.prepare(`SELECT max(exported_at) AS at FROM tally_export_runs WHERE institution_id = ?`).bind(school(c).id).first<{ at: string | null }>()
  t.last_ok_label = 'last export filed'
  if (!t.configured || !t.enabled) t.health = 'not_configured'
  else if (!last?.at) {
    t.health = 'unknown'; t.health_note = 'switched on, but no export has ever been filed. ' + CANNOT_JUDGE; t.stale_after_days = TALLY_STALE_AFTER_DAYS
  } else {
    t.last_ok_at = rfc3339(last.at)
    const silent = Math.trunc((Date.now() - Date.parse(last.at)) / 86_400_000)
    t.silent_days = silent; t.stale_after_days = TALLY_STALE_AFTER_DAYS
    if (silent >= TALLY_STALE_AFTER_DAYS) { t.health = 'stale'; t.health_note = 'no export has been filed in ' + humanDays(silent) + '. ' + CANNOT_JUDGE }
    else { t.health = 'ok'; t.health_note = CANNOT_JUDGE }
  }
  out.push(t)
  return out
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b)

async function platformIntegrations(c: Ctx): Promise<Entry[]> {
  let crmKeys = 0, meetAccounts = 0
  let crmOK: string | null = null, crmFailAt: string | null = null, crmFailDetail: string | null = null
  let meetOK: string | null = null, meetFailAt: string | null = null, meetDetail: string | null = null
  const portals = new Map<string, Record<string, unknown>>()
  const seenCreds = new Set<string>(), seenMeet = new Set<string>()
  for (const f of await fleetAll(c)) {
    if (!f.db) continue
    const db = f.db
    const [creds, meets, crmRuns, meetReqs, ci] = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT id FROM crm_api_credentials WHERE credentials IS NOT NULL AND length(credentials) > 0`),
      db.prepare(`SELECT id FROM virtual_meeting_platform_providers WHERE is_enabled = 1 AND credentials IS NOT NULL AND length(credentials) > 0`),
      db.prepare(`SELECT (SELECT max(finished_at) FROM crm_sync_runs WHERE status = 'ok') AS ok_at,
          (SELECT started_at FROM crm_sync_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1) AS fail_at,
          (SELECT detail FROM crm_sync_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1) AS fail_detail`),
      db.prepare(`SELECT (SELECT max(resolved_at) FROM virtual_meeting_requests WHERE status = 'created') AS ok_at,
          (SELECT requested_at FROM virtual_meeting_requests WHERE status = 'failed' ORDER BY requested_at DESC LIMIT 1) AS fail_at,
          (SELECT detail FROM virtual_meeting_requests WHERE status = 'failed' ORDER BY requested_at DESC LIMIT 1) AS fail_detail`),
      db.prepare(`SELECT id, state_code, name, provider, endpoint_url, (credentials IS NOT NULL AND length(credentials) > 0) AS has_secret,
          is_enabled, last_sync_at, last_status, last_error FROM child_info_portal_connectors`),
    ])
    for (const x of creds.results) if (!seenCreds.has(String(x.id))) { seenCreds.add(String(x.id)); crmKeys++ }
    for (const x of meets.results) if (!seenMeet.has(String(x.id))) { seenMeet.add(String(x.id)); meetAccounts++ }
    const cr = crmRuns.results[0] ?? {}
    crmOK = later(crmOK, (cr.ok_at as string | null) ?? null)
    if (cr.fail_at && later(crmFailAt, cr.fail_at as string) === cr.fail_at) { crmFailAt = cr.fail_at as string; crmFailDetail = (cr.fail_detail as string | null) ?? null }
    const mr = meetReqs.results[0] ?? {}
    meetOK = later(meetOK, (mr.ok_at as string | null) ?? null)
    if (mr.fail_at && later(meetFailAt, mr.fail_at as string) === mr.fail_at) { meetFailAt = mr.fail_at as string; meetDetail = (mr.fail_detail as string | null) ?? null }
    for (const x of ci.results) if (!portals.has(String(x.id))) portals.set(String(x.id), x)
  }
  const out: Entry[] = []

  const crm: Entry = { key: 'crm', label: 'Meritto / LeadSquared', group: 'Admissions', scope: 'platform',
    fix_key: 'super_admin.payments_devices.meritto_leadsquared_sync', fix_label: 'CRM sync',
    configured: crmKeys > 0, enabled: crmKeys > 0, health: '', live_available: false, live_note: CRM_LIVE_NOTE, last_ok_label: 'last completed sync run' }
  if (!crm.configured) crm.reason = 'no CRM API key is recorded on this installation'
  crm.last_ok_at = rfc3339(crmOK)
  if (crmFailAt) { crm.last_error_at = rfc3339(crmFailAt); crm.last_error = crmFailDetail }
  if (!crm.configured) crm.health = 'not_configured'
  else if (crmFailAt && (!crmOK || Date.parse(crmFailAt) > Date.parse(crmOK))) crm.health = 'failing'
  else if (!crmOK) { crm.health = 'idle'; crm.health_note = 'a key is recorded, but no sync run has completed' }
  else crm.health = 'ok'
  out.push(crm)

  const meet: Entry = { key: 'meetings', label: 'Zoom / Meet / Teams', group: 'Teaching', scope: 'platform',
    fix_key: 'super_admin.payments_devices.virtual_classroom_integration', fix_label: 'Virtual classroom',
    configured: meetAccounts > 0, enabled: meetAccounts > 0, health: '', live_available: false, live_note: MEETING_LIVE_NOTE,
    last_ok_label: 'last meeting created automatically' }
  if (!meet.configured) meet.reason = 'no meeting provider account with a credential is switched on'
  meet.last_ok_at = rfc3339(meetOK)
  if (meetFailAt) { meet.last_error_at = rfc3339(meetFailAt); meet.last_error = meetDetail }
  if (!meet.configured) meet.health = 'not_configured'
  else if (meetFailAt && (!meetOK || Date.parse(meetFailAt) > Date.parse(meetOK))) meet.health = 'failing'
  else if (!meetOK) { meet.health = 'idle'; meet.health_note = 'an account is recorded, but no meeting has been created automatically' }
  else meet.health = 'ok'
  out.push(meet)

  const list = [...portals.values()].sort((a, b) => String(a.state_code).localeCompare(String(b.state_code)) || String(a.name).localeCompare(String(b.name)))
  for (const row of list) {
    // childInfoProviderFor(provider).Ready, as statutory.ts ports it.
    let ready = true, blocker = ''
    if (row.provider === 'api') {
      ready = false
      if (!bool(row.has_secret)) blocker = 'no portal credentials have been entered'
      else if (String(row.endpoint_url ?? '').trim() === '') blocker = 'no portal endpoint has been recorded'
      else blocker = 'live portal sync needs state portal API credentials and an endpoint the state publishes; neither exists for this installation today. ' +
        "Use the file exchange: export the roster, upload it on the portal, and import the portal's extract into Child Info Reconciliation."
    } else if (!bool(row.is_enabled)) { ready = false; blocker = 'the connector is switched off' }
    const failedLast = row.last_status === 'failed'
    const e: Entry = { key: 'child_info.' + row.id, label: `Child Info - ${row.state_code} · ${row.name}`, group: 'Statutory', scope: 'platform',
      provider: String(row.provider) || undefined, enabled: bool(row.is_enabled), configured: ready, reason: blocker || undefined,
      last_error: (row.last_error as string | null) ?? null, last_ok_label: 'last portal sync',
      fix_key: 'super_admin.statutory_boards.child_info_portal_sync', fix_label: 'Child Info portal sync', health: '' }
    if (row.last_sync_at) { if (failedLast) e.last_error_at = rfc3339(row.last_sync_at); else e.last_ok_at = rfc3339(row.last_sync_at) }
    if (failedLast) e.health = 'failing'
    else if (!ready) e.health = 'not_configured'
    else if (!row.last_sync_at) { e.health = 'idle'; e.health_note = 'ready, but no sync has been recorded' }
    else e.health = 'ok'
    out.push(e)
  }
  return out
}

export function registerIntegrationsIndex(r: Router): void {
  r.get('/admin/integrations/index', 'institution.read', async (c) => {
    const platformView = c.id.platformAdmin && can(c.id, 'platform.tenants.write')
    const haveInstitution = !!c.id.institution
    const items: Entry[] = []
    if (haveInstitution) items.push(...await institutionIntegrations(c))
    if (platformView) items.push(...await platformIntegrations(c))
    let working = 0, attention = 0, notSetUp = 0
    for (const it of items) {
      if (it.health === 'ok') working++
      else if (it.health === 'failing' || it.health === 'stale') attention++
      else if (it.health === 'not_configured') notSetUp++
    }
    // omitempty on last_error (a *string): drop nulls.
    for (const it of items) if (it.last_error === null || it.last_error === undefined) delete it.last_error
    return ok({
      items, institution_selected: haveInstitution, platform_view: platformView,
      counts: { working, attention, not_configured: notSetUp, total: items.length },
      note: 'Each connector reports its own state. Nothing on this screen is a ' +
        'second opinion, and a connector that keeps no record of success or ' +
        'failure says so rather than being counted as healthy.',
    })
  })
}
