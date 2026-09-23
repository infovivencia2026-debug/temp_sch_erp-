import { useEffect, useRef } from 'react'
import { useShortcuts, removeFromDashboard } from '@/lib/shortcuts'
import { useCatalogIfAny, featurePath } from '@/lib/catalog'
import { useLayout, isRemoved } from '@/lib/widgets'
import { FeatureGlyph } from '@/components/FeatureGlyph'
import { Cell, Cue } from './bento-kit'
import { Widget, useWidgetLayer } from './WidgetLayer'
import { hueFor } from './BentoLauncher'

/* "ADD TO HOME" PUTS A TILE ON THE HOME.
 *
 * It used to add the feature to a strip of chips above the board -- correct,
 * and invisible on a phone, where the board fills the screen and the strip
 * sat above it in the scroll. A person who long-pressed a tile, chose "Add
 * to home" and looked at their home saw nothing change, and said so.
 *
 * So the home shortcuts are cells now, on the board itself, keyed
 * `feature:<key>`: the same plate the launcher draws, the feature's name,
 * and Open. They declare themselves to the layer like any other card, so
 * they page, drag, resize and hide with the rest. Hiding one from the board
 * also takes it off the shortcuts list, so the launcher's "Remove from home"
 * and the card's own "Hide" agree.
 *
 * Resolved through the catalogue every render, for the reason the strip
 * was: a shortcut to something this account may no longer open simply
 * stops appearing rather than 404ing on tap. */

export const FEATURE_PREFIX = 'feature:'

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

  /* A tile hidden from the board is a shortcut removed: the two lists must
     not disagree about what is on the home. Done in an effect, because the
     shortcuts store is not this component's state. */
  const hidden = found.filter((f) => f && isRemoved(layout, FEATURE_PREFIX + f.key)).map((f) => f!.key)
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
    const id = FEATURE_PREFIX + fresh
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
      {found.map((f, i) => {
        if (!f) return null
        const id = FEATURE_PREFIX + f.key
        return (
          <Widget key={id} id={id} label={f.name} size="small" index={900 + i}>
            {(span) => (
              <Cell span={span}>
                <div className="flex h-full flex-col">
                  <FeatureGlyph slug={f.slug} section={f.section} tint={hueFor(f.workspace)} size={40} />
                  <p className="mt-auto pt-3 text-[14px] font-semibold leading-snug">{f.name}</p>
                  <p className="text-[12px] text-[var(--bento-muted)]">{f.workspace}</p>
                </div>
                <Cue to={f.href} label="Open" />
              </Cell>
            )}
          </Widget>
        )
      })}
    </>
  )
}
