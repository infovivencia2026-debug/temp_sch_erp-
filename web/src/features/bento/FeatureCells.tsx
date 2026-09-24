import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useShortcuts, removeFromDashboard } from '@/lib/shortcuts'
import { useCatalogIfAny, featurePath } from '@/lib/catalog'
import { useLayout, isRemoved } from '@/lib/widgets'
import { FeatureGlyph } from '@/components/FeatureGlyph'
import { Cell } from './bento-kit'
import { Widget, useWidgetLayer } from './WidgetLayer'
import { hueFor } from './BentoLauncher'
import './feature-cells.css'

/* "ADD TO HOME" PUTS A TILE ON THE HOME.
 *
 * It used to add the feature to a strip of chips above the board -- correct,
 * and invisible on a phone, where the board fills the screen and the strip
 * sat above it in the scroll. A person who long-pressed a tile, chose "Add
 * to home" and looked at their home saw nothing change, and said so.
 *
 * So the home shortcuts are cells now, on the board itself: the same plate
 * the launcher draws and the feature's name, four to a cell (see FOUR TO A
 * CELL below). They declare themselves to the layer like any other card, so
 * they page, drag, resize and hide with the rest. Hiding one from the board
 * also takes its screens off the shortcuts list, so the launcher's "Remove
 * from home" and the card's own "Hide" agree.
 *
 * Resolved through the catalogue every render, for the reason the strip
 * was: a shortcut to something this account may no longer open simply
 * stops appearing rather than 404ing on tap. */

export const FEATURE_PREFIX = 'feature:'

/* FOUR TO A CELL.

   One screen per small cell spent a whole card on one glyph and one name,
   and a person with eight shortcuts had eight cards -- two phone pages of
   them. So a small cell now holds up to four, in a two-by-two grid, each
   its own link: the same plate the launcher draws, the name beneath. The
   cells are keyed `feature:group:1`, `feature:group:2`... in the order the
   shortcuts were added, so the first four fill the first cell and the fifth
   opens the second. Hiding a cell takes its four off the shortcuts list, so
   the launcher's "Remove from home" and the card's own "Hide" still agree. */
export const PER_CELL = 4
const GROUP_PREFIX = FEATURE_PREFIX + 'group:'
export function groupId(n: number): string {
  return `${GROUP_PREFIX}${n + 1}`
}

export function FeatureCells() {
  const layer = useWidgetLayer()
  const keys = useShortcuts()
  const catalog = useCatalogIfAny()
  const { layout } = useLayout(layer?.dashboard ?? 'default')

  const found = keys.map((key) => {
    for (const role of catalog?.roles ?? []) {
      for (const section of role.sections) {
        const f = section.features.find((x) => x.key === key)
        if (f && f.live && f.in_scope) {
          return {
            key, name: f.name, slug: f.slug, section: section.slug,
            workspace: section.workspace || section.name,
            href: featurePath(role.key, section.slug, f.slug),
          }
        }
      }
    }
    return null
  })

  /* The cells, four screens each, in the order the shortcuts were added. */
  const live = found.filter((f): f is NonNullable<typeof f> => f !== null)
  const groups: (typeof live)[] = []
  for (let i = 0; i < live.length; i += PER_CELL) groups.push(live.slice(i, i + PER_CELL))

  /* A cell hidden from the board is its shortcuts removed: the two lists
     must not disagree about what is on the home. Done in an effect, because
     the shortcuts store is not this component's state. */
  const hidden = groups
    .flatMap((g, n) => (isRemoved(layout, groupId(n)) ? g.map((f) => f.key) : []))
  useEffect(() => {
    for (const k of hidden) removeFromDashboard(k)
  }, [hidden.join(',')])

  /* THE NEW TILE COMES TO YOU.

     On a phone the board is pages of four, and the first page is usually
     the anchor card alone; a tile declared after everything else lands on
     the last page. So "Add to home" said "Fees is on your home" and the
     home, on page one, looked exactly as it had -- which the owner reported
     as "I can't see it". When a key appears that was not there a moment
     ago, the pager is scrolled to the page the layer packed it onto, after
     the frame in which it was packed. A desk shows every page at once and
     needs nothing. */
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    const now = new Set(keys)
    const before = seen.current
    seen.current = now
    if (!before || !layer?.spots) return
    const fresh = keys.find((k) => !before.has(k))
    if (!fresh) return
    const at = live.findIndex((f) => f.key === fresh)
    if (at < 0) return
    const id = groupId(Math.floor(at / PER_CELL))
    const t = window.setTimeout(() => {
      const page = layer.spots?.get(id)?.page
      if (page === undefined) return
      document
        .querySelector<HTMLElement>(`.bento-board .bento-page[data-page="${page}"]`)
        ?.scrollIntoView({ behavior: layer.still ? 'auto' : 'smooth', inline: 'start', block: 'nearest' })
    }, 120)
    return () => window.clearTimeout(t)
  }, [keys.join(','), layer?.spots])

  if (!layer) return null
  return (
    <>
      {groups.map((g, n) => {
        const id = groupId(n)
        const label = n === 0 ? 'Shortcuts' : `Shortcuts ${n + 1}`
        return (
          <Widget key={id} id={id} label={label} size="small" index={900 + n}>
            {(span) => (
              <Cell span={span}>
                <div className="fc-grid" role="group" aria-label={label}>
                  {g.map((f) => (
                    <Link key={f.key} to={f.href} className="fc-tile" title={`${f.name} (${f.workspace})`}>
                      <FeatureGlyph slug={f.slug} section={f.section} tint={hueFor(f.workspace)} size={34} />
                      <span className="fc-name">{f.name}</span>
                    </Link>
                  ))}
                  {/* The empty places say the cell holds four; they are
                      filled from the launcher's "Add to home" or the
                      board's own "+". */}
                  {Array.from({ length: PER_CELL - g.length }, (_, i) => (
                    <span key={`empty-${i}`} className="fc-empty" aria-hidden="true" />
                  ))}
                </div>
              </Cell>
            )}
          </Widget>
        )
      })}
    </>
  )
}
