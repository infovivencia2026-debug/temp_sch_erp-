import { GROUPS, type GridGroupDef } from './static_data'

/* Port of internal/rbac/model.go: the configuration grid a school reads a
   role through, and the two projections between it and permission keys. */

export type Level = 0 | 1 | 2
const LEVEL_NAMES = ['none', 'view', 'manage'] as const
export const levelName = (l: Level): string => LEVEL_NAMES[l] ?? 'none'
export function parseLevel(s: string): Level | null {
  const i = LEVEL_NAMES.indexOf(s as (typeof LEVEL_NAMES)[number])
  return i < 0 ? null : (i as Level)
}

export interface GroupState { group: string; level: string; scope: string; approve: boolean; export: boolean; extra?: string[] }

function keysAt(g: GridGroupDef, l: Level): string[] {
  const out: string[] = []
  if (l >= 1) out.push(...g.view)
  if (l >= 2) out.push(...g.manage)
  return out
}
export function groupLevels(g: GridGroupDef): Level[] {
  const out: Level[] = [0]
  if (g.view.length > 0) out.push(1)
  if (g.manage.length > 0) out.push(2)
  return out
}
function owns(g: GridGroupDef, key: string): boolean {
  for (const list of [g.view, g.manage, g.approve, g.export]) if (list.includes(key)) return true
  for (const s of g.scopes) if (s.keys.includes(key) || s.write_keys.includes(key)) return true
  return false
}
const allHeld = (held: Set<string>, keys: string[]) => keys.length > 0 && keys.every((k) => held.has(k))

/** rbac.Read: projects a permission set onto the grid. */
export function readGrid(keys: string[]): GroupState[] {
  const held = new Set(keys)
  const out: GroupState[] = []
  for (const g of GROUPS) {
    let level: Level = 0
    for (const l of [1, 2] as Level[]) {
      if (!keysAt(g, l).every((k) => held.has(k))) break
      level = l
    }
    const st: GroupState = { group: g.key, level: levelName(level), scope: '', approve: g.approve.length > 0 && allHeld(held, g.approve), export: g.export.length > 0 && allHeld(held, g.export) }
    for (const s of g.scopes) if (allHeld(held, s.keys)) st.scope = s.scope
    if (st.scope === '' && g.scopes.length > 0) st.scope = g.scopes[0].scope
    const accounted = new Set(keysAt(g, level))
    if (st.approve) for (const k of g.approve) accounted.add(k)
    if (st.export) for (const k of g.export) accounted.add(k)
    if (level > 0) {
      for (const s of g.scopes) {
        if (s.scope !== st.scope) continue
        for (const k of s.keys) accounted.add(k)
        if (level >= 2) for (const k of s.write_keys) accounted.add(k)
      }
    }
    const extra = keys.filter((k) => owns(g, k) && !accounted.has(k)).sort()
    if (extra.length > 0) st.extra = extra
    out.push(st)
  }
  return out
}

/** rbac.Apply: projects a grid back onto capability keys. */
export function applyGrid(states: GroupState[]): string[] {
  const byKey = new Map(states.map((s) => [s.group, s]))
  const set = new Set<string>()
  for (const g of GROUPS) {
    const st = byKey.get(g.key)
    if (!st) continue
    const level = parseLevel(st.level)
    if (level === null) continue
    for (const k of keysAt(g, level)) set.add(k)
    if (level > 0) {
      if (st.approve) for (const k of g.approve) set.add(k)
      if (st.export) for (const k of g.export) set.add(k)
    }
    for (const s of g.scopes) {
      if (s.scope !== st.scope || level === 0) continue
      for (const k of s.keys) set.add(k)
      if (level >= 2) for (const k of s.write_keys) set.add(k)
    }
    for (const k of st.extra ?? []) if (owns(g, k)) set.add(k)
  }
  return [...set].sort()
}

export function groupByKey(key: string): GridGroupDef | undefined { return GROUPS.find((g) => g.key === key) }
