import { beforeAll, expect, it } from 'vitest'
import { E, IDS, call, seed } from './fixture'

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

it('Fetch history: the next check-in asks once for everything, and the answer is stored', async () => {
  const dev = (await T().prepare(`SELECT id FROM biometric_devices WHERE serial = ?`).bind(SN).first<{ id: string }>())!.id
  await T().prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, 1, '{}')`).bind(IDS.school, `biometric_history:${dev}`).run()
  const cmd = await (await call(`/iclock/getrequest?SN=${SN}`)).text()
  expect(cmd).toMatch(/DATA QUERY ATTLOG/)
  expect(await (await call(`/iclock/getrequest?SN=${SN}`)).text()).toBe('OK')
  // A newer reader answers in key=value form.
  const r = await call(`/iclock/querydata?SN=${SN}&type=tabledata&tablename=ATTLOG`, { method: 'POST', body: 'ATTLOG PIN=7\tTime=2026-10-01 09:02:00\tStatus=0\tVerify=1\n' })
  expect(await r.text()).toBe('OK: 1')
  const n = await T().prepare(`SELECT count(*) AS n FROM biometric_punches WHERE punched_at LIKE '2026-10-01%'`).first<{ n: number }>()
  expect(n!.n).toBe(1)
})
