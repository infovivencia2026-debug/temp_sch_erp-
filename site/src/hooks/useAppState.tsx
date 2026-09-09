import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  activeIndustry, DEFAULT_INDUSTRY, INDUSTRY_MAP, setActiveIndustry, type IndustryDef,
} from '@/industries'
import { setSegment, type Segment } from '@/data/generator'

function persisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

export type Skin = 'shadcn' | 'bento' | 'ui-3'

/**
 * Typeface is a user preference, not a property of an interface: every one of
 * the twenty-one reads the same --app-font variable, so a choice made here
 * follows you across interfaces and industries.
 */
export interface FontDef { id: string; name: string; note: string }

export const FONTS: FontDef[] = [
  { id: 'inter', name: 'Inter', note: 'Neutral UI grotesk. The default.' },
  { id: 'geist', name: 'Geist', note: 'Tighter, more editorial.' },
  { id: 'manrope', name: 'Manrope', note: 'Rounder, friendlier.' },
  { id: 'plex', name: 'IBM Plex Sans', note: 'Institutional, slightly technical.' },
  { id: 'dm', name: 'DM Sans', note: 'Geometric and compact.' },
  { id: 'system', name: 'System', note: 'Whatever the device ships with.' },
  { id: 'alata', name: 'Alata', note: 'Wide and even, low contrast.' },
  { id: 'barlow', name: 'Barlow', note: 'Slightly condensed, signage-like.' },
  { id: 'josefin', name: 'Josefin Sans', note: 'Geometric with a tall x-height.' },
  { id: 'outfit', name: 'Outfit', note: 'Clean geometric display.' },
  { id: 'figtree', name: 'Figtree', note: 'Warm, softly rounded.' },
  { id: 'sourceserif', name: 'Source Serif', note: 'A serif, for reading at length.' },
  { id: 'mono', name: 'JetBrains Mono', note: 'Fixed width. Every figure lines up.' },

  /* From the designer list. Four are on Google Fonts as named; the rest are
     commercial faces, so each carries the closest free equivalent and says so
     rather than silently rendering as something else. */
  { id: 'bebas', name: 'Bebas Neue', note: 'Tall condensed caps. Headlines only.' },
  { id: 'cinzel', name: 'Cinzel', note: 'Roman capitals, engraved.' },
  { id: 'roboto', name: 'Roboto', note: 'The Android grotesk.' },
  { id: 'lato', name: 'Lato', note: 'Humanist, quietly warm.' },
  { id: 'jost', name: 'Jost', note: 'Geometric — stands in for Futura.' },
  { id: 'playfair', name: 'Playfair Display', note: 'High contrast — stands in for Didot.' },
  { id: 'cormorant', name: 'Cormorant', note: 'Fine old-style — stands in for Cirka.' },
  { id: 'oswald', name: 'Oswald', note: 'Condensed grotesk — stands in for Telegraf.' },
]

export type TextSize = 'small' | 'medium' | 'large' | 'x-large'
export const TEXT_SIZES: { id: TextSize; name: string; note: string }[] = [
  { id: 'small', name: 'Small', note: 'Denser — more rows on screen.' },
  { id: 'medium', name: 'Medium', note: 'The default.' },
  { id: 'large', name: 'Large', note: 'Easier at arm’s length.' },
  { id: 'x-large', name: 'Extra large', note: 'For presenting or poor sight.' },
]
export const FONT_MAP: Record<string, FontDef> = Object.fromEntries(FONTS.map((f) => [f.id, f]))

/**
 * Three interfaces over one application. The registry, the data and every
 * screen stay identical — what changes is the shell, the type scale, the
 * shape language and how dense the page is allowed to be.
 */
export type UiId =
  | 'ui-1' | 'ui-2' | 'ui-3' | 'ui-4'
  | 'ui-5' | 'ui-6' | 'ui-7' | 'ui-8' | 'ui-9'
  | 'ui-10' | 'ui-11'
  | 'ui-12' | 'ui-13' | 'ui-14' | 'ui-15'
  | 'ui-16'

/** The navigation model a UI uses. This is what App.tsx switches on. */
export type ShellId =
  | 'dock'      /* icon dock + contextual panel        */
  | 'mega'      /* horizontal header + mega-menus      */
  | 'strip'     /* narrow control strip + module chips */
  | 'prism'     /* command menu + right inspector      */
  | 'halo'      /* bottom dock + floating module panel */
  | 'monolith'  /* top-left command strip, no rail     */
  | 'terrace'   /* module tabs + submodule strip       */
  | 'pulse'     /* slim rail + timeline module list    */
  | 'mosaic'    /* tile launcher, nav in the dashboard */
  | 'eduos'     /* command rail + floating bar + context drawer */

export interface UiDef {
  id: UiId
  label: string
  name: string
  tagline: string
  detail: string
  shell: ShellId
  /** Forced table density. */
  density?: 'comfortable' | 'compact'
  /**
   * Which half of the set this belongs to. The first ten are distinguished by
   * their shell and share the standard dashboard; the second ten are
   * distinguished by their dashboard skeleton and wear a quieter shell.
   */
  family: 'shell' | 'dashboard' | 'education'
  /** Optionally restricts an interface to one vertical. Currently unused. */
  onlyIndustry?: string
}

