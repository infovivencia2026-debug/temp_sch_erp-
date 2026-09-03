import { useCallback, useSyncExternalStore } from 'react'
import { resetPaint } from './paint'

/* PERSONALITIES: one token architecture, eight looks.

   Ten shipped palettes already dress the bento surface, and the classic
   layout has its own tokens in index.css, and a hand-painted region can be
   laid over either. What none of that gives is a single decision — "this
   school is Brutalist" — that moves the WHOLE product at once, both layouts,
   both polarities, and leaves every component untouched.

   So a personality is not a palette. It is a set of semantic roles:

     foundation  ground · sidebar · card · card-2
     content     ink · secondary · muted · inverse
     structure   line · line-strong
     brand       primary · primary-hover · primary-soft · primary-contrast
     semantic    success · warning · danger · info
     accents     four hues the boards draw with, and twelve domain hues

   Each personality fills every role twice, light and dark, and the theme
   decides which of the two is on. Components never see any of this: they go
   on reading `bg-card`, `text-foreground`, `--bento-ink` and the rest, and
   this module re-points those tokens. Adding a ninth personality is a table
   entry, not a redesign.

   Hex is the source of truth because that is what a designer hands over and
   what a contrast checker reads. The classic layout's tokens are HSL triplets
   (tailwind composes `hsl(var(--x) / alpha)`), so the conversion is done here
   once rather than by hand in a stylesheet nobody could verify against the
   design.

   Delivered as one <style> element written at module load rather than a
   generated CSS file, so the hex table and the stylesheet cannot drift.
   Attribute selectors on <html> carry it, which is the same seam every other
   appearance axis uses, and a hand-painted region — an inline property on the
   root — still wins over it, exactly as it wins over the shipped theme.

   Device-local, like the skin, until it earns an account row. */

export type Personality =
  | 'classic' | 'ethereal' | 'mono' | 'ocean'
  | 'brutalist' | 'playful' | 'royal' | 'terminal'

export const PERSONALITIES: readonly Personality[] = [
  'classic', 'ethereal', 'mono', 'ocean', 'brutalist', 'playful', 'royal', 'terminal',
] as const

export const DEFAULT_PERSONALITY: Personality = 'classic'
const KEY = 'erp.personality'

export interface Roles {
  ground: string
  sidebar: string
  card: string
  card2: string
  ink: string
  secondary: string
  muted: string
  inverse: string
  line: string
  lineStrong: string
  primary: string
  primaryHover: string
  primarySoft: string
  primaryContrast: string
  success: string
  warning: string
  danger: string
  info: string
  /** The four hues the boards draw with: mint, purple, pink, orange slots. */
  accents: [string, string, string, string]
  /** Twelve domain hues, in DOMAINS order. */
  domains: string[]
}

export const DOMAINS = [
  'students', 'academics', 'attendance', 'finance', 'staff', 'admissions',
  'communication', 'operations', 'reports', 'critical', 'warning', 'success',
] as const

export interface PersonalitySpec {
  id: Personality
  emotion: string
  light: Roles | null
  dark: Roles | null
}

/* Brutalist and Playful are the two that were specified exactly, and they are
   copied, not adjusted: the brief was that the colours matter. The remaining
   five are built to the same shape from the hue the brief named for each. */
