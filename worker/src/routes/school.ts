import type { Ctx } from '../router'
import type { Institution } from '../tenant'
import { forbidden } from '../http'

/** The caller's school. A platform admin who is not acting as a school has
    none; that is the same 403 the ctx.db getter gives, not a TypeError 500. */
export function school(c: Pick<Ctx, 'id'>): Institution {
  if (!c.id.institution) throw forbidden('no school in scope')
  return c.id.institution
}