export const UIS: UiDef[] = [
  {
    id: 'ui-1', family: 'shell', label: 'UI-1', name: 'Nexus Command', shell: 'dock', density: 'compact',
    tagline: 'Icon dock · contextual panel · asymmetric grid',
    detail: 'Mission control. A slim icon dock and a contextual panel that follows the module, over an asymmetric analytical grid in graphite and electric cyan.',
  },
  {
    id: 'ui-2', family: 'shell', label: 'UI-2', name: 'Aurora Executive', shell: 'mega',
    tagline: 'Header mega-menus · editorial figures · ivory',
    detail: 'An interactive executive report. Navigation moves into a horizontal header so the page belongs to the content: ivory, champagne, oversized numerical statements.',
  },
  {
    id: 'ui-3', family: 'shell', label: 'UI-3', name: 'Vector Grid', shell: 'strip', density: 'compact',
    tagline: 'Control strip · live status bar · maximum density',
    detail: 'An industrial control system. A narrow control strip, a compact module selector across the top, and as much operational data on screen as legibility allows.',
  },
  {
    id: 'ui-4', family: 'shell', label: 'UI-4', name: 'Prism Intelligence', shell: 'prism',
    tagline: 'Command menu · persistent inspector · monochrome',
    detail: 'A data-exploration workspace. A hierarchical command menu at top-left, and a persistent inspector on the right that fills with whatever record you select.',
  },
  {
    id: 'ui-5', family: 'shell', label: 'UI-5', name: 'Halo Workspace', shell: 'halo',
    tagline: 'Bottom dock · centred workspace · radial KPIs',
    detail: 'A centred command workspace with the navigation as a floating dock at the bottom of the screen, off-white surfaces, deep navy text and icy blue highlights.',
  },
  {
    id: 'ui-6', family: 'shell', label: 'UI-6', name: 'Monolith', shell: 'monolith', density: 'compact',
    tagline: 'Command strip · no rail · near-black',
    detail: 'A financial terminal. Full-height charcoal, oversized panels separated by space rather than borders, keyboard-first navigation and a single electric lime accent.',
  },
  {
    id: 'ui-7', family: 'shell', label: 'UI-7', name: 'Terrace', shell: 'terrace',
    tagline: 'Horizontal bands · module tabs · warm palette',
    detail: 'A live annual report. Broad stacked bands run from overview to detail, navigated by module tabs with a submodule strip beneath, in cream, emerald and terracotta.',
  },
  {
    id: 'ui-8', family: 'shell', label: 'UI-8', name: 'Pulse', shell: 'pulse', density: 'compact',
    tagline: 'Slim rail · timeline list · live activity',
    detail: 'An event-driven operations platform. A slim rail beside a timeline-style module list, deep blue-grey surfaces and cyan, magenta and amber for what just changed.',
  },
  {
    id: 'ui-9', family: 'shell', label: 'UI-9', name: 'Mosaic', shell: 'mosaic',
    tagline: 'Tile launcher · navigation in the dashboard',
    detail: 'A tile-based workspace. Navigation lives in the dashboard itself as tiles sized by importance, on a bright neutral ground with cobalt, teal, coral and violet.',
  },

  /* ---------------------------------------------------------------------
     UI-11 to UI-15 — executive dashboard layouts.

     These are the other axis. Each wears a restrained version of a shell so
     it stays out of the way, and puts its whole identity into the page
     skeleton: an editorial split, a circular field, a dense matrix, a canvas,
     a triptych, a stage, a command drawer, terraces, a spine, a mosaic.
     --------------------------------------------------------------------- */
  {
    id: 'ui-10', family: 'dashboard', label: 'UI-10', name: 'Dense Matrix Wall', shell: 'strip', density: 'compact',
    tagline: '12-column grid · no hero · nothing dominant',
    detail: 'A uniform analytical matrix. Two narrow utility bars, then heatmap, scatter, small multiples, correlation and ranking packed to one rhythm.',
  },
  {
    id: 'ui-11', family: 'dashboard', label: 'UI-11', name: 'Intelligence Triptych', shell: 'prism',
    tagline: 'Queries · driver tree · evidence that never leaves',
    detail: 'Three fixed panes. Saved queries on the left, a driver tree and forecast in the middle, and an evidence inspector on the right that never disappears.',
  },
  {
    id: 'ui-12', family: 'dashboard', label: 'UI-12', name: 'Full-Screen Stage', shell: 'halo',
    tagline: 'One number, one graph, one screen at a time',
    detail: 'Each viewport is a slide. A single dominant figure with a single dominant graph, moved through by a dock — built for presenting rather than scanning.',
  },
  {
    id: 'ui-13', family: 'dashboard', label: 'UI-13', name: 'Terrace Stack', shell: 'terrace',
    tagline: 'Five bands · click one, the rest compress',
    detail: 'The page is horizontal bands, one per level of the business — enterprise, unit, region, initiatives, execution. Opening one compresses the others.',
  },
  {
    id: 'ui-14', family: 'dashboard', label: 'UI-14', name: 'Event Spine', shell: 'pulse', density: 'compact',
    tagline: 'Signals left · time down the centre · events right',
    detail: 'A timeline runs vertically through the page. Performance signals sit to its left, events and decisions to its right, and the forecast continues past now.',
  },
  {
    id: 'ui-15', family: 'dashboard', label: 'UI-15', name: 'Adaptive Mosaic', shell: 'mosaic',
    tagline: 'Irregular tiles · selecting one pushes the rest aside',
    detail: 'Tiles sized by importance — ultra-wide, tall, square. A tile can take half the viewport, and expanding one rearranges the others instead of opening a page.',
  },

  /* ---------------------------------------------------------------------
     UI-16 — built for education only. Everything the education registry
     already contains stays exactly where it is; this is a shell, a
     dashboard and an interaction language wrapped around it.
     --------------------------------------------------------------------- */
  {
    id: 'ui-16', family: 'education', label: 'UI-16', name: 'Intelligence OS',
    shell: 'eduos',
    tagline: 'Command rail · floating bar · live pulse',
    detail: 'A control centre for an organisation: a midnight command rail and dark hero against a warm ivory workspace, with a live Pulse and a bento of operations, money, pipeline and place. Built for education first; every vertical supplies its own figures.',
  },
]

