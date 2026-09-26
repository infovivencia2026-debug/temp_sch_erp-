import type { Router } from '../../router'
import { badRequest, isUUID, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { tenantDb, institutionById } from '../../tenant'
import { platformOnly } from './common'
import { PERM_VENDOR, NIL_UUID, credentialKeyPresent, fleetDbs, rfc3339, sealedSecretFrom } from './connectors_common'

/* Port of internal/api/platform_gateways.go: payment gateway merchant keys and
   the biometric reader fleet, both platform scope.

   Go read these across every school through AsPlatform. Here each school's
   D1 is read in turn (schools without a binding are skipped). A row for one
   school is written to that school's database; an installation-default row
   (institution_id NULL) is written to the acting school's database. Nothing
   is ever sent to a gateway, exactly as in Go (live_checkout_available is
   false), so no 501 stub is needed. */

const GATEWAYS: Record<string, string> = { razorpay: 'Razorpay', paytm: 'Paytm', ccavenue: 'CCAvenue', billdesk: 'BillDesk', easebuzz: 'Easebuzz' }

export function registerPlatformGateways(r: Router): void {
  // listPaymentGateways
  r.get('/admin/connectors/payment-gateways', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const fleet = await fleetDbs(c)
    const names = new Map(fleet.map((f) => [f.inst.id, f.inst.name]))
    const seen = new Set<string>()
    const items: Record<string, unknown>[] = []
    for (const { db } of fleet) {
      const rs = await db.prepare(`SELECT id, institution_id, provider, mode, COALESCE(key_id, '') AS key_id,
          (key_secret IS NOT NULL AND length(key_secret) > 0) AS has_secret,
          (webhook_secret IS NOT NULL AND length(webhook_secret) > 0) AS has_webhook_secret,
          is_enabled, COALESCE(notes, '') AS notes, updated_at FROM payment_gateway_credentials`).all<Record<string, string | number | null>>()
      for (const v of rs.results) {
        if (seen.has(String(v.id))) continue
        seen.add(String(v.id))
        const inst = v.institution_id === null ? null : String(v.institution_id)
        const row: Record<string, unknown> = {
          id: v.id, institution_id: inst, school: inst === null ? 'Every school' : (names.get(inst) ?? 'Every school'),
          provider: v.provider, provider_label: GATEWAYS[String(v.provider)] ?? '', mode: v.mode, key_id: v.key_id,
          has_secret: bool(v.has_secret), has_webhook_secret: bool(v.has_webhook_secret), is_enabled: bool(v.is_enabled), notes: v.notes,
        }
        const up = rfc3339(v.updated_at); if (up) row.updated_at = up
        items.push(row)
      }
    }
    // ORDER BY institution_id IS NOT NULL, school name, provider.
    items.sort((a, b) => Number(a.institution_id !== null) - Number(b.institution_id !== null)
      || String(a.institution_id === null ? '' : a.school).localeCompare(String(b.institution_id === null ? '' : b.school))
      || String(a.provider).localeCompare(String(b.provider)))
    const schools = (await c.env.CONTROL.prepare(`SELECT id, name FROM institutions WHERE status = 'active' ORDER BY name`)
      .all<{ id: string; name: string }>()).results.map((s) => ({ value: s.id, label: s.name }))
    return ok({
      items,
      providers: Object.entries(GATEWAYS).map(([value, label]) => ({ value, label })),
      schools,
      live_checkout_available: false,
      note: 'Keys are recorded for the day an online checkout is wired. No payment ' +
        'is taken through this product today, and nothing here is sent to a gateway.',
      credential_key_present: credentialKeyPresent(c),
    })
  })

  // savePaymentGateway
  r.put('/admin/connectors/payment-gateways', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ institution_id?: string; provider?: string; mode?: string; key_id?: string; secret?: string | null;
      webhook_secret?: string | null; is_enabled?: boolean; notes?: string }>(c.req)
    const provider = String(req.provider ?? '').trim().toLowerCase()
    if (!(provider in GATEWAYS)) throw badRequest('choose one of Razorpay, Paytm, CCAvenue, BillDesk or Easebuzz')
    const mode = req.mode || 'test'
    if (mode !== 'test' && mode !== 'live') throw badRequest('mode is test or live')
    let inst: string | null = null
    const rawInst = String(req.institution_id ?? '').trim()
    if (rawInst !== '') {
      if (!isUUID(rawInst)) throw badRequest('institution_id must be a uuid')
      inst = rawInst.toLowerCase()
    }
    const key = await sealedSecretFrom(c, req.secret)
    const hook = await sealedSecretFrom(c, req.webhook_secret)

    let db: D1Database
    if (inst !== null) {
      const row = await institutionById(c.env, inst)
      if (!row) throw badRequest('that refers to something which does not exist')
      db = tenantDb(c.env, row)
    } else {
      if (!c.id.institution) throw badRequest('choose a school first: the installation default is kept with the school being acted on')
      db = c.db
    }
    const enabled = req.is_enabled === true
    const keyID = String(req.key_id ?? '').trim() || null
    const notes = String(req.notes ?? '').trim() || null
    const at = now()
    const cur = await db.prepare(`SELECT id FROM payment_gateway_credentials WHERE COALESCE(institution_id, ?) = ? AND provider = ?`)
      .bind(NIL_UUID, inst ?? NIL_UUID, provider).first<{ id: string }>()
    const id = cur?.id ?? uuid()
    if (cur) {
      await db.prepare(`UPDATE payment_gateway_credentials SET mode = ?, key_id = ?,
          key_secret = CASE WHEN ? THEN NULL ELSE COALESCE(?, key_secret) END,
          webhook_secret = CASE WHEN ? THEN NULL ELSE COALESCE(?, webhook_secret) END,
          is_enabled = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
        .bind(mode, keyID, key.clear ? 1 : 0, key.sealed, hook.clear ? 1 : 0, hook.sealed, enabled ? 1 : 0, notes, at, c.id.userId, id).run()
    } else {
      await db.prepare(`INSERT INTO payment_gateway_credentials (id, institution_id, provider, mode, key_id, key_secret, webhook_secret,
          is_enabled, notes, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, provider, mode, keyID, key.sealed, hook.sealed, enabled ? 1 : 0, notes, at, c.id.userId).run()
    }
    const has = await db.prepare(`SELECT (key_secret IS NOT NULL AND length(key_secret) > 0) AS h FROM payment_gateway_credentials WHERE id = ?`)
      .bind(id).first<{ h: number }>()
    let leftOff = false
    if (enabled && !bool(has?.h)) {
      leftOff = true
      await db.prepare(`UPDATE payment_gateway_credentials SET is_enabled = 0 WHERE id = ?`).bind(id).run()
    }
    const out: Record<string, unknown> = { id, is_enabled: enabled && !leftOff }
    if (leftOff) out.note = 'Saved, but left switched off: there is no secret behind this key yet.'
    return ok(out)
  })

  // deletePaymentGateway: the row lives in whichever school's database holds it.
  r.del('/admin/connectors/payment-gateways/{id}', PERM_VENDOR, async (c) => {
    platformOnly(c)
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    let deleted = 0
    for (const { db } of await fleetDbs(c)) {
      const res = await db.prepare(`DELETE FROM payment_gateway_credentials WHERE id = ?`).bind(c.params.id).run()
      deleted += res.meta.changes ?? 0
    }
    if (deleted === 0) throw notFound()
    return ok({ ok: true })
  })

  // listBiometricFleet: every school's readers, read-only.
  r.get('/admin/biometric-devices', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const items: Record<string, unknown>[] = []
    const sum = { devices: 0, active: 0, seen_today: 0, quiet: 0, never_seen: 0, schools: 0 }
    const schools = new Set<string>()
    const todayUTC = new Date().toISOString().slice(0, 10)
    for (const { inst, db } of await fleetDbs(c)) {
      const rs = await db.prepare(`SELECT d.institution_id, c.name AS campus, d.id, d.serial, d.name, d.is_active, d.last_seen_at,
          d.last_push_at, d.firmware,
          (SELECT count(*) FROM biometric_punches p WHERE p.device_id = d.id AND p.punched_at >= ?) AS punches_today,
          (SELECT count(*) FROM biometric_punches p WHERE p.device_id = d.id AND p.employee_id IS NULL) AS unresolved
          FROM biometric_devices d LEFT JOIN campuses c ON c.id = d.campus_id ORDER BY d.name`)
        .bind(todayUTC).all<Record<string, string | number | null>>()
      for (const v of rs.results) {
        const active = bool(v.is_active)
        const row: Record<string, unknown> = {
          institution_id: v.institution_id, school: inst.name, campus: v.campus ?? null, id: v.id, serial: v.serial, name: v.name, is_active: active,
        }
        const seen = rfc3339(v.last_seen_at); if (seen) row.last_seen_at = seen
        const push = rfc3339(v.last_push_at); if (push) row.last_push_at = push
        if (v.firmware !== null) row.firmware = v.firmware
        row.punches_today = Number(v.punches_today); row.unresolved = Number(v.unresolved)
        let quiet = false
        sum.devices++
        schools.add(String(v.institution_id))
        if (active) sum.active++
        if (!seen) sum.never_seen++
        else if (Date.now() - Date.parse(seen) < 86_400_000) sum.seen_today++
        else if (active) { quiet = true; sum.quiet++ }
        row.quiet = quiet
        items.push(row)
      }
    }
    sum.schools = schools.size
    return ok({
      items, summary: sum,
      protocol: 'ADMS push over HTTP (ZKTeco-compatible readers). The device dials this host at /iclock; no polling, no webhook.',
    })
  })
}
