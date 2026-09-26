import type { Ctx } from '../../router'
import { HttpError, badRequest } from '../../http'
import { tenantDb, type Institution } from '../../tenant'
import { sealSecret } from './providers'

/* Helpers shared by connectors.ts, platform_gateways.ts, platform_signals.ts
   and integrations_index.ts. Nothing here is a route. */

export const PERM_VENDOR = 'platform.tenants.write'
export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** Every active school with a D1 binding: the AsPlatform reads, one database per school. */
export async function fleetDbs(c: Ctx): Promise<{ inst: Institution; db: D1Database }[]> {
  const insts = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY name`).all<Institution>()
  const out: { inst: Institution; db: D1Database }[] = []
  for (const inst of insts.results) { try { out.push({ inst, db: tenantDb(c.env, inst) }) } catch { /* not provisioned */ } }
  return out
}

/** connectorInstitution: the school being configured, or the Go server's 400. */
export function connectorInstitution(c: Ctx): string {
  if (!c.id.institution) throw badRequest('choose the school to configure first')
  return c.id.institution.id
}

/**
 * sealedSecretFrom: absent leaves what is stored (sealed null, clear false),
 * empty wipes it (clear true), anything else is sealed. A seal failure is a 400
 * as in Go.
 */
export async function sealedSecretFrom(c: Ctx, secret: unknown): Promise<{ sealed: Uint8Array | null; clear: boolean }> {
  if (secret === undefined || secret === null) return { sealed: null, clear: false }
  const s = String(secret)
  if (s.trim() === '') return { sealed: null, clear: true }
  try { return { sealed: await sealSecret(c, s), clear: false } } catch (e) {
    if (e instanceof HttpError) throw badRequest(e.message)
    throw e
  }
}

export const credentialKeyPresent = (c: Ctx): boolean => {
  const k = c.env.CREDENTIAL_KEY
  return typeof k === 'string' && k.trim() !== ''
}

/** A TEXT timestamp as RFC3339 seconds, the way Go's time.Format(time.RFC3339) printed it (UTC). */
export function rfc3339(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const t = Date.parse(String(v).includes('T') || String(v).length <= 10 ? String(v) : String(v).replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return String(v)
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** unique/foreign-key failures in a batch, as ledgerFail phrased them. */
export function ledgerFail(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e)
  if (/UNIQUE constraint failed/i.test(msg)) throw badRequest('that already exists: ' + (msg.split('failed:')[1] ?? '').trim())
  if (/FOREIGN KEY constraint failed/i.test(msg)) throw badRequest('that refers to something which does not exist')
  throw e
}
