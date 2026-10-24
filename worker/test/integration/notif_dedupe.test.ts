/* Owner, 2026-10-24: "so many" repeated notifications. One "marked absent"
   bell per person, child and day; a later present mark takes it away; the
   report digest goes only to the principal and school admin, and only the
   newest stays in the bell. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'
import { dispatchMessages } from '../../src/services/messaging'
import { digestRecipients } from '../../src/services/background/report-digest'

beforeAll(seed)
const db = () => E.TENANT_TEST
const day = isoDay(-2)
const absentBells = async (dismissed: boolean) => (await db().prepare(`SELECT count(*) AS n FROM notifications
    WHERE user_id = ? AND student_id = ? AND kind = 'attendance' AND dismissed_at IS ${dismissed ? 'NOT ' : ''}NULL`)
  .bind(IDS.otherParent, IDS.otherChild).first<{ n: number }>())!.n
const mark = (status: string) => api('teacher', 'POST', '/attendance', {
  section_id: IDS.section, on_date: day, entries: [{ student_id: IDS.otherChild, status }],
})

describe('absence alerts', () => {
  it('a parent linked twice, a re-marked register: one bell', async () => {
    // A second guardian record for the same parent account.
    const g2 = '00000000-0000-4000-8000-00000000b001'
    await db().batch([
      db().prepare(`INSERT INTO guardians (id, institution_id, full_name, relation, phone, email, user_id) VALUES (?, ?, 'Olga Other', 'mother', '9000000009', NULL, ?)`)
        .bind(g2, IDS.school, IDS.otherParent),
      db().prepare(`INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary) VALUES (?, ?, ?, 0)`).bind(IDS.otherChild, g2, IDS.school),
    ])
    expect((await mark('absent')).status).toBe(200)
    await mark('absent')
    await mark('late')
    await mark('absent')
    expect(await absentBells(false)).toBe(1)
    expect(await absentBells(true)).toBe(0)
  })

  it('marked present after absent takes the bell away', async () => {
    await mark('present')
    expect(await absentBells(false)).toBe(0)
    expect(await absentBells(true)).toBe(1)
  })
})

describe('report digest', () => {
  it('goes only to the principal and the school admin', async () => {
    const ids = (await digestRecipients(db(), IDS.school)).map((r) => r.user_id)
    expect(ids).toContain(IDS.admin)
    for (const u of [IDS.teacher, IDS.parent, IDS.otherParent, IDS.finance]) expect(ids).not.toContain(u)
  })

  it('a new daily digest leaves only the newest in the bell', async () => {
    for (const [i, id] of ['00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002'].entries()) {
      await db().prepare(`INSERT INTO message_log (id, institution_id, channel, template_code, user_id, recipient, subject, body, status, queued_at, attempts)
          VALUES (?, ?, 'in_app', 'report_digest.daily', ?, ?, 'Daily report digest', 'day ' || ?, 'queued', ?, 0)`)
        .bind(id, IDS.school, IDS.admin, IDS.admin, i, new Date().toISOString()).run()
      await dispatchMessages(E, db(), IDS.school, 20)
    }
    const rows = (await db().prepare(`SELECT source_id, dismissed_at FROM notifications WHERE user_id = ? AND kind = 'report_digest.daily'`)
      .bind(IDS.admin).all<{ source_id: string; dismissed_at: string | null }>()).results
    expect(rows.length).toBe(2)
    expect(rows.filter((r) => r.dismissed_at === null).map((r) => r.source_id)).toEqual(['00000000-0000-4000-8000-00000000c002'])
  })
})
