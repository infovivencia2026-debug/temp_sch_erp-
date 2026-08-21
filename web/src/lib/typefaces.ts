/* The typefaces somebody can choose, and how they arrive.

   Fifteen faces, and the product ships exactly one of them. Inter is bundled
   as a variable woff2 and is the default; everything else is fetched from
   Google Fonts the first time it is wanted — when the picker opens to draw its
   specimens, or when a choice is restored on load.

   That is the whole reason this file exists rather than a list of CSS classes.
   Bundling fifteen families would put roughly two megabytes of webfont into
   the initial download so that fourteen of them could go unused by almost
   everybody. Fetching on demand costs the default nothing.

   THE OFFLINE CASE IS REAL AND IS HANDLED BY DOING NOTHING. A school running
   this on a LAN with no route out will have the <link> fail, and the stack
   below falls through to the next family and then to the system UI font. The
   interface stays legible; it is simply not the face that was picked. That is
   the correct failure for a preference about appearance, and it is why every
   stack ends in a real system fallback rather than in the family name alone. */

export interface Typeface {
  id: string
  name: string
  /** What Google calls it. Null for the two that need no fetching. */
  google: string | null
  /** The full CSS stack, fallbacks included. */
  stack: string
  note: string
}

export const TYPEFACES: readonly Typeface[] = [
  {
    id: 'inter',
    name: 'Inter',
    google: null, // bundled via @fontsource-variable/inter
    stack: "'Inter Variable', Inter, ui-sans-serif, system-ui, sans-serif",
    note: 'Neutral UI grotesk. The default.',
  },
  {
    id: 'system',
    name: 'System',
    google: null,
    stack: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    note: 'Whatever the device ships with.',
  },
  { id: 'geist', name: 'Geist', google: 'Geist',
    stack: "Geist, ui-sans-serif, system-ui, sans-serif", note: 'Tighter, more editorial.' },
  { id: 'manrope', name: 'Manrope', google: 'Manrope',
    stack: "Manrope, ui-sans-serif, system-ui, sans-serif", note: 'Rounder, friendlier.' },
  { id: 'plex', name: 'IBM Plex Sans', google: 'IBM+Plex+Sans:wght@400;500;600',
    stack: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
    note: 'Institutional, slightly technical.' },
  { id: 'dm', name: 'DM Sans', google: 'DM+Sans:opsz,wght@9..40,400..700',
    stack: "'DM Sans', ui-sans-serif, system-ui, sans-serif", note: 'Geometric and compact.' },
  { id: 'alata', name: 'Alata', google: 'Alata',
    stack: "Alata, ui-sans-serif, system-ui, sans-serif", note: 'Wide and even, low contrast.' },
  { id: 'barlow', name: 'Barlow', google: 'Barlow:wght@400;500;600',
    stack: "Barlow, ui-sans-serif, system-ui, sans-serif", note: 'Slightly condensed, signage-like.' },
  { id: 'josefin', name: 'Josefin Sans', google: 'Josefin+Sans:wght@400;500;600',
    stack: "'Josefin Sans', ui-sans-serif, system-ui, sans-serif",
    note: 'Geometric with a tall x-height.' },
  { id: 'outfit', name: 'Outfit', google: 'Outfit:wght@400;500;600',
    stack: "Outfit, ui-sans-serif, system-ui, sans-serif", note: 'Clean geometric display.' },
  { id: 'figtree', name: 'Figtree', google: 'Figtree:wght@400;500;600',
    stack: "Figtree, ui-sans-serif, system-ui, sans-serif", note: 'Warm, softly rounded.' },
  { id: 'sourceserif', name: 'Source Serif', google: 'Source+Serif+4:opsz,wght@8..60,400..700',
    stack: "'Source Serif 4', ui-serif, Georgia, serif", note: 'A serif, for reading at length.' },
  { id: 'jetbrains', name: 'JetBrains Mono', google: 'JetBrains+Mono:wght@400;500',
    stack: "'JetBrains Mono', ui-monospace, Menlo, monospace",
    note: 'Fixed width. Every figure lines up.' },
  { id: 'ibmplexmono', name: 'IBM Plex Mono', google: 'IBM+Plex+Mono:wght@400;500;600',
    stack: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
    note: 'Monospaced. IDs, codes, and technical values.' },
  { id: 'cinzel', name: 'Cinzel', google: 'Cinzel:wght@400;600',
    stack: "Cinzel, ui-serif, Georgia, serif", note: 'Roman capitals, engraved.' },
] as const

export const DEFAULT_TYPEFACE = 'inter'

export function typefaceById(id: string): Typeface {
  return TYPEFACES.find((t) => t.id === id) ?? TYPEFACES[0]
}

const loaded = new Set<string>()

/** Fetch a family's stylesheet once. Safe to call on every render. */
export function ensureFont(id: string) {
  const face = TYPEFACES.find((t) => t.id === id)
  if (!face?.google || loaded.has(face.id)) return
  loaded.add(face.id)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  // display=swap so text is readable in the fallback while the file arrives,
  // rather than invisible for the length of the request.
  link.href = `https://fonts.googleapis.com/css2?family=${face.google}&display=swap`
  // Failure is silent on purpose: the stack falls through and the page stays
  // legible. Logging it would put a red line in the console of every school
  // that runs this on a closed network, every time somebody opened the picker.
  link.addEventListener('error', () => loaded.delete(face.id))
  document.head.appendChild(link)
}

/** Everything the picker needs to draw its specimens. */
export function ensureAllFonts() {
  for (const t of TYPEFACES) ensureFont(t.id)
}
