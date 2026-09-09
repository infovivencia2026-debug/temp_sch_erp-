import { int, rng } from '@/lib/utils'

/** Twelve months ending with the current demo month (Aug 2026). */
export const MONTHS = ['Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']

/**
 * Deterministic multi-series monthly data. Same seed, same chart on every
 * reload — a demo that reshuffles its numbers reads as noise, not as a system.
 */
export function series(seed: number, keys: { key: string; min: number; max: number; decimals?: number }[]) {
  return MONTHS.map((name, i) => {
    const r = rng(seed + i * 131)
    const row: Record<string, any> = { name }
    keys.forEach((k, ki) => {
      const raw = k.min + r() * (k.max - k.min) + ki * 0
      row[k.key] = k.decimals ? +raw.toFixed(k.decimals) : Math.round(raw)
    })
    return row
  })
}

/** A funnel-shaped series where each stage is a fraction of the one before. */
export function funnelSeries(seed: number, keys: string[], top: [number, number], drop: [number, number]) {
  return MONTHS.slice(-8).map((name, i) => {
    const r = rng(seed + i * 977)
    const row: Record<string, any> = { name }
    let value = int(r, top[0], top[1])
    keys.forEach((k) => {
      row[k] = value
      value = Math.round(value * (drop[0] + r() * (drop[1] - drop[0])))
    })
    return row
  })
}