export const SPECS: readonly PersonalitySpec[] = [
  {
    /* The shipped tokens as they are. No override at all, so a school that
       never chose anything sees exactly what it saw yesterday. */
    id: 'classic',
    emotion: 'trust',
    light: null,
    dark: null,
  },
  {
    id: 'ethereal',
    emotion: 'wonder',
    light: {
      ground: '#F5F6F8', sidebar: '#EEF0F4', card: '#FFFFFF', card2: '#EEF0F4',
      ink: '#000000', secondary: '#333333', muted: '#595959', inverse: '#FFFFFF',
      line: '#E3E6EA', lineStrong: '#C9CED6',
      primary: '#9D00FF', primaryHover: '#7E00CC', primarySoft: '#F5E6FF', primaryContrast: '#FFFFFF',
      success: '#157A3A', warning: '#9A5404', danger: '#DC2626', info: '#07728D',
      accents: ['#39FF14', '#9D00FF', '#FF007F', '#FF5F1F'],
      domains: ['#2563EB', '#7C3AED', '#0F766E', '#A16207', '#A21CAF', '#4F46E5',
        '#BE185D', '#B45309', '#0E7490', '#B42318', '#B7791F', '#15803D'],
    },
    dark: {
      ground: '#0D0F14', sidebar: '#111318', card: '#1C1E26', card2: '#262834',
      ink: '#FFFFFF', secondary: '#C5C7D0', muted: '#9A9DA8', inverse: '#000000',
      line: '#2A2C35', lineStrong: '#3A3D48',
      primary: '#B39BFA', primaryHover: '#C9B8FF', primarySoft: '#262234', primaryContrast: '#000000',
      success: '#A8F09B', warning: '#FFB37B', danger: '#FF8FA3', info: '#7DD3FC',
      accents: ['#A8F09B', '#B39BFA', '#FF8FA3', '#FFB37B'],
      domains: ['#8AB4FF', '#C4A7FF', '#7FE0D2', '#F4C97A', '#F0A6F0', '#A5A9FF',
        '#FF9AC4', '#FFB37B', '#8AD6F0', '#FF8B85', '#F4D27A', '#A8F09B'],
    },
  },
  {
    id: 'mono',
    emotion: 'intelligence',
    light: {
      ground: '#FAFAFA', sidebar: '#F0F0F0', card: '#FFFFFF', card2: '#F2F2F2',
      ink: '#000000', secondary: '#444444', muted: '#666666', inverse: '#FFFFFF',
      line: '#DADADA', lineStrong: '#000000',
      primary: '#000000', primaryHover: '#333333', primarySoft: '#EBEBEB', primaryContrast: '#FFFFFF',
      success: '#157A3A', warning: '#9A5404', danger: '#DC2626', info: '#07728D',
      accents: ['#000000', '#4A4A4A', '#7A7A7A', '#A3A3A3'],
      domains: ['#000000', '#2B2B2B', '#3D3D3D', '#000000', '#4A4A4A', '#2B2B2B',
        '#3D3D3D', '#4A4A4A', '#2B2B2B', '#000000', '#5A5A5A', '#2B2B2B'],
    },
    dark: {
      ground: '#000000', sidebar: '#0A0A0A', card: '#121212', card2: '#1C1C1C',
      ink: '#FFFFFF', secondary: '#BDBDBD', muted: '#8A8A8A', inverse: '#000000',
      line: '#2A2A2A', lineStrong: '#FFFFFF',
      primary: '#FFFFFF', primaryHover: '#D6D6D6', primarySoft: '#1F1F1F', primaryContrast: '#000000',
      success: '#4ADE80', warning: '#FBBF24', danger: '#F87171', info: '#67E8F9',
      accents: ['#FFFFFF', '#D0D0D0', '#A0A0A0', '#707070'],
      domains: ['#FFFFFF', '#D6D6D6', '#BDBDBD', '#FFFFFF', '#A8A8A8', '#D6D6D6',
        '#BDBDBD', '#A8A8A8', '#D6D6D6', '#FFFFFF', '#9A9A9A', '#D6D6D6'],
    },
  },
  {
    id: 'ocean',
    emotion: 'calm',
    light: {
      ground: '#F3F8FB', sidebar: '#E6F0F6', card: '#FFFFFF', card2: '#EAF3F8',
      ink: '#0B1B26', secondary: '#3E5563', muted: '#5B7080', inverse: '#FFFFFF',
      line: '#D5E2EA', lineStrong: '#B7CBD8',
      primary: '#0077B6', primaryHover: '#005F94', primarySoft: '#E1F2FB', primaryContrast: '#FFFFFF',
      success: '#0F8A5F', warning: '#B5651D', danger: '#D63B3B', info: '#0077B6',
      accents: ['#00A896', '#3A6FE8', '#0096C7', '#48A6C7'],
      domains: ['#0077B6', '#3A6FE8', '#00A896', '#0E7490', '#5B6ED6', '#0096C7',
        '#2A8FBD', '#3B7A9E', '#1F6F8B', '#D63B3B', '#B5651D', '#0F8A5F'],
    },
    dark: {
      ground: '#071219', sidebar: '#0B1A24', card: '#10222E', card2: '#16303E',
      ink: '#EAF6FB', secondary: '#A9C4D2', muted: '#7F9BAB', inverse: '#04141C',
      line: '#1F3A49', lineStrong: '#2E5266',
      primary: '#48CAE4', primaryHover: '#90E0EF', primarySoft: '#0F2F3D', primaryContrast: '#04141C',
      success: '#4ADE9A', warning: '#F2B266', danger: '#FF7B7B', info: '#48CAE4',
      accents: ['#5EEAD4', '#7FA6FF', '#48CAE4', '#90E0EF'],
      domains: ['#48CAE4', '#7FA6FF', '#5EEAD4', '#67D6E8', '#9AA8FF', '#7DD3FC',
        '#8FD4F5', '#86B8D0', '#7CC3DD', '#FF7B7B', '#F2B266', '#4ADE9A'],
    },
  },
  {
    /* Black, paper, orange. Blue, yellow and red are functional exceptions
       and stay on the semantic roles only. */
    id: 'brutalist',
    emotion: 'power',
    light: {
      ground: '#F4F1E8', sidebar: '#E5E1D6', card: '#FFFFFF', card2: '#EAE6DB',
      ink: '#000000', secondary: '#363636', muted: '#666666', inverse: '#FFFFFF',
      line: '#000000', lineStrong: '#000000',
      primary: '#FF3B00', primaryHover: '#D92F00', primarySoft: '#FFE5DC', primaryContrast: '#FFFFFF',
      success: '#008A2E', warning: '#D99A00', danger: '#E6002D', info: '#0057FF',
      accents: ['#000000', '#0057FF', '#E6002D', '#FF3B00'],
      domains: ['#FF3B00', '#000000', '#0057FF', '#FF3B00', '#000000', '#FF3B00',
        '#0057FF', '#000000', '#000000', '#E6002D', '#D99A00', '#008A2E'],
    },
    dark: {
      ground: '#080808', sidebar: '#101010', card: '#181818', card2: '#222222',
      ink: '#FFFFFF', secondary: '#B5B5B5', muted: '#777777', inverse: '#000000',
      line: '#FFFFFF', lineStrong: '#FFFFFF',
      primary: '#FF4D1A', primaryHover: '#FF7043', primarySoft: '#35160D', primaryContrast: '#000000',
      success: '#39FF72', warning: '#FFD000', danger: '#FF3158', info: '#3377FF',
      accents: ['#FFFFFF', '#3377FF', '#FF3158', '#FF4D1A'],
      domains: ['#FF4D1A', '#FFFFFF', '#3377FF', '#FF4D1A', '#FFFFFF', '#FF4D1A',
        '#3377FF', '#FFFFFF', '#FFFFFF', '#FF3158', '#FFD000', '#39FF72'],
    },
  },
  {
    /* Colour and movement, the opposite of the one above. */
    id: 'playful',
    emotion: 'energy',
    light: {
      ground: '#FFF9F5', sidebar: '#FFF0E8', card: '#FFFFFF', card2: '#FFF4EC',
      ink: '#17131A', secondary: '#665D6B', muted: '#918894', inverse: '#FFFFFF',
      line: '#E9DDE7', lineStrong: '#D8C9D7',
      primary: '#FF4F87', primaryHover: '#E63870', primarySoft: '#FFE7F0', primaryContrast: '#FFFFFF',
      success: '#20A95A', warning: '#D99100', danger: '#E83E5B', info: '#2588D9',
      accents: ['#35C978', '#7657F5', '#FF4F87', '#FF7948'],
      domains: ['#3D9BFF', '#7657F5', '#35C978', '#FFC928', '#FF7948', '#FF4F87',
        '#7657F5', '#3D9BFF', '#35C978', '#E83E5B', '#D99100', '#20A95A'],
    },
    dark: {
      ground: '#110F15', sidebar: '#18151E', card: '#201C27', card2: '#292330',
      ink: '#FFF9FF', secondary: '#B9AFBF', muted: '#817887', inverse: '#151118',
      line: '#393140', lineStrong: '#514556',
      primary: '#FF7FA5', primaryHover: '#FF9DB9', primarySoft: '#3B202C', primaryContrast: '#24131B',
      success: '#55D98A', warning: '#FFD45A', danger: '#FF7188', info: '#70BCFF',
      accents: ['#6BE59B', '#A99BFF', '#FF7FA5', '#FF9A70'],
      domains: ['#70BCFF', '#A99BFF', '#6BE59B', '#FFD95A', '#FF9A70', '#FF7FA5',
        '#A99BFF', '#70BCFF', '#6BE59B', '#FF7188', '#FFD45A', '#55D98A'],
    },
  },
  {
    id: 'royal',
    emotion: 'prestige',
    light: {
      ground: '#F7F5FB', sidebar: '#EEEAF7', card: '#FFFFFF', card2: '#F1EDF9',
      ink: '#1A1230', secondary: '#4E4468', muted: '#6F6588', inverse: '#FFFFFF',
      line: '#DED7EE', lineStrong: '#C4B9E0',
      primary: '#5B21B6', primaryHover: '#4C1D95', primarySoft: '#EDE9FE', primaryContrast: '#FFFFFF',
      success: '#15803D', warning: '#A16207', danger: '#BE123C', info: '#1D4ED8',
      accents: ['#B8860B', '#5B21B6', '#BE123C', '#D97706'],
      domains: ['#5B21B6', '#7C3AED', '#6D28D9', '#B8860B', '#9333EA', '#4C1D95',
        '#A21CAF', '#6B21A8', '#5B21B6', '#BE123C', '#A16207', '#15803D'],
    },
    dark: {
      ground: '#0E0A1A', sidebar: '#150F26', card: '#1C1533', card2: '#261D42',
      ink: '#F5F1FF', secondary: '#C4B8E0', muted: '#9187B0', inverse: '#12082A',
      line: '#322858', lineStrong: '#47397A',
      primary: '#A78BFA', primaryHover: '#C4B5FD', primarySoft: '#2A1F4D', primaryContrast: '#12082A',
      success: '#4ADE80', warning: '#FBBF24', danger: '#FB7185', info: '#60A5FA',
      accents: ['#FBBF24', '#A78BFA', '#FB7185', '#F59E0B'],
      domains: ['#A78BFA', '#C4B5FD', '#B794F4', '#FBBF24', '#D8B4FE', '#A78BFA',
        '#E879F9', '#C084FC', '#A78BFA', '#FB7185', '#FBBF24', '#4ADE80'],
    },
  },
  {
    id: 'terminal',
    emotion: 'machine',
    light: {
      ground: '#F4F7F2', sidebar: '#E8EEE4', card: '#FFFFFF', card2: '#EDF2EA',
      ink: '#0B140B', secondary: '#3A4A3A', muted: '#5C6E5C', inverse: '#FFFFFF',
      line: '#D3DDD0', lineStrong: '#A9BBA6',
      primary: '#0B7A0B', primaryHover: '#085E08', primarySoft: '#E3F5E3', primaryContrast: '#FFFFFF',
      success: '#0B7A0B', warning: '#8A6D00', danger: '#B91C1C', info: '#0E7490',
      accents: ['#0B7A0B', '#3B6EA5', '#B91C1C', '#8A6D00'],
      domains: ['#0B7A0B', '#2F6F2F', '#0E7490', '#8A6D00', '#3B6EA5', '#0B7A0B',
        '#2F6F2F', '#3B6EA5', '#2F6F2F', '#B91C1C', '#8A6D00', '#0B7A0B'],
    },
    dark: {
      ground: '#000000', sidebar: '#050805', card: '#0A120A', card2: '#101A10',
      ink: '#D9FFD9', secondary: '#8FD48F', muted: '#6AA86A', inverse: '#000000',
      line: '#1B2E1B', lineStrong: '#2F5A2F',
      primary: '#39FF14', primaryHover: '#7CFF5E', primarySoft: '#0E2A0E', primaryContrast: '#000000',
      success: '#39FF14', warning: '#FFD000', danger: '#FF5555', info: '#55D6FF',
      accents: ['#39FF14', '#55D6FF', '#FF5555', '#FFD000'],
      domains: ['#39FF14', '#7CFF5E', '#55D6FF', '#FFD000', '#5EE0A0', '#39FF14',
        '#7CFF5E', '#5EE0A0', '#7CFF5E', '#FF5555', '#FFD000', '#39FF14'],
    },
  },
]

