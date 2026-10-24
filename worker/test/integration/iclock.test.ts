import { beforeAll, expect, it } from 'vitest'
import { E, IDS, call, seed } from './fixture'
import { zkTime } from '../../src/routes/iclock'

/* An eSSL reader (X2008) pushing punches over the iclock protocol, with no
   static IP at the school (owner, 2026-10-13). */
const T = () => E.TENANT_TEST
const SN = 'ESSLX2008TEST'

beforeAll(async () => {
  await seed()
  await T().prepare(`INSERT INTO biometric_devices (id, institution_id, serial, name, is_active, created_at) VALUES (?, ?, ?, 'Staff room', 1, ?)`)
    .bind(crypto.randomUUID(), IDS.school, SN, new Date().toISOString()).run()
  const campus = (await T().prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>())!.id
  await T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name, user_id, device_user_id, status) VALUES (?, ?, ?, 'E7', 'Tara', ?, 7, 'active')`)
    .bind(crypto.randomUUID(), IDS.school, campus, IDS.teacher).run()
})

it('answers the hello with its options, and an unknown reader politely', async () => {
  const r = await call(`/iclock/cdata?SN=${SN}&options=all&pushver=2.4.1`)
  // No time zone: eSSL firmware read 5.5 as whole hours and set its clock half an hour out.
  expect(await r.clone().text()).not.toMatch(/TimeZone/)
  expect(r.status).toBe(200)
  expect(await r.text()).toContain(`GET OPTION FROM: ${SN}`)
  expect(await (await call('/iclock/getrequest?SN=NOSUCH')).text()).toBe('OK')
})

it('stores each punch once and marks the day present, in and out', async () => {
  const body = '7\t2026-10-12 08:41:02\t0\t1\t0\t0\n7\t2026-10-12 16:05:40\t1\t1\t0\t0\n99\t2026-10-12 08:50:00\t0\t1\t0\t0\n'
  const r = await call(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=1`, { method: 'POST', body })
  expect(await r.text()).toBe('OK: 3')
  // The same lines again: nothing doubles.
  await call(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=2`, { method: 'POST', body })
  const p = await T().prepare(`SELECT device_user_id, employee_id IS NOT NULL AS matched FROM biometric_punches ORDER BY punched_at`).all<{ device_user_id: string; matched: number }>()
  expect(p.results.map((x) => `${x.device_user_id}:${x.matched}`)).toEqual(['7:1', '99:0', '7:1'])
  const a = await T().prepare(`SELECT status, check_in, check_out, source FROM staff_attendance WHERE user_id = ? AND on_date = '2026-10-12'`).bind(IDS.teacher)
    .first<{ status: string; check_in: string; check_out: string; source: string }>()
  expect(a).toMatchObject({ status: 'present', source: 'device' })
  expect(a!.check_in < a!.check_out).toBe(true)
})

it('a second tap minutes after arriving is not the time they left', async () => {
  const body = '7\t2026-10-13 08:43:19\t0\t1\t0\t0\n7\t2026-10-13 08:52:07\t0\t1\t0\t0\n'
  await call(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=3`, { method: 'POST', body })
  const a = await T().prepare(`SELECT check_in, check_out FROM staff_attendance WHERE user_id = ? AND on_date = '2026-10-13'`).bind(IDS.teacher)
    .first<{ check_in: string; check_out: string | null }>()
  expect(a!.check_in).toBeTruthy()
  expect(a!.check_out).toBeNull()
})

it('Fetch history: the next check-in asks once for everything, and the answer is stored', async () => {
  const dev = (await T().prepare(`SELECT id FROM biometric_devices WHERE serial = ?`).bind(SN).first<{ id: string }>())!.id
  await T().prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, 1, '{}')`).bind(IDS.school, `biometric_history:${dev}`).run()
  const cmd = await (await call(`/iclock/getrequest?SN=${SN}`)).text()
  expect(cmd).toMatch(/DATA QUERY ATTLOG/)
  // Asked once: the next check-in is not asked for history again (it may be set the time instead).
  expect(await (await call(`/iclock/getrequest?SN=${SN}`)).text()).not.toMatch(/DATA QUERY/)
  // A newer reader answers in key=value form.
  const r = await call(`/iclock/querydata?SN=${SN}&type=tabledata&tablename=ATTLOG`, { method: 'POST', body: 'ATTLOG PIN=7\tTime=2026-10-01 09:02:00\tStatus=0\tVerify=1\n' })
  expect(await r.text()).toBe('OK: 1')
  const n = await T().prepare(`SELECT count(*) AS n FROM biometric_punches WHERE punched_at LIKE '2026-10-01%'`).first<{ n: number }>()
  expect(n!.n).toBe(1)
})

it('sets the reader clock to India time on first contact, then not again within the hour', async () => {
  await T().prepare(`DELETE FROM module_settings WHERE module LIKE 'iclock_clock:%'`).run()
  const first = await (await call(`/iclock/getrequest?SN=${SN}`)).text()
  const m = /^C:\d+:SET OPTIONS DateTime=(\d+)\n$/.exec(first)
  expect(m).not.toBeNull()
  expect(Math.abs(Number(m![1]) - zkTime(new Date()))).toBeLessThan(5)
  expect(await (await call(`/iclock/getrequest?SN=${SN}`)).text()).toBe('OK')
})

it('packs the time the way the readers read it', () => {
  // 2026-10-23 10:15:30 IST is 04:45:30 UTC.
  expect(zkTime(new Date('2026-10-23T04:45:30Z'))).toBe(((26 * 12 * 31 + 9 * 31 + 22) * 86400) + (10 * 60 + 15) * 60 + 30)
})

it('with the clock set to auto, a reader 30 minutes slow has its punch stored at the real time', async () => {
  await T().prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, 'biometric_clock', 1, '{"auto":true}')
      ON CONFLICT (institution_id, module) DO UPDATE SET enabled = 1, config = excluded.config`).bind(IDS.school).run()
  const deviceNow = new Date(Date.now() + (330 - 30) * 60_000).toISOString().slice(0, 19).replace('T', ' ')
  await call(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=9`, { method: 'POST', body: `7\t${deviceNow}\t0\t1\t0\t0\n` })
  const p = await T().prepare(`SELECT punched_at FROM biometric_punches ORDER BY created_at DESC LIMIT 1`).first<{ punched_at: string }>()
  expect(Math.abs(Date.parse(p!.punched_at) - Date.now())).toBeLessThan(3 * 60_000)
  await T().prepare(`DELETE FROM module_settings WHERE module = 'biometric_clock'`).run()
})
