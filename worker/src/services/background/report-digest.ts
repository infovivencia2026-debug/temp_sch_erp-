import type { Env } from '../../env'
import type { Institution } from '../../tenant'
import { renderDigestPDF, DIGEST_REPORT_LABELS } from '../pdf'
import { specs } from '../../routes/admin/export'
import { localDate } from './schools'
import { Messenger, MessagingError } from '../messaging'

/* SendReportDigest from internal/api/report_digest.go: one school's daily or
   weekly digest, one combined message per recipient per channel, the email
   carrying a PDF summary and the CSV datasets behind each report. */

const REPORT_KEYS = ['attendance_summary', 'fees_collected_dues', 'admissions_enrolment', 'staff_attendance_leave']
const OTHER_CHANNEL_NOTE = 'The full PDF report and data files were sent to the email address on file.'
const EXPORTS_FOR: Record<string, string[]> = {
  attendance_summary: ['attendance'],
  fees_collected_dues: ['collections', 'fees_by_student', 'defaulters'],
  admissions_enrolment: ['admissions'],
  staff_attendance_leave: ['staff-attendance', 'leave'],
}

interface ChannelCfg { enabled: boolean; channels: string[] }
interface Range { period: string; from: string; to: string; label: string }
interface DigestAttachment { filename: string; content_type: string; data: Uint8Array }

function rangeFor(period: string, today: string): Range {
  if (period === 'weekly') {
    const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 6)
    const from = d.toISOString().slice(0, 10)
    return { period, from, to: today, label: `the week ${from} to ${today}` }
  }
  return { period: 'daily', from: today, to: today, label: today }
}

const rupees = (paise: number) => '₹' + (paise / 100).toFixed(2)

async function section(db: D1Database, key: string, r: Range): Promise<string> {
  switch (key) {
    case 'attendance_summary': {
      const x = await db.prepare(`SELECT count(*) FILTER (WHERE status IN ('present','late')) AS present,
          count(*) FILTER (WHERE status = 'absent') AS absent, count(*) AS total
        FROM student_attendance WHERE on_date BETWEEN ? AND ?`).bind(r.from, r.to).first<{ present: number; absent: number; total: number }>()
      if (!x || !x.total) return 'No student attendance was marked in this period.'
      return `Registers marked: ${x.total}. Present/late: ${x.present}. Absent: ${x.absent}. Attendance: ${Math.floor(100 * x.present / x.total)}%.`
    }
    case 'fees_collected_dues': {
      const x = await db.prepare(`SELECT
          COALESCE((SELECT sum(amount_paise) FROM payments WHERE status = 'success' AND mode <> 'adjustment' AND paid_on BETWEEN ?1 AND ?2), 0) AS collected,
          (SELECT count(*) FROM payments WHERE status = 'success' AND mode <> 'adjustment' AND paid_on BETWEEN ?1 AND ?2) AS receipts,
          COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?2), 0) AS overdue,
          (SELECT count(DISTINCT student_id) FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?2) AS defaulters`)
        .bind(r.from, r.to).first<{ collected: number; receipts: number; overdue: number; defaulters: number }>()
      return `Collected: ${rupees(x?.collected ?? 0)} across ${x?.receipts ?? 0} receipts. Overdue outstanding: ${rupees(x?.overdue ?? 0)} from ${x?.defaulters ?? 0} students.`
    }
    case 'admissions_enrolment': {
      const x = await db.prepare(`SELECT
          (SELECT count(*) FROM applications WHERE date(created_at, '+330 minutes') BETWEEN ?1 AND ?2) AS enquiries,
          (SELECT count(*) FROM applications WHERE status IN ('submitted','under_review','test_scheduled','interviewed')) AS awaiting,
          (SELECT count(*) FROM applications WHERE status = 'accepted') AS accepted`)
        .bind(r.from, r.to).first<{ enquiries: number; awaiting: number; accepted: number }>()
      return `New applications this period: ${x?.enquiries ?? 0}. Awaiting a decision: ${x?.awaiting ?? 0}. Accepted (to date): ${x?.accepted ?? 0}.`
    }
    case 'staff_attendance_leave': {
      const x = await db.prepare(`SELECT count(DISTINCT user_id) FILTER (WHERE status = 'absent') AS absent,
          count(DISTINCT user_id) FILTER (WHERE status = 'leave') AS leave
        FROM staff_attendance WHERE on_date BETWEEN ? AND ?`).bind(r.from, r.to).first<{ absent: number; leave: number }>()
      return `Staff absent: ${x?.absent ?? 0}. On leave: ${x?.leave ?? 0}.`
    }
  }
  return ''
}

