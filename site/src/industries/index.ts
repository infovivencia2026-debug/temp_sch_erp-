import { CONSTRUCTION } from './construction'
import { EDUCATION } from './education'
import { HEALTHCARE } from './healthcare'
import { LOGISTICS } from './logistics'
import { MANUFACTURING } from './manufacturing'
import type { IndustryDef, ModuleDef } from './types'

export type { IndustryDef, ModuleDef, TabDef, Role } from './types'

/** Home-page order. Education first — it is where the suite started. */
export const INDUSTRIES: IndustryDef[] = [
  EDUCATION, CONSTRUCTION, LOGISTICS, HEALTHCARE, MANUFACTURING,
]

export const INDUSTRY_MAP: Record<string, IndustryDef> =
  Object.fromEntries(INDUSTRIES.map((i) => [i.id, i]))

export const DEFAULT_INDUSTRY = EDUCATION.id

/* ---------------------------------------------------------------------------
   The active industry is module state rather than a prop, for the same reason
   the education segment is: every table cell, sidebar item and top-bar picker
   would otherwise have to thread it through. AppStateProvider keeps it in step
   with React state, and changing it remounts the page tree.
   --------------------------------------------------------------------------- */
let ACTIVE = DEFAULT_INDUSTRY

export const setActiveIndustry = (id: string) => { ACTIVE = INDUSTRY_MAP[id] ? id : DEFAULT_INDUSTRY }
export const getActiveIndustryId = () => ACTIVE
export const activeIndustry = (): IndustryDef => INDUSTRY_MAP[ACTIVE] ?? INDUSTRY_MAP[DEFAULT_INDUSTRY]

export const activeModules = (): ModuleDef[] => activeIndustry().modules
export const activeModuleMap = (): Record<string, ModuleDef> =>
  Object.fromEntries(activeIndustry().modules.map((m) => [m.id, m]))
export const activeRoles = () => activeIndustry().roles
export const activeGroupOrder = () => activeIndustry().groupOrder

export function activeRole(roleId: string) {
  const roles = activeRoles()
  return roles.find((r) => r.id === roleId) ?? roles[0]
}

/** Modules this role may open, in registry order. */
export function modulesForRole(roleId: string): ModuleDef[] {
  const role = activeRole(roleId)
  const modules = activeModules()
  if (!role || role.modules === '*') return modules
  const allowed = new Set(role.modules as string[])
  const visible = modules.filter((m) => allowed.has(m.id))
  return visible.length ? visible : modules
}

/** Landing route for a role — its dashboard when it has one. */
export function homePathFor(roleId: string): string {
  const allowed = modulesForRole(roleId)
  return allowed.some((m) => m.id === 'dashboard') ? '/dashboard' : `/${allowed[0].id}`
}
