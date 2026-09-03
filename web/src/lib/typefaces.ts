/* The typefaces somebody can choose, and how they arrive.

   Six faces, and the product ships exactly one of them. Inter is bundled as a
   variable woff2 and is the default; the other four fetched families come from
   Google Fonts the first time one is wanted -- when the picker opens to draw
   its specimens, or when a choice is restored on load.

   That is the whole reason this file exists rather than a list of CSS classes.
   Bundling every family would put roughly two megabytes of webfont into the
   initial download so that all but one could go unused by almost everybody.
   Fetching on demand costs the default nothing.

   IT WAS FIFTEEN. The list carried a serif, two monospaces and seven more
   sans faces that differed from each other by less than the specimen row
   could show at this size, so the picker asked a school to choose between
   things it could not tell apart. A choice nobody can make is not a choice,
   and every extra row was another specimen to render and another family to
   fetch. Removing one is safe by construction: typefaceById falls back to the
   first entry, so anybody already on a face that has gone is on Inter the next
   time they load, with nothing to fix and nothing lost but a preference they
   could set again in two taps.

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
] as const

export const DEFAULT_TYPEFACE = 'inter'

/* Faces that are no longer offered, and where somebody set to one should land.

   A removed face cannot simply vanish: the choice is stored per device, so
   anybody who had picked it keeps that id in localStorage and would otherwise
   be silently dropped back to the default — a different typeface from the one
   they chose, with nothing said about it.

   Cinzel was engraved Roman capitals, which is a display face; it belonged on
   a monument rather than on a fee register. Whoever chose it wanted something
   with more character than the default, so they go to IBM Plex Sans rather
   than back to Inter. */
const RETIRED: Record<string, string> = { cinzel: 'plex' }

export function typefaceById(id: string): Typeface {
  const wanted = RETIRED[id] ?? id
  return TYPEFACES.find((t) => t.id === wanted) ?? TYPEFACES[0]
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
