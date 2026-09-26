import type { Router, Ctx } from '../../router'
import { badRequest, bool, now, ok, readJSON } from '../../http'
import { institutionId, parseJSON } from './common'

/* Port of mountReportDigests' settings screen (internal/api/report_digest.go).
   The digest builder and sender are a scheduled job, not routes, and are not
   here. */

const KEYS = ['attendance_summary', 'fees_collected_dues', 'admissions_enrolment', 'staff_attendance_leave']
const LABELS: Record<string, string> = {
  attendance_summary: 'Student attendance',
  fees_collected_dues: 'Fees: collected & dues',
  admissions_enrolment: 'Admissions & enrolment',
  staff_attendance_leave: 'Staff attendance & leave',
}
const CHANNELS = new Set(['email', 'sms', 'whatsapp', 'in_app'])

interface ChannelCfg { enabled: boolean; channels: string[] }
type Config = Record<string, ChannelCfg>

const reports = () => KEYS.map((k) => ({ key: k, label: LABELS[k] }))

function defaults(): { config: Config; daily: boolean; weekly: boolean } {
  const config: Config = {}
  for (const k of KEYS) config[k] = { enabled: true, channels: ['email', 'in_app'] }
  return { config, daily: true, weekly: true }
}

async function recipients(c: Ctx, inst: string) {
  const rows = await c.db.prepare(`
    SELECT u.id AS user_id, u.full_name AS name, min(r.key) AS role
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
     WHERE u.institution_id = ? AND u.status = 'active'
       AND r.key IN ('board_member','institution_admin')
     GROUP BY u.id, u.full_name
     ORDER BY u.full_name`).bind(inst).all<{ user_id: string; name: string; role: string }>()
  return rows.results
}

async function respond(c: Ctx, inst: string, config: Config, daily: boolean, weekly: boolean): Promise<Response> {
  const recips = await recipients(c, inst)
  return ok({ config, daily_enabled: daily, weekly_enabled: weekly, reports: reports(),
    recipients: recips, recipient_count: recips.length })
}

async function getSettings(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const row = await c.db.prepare(`SELECT config, daily_enabled, weekly_enabled
    FROM report_digest_settings WHERE institution_id = ?`).bind(inst).first<any>()
  if (!row) {
    const d = defaults()
    return respond(c, inst, d.config, d.daily, d.weekly)
  }
  return respond(c, inst, parseJSON<Config>(row.config, {}) ?? {}, bool(row.daily_enabled), bool(row.weekly_enabled))
}

async function putSettings(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const b = await readJSON<any>(c.req)
  const cfg = b.config && typeof b.config === 'object' ? b.config as Record<string, any> : {}
  const clean: Config = {}
  for (const k of KEYS) {
    if (!(k in cfg)) continue
    const e = cfg[k] ?? {}
    const seen = new Set<string>()
    const chans: string[] = []
    for (const raw of Array.isArray(e.channels) ? e.channels : []) {
      const ch = typeof raw === 'string' ? raw.trim() : ''
      if (CHANNELS.has(ch) && !seen.has(ch)) { seen.add(ch); chans.push(ch) }
    }
    const enabled = e.enabled === true
    if (enabled && chans.length === 0) {
      throw badRequest(`"${LABELS[k]}" is switched on but has no channel selected -- choose a channel or switch it off`)
    }
    clean[k] = { enabled, channels: chans }
  }
  const daily = b.daily_enabled === true, weekly = b.weekly_enabled === true
  const at = now()
  await c.db.prepare(`
    INSERT INTO report_digest_settings
        (institution_id, config, daily_enabled, weekly_enabled, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (institution_id) DO UPDATE
       SET config = excluded.config, daily_enabled = excluded.daily_enabled,
           weekly_enabled = excluded.weekly_enabled, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`)
    .bind(inst, JSON.stringify(clean), daily ? 1 : 0, weekly ? 1 : 0, c.id.userId, at, at).run()
  return respond(c, inst, clean, daily, weekly)
}

export function registerReportDigest(r: Router): void {
  r.get('/reports/digest/settings', 'admin.reports.read', getSettings)
  r.put('/reports/digest/settings', 'institution.settings.write', putSettings)
}
