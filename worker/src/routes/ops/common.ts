import { HttpError, forbidden } from '../../http'
import type { Ctx } from '../../router'

/* Shared by every /ops sub-file. */

/** A side effect that leaves the database (SMS, WhatsApp, push, email, R2, PDF): 501 with the name. */
export function notImplemented(what: string): never {
  throw new HttpError(501, `not implemented: ${what}`)
}

/** The tenant id for INSERTs; every Go handler took it from the identity. */
export function instId(c: Ctx): string {
  const inst = c.id.institution
  if (!inst) throw forbidden('no institution')
  return inst.id
}

export const has = (c: Ctx, perm: string) => (c.id.platformAdmin && !c.id.restricted) || c.id.permissions.has(perm)
export const hasRole = (c: Ctx, role: string) => c.id.roles.includes(role)
