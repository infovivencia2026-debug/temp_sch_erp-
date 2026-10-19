/* Mail addresses from a staff list file (communication.mail_addresses):
   the browser reads the code, name and email columns out of the CSV, the
   server dry-runs the match, and Apply writes only the lines marked assign. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'
import { readMailImportCsv, type MailImportRow } from '../../../shared/api/feature_mail_addresses'

const DOMAIN = 'staff.import-test.example'

const CSV: string[][] = [
  ['Staff email list'],
  [''],
  ['E.I.D.', 'Staff Name', 'Email ID', 'Password'],
  ['E01', 'Somebody Else', `farah@${DOMAIN}`, 'secret-one'],
  ['E02', 'Tara  teacher', `tara@${DOMAIN}`, 'secret-two'],
  ['E02', 'No Such Person', `nobody@${DOMAIN}`, 'secret-three'],
  ['E99', 'Asha Admin', 'asha@other.example', 'secret-four'],
  ['', 'Asha Admin', 'not an email', 'secret-five'],
]

let rows: MailImportRow[] = []

beforeAll(async () => {
  await seed()
  const campus = (await E.TENANT_TEST.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await E.TENANT_TEST.batch([
    ['E01', 'Farah', 'Finance', IDS.finance], ['E02', 'Tara', 'Teacher', IDS.teacher],
  ].map(([code, first, last, user]) => E.TENANT_TEST.prepare(
    `INSERT INTO employees (institution_id, campus_id, user_id, employee_code, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(IDS.school, campus, user, code, first, last)))
  const read = readMailImportCsv(CSV)
  if ('error' in read) throw new Error(read.error)
  rows = read.rows
})

describe('reading the file', () => {
  it('skips the title lines and never reads the password column', () => {
    expect(rows.map((r) => r.line)).toEqual([4, 5, 6, 7, 8])
    expect(rows[0]).toEqual({ line: 4, code: 'E01', name: 'Somebody Else', email: `farah@${DOMAIN}` })
    expect(JSON.stringify(rows)).not.toContain('secret')
  })
  it('turns away a file with no usable header', () => {
    expect('error' in readMailImportCsv([['Name', 'Phone'], ['A', '1']])).toBe(true)
  })
})

describe('import', () => {
  it('needs comms.mail.manage', async () => {
    expect((await api('teacher', 'POST', '/comms/mail-addresses/import/preview', { rows })).status).toBe(403)
    expect((await api('finance', 'POST', '/comms/mail-addresses/import', { rows })).status).toBe(403)
  })

  it('offers the file\'s domain when none is set, and refuses to apply without one', async () => {
    const p = await api('admin', 'POST', '/comms/mail-addresses/import/preview', { rows: rows.slice(0, 3) })
    expect(p.status).toBe(200)
    expect(p.body.domain).toBe(null)
    expect(p.body.suggested_domain).toBe(DOMAIN)
    expect((await api('admin', 'POST', '/comms/mail-addresses/import', { rows })).status).toBe(409)
  })

  it('previews each line without writing', async () => {
    expect((await api('admin', 'PUT', '/comms/mail-addresses/domain', { domain: DOMAIN })).status).toBe(200)
    // A password sent anyway is dropped unread.
    const p = await api('admin', 'POST', '/comms/mail-addresses/import/preview', { rows: rows.map((r) => ({ ...r, password: 'x' })) })
    expect(p.status).toBe(200)
    const by = Object.fromEntries(p.body.rows.map((r: any) => [r.line, r]))
    expect(by[4]).toMatchObject({ result: 'assign', user_id: IDS.finance, matched_by: 'code' })
    // E02 is on two lines, so each falls back to the name.
    expect(by[5]).toMatchObject({ result: 'assign', user_id: IDS.teacher, matched_by: 'name' })
    expect(by[6]).toMatchObject({ result: 'unmatched', user_id: null })
    expect(by[7]).toMatchObject({ result: 'domain', user_id: IDS.admin, matched_by: 'name' })
    expect(by[8].result).toBe('invalid')
    expect(p.body.rows.some((r: any) => 'password' in r)).toBe(false)
    const n = await E.TENANT_TEST.prepare('SELECT COUNT(*) AS n FROM mail_addresses').first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  it('flags an address used twice or held by someone else', async () => {
    const twice = await api('admin', 'POST', '/comms/mail-addresses/import/preview', {
      rows: [{ line: 1, code: 'E01', name: '', email: `same@${DOMAIN}` }, { line: 2, code: '', name: 'Asha Admin', email: `same@${DOMAIN}` }],
    })
    expect(twice.body.rows.map((r: any) => r.result)).toEqual(['duplicate', 'duplicate'])
  })

  it('applies only the valid lines', async () => {
    const a = await api('admin', 'POST', '/comms/mail-addresses/import', { rows })
    expect(a.status).toBe(200)
    expect(a.body.assigned).toBe(2)
    const held = await E.TENANT_TEST.prepare('SELECT user_id, address, status FROM mail_addresses ORDER BY address').all<any>()
    expect(held.results).toEqual([
      { user_id: IDS.finance, address: `farah@${DOMAIN}`, status: 'active' },
      { user_id: IDS.teacher, address: `tara@${DOMAIN}`, status: 'active' },
    ])
    const again = await api('admin', 'POST', '/comms/mail-addresses/import/preview', { rows })
    expect(again.body.rows.filter((r: any) => r.result === 'already').map((r: any) => r.line)).toEqual([4, 5])
    const taken = await api('admin', 'POST', '/comms/mail-addresses/import/preview', {
      rows: [{ line: 1, code: '', name: 'Asha Admin', email: `farah@${DOMAIN}` }],
    })
    expect(taken.body.rows[0].result).toBe('duplicate')
  })
})