export function isPersonality(v: unknown): v is Personality {
  return typeof v === 'string' && (PERSONALITIES as readonly string[]).includes(v)
}

export function specOf(id: Personality): PersonalitySpec {
  return SPECS.find((s) => s.id === id) ?? SPECS[0]
}

// ---------------------------------------------------------------- colour maths

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}

/** "H S% L%" — the triplet tailwind wraps in hsl(). */
export function hslTriplet(hexColour: string): string {
  const [r8, g8, b8] = rgb(hexColour)
  const r = r8 / 255, g = g8 / 255, b = b8 / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  const f = (n: number) => Math.round(n * 10) / 10
  return `${f(h)} ${f(s * 100)}% ${f(l * 100)}%`
}

/** `t` of the way from a to b, in sRGB. Tints are made this way: an accent
    mixed most of the way into the card it will sit on. */
export function mix(a: string, b: string, t: number): string {
  const A = rgb(a), B = rgb(b)
  return hex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t])
}

function luminance(hexColour: string): number {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = rgb(hexColour)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast ratio. Exported for the test that keeps ink on card ≥ 4.5. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// ------------------------------------------------------------------ the tokens

/** Every CSS custom property one polarity of one personality sets. */
export function tokensFor(r: Roles): Record<string, string> {
  const t: Record<string, string> = {}
  const hsl = (names: string[], value: string) => {
    for (const n of names) t[n] = hslTriplet(value)
  }
  // Classic layout: the index.css names, as HSL triplets.
  hsl(['--ground', '--background'], r.ground)
  hsl(['--sidebar', '--rail'], r.sidebar)
  hsl(['--card', '--card-default', '--popover', '--elevated', '--nav-active'], r.card)
  hsl(['--surface-subtle', '--secondary', '--muted', '--accent'], r.card2)
  hsl(['--surface-hover'], mix(r.card2, r.line, 0.5))
  hsl(['--foreground', '--card-foreground', '--popover-foreground', '--accent-foreground'], r.ink)
  hsl(['--secondary-foreground', '--rail-foreground'], r.secondary)
  hsl(['--muted-foreground'], r.muted)
  hsl(['--border', '--input'], r.line)
  hsl(['--border-strong'], r.lineStrong)
  hsl(['--primary', '--ring'], r.primary)
  hsl(['--primary-hover'], r.primaryHover)
  hsl(['--primary-soft'], r.primarySoft)
  hsl(['--primary-foreground', '--destructive-foreground'], r.primaryContrast)
  hsl(['--success'], r.success)
  hsl(['--warning'], r.warning)
  hsl(['--destructive'], r.danger)
  hsl(['--info'], r.info)

  // Bento surface: hex, as bento-theme.css writes them.
  t['--bento-bg'] = r.ground
  t['--bento-card'] = r.card
  t['--bento-card-2'] = r.card2
  t['--bento-ink'] = r.ink
  t['--bento-muted'] = r.secondary
  t['--bento-line'] = r.line
  t['--bento-dock-bg'] = r.sidebar
  t['--bento-dock-ink'] = r.ink
  const slots = ['mint', 'purple', 'pink', 'orange'] as const
  slots.forEach((slot, i) => {
    t[`--bento-${slot}`] = r.accents[i]
    t[`--bento-${slot}-tint`] = mix(r.accents[i], r.card, 0.85)
  })
  t['--bento-anchor-from'] = r.sidebar
  t['--bento-anchor-to'] = r.card2
  t['--bento-anchor-ink'] = r.ink
  DOMAINS.forEach((d, i) => {
    const hue = r.domains[i] ?? r.primary
    t[`--dom-${d}`] = hue
    t[`--dom-${d}-soft`] = mix(hue, r.card, 0.85)
    t[`--dom-${d}-text`] = r.ink
  })
  return t
}

function block(selector: string, tokens: Record<string, string>, scheme: 'light' | 'dark'): string {
  const body = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')
  return `${selector} {\n  color-scheme: ${scheme};\n${body}\n}\n`
}

/** The whole stylesheet: every personality, both polarities. */
export function renderPersonalityCss(): string {
  let css = '/* generated by lib/personality.ts */\n'
  for (const s of SPECS) {
    /* html[...] rather than [...] so this outranks `[data-layout='bento']`
       (0,1,0) and ties `html.dark[data-layout='bento']` (0,2,1), which it then
       beats by coming later in the document. */
    if (s.light) css += block(`html[data-personality='${s.id}']`, tokensFor(s.light), 'light')
    if (s.dark) css += block(`html.dark[data-personality='${s.id}']`, tokensFor(s.dark), 'dark')
  }
  return css
}

// -------------------------------------------------------------------- the store

function readStored(): Personality {
  try {
    const raw = localStorage.getItem(KEY)
    if (isPersonality(raw)) return raw
  } catch {
    /* private mode */
  }
  return DEFAULT_PERSONALITY
}

let current: Personality = typeof window === 'undefined' ? DEFAULT_PERSONALITY : readStored()
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function snapshot(): Personality {
  return current
}

function serverSnapshot(): Personality {
  return DEFAULT_PERSONALITY
}

const STYLE_ID = 'erp-personalities'

function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = renderPersonalityCss()
  document.head.appendChild(el)
}

/* The default leaves no trace, so a stylesheet asking html[data-personality]
   is never asking about the ordinary case — the same rule as the skin. */
export function applyPersonality(next: Personality, opts: { clearPaint?: boolean } = {}) {
  const root = document.documentElement
  ensureStylesheet()
  /* A shipped palette writes fifty-five bento tokens inline on the root, and
     inline beats any selector: picked on top of a personality it would dress
     the boards in one look and the chrome in another. A deliberate pick of a
     personality is a decision about the whole surface, so the palette goes.
     Not at load, where the stored palette is somebody's earlier decision. */
  if (opts.clearPaint) resetPaint()
  if (next === DEFAULT_PERSONALITY) root.removeAttribute('data-personality')
  else root.setAttribute('data-personality', next)
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* private mode */
  }
  if (current === next) return
  current = next
  for (const l of listeners) l()
}

export function currentPersonality(): Personality {
  return current
}

export function usePersonality(): {
  personality: Personality
  setPersonality: (next: Personality) => void
} {
  const personality = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const setPersonality = useCallback((next: Personality) => {
    if (isPersonality(next)) applyPersonality(next, { clearPaint: true })
  }, [])
  return { personality, setPersonality }
}

if (typeof document !== 'undefined') applyPersonality(current)
