export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

/** Deterministic PRNG so every reload shows the same "database". */
export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

export function hashStr(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

export const pick = <T,>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length) % arr.length]
export const int = (r: () => number, min: number, max: number) => min + Math.floor(r() * (max - min + 1))

export const inr = (n: number) =>
  '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n))

export function inrCompact(n: number) {
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr'
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L'
  if (n >= 1e3) return '₹' + (n / 1e3).toFixed(1) + 'K'
  return inr(n)
}

export const num = (n: number) => new Intl.NumberFormat('en-IN').format(n)

export function fmtDate(d: Date | string) {
  const dt = typeof d === 'string' ? new Date(d) : d
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Fixed "today" keeps the demo reproducible across sessions. */
export const TODAY = new Date('2026-08-08T09:30:00')

export function dateOffset(days: number) {
  const d = new Date(TODAY)
  d.setDate(d.getDate() + days)
  return d
}

export function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()
}

export function download(filename: string) {
  // Prototype only: no file is produced, the toast confirms the intent.
  return filename
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

export function sortRows<T extends Record<string, any>>(rows: T[], key: string | null, dir: 'asc' | 'desc') {
  if (!key) return rows
  const out = [...rows]
  out.sort((a, b) => {
    const x = a[key], y = b[key]
    const nx = typeof x === 'number' ? x : parseFloat(String(x).replace(/[^0-9.-]/g, ''))
    const ny = typeof y === 'number' ? y : parseFloat(String(y).replace(/[^0-9.-]/g, ''))
    let c: number
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && String(x).match(/\d/) && String(y).match(/\d/)) c = nx - ny
    else c = String(x ?? '').localeCompare(String(y ?? ''))
    return dir === 'asc' ? c : -c
  })
  return out
}