export const UI_MAP: Record<string, UiDef> = Object.fromEntries(UIS.map((u) => [u.id, u]))

interface AppState {
  theme: 'light' | 'dark'
  setTheme: (t: 'light' | 'dark') => void
  skin: Skin
  setSkin: (s: Skin) => void
  ui: UiId
  uiDef: UiDef
  setUi: (u: UiId) => void
  font: string
  setFont: (f: string) => void
  /** The active vertical — education, construction, logistics, healthcare, manufacturing. */
  industry: IndustryDef
  industryId: string
  setIndustry: (id: string) => void
  /** Higher-ed vs K-12. Only meaningful inside education. */
  segment: Segment
  setSegment: (s: Segment) => void
  sidebarCollapsed: boolean
  /** The module column, where a shell has one beside its rail. Its own flag:
      collapsing the rail and collapsing the list it feeds are separate wishes. */
  subPanelCollapsed: boolean
  setSubPanelCollapsed: (v: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  mobileNavOpen: boolean
  setMobileNavOpen: (v: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (v: boolean) => void
  role: string
  setRole: (r: string) => void
  institution: string
  setInstitution: (v: string) => void
  campus: string
  setCampus: (v: string) => void
  year: string
  setYear: (v: string) => void
  textSize: TextSize
  setTextSize: (v: TextSize) => void
  /* Look. Each of these is a preference of the reader's, not a property of an
     interface, so they persist across interfaces the way the typeface does. */
  corners: Corners
  setCorners: (v: Corners) => void
  borders: Borders
  setBorders: (v: Borders) => void
  shadows: Shadows
  setShadows: (v: Shadows) => void
  pattern: Pattern
  setPattern: (v: Pattern) => void
  contrast: Contrast
  setContrast: (v: Contrast) => void
  /** Accent colour, chosen apart from the surfaces. Null keeps the interface's own. */
  accent: { h: number; s: number; l: number } | null
  setAccent: (c: { h: number; s: number; l: number } | null) => void
  /** Colour schemes the reader saved, newest first. */
  palettes: Palette[]
  savePalette: (name: string) => void
  applyPalette: (id: string) => void
  deletePalette: (id: string) => void
  /** Background colour chosen for the current interface, or null for its own. */
  background: { h: number; s: number; l: number } | null
  setBackground: (c: { h: number; s: number; l: number } | null) => void
  /** Per-element colours, keyed by target. */
  backgrounds: BgMap
  setBackgroundFor: (t: BgTarget, c: { h: number; s: number; l: number } | null) => void
  bgTarget: BgTarget
  setBgTarget: (t: BgTarget) => void
  /** Text colours, keyed by the same targets. */
  inks: BgMap
  setInkFor: (t: BgTarget, c: { h: number; s: number; l: number } | null) => void
  period: string
  setPeriod: (v: string) => void
  periods: string[]
  density: 'comfortable' | 'compact'
  setDensity: (v: 'comfortable' | 'compact') => void
  years: string[]
  institutions: string[]
  campuses: string[]
}

const Ctx = createContext<AppState>(null as unknown as AppState)
export const useApp = () => useContext(Ctx)

const roleKey = (id: string) => `erp.role.${id}`
/* Per interface, not global: the twenty-one are meant to look unrelated, and
   one colour across all of them would undo that. */
const bgKey = (uiId: string) => `erp.bg.${uiId}`

/* ===========================================================================
   WHAT A COLOUR IS APPLIED TO

   "All" derives a whole palette from one colour, which is the common case. The
   rest paint a single surface and leave everything else alone, so a top bar can
   be given its own colour without the page following it.
   =========================================================================== */
/* The colour actually behind an element: its own background if it has one,
   otherwise the nearest ancestor that does. Gradients are not a disqualifier —
   several shells wash their rail with one over a solid base, and refusing to
   answer there was what left those rails without an ink of their own. */
function effectiveBackground(el: Element): [number, number, number] | null {
  let n: Element | null = el
  while (n) {
    const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g)
    if (m && m.length >= 3 && (m.length < 4 || +m[3] > 0.5)) return [+m[0], +m[1], +m[2]]
    n = n.parentElement
  }
  return null
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/* Whichever ink reads better on this colour. Relative luminance rather than a
   lightness threshold: a saturated yellow at 55% lightness is far brighter than
   a blue at the same number, and wants the dark ink, not the pale one. */
function inkOnHsl(h: number, s: number, l: number): string {
  const S = s / 100, L = l / 100
  const c = (1 - Math.abs(2 * L - 1)) * S
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = L - c / 2
  const [r0, g0, b0] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const li = [r0 + m, g0 + m, b0 + m].map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  const lum = 0.2126 * li[0] + 0.7152 * li[1] + 0.0722 * li[2]
  return lum < 0.42 ? '0 0% 98%' : `${Math.round(h)} 24% 11%`
}

/* Which picker target owns each ink token, so a derived ink never overwrites
   one the reader chose. */
const INK_OWNER: Record<string, string> = {
  '--chrome-foreground': 'topbar',
  '--rail-foreground': 'sidebar',
  '--dock-foreground': 'dock',
}

/* ===========================================================================
   LOOK

   Seven dials over the appearance, all of them relative. Nothing here sets an
   absolute value: corners scale each interface's own radius, borders and
   shadows step from whatever that interface already draws, and the pattern is
   an overlay in the page's own ink. That is deliberate — the twenty-one are
   meant to stay as different from each other with a dial turned as they are
   with it at rest, so every option is a multiplier rather than a replacement.
   =========================================================================== */
export type Corners = 'sharp' | 'default' | 'soft' | 'round'
export const CORNERS: { id: Corners; name: string; scale: number }[] = [
  { id: 'sharp', name: 'Sharp', scale: 0.15 },
  { id: 'default', name: 'Default', scale: 1 },
  { id: 'soft', name: 'Soft', scale: 1.4 },
  { id: 'round', name: 'Round', scale: 2 },
]

export type Borders = 'none' | 'hairline' | 'default' | 'strong'
export const BORDERS: { id: Borders; name: string }[] = [
  { id: 'none', name: 'None' }, { id: 'hairline', name: 'Hairline' },
  { id: 'default', name: 'Default' }, { id: 'strong', name: 'Strong' },
]

export type Shadows = 'flat' | 'default' | 'lifted' | 'deep'
export const SHADOWS: { id: Shadows; name: string }[] = [
  { id: 'flat', name: 'Flat' }, { id: 'default', name: 'Default' },
  { id: 'lifted', name: 'Lifted' }, { id: 'deep', name: 'Deep' },
]

export type Pattern = 'none' | 'dots' | 'grid' | 'lines' | 'noise'
export const PATTERNS: { id: Pattern; name: string }[] = [
  { id: 'none', name: 'None' }, { id: 'dots', name: 'Dots' },
  { id: 'grid', name: 'Grid' }, { id: 'lines', name: 'Lines' },
  { id: 'noise', name: 'Noise' },
]

export type Contrast = 'normal' | 'high'

/** A colour scheme the reader liked, kept so it can be used again. */
export interface Palette {
  id: string
  name: string
  parts: BgMap
  inks: BgMap
  accent: { h: number; s: number; l: number } | null
}

export const BG_TARGETS = [
  { id: 'page', name: 'Work area' },
  { id: 'topbar', name: 'Top bar' },
  { id: 'sidebar', name: 'Side bar' },
  { id: 'dock', name: 'Bottom bar' },
  { id: 'cards', name: 'Cards' },
] as const
export type BgTarget = typeof BG_TARGETS[number]['id']
export type BgMap = Partial<Record<BgTarget, { h: number; s: number; l: number } | null>>

/** What the term selector means in each vertical. */
const TERMS: Record<string, string[]> = {
  education: ['Semester 1', 'Semester 2', 'Summer term'],
  construction: ['Phase 1', 'Phase 2', 'Phase 3'],
  logistics: ['Morning wave', 'Evening wave', 'Night wave'],
  healthcare: ['Morning OPD', 'Evening OPD', 'Night shift'],
  manufacturing: ['Shift A', 'Shift B', 'Shift C'],
}

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeRaw] = useState<'light' | 'dark'>(() => persisted('erp.theme', 'light' as const))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => persisted('erp.sidebar', false))
  const [subPanelCollapsed, setSubPanelCollapsed] = useState(() => persisted('erp.subpanel', false))
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => persisted('erp.density', 'comfortable' as const))
  const [skin, setSkinRaw] = useState<Skin>(() => persisted('erp.skin', 'shadcn' as Skin))
  const [segment, setSegmentRaw] = useState<Segment>(() => persisted('erp.segment', 'higher-ed' as Segment))
  const [font, setFontRaw] = useState<string>(() => {
    const saved = persisted('erp.font', 'inter')
    return FONT_MAP[saved] ? saved : 'inter'
  })
  const setFont = (f: string) => {
    if (!FONT_MAP[f]) return
    setFontRaw(f)
    localStorage.setItem('erp.font', JSON.stringify(f))
  }

  /* The set was renumbered into a sequence when five interfaces were retired.
     Without this a browser holding "ui-21" would not fall back — it would land
     on whatever now answers to that name, which is a different interface.
     Mapped once, then written back, so this runs at most a single time. */
  const [ui, setUiRaw] = useState<UiId>(() => {
    const RENUMBERED: Record<string, UiId> = {
      'ui-5': 'ui-4', 'ui-6': 'ui-5', 'ui-7': 'ui-6', 'ui-8': 'ui-7', 'ui-9': 'ui-8',
      'ui-10': 'ui-9', 'ui-13': 'ui-10', 'ui-15': 'ui-11', 'ui-16': 'ui-12',
      'ui-18': 'ui-13', 'ui-19': 'ui-14', 'ui-20': 'ui-15', 'ui-21': 'ui-16',
      // retired outright; their nearest surviving neighbour
      'ui-4': 'ui-1', 'ui-11': 'ui-1', 'ui-12': 'ui-1', 'ui-14': 'ui-1', 'ui-17': 'ui-1',
    }
    const saved = persisted('erp.ui', 'ui-1' as UiId)
    if (!localStorage.getItem('erp.ui.renumbered')) {
      localStorage.setItem('erp.ui.renumbered', '1')
      const moved = RENUMBERED[saved as string]
      if (moved) {
        localStorage.setItem('erp.ui', JSON.stringify(moved))
        return moved
      }
    }
    return UI_MAP[saved] ? saved : 'ui-1'
  })
  const setUi = (u: UiId) => {
    if (!UI_MAP[u]) return
    setUiRaw(u)
    localStorage.setItem('erp.ui', JSON.stringify(u))
    const forced = UI_MAP[u].density
    if (forced) setDensity(forced)
  }

  const [industryId, setIndustryIdRaw] = useState<string>(() => {
    const saved = persisted('erp.industry', DEFAULT_INDUSTRY)
    return INDUSTRY_MAP[saved] ? saved : DEFAULT_INDUSTRY
  })

  // The generator and the registry read these as module state, so keep them in
  // step during render rather than in an effect — the first paint must already
  // be showing the right vertical's data.
  setActiveIndustry(industryId)
  setSegment(segment)

  const industry = activeIndustry()

  const [role, setRoleRaw] = useState<string>(() => persisted(roleKey(industryId), industry.user.defaultRole))
  const [institution, setInstitution] = useState(industry.scope.orgs[0])
  const [campus, setCampus] = useState(industry.scope.sites[0])
  const [year, setYear] = useState(industry.scope.periods[0])
  const [textSize, setTextSizeRaw] = useState<TextSize>(() => persisted('erp.textsize', 'medium' as TextSize))
  const [corners, setCornersRaw] = useState<Corners>(() => persisted('erp.corners', 'default' as Corners))
  const [borders, setBordersRaw] = useState<Borders>(() => persisted('erp.borders', 'default' as Borders))
  const [shadows, setShadowsRaw] = useState<Shadows>(() => persisted('erp.shadows', 'default' as Shadows))
  const [pattern, setPatternRaw] = useState<Pattern>(() => persisted('erp.pattern', 'none' as Pattern))
  const [contrast, setContrastRaw] = useState<Contrast>(() => persisted('erp.contrast', 'normal' as Contrast))
  const [accent, setAccentRaw] = useState<{ h: number; s: number; l: number } | null>(
    () => persisted('erp.accent', null as any))
  const [palettes, setPalettesRaw] = useState<Palette[]>(() => persisted('erp.palettes', [] as Palette[]))
  const [background, setBackgroundRaw] = useState<{ h: number; s: number; l: number } | null>(
    () => persisted(bgKey(persisted('erp.ui', 'ui-1')), null as any),
  )
  const [backgrounds, setBackgrounds] = useState<BgMap>(
    () => persisted(`${bgKey(persisted('erp.ui', 'ui-1'))}.parts`, {} as BgMap),
  )
  const [bgTarget, setBgTarget] = useState<BgTarget>('page')
  const [inks, setInks] = useState<BgMap>(
    () => persisted(`${bgKey(persisted('erp.ui', 'ui-1'))}.ink`, {} as BgMap),
  )
  /** Which element overrides this pass has written, so it clears only those. */
  const appliedParts = useRef<Set<string>>(new Set())
  const appliedInks = useRef<Set<string>>(new Set())
  // The term / shift / wave selector. It reads differently per vertical, which
  // is why the options come from a table rather than from scope.periods.
  const [period, setPeriod] = useState(() => TERMS[industryId]?.[0] ?? 'Period 1')

  const setIndustry = (id: string) => {
    const next = INDUSTRY_MAP[id] ? id : DEFAULT_INDUSTRY
    setActiveIndustry(next)
    setIndustryIdRaw(next)
    localStorage.setItem('erp.industry', JSON.stringify(next))
    const def = INDUSTRY_MAP[next]
    const savedRole = persisted(roleKey(next), def.user.defaultRole)
    setRoleRaw(def.roles.some((r) => r.id === savedRole) ? savedRole : def.user.defaultRole)
    setInstitution(def.scope.orgs[0])
    setCampus(def.scope.sites[0])
    setYear(def.scope.periods[0])
    setPeriod(TERMS[next]?.[0] ?? 'Period 1')
  }

  const changeSegment = (v: Segment) => {
    setSegmentRaw(v); setSegment(v); localStorage.setItem('erp.segment', JSON.stringify(v))
  }

  const setSkin = (s: Skin) => { setSkinRaw(s); localStorage.setItem('erp.skin', JSON.stringify(s)) }

  const setTheme = (t: 'light' | 'dark') => {
    /* Asking for light or dark is asking for a plain interface. Clearing only
       the palette colour left every per-element colour in place, so the page
       stayed painted and the toggle looked broken. */
    setBackgroundRaw(null)
    localStorage.removeItem(bgKey(ui))
    setBackgrounds({})
    localStorage.removeItem(`${bgKey(ui)}.parts`)
    setInks({})
    localStorage.removeItem(`${bgKey(ui)}.ink`)
    setThemeRaw(t)
    localStorage.setItem('erp.theme', JSON.stringify(t))
    document.documentElement.classList.toggle('dark', t === 'dark')
  }
  const setRole = (r: string) => { setRoleRaw(r); localStorage.setItem(roleKey(industryId), JSON.stringify(r)) }
  const setTextSize = (v: TextSize) => { setTextSizeRaw(v); localStorage.setItem('erp.textsize', JSON.stringify(v)) }
  /* One setter shape for all of them: write the state, write the key. */
  const keep = <T,>(set: (v: T) => void, key: string) => (v: T) => {
    set(v); localStorage.setItem(key, JSON.stringify(v))
  }
  const setCorners = keep(setCornersRaw, 'erp.corners')
  const setBorders = keep(setBordersRaw, 'erp.borders')
  const setShadows = keep(setShadowsRaw, 'erp.shadows')
  const setPattern = keep(setPatternRaw, 'erp.pattern')
  const setContrast = keep(setContrastRaw, 'erp.contrast')
  const setAccent = keep(setAccentRaw, 'erp.accent')

  /* A palette is the whole scheme, not one colour: every surface, every ink and
     the accent, so applying one restores exactly what was seen when it was
     saved. Saved globally rather than per interface — the point of keeping a
     scheme is to use it on another one. */
  const savePalette = (name: string) => {
    const p: Palette = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || 'Untitled', parts: backgrounds, inks, accent,
    }
    setPalettesRaw((prev) => {
      const next = [p, ...prev].slice(0, 24)
      localStorage.setItem('erp.palettes', JSON.stringify(next))
      return next
    })
  }
  const applyPalette = (id: string) => {
    const p = palettes.find((x) => x.id === id)
    if (!p) return
    setBackgrounds(p.parts)
    localStorage.setItem(`${bgKey(ui)}.parts`, JSON.stringify(p.parts))
    setInks(p.inks)
    localStorage.setItem(`${bgKey(ui)}.ink`, JSON.stringify(p.inks))
    setAccent(p.accent)
  }
  const deletePalette = (id: string) => {
    setPalettesRaw((prev) => {
      const next = prev.filter((x) => x.id !== id)
      localStorage.setItem('erp.palettes', JSON.stringify(next))
      return next
    })
  }
  const setBackgroundFor = (t: BgTarget, c: { h: number; s: number; l: number } | null) => {
    setBackgrounds((prev) => {
      const next = { ...prev, [t]: c }
      if (!c) delete next[t]
      localStorage.setItem(`${bgKey(ui)}.parts`, JSON.stringify(next))
      return next
    })
  }

  const setInkFor = (t: BgTarget, c: { h: number; s: number; l: number } | null) => {
    setInks((prev) => {
      const next = { ...prev, [t]: c }
      if (!c) delete next[t]
      localStorage.setItem(`${bgKey(ui)}.ink`, JSON.stringify(next))
      return next
    })
  }

  const setBackground = (c: { h: number; s: number; l: number } | null) => {
    setBackgroundRaw(c)
    if (c) localStorage.setItem(bgKey(ui), JSON.stringify(c))
    else localStorage.removeItem(bgKey(ui))
  }

  useEffect(() => { localStorage.setItem('erp.sidebar', JSON.stringify(sidebarCollapsed)) }, [sidebarCollapsed])
  useEffect(() => { localStorage.setItem('erp.subpanel', JSON.stringify(subPanelCollapsed)) }, [subPanelCollapsed])
  useEffect(() => { localStorage.setItem('erp.density', JSON.stringify(density)) }, [density])
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark') }, [theme])
  useEffect(() => { document.documentElement.dataset.skin = skin }, [skin])
  useEffect(() => { document.documentElement.dataset.density = density }, [density])
  useEffect(() => { document.documentElement.dataset.industry = industryId }, [industryId])
  useEffect(() => { document.documentElement.dataset.ui = ui }, [ui])

  // Switching interface restores that interface's own colour.
  useEffect(() => {
    setBackgroundRaw(persisted(bgKey(ui), null as any))
    setBackgrounds(persisted(`${bgKey(ui)}.parts`, {} as BgMap))
    setInks(persisted(`${bgKey(ui)}.ink`, {} as BgMap))
  }, [ui])

  /* A background is not one token. The rails and the top bar read --rail and
     --chrome, the surfaces read --card, and the hairlines read --border — set
     only --background and the page changes colour while its chrome stays
     white, which is what happened the first time.
     So the choice becomes a small palette. Everything is derived from the one
     hue and saturation, stepped in lightness, and which direction each step
     goes depends on whether the chosen colour is dark: on a dark ground a card
     has to be lighter than the page, on a light ground darker. */
  useEffect(() => {
    const root = document.documentElement
    const TOKENS = [
      '--background', '--ground', '--card', '--popover', '--chrome', '--rail', '--th',
      '--border', '--input', '--muted', '--secondary', '--accent',
      '--foreground', '--card-foreground', '--popover-foreground',
      '--muted-foreground', '--secondary-foreground', '--accent-foreground',
    ]
    if (!background) {
      TOKENS.forEach((t) => root.style.removeProperty(t))
      root.style.removeProperty('--bg-mesh')
      return
    }

    const { h, s, l } = background
    const rgb = ((): number[] => {
      const S = s / 100, L = l / 100
      const c = (1 - Math.abs(2 * L - 1)) * S
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
      const m = L - c / 2
      const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
      return [r + m, g + m, b + m]
    })()
    const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    const picked = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] < 0.4
    void picked   // kept for reference; the appearance decides, not the colour
    const dark = theme === 'dark'

    /* Restraint is the whole trick. Tinting every surface with the chosen hue
       turns the interface into one muddy wash — the first attempt did exactly
       that and looked cheap. The colour is a canvas: the page takes it at full
       strength, and what sits on the page stays close to a neutral surface,
       carrying only enough of the hue to belong to it. */
    const clamp = (v: number) => Math.min(Math.max(v, 0), 100)
    const hsl = (light: number, sat: number) =>
      `${Math.round(h)} ${Math.round(clamp(sat))}% ${Math.round(clamp(light))}%`

    /* The same choice reads differently in each appearance: in light it is the
       colour as picked, in dark the same hue taken down to a ground that text
       can sit on. Without this, choosing a colour froze the toggle. */
    const pageL = dark ? clamp(Math.min(l, 26) * 0.75 + 6) : l
    const pageS = dark ? Math.min(s, 55) : s

    /* Enough of the hue that the rails and bars read as part of the chosen
       colour, not enough to stop being surfaces. The first attempt washed them
       at full saturation and looked cheap; a whisper left them looking like
       they belonged to a different theme. This sits between the two. */
    const tint = Math.min(pageS * 0.42, dark ? 30 : 24)
    const line = Math.min(pageS * 0.5, dark ? 34 : 28)

    /* Chrome sits a few steps off the page so it is plainly the same colour,
       lifted. Cards stay near the ends of the range, because a table of figures
       needs to be read, and reading happens on paper rather than on colour. */
    /* A panel has to separate from the page it floats on. Stepping a fixed
       amount left them almost invisible on some colours, so the step has a
       floor: at least 14 points of lightness between panel and page, in
       whichever direction there is room for. */
    const away = pageL > 50 ? -1 : 1
    const offPage = (up: number) => clamp(pageL + away * Math.max(up, 14))
    const surface = dark ? 15 : 100
    const raised = dark ? 19 : 100

    /* A flat fill of one colour is the least interesting thing a colour can
       do. The page becomes a soft mesh instead: four blobs drawn from around
       the chosen hue, far enough apart to read as a gradient and close enough
       to still read as that colour. */
    const near = (dh: number, dl: number, ds = 0) =>
      `hsl(${Math.round((h + dh + 360) % 360)} ${Math.round(clamp(pageS + ds))}% ${Math.round(clamp(pageL + dl))}%)`
    root.style.setProperty('--bg-mesh', [
      `radial-gradient(62% 58% at 12% 18%, ${near(-32, dark ? 6 : 8)} 0%, transparent 62%)`,
      `radial-gradient(58% 62% at 88% 12%, ${near(28, dark ? 4 : 6, -8)} 0%, transparent 60%)`,
      `radial-gradient(70% 66% at 78% 88%, ${near(58, dark ? 8 : 10, -6)} 0%, transparent 64%)`,
      `radial-gradient(66% 60% at 22% 92%, ${near(-64, dark ? 3 : 5)} 0%, transparent 62%)`,
      `linear-gradient(${hsl(pageL, pageS)}, ${hsl(pageL, pageS)})`,
    ].join(', '))

    root.style.setProperty('--background', hsl(pageL, pageS))
    root.style.setProperty('--ground', hsl(dark ? pageL - 3 : pageL - 4, pageS))
    root.style.setProperty('--card', hsl(surface, tint))
    root.style.setProperty('--popover', hsl(raised, tint))
    // The bars and rails take the colour; the reading surfaces do not.
    root.style.setProperty('--chrome', hsl(offPage(dark ? 9 : 16), tint))
    root.style.setProperty('--rail', hsl(offPage(dark ? 7 : 13), tint))
    root.style.setProperty('--th', hsl(dark ? 20 : 97, tint))
    root.style.setProperty('--muted', hsl(dark ? 22 : 96, tint))
    root.style.setProperty('--secondary', hsl(dark ? 22 : 96, tint))
    root.style.setProperty('--accent', hsl(dark ? 26 : 94, tint))
    root.style.setProperty('--border', hsl(dark ? 30 : 88, line))
    root.style.setProperty('--input', hsl(dark ? 30 : 88, line))

    /* Text sits on the surfaces, not on the page, so it is judged against
       those — near-black on light paper, near-white on dark, whatever colour
       the canvas behind them happens to be. */
    /* Not "is this dark?" but "which of black or white reads better on it?".
       A threshold picks a side; at the boundary — a mid pink, an olive — it
       picks the wrong one and lands near 3:1. Comparing both candidates and
       taking the better always lands above 4.5:1, whatever colour is chosen. */
    const relLum = (lightness: number, sat: number) => {
      const S = sat / 100, L = lightness / 100
      const c = (1 - Math.abs(2 * L - 1)) * S
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
      const m = L - c / 2
      const [r0, g0, b0] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
      const li = [r0 + m, g0 + m, b0 + m].map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * li[0] + 0.7152 * li[1] + 0.0722 * li[2]
    }

    const LIGHT_INK = '0 0% 98%'
    const DARK_INK = `${Math.round(h)} 26% 10%`
    const LIGHT_L = 0.9522, DARK_L = relLum(10, 26)

    /** Whichever of the two inks contrasts better with this surface. */
    const inkFor = (lightness: number, sat: number) => {
      const bg = relLum(lightness, sat) + 0.05
      const onLight = Math.max(bg, LIGHT_L + 0.05) / Math.min(bg, LIGHT_L + 0.05)
      const onDark = Math.max(bg, DARK_L + 0.05) / Math.min(bg, DARK_L + 0.05)
      return onLight >= onDark ? LIGHT_INK : DARK_INK
    }

    const cardL = dark ? 15 : 100
    const pageInk = inkFor(pageL, pageS)
    const cardInk = inkFor(cardL, tint)
    const pageDark = pageInk === LIGHT_INK
    const cardDark = cardInk === LIGHT_INK
    const inkOn = (isDark: boolean) => (isDark ? LIGHT_INK : DARK_INK)

    // Headings sit on the page; a card's contents sit on the card.
    root.style.setProperty('--foreground', inkOn(pageDark))
    root.style.setProperty('--card-foreground', inkOn(cardDark))
    root.style.setProperty('--popover-foreground', inkOn(cardDark))
    root.style.setProperty('--secondary-foreground', inkOn(cardDark))
    root.style.setProperty('--accent-foreground', inkOn(cardDark))
    root.style.setProperty('--muted-foreground', cardDark ? `${Math.round(h)} 10% 78%` : `${Math.round(h)} 14% 32%`)
    // Secondary text on the page follows the page's ink, not the card's.
    root.style.setProperty('--muted-on-page', pageDark ? `${Math.round(h)} 10% 82%` : `${Math.round(h)} 16% 26%`)
  }, [background, theme])

  /* Applied after the palette so a single surface can be repainted without
     disturbing the rest. Each surface takes a foreground chosen against it, or
     a dark bar would keep the page's dark text. */
  useEffect(() => {
    const root = document.documentElement
    const PARTS: Record<string, string[]> = {
      page: ['--background', '--ground'],
      topbar: ['--chrome'],
      sidebar: ['--rail'],
      dock: ['--dock'],
      cards: ['--card', '--popover'],
    }
    const INK: Record<string, string> = {
      page: '--foreground', topbar: '--chrome-foreground', sidebar: '--rail-foreground',
      dock: '--dock-foreground', cards: '--card-foreground',
    }
    Object.entries(PARTS).forEach(([t, tokens]) => {
      const c = (backgrounds as any)[t]
      if (!c) {
        /* Only clear what this pass previously wrote. Clearing unconditionally
           stripped --background moments after the palette had set it, so
           choosing "All" appeared to do nothing. */
        if (appliedParts.current.has(t)) {
          tokens.forEach((k) => root.style.removeProperty(k))
          root.style.removeProperty(INK[t])
          appliedParts.current.delete(t)
        }
        return
      }
      appliedParts.current.add(t)
      const { h, s, l } = c
      tokens.forEach((k, i) => root.style.setProperty(k, `${Math.round(h)} ${Math.round(s)}% ${Math.round(Math.max(l - i * 3, 0))}%`))
      // Same rule as everywhere else: whichever ink reads better on it.
      root.style.setProperty(INK[t], inkOnHsl(h, s, l))
    })

    /* Every surface takes an ink chosen against its OWN colour, painted or not.
       Deriving one only for the surfaces the reader repainted left the rest
       falling back to `--foreground`, which belongs to the page. Paint the page
       gold and the sidebar — still pale — inherited the gold page's pale ink and
       its labels all but vanished. The surface's colour is read back from the
       cascade, so a colour set by the interface's own stylesheet counts too. */
    const SURFACE: Array<[string, string]> = [
      ['--chrome-foreground', '.chrome'],
      ['--rail-foreground', '.edu-sidebar, .nexus-panel, .vector-strip, .pulse-rail, .halo-panel'],
      ['--dock-foreground', '.halo-dock, nav.chrome'],
    ]
    SURFACE.forEach(([inkVar, selector]) => {
      // The reader's own choice wins; this only fills a gap.
      if ((inks as any)[INK_OWNER[inkVar]]) return
      const el = document.querySelector(selector)
      if (!el) { root.style.removeProperty(inkVar); return }
      /* Measured off the element rather than read from `--rail` and friends,
         because several shells paint their rail from their own stylesheet and
         never define the token. Reading the token there returned nothing, the
         ink fell back to the page's, and a repainted work area took the
         sidebar's labels down with it. */
      const bg = effectiveBackground(el)
      if (!bg) { root.style.removeProperty(inkVar); return }
      root.style.setProperty(inkVar, luminance(bg) < 0.42 ? '0 0% 98%' : '220 24% 11%')
    })
  }, [backgrounds, background, inks, theme, ui])

  /* Text colours the reader has chosen, applied after everything that derives
     one. Deliberate beats derived — but the contrast floors elsewhere no longer
     apply, which is the reader's call to make. */
  useEffect(() => {
    const root = document.documentElement
    const INK: Record<string, string[]> = {
      page: ['--foreground', '--muted-on-page'],
      topbar: ['--chrome-foreground'],
      sidebar: ['--rail-foreground'],
      dock: ['--dock-foreground'],
      cards: ['--card-foreground', '--popover-foreground', '--secondary-foreground',
              '--accent-foreground', '--muted-foreground'],
    }
    Object.entries(INK).forEach(([t, tokens]) => {
      const c = (inks as any)[t]
      if (!c) {
        if (appliedInks.current.has(t)) { tokens.forEach((k) => root.style.removeProperty(k)); appliedInks.current.delete(t) }
        return
      }
      appliedInks.current.add(t)
      tokens.forEach((k) => root.style.setProperty(k, `${Math.round(c.h)} ${Math.round(c.s)}% ${Math.round(c.l)}%`))
    })
  }, [inks, backgrounds, background, theme, ui])
  useEffect(() => { document.documentElement.dataset.font = font }, [font])
  useEffect(() => { document.documentElement.dataset.textsize = textSize }, [textSize])

  /* The look dials, as attributes the stylesheet keys off. Corners is the one
     that also needs a number, since it multiplies whatever radius the current
     interface declared for itself. */
  useEffect(() => {
    const root = document.documentElement
    root.dataset.corners = corners
    root.style.setProperty('--radius-scale',
      String(CORNERS.find((c) => c.id === corners)?.scale ?? 1))
  }, [corners])
  useEffect(() => { document.documentElement.dataset.borders = borders }, [borders])
  useEffect(() => { document.documentElement.dataset.shadows = shadows }, [shadows])
  useEffect(() => { document.documentElement.dataset.pattern = pattern }, [pattern])
  useEffect(() => { document.documentElement.dataset.contrast = contrast }, [contrast])

  /* The accent is set apart from the surfaces because it is the one colour that
     has to stay legible against all of them — buttons, links, the focus ring
     and every selected state read from it. Its own foreground is chosen the
     same way every other ink is. */
  useEffect(() => {
    const root = document.documentElement
    if (!accent) {
      root.style.removeProperty('--primary')
      root.style.removeProperty('--primary-foreground')
      root.style.removeProperty('--ring')
      return
    }
    const { h, s, l } = accent
    root.style.setProperty('--primary', `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`)
    root.style.setProperty('--ring', `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`)
    root.style.setProperty('--primary-foreground', inkOnHsl(h, s, l))
  }, [accent])

  // Global shortcut: Cmd/Ctrl+K opens the command palette.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o) }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); setSidebarCollapsed((c) => !c) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const value = useMemo<AppState>(() => ({
    theme, setTheme, skin, setSkin, ui, uiDef: UI_MAP[ui], setUi, font, setFont,
    industry, industryId, setIndustry,
    segment, setSegment: changeSegment, sidebarCollapsed, setSidebarCollapsed,
    subPanelCollapsed, setSubPanelCollapsed,
    mobileNavOpen, setMobileNavOpen, paletteOpen, setPaletteOpen, role, setRole,
    institution, setInstitution, campus, setCampus, year, setYear, density, setDensity,
    period, setPeriod, periods: TERMS[industryId] ?? ['Period 1', 'Period 2', 'Period 3'],
    background, setBackground, backgrounds, setBackgroundFor, bgTarget, setBgTarget,
    inks, setInkFor,
    corners, setCorners, borders, setBorders, shadows, setShadows,
    pattern, setPattern, contrast, setContrast, accent, setAccent,
    palettes, savePalette, applyPalette, deletePalette,
    textSize, setTextSize,
    years: industry.scope.periods, institutions: industry.scope.orgs, campuses: industry.scope.sites,
  }), [theme, skin, ui, font, industryId, segment, sidebarCollapsed, subPanelCollapsed, mobileNavOpen, paletteOpen, role, institution, campus, year, period, density, background, backgrounds, inks, bgTarget, textSize, corners, borders, shadows, pattern, contrast, accent, palettes])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