function renderBody(school: string, periodWord: string, r: Range, reports: string[], blocks: Record<string, string>, note: string): string {
  let b = `${periodWord} report digest for ${school}\n${r.label}\n\n`
  for (const k of reports) b += `${DIGEST_REPORT_LABELS[k]}\n${blocks[k]}\n\n`
  if (note) b += note + '\n\n'
  return b + school
}

/** encoding/csv's quoting rule. */
function csvField(f: string): string {
  if (f === '') return f
  if (f === '\\.' || /[,"\r\n]/.test(f) || /^\s/.test(f)) return '"' + f.replace(/"/g, '""') + '"'
  return f
}

/** digestCSVAttachments: one CSV per export dataset the reports map to, BOM + header like the download screen. */
async function csvAttachments(db: D1Database, enabled: string[], r: Range, today: string): Promise<DigestAttachment[]> {
  const dateRange = r.period === 'weekly' ? `${r.from}_${r.to}` : r.to
  const all = specs(today)
  const slugs = [...new Set(enabled.flatMap((k) => EXPORTS_FOR[k] ?? []))]
  const out: DigestAttachment[] = []
  const enc = new TextEncoder()
  for (const slug of slugs) {
    const spec = all[slug]
    if (!spec) continue
    const n = spec.header.length
    const rows = await db.prepare(spec.query).raw<unknown[]>()
    let text = '﻿' + spec.header.map(csvField).join(',') + '\n'
    for (const vals of rows) {
      const rec: string[] = []
      for (let i = 0; i < n; i++) rec.push(vals[i] == null ? '' : String(vals[i]).trim())
      text += rec.map(csvField).join(',') + '\n'
    }
    out.push({ filename: `${slug}-${dateRange}.csv`, content_type: 'text/csv; charset=utf-8', data: enc.encode(text) })
  }
  return out
}

export async function sendReportDigest(env: Env, inst: Institution, db: D1Database, period: 'daily' | 'weekly'): Promise<void> {
  const row = await db.prepare(`SELECT config, daily_enabled, weekly_enabled FROM report_digest_settings WHERE institution_id = ?`)
    .bind(inst.id).first<{ config: string; daily_enabled: number; weekly_enabled: number }>()
  let cfg: Record<string, ChannelCfg>
  let daily = true, weekly = true
  if (!row) {
    cfg = Object.fromEntries(REPORT_KEYS.map((k) => [k, { enabled: true, channels: ['email', 'in_app'] }]))
  } else {
    cfg = row.config ? JSON.parse(row.config) : {}
    daily = !!row.daily_enabled; weekly = !!row.weekly_enabled
  }
  if ((period === 'daily' && !daily) || (period === 'weekly' && !weekly)) return

  const enabled = REPORT_KEYS.filter((k) => cfg[k]?.enabled && (cfg[k].channels?.length ?? 0) > 0)
  if (!enabled.length) return

  const recips = (await db.prepare(`SELECT u.id AS user_id FROM users u
      JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE u.institution_id = ? AND u.status = 'active' AND r.key IN ('board_member','institution_admin')
     GROUP BY u.id, u.full_name ORDER BY u.full_name`).bind(inst.id).all<{ user_id: string }>()).results ?? []
  if (!recips.length) return

  const school = inst.name
  const today = localDate(inst.timezone)
  const r = rangeFor(period, today)
  const blocks: Record<string, string> = {}
  for (const k of enabled) blocks[k] = await section(db, k, r)

  const byChannel: Record<string, string[]> = {}
  for (const k of enabled) for (const ch of cfg[k].channels) (byChannel[ch] ??= []).push(k)
  const periodWord = period === 'weekly' ? 'Weekly' : 'Daily'
  const subject = `${school}: ${periodWord} report digest, ${r.label}`

  const ms = new Messenger({ env, db, inst: inst.id })
  for (const ch of Object.keys(byChannel).sort()) {
    let note = OTHER_CHANNEL_NOTE
    const atts: DigestAttachment[] = []
    if (ch === 'email') {
      note = ''
      atts.push({ filename: `report-digest-${period}-${today}.pdf`, content_type: 'application/pdf',
        data: await renderDigestPDF(school, periodWord, r.label, byChannel[ch], blocks) })
      atts.push(...await csvAttachments(db, byChannel[ch], r, today))
    }
    const body = renderBody(school, periodWord, r, byChannel[ch], blocks, note)
    for (const rec of recips) {
      try {
        await ms.queue({
          channel: ch, template_code: 'report_digest.' + period, to_user_id: rec.user_id,
          vars: { subject, body, school_name: school }, source_kind: 'report_digest',
          occurrence_key: `${period}:${ch}:${today}`, attachments: atts,
        })
      } catch (err) {
        // No address for this channel, or a channel never configured: skip, carry on.
        if (err instanceof MessagingError && (err.code === 'no_recipient' || err.code === 'provider_not_configured')) continue
        throw err
      }
    }
  }
  await ms.kick()
}
