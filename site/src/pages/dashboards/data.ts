import { hashStr, int, pick, rng } from '@/lib/utils'
import type { IndustryDef } from '@/industries/types'

/* ---------------------------------------------------------------------------
   Derived analytics.

   The ten layouts need shapes the dashboard config does not carry — scatter
   fields, heat matrices, waterfalls, ridgelines, event spines. Rather than
   writing them out five times, they are derived here from what the industry
   already declares, seeded by hashed keys so a figure never changes between
   reloads or between two layouts showing the same thing.
   --------------------------------------------------------------------------- */

const seed = (k: string) => rng(hashStr(k))

export interface Derived {
  /** Per-KPI sparkline, so a number can carry its own recent history. */
  spark: Record<string, number[]>
  scatter: { name: string; x: number; y: number; r: number }[]
  heat: { rows: string[]; cols: string[]; values: number[][] }
  waterfall: { name: string; value: number; kind?: 'start' | 'end' }[]
  treemap: { name: string; value: number }[]
  ridges: { name: string; data: number[] }[]
  dumbbell: { name: string; a: number; b: number }[]
  flow: { left: { name: string; value: number }[]; right: { name: string; value: number }[] }
  volume: number[]
  events: { time: string; title: string; detail: string; tone: 'good' | 'warn' | 'bad' | 'info' }[]
  sectors: { name: string; value: number; delta: string; up: boolean }[]
  drivers: { name: string; contribution: number; sub: { name: string; value: number }[] }[]
}

const WEEKS = ['W30', 'W31', 'W32', 'W33', 'W34', 'W35', 'W36', 'W37']
const HOURS = ['08', '10', '12', '14', '16', '18']

export function derive(industry: IndustryDef): Derived {
  const cfg = industry.dashboard!
  const v = industry.vocab
  const key = industry.id

  const spark: Record<string, number[]> = {}
  cfg.kpis.forEach((k) => {
    const r = seed(`spark:${key}:${k.label}`)
    const drift = k.up ? 1 : -1
    let base = 50
    spark[k.label] = Array.from({ length: 14 }, () => {
      base += (r() - 0.45) * 9 + drift * 1.2
      return Math.max(8, Math.round(base))
    })
  })

  const scatter = v.program.slice(0, 12).map((name, i) => {
    const r = seed(`scatter:${key}:${i}`)
    return { name, x: int(r, 25, 98), y: int(r, 20, 96), r: 1.2 + r() * 2.2 }
  })

  const heatRows = v.dept.slice(0, 7)
  const heat = {
    rows: heatRows,
    cols: WEEKS,
    values: heatRows.map((d, ri) => WEEKS.map((_, ci) => {
      const r = seed(`heat:${key}:${ri}:${ci}`)
      return int(r, 12, 98)
    })),
  }

  const wr = seed(`wf:${key}`)
  const opening = int(wr, 240, 420)
  const waterfall: Derived['waterfall'] = [
    { name: 'Opening', value: opening, kind: 'start' as const },
    { name: 'New', value: int(wr, 40, 110) },
    { name: 'Expansion', value: int(wr, 15, 60) },
    { name: 'Cost', value: -int(wr, 30, 90) },
    { name: 'Leakage', value: -int(wr, 8, 34) },
    { name: 'Other', value: int(wr, 4, 26) },
  ]
  const closing = waterfall.slice(1).reduce((a, s) => a + s.value, opening)
  waterfall.push({ name: 'Closing', value: closing, kind: 'end' as const })

  const treemap = cfg.mix.data.slice(0, 8).map((d) => ({ name: d.name, value: d.value }))

  const ridges = v.dept.slice(0, 5).map((name, i) => {
    const r = seed(`ridge:${key}:${i}`)
    return { name, data: Array.from({ length: 24 }, (_, j) => Math.round(40 + Math.sin(j / 3 + i) * 18 + r() * 26)) }
  })

  const dumbbell = cfg.progress.rows.slice(0, 5).map((row, i) => {
    const r = seed(`db:${key}:${i}`)
    const pct = Math.round((row.done / row.total) * 100)
    return { name: row.name, a: Math.max(5, pct - int(r, 3, 22)), b: pct }
  })

  const fr = seed(`flow:${key}`)
  const flow = {
    left: v.course.slice(0, 4).map((name) => ({ name, value: int(fr, 20, 90) })),
    right: cfg.mix.data.slice(0, 4).map((d) => ({ name: d.name, value: int(fr, 20, 90) })),
  }

  const vr = seed(`vol:${key}`)
  const volume = Array.from({ length: 26 }, () => int(vr, 24, 100))

  const er = seed(`ev:${key}`)
  const tones = ['good', 'warn', 'bad', 'info'] as const
  const events = cfg.activityVerbs.slice(0, 8).map((verb, i) => ({
    time: `${String(8 + i * 2).padStart(2, '0')}:${pick(er, ['05', '20', '35', '50'])}`,
    title: `${pick(er, v.company)} — ${verb.replace(/ (for|to|from|on|at|of|in|with|—)$/, '')}`,
    detail: pick(er, v.program),
    tone: tones[i % 4],
  }))

  const sectors = [
    { name: 'Growth', value: int(seed(`s1:${key}`), 62, 94) },
    { name: 'Customer', value: int(seed(`s2:${key}`), 55, 92) },
    { name: 'Operations', value: int(seed(`s3:${key}`), 58, 96) },
    { name: 'Risk', value: int(seed(`s4:${key}`), 40, 88) },
    { name: 'Financial', value: int(seed(`s5:${key}`), 60, 95) },
  ].map((s, i) => {
    const r = seed(`sd:${key}:${i}`)
    const up = r() > 0.35
    return { ...s, delta: `${up ? '+' : '-'}${(r() * 6).toFixed(1)}%`, up }
  })

  const drivers = cfg.mix.data.slice(0, 4).map((d, i) => {
    const r = seed(`drv:${key}:${i}`)
    return {
      name: d.name,
      contribution: int(r, -18, 34),
      sub: v.course.slice(i * 2, i * 2 + 3).map((name) => ({ name, value: int(r, -12, 26) })),
    }
  })

  return { spark, scatter, heat, waterfall, treemap, ridges, dumbbell, flow, volume, events, sectors, drivers }
}

export const HEAT_HOURS = HOURS
