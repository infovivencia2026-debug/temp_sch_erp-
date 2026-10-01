import { useEffect, useRef, type CSSProperties } from 'react'
import { shortLabels } from './short-labels'
import { Link } from 'react-router-dom'
import { useShortcuts, removeFromDashboard, seedShortcuts } from '@/lib/shortcuts'
import { useCatalogIfAny, featurePath, usable, type CatalogResponse } from '@/lib/catalog'
import { useLayout, isRemoved } from '@/lib/widgets'
import { FeatureGlyph } from '@/components/FeatureGlyph'
import { markFor } from './BentoLauncher'
import './launcher.css'
import { Widget, useWidgetLayer } from './WidgetLayer'
import { hueFor } from './BentoLauncher'
import './feature-cells.css'

/* APP ICONS ON THE HOME.
 *
 * Every screen somebody puts on their home is its own tile: one app icon,
 * the way a phone home screen draws an app -- the feature's own glyph
 * (feature-icons.tsx, one per feature, no two alike) centred in a rounded
 * square washed with its workspace's colour, the name under it. Not four in
 * a box: the owner rejected the two-by-two shortcut cell.
 *
 * ON A PHONE each icon is a 1x1 Widget of its own, so it drags, hides and
 * reorders like any card. The pager packs on a grid four (or, by the
 * person's choice, three) units across (PHONE_UNIT in widgets.ts): a card
 * spans the page, an icon is one unit. Never grouped there (owner: "each
 * icon is one unit, not 4 as one").
 *
 * ON A DESK four icons share one 1x1 tile, two by two, each its own target
 * with its own name (owner, 2026-10-01: four in one tile is right on the
 * web). A fifth starts the next tile. While arranging, each icon in a tile
 * has its own remove, and removing the tile removes its four.
 * See ICON_SHAPE in lib/size-tiers.ts.
 *
 * The list is the shortcuts store (lib/shortcuts.ts), resolved through the
 * catalogue every render, so a shortcut to something this account may no
 * longer open stops appearing rather than 404ing on tap. Hiding an icon from
 * the board takes it off the shortcuts list, so the launcher's "Remove from
 * home" and the board's own remove agree. */

export const FEATURE_PREFIX = 'feature:'
/** Icons per desk tile: two by two. */
export const DESK_QUAD = 4
const QUAD_PREFIX = FEATURE_PREFIX + 'quad:'
export function quadId(n: number): string {
  return `${QUAD_PREFIX}${n + 1}`
}
/* THE ICONS LEAD. Declared ahead of every board's own cards (which count up
   from 0), so on a board that has never been arranged the row of app icons
   is the first thing on the home -- the top row on a desk, the first page on
   a phone -- and the board's last figure card is what moves to the Add
   gallery to make room, rather than the icons silently not fitting. Once a
   person arranges the board, their order wins (orderOf). */
const ICON_INDEX = -100
/** How many app icons a new account's home starts with. */
export const DEFAULT_ICONS = 4

type Found = {
  key: string
  name: string
  slug: string
  section: string
  workspace: string
  href: string
}

/** The screens a new home starts with: the first screen of each of the
    first few working sections of the account's first role -- the role's
    home section is skipped, because the board already IS that screen. */
export function defaultShortcuts(catalog: CatalogResponse | null, n = DEFAULT_ICONS): string[] {
  const role = catalog?.roles?.[0]
  if (!role) return []
  const out: string[] = []
  for (const section of role.sections) {
    if (section.slug === 'home') continue
    const f = section.features.find(usable)
    if (f) out.push(f.key)
    if (out.length >= n) break
  }
  return out
}

function resolve(catalog: CatalogResponse | null, key: string): Found | null {
  for (const role of catalog?.roles ?? []) {
    for (const section of role.sections) {
      const f = section.features.find((x) => x.key === key)
      if (f && usable(f)) {
        return {
          key, name: f.name, slug: f.slug, section: section.slug,
          workspace: section.workspace || section.name,
          href: featurePath(role.key, section.slug, f.slug),
        }
      }
    }
  }
  return null
}

/** One app icon, drawn exactly as the All features launcher draws it (owner,
    2026-10-01: "even in bentos use icons that are like in all features"):
    the same FeatureGlyph disc tinted from the workspace colour, the same
    Material Symbol, the workspace's own mark in the corner, then the name. */
export function AppIcon({ slug, section, workspace, name, size }: {
  slug: string
  section?: string
  workspace: string
  name?: string
  size?: number
}) {
  const Mark = markFor(workspace)
  return (
    <>
      <FeatureGlyph
        slug={slug}
        section={section}
        tint={hueFor(workspace)}
        className="ai-plate lch-plate"
        style={{ '--size': size ? `${size}px` : 'var(--ai-size, 64px)' } as CSSProperties}
      >
        <span className="lch-plate-mark" title={workspace}><Mark aria-hidden="true" /></span>
      </FeatureGlyph>
      {name && <span className="ai-name">{name}</span>}
    </>
  )
}

function IconLink({ f, label }: { f: Found; label: string }) {
  return (
    <Link to={f.href} className="ai-tile" title={`${f.name} (${f.workspace})`} aria-label={f.name} data-feature-key={f.key}>
      <AppIcon slug={f.slug} section={f.section} workspace={f.workspace} name={label} />
    </Link>
  )
}

export function FeatureCells() {
  const layer = useWidgetLayer()
  const stored = useShortcuts()
  const catalog = useCatalogIfAny()
  const { layout, place } = useLayout(layer?.dashboard ?? 'default')

  /* A NEW HOME IS A HOME SCREEN, NOT ONLY CHARTS. An account that has never
     touched its shortcuts gets a row of its role's main screens, written to
     the store once so removing one later removes only that one. */
  useEffect(() => {
    if (!catalog) return
    const d = defaultShortcuts(catalog)
    if (d.length) seedShortcuts(d)
  }, [catalog])

  const live = stored.map((k) => resolve(catalog, k)).filter((f): f is Found => f !== null)

  const phone = layer?.phone ?? false
  /* One word under each icon, none repeated on the board (short-labels.ts). */
  const shorts = shortLabels(live.map((f) => f.name))
  const shortOf = (f: Found) => shorts[live.indexOf(f)] ?? f.name
  const quads: Found[][] = []
  for (let i = 0; i < live.length; i += DESK_QUAD) quads.push(live.slice(i, i + DESK_QUAD))
  const idOf = (f: Found, at = live.indexOf(f)) => (phone ? FEATURE_PREFIX + f.key : quadId(Math.floor(at / DESK_QUAD)))

  /* An icon (or, on a desk, a tile of four) hidden from the board is its
     shortcut removed: the two lists must not disagree about what is on the
     home. Its place is freed again, or the screens that slide into it next
     would be hidden with it. */
  const hiddenIds = phone
    ? live.map((f) => FEATURE_PREFIX + f.key).filter((id) => isRemoved(layout, id))
    : quads.map((_, n) => quadId(n)).filter((id) => isRemoved(layout, id))
  const hidden = phone
    ? live.filter((f) => isRemoved(layout, FEATURE_PREFIX + f.key)).map((f) => f.key)
    : quads.flatMap((q, n) => (isRemoved(layout, quadId(n)) ? q.map((f) => f.key) : []))
  useEffect(() => {
    for (const k of hidden) removeFromDashboard(k)
    for (const id of hiddenIds) place(id, 1, 1)
  }, [hidden.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  /* THE NEW TILE COMES TO YOU: on a phone the pager scrolls to the page the
     icon just added landed on. A desk shows every page at once. */
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    const now = new Set(stored)
    const before = seen.current
    seen.current = now
    if (!before || !layer?.spots) return
    const fresh = stored.find((k) => !before.has(k))
    if (!fresh) return
    const at = live.findIndex((f) => f.key === fresh)
    if (at < 0) return
    const id = idOf(live[at])
    const t = window.setTimeout(() => {
      const page = layer.spots?.get(id)?.page
      if (page === undefined) return
      document
        .querySelector<HTMLElement>(`.bento-board .bento-page[data-page="${page}"]`)
        ?.scrollIntoView({ behavior: layer.still ? 'auto' : 'smooth', inline: 'start', block: 'nearest' })
    }, 120)
    return () => window.clearTimeout(t)
  }, [stored.join(','), layer?.spots]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!layer) return null

  if (phone) {
    return (
      <>
        {live.map((f, i) => (
          <Widget key={f.key} id={FEATURE_PREFIX + f.key} label={f.name} size="small" index={ICON_INDEX + i} fixed>
            {() => (
              <div className="ai-cell">
                <IconLink f={f} label={shortOf(f)} />
              </div>
            )}
          </Widget>
        ))}
      </>
    )
  }

  const editing = layer.editing
  return (
    <>
      {quads.map((q, n) => {
        const id = quadId(n)
        const label = q.length === 1 ? q[0].name : q.map((f) => f.name).join(', ')
        return (
          <Widget key={id} id={id} label={label} size="small" index={ICON_INDEX + n} fixed>
            {() => (
              <div className="ai-quad" role="group" aria-label={label} data-count={q.length}>
                {q.map((f) => (
                  <div key={f.key} className="ai-quad__slot">
                    <IconLink f={f} label={shortOf(f)} />
                    {editing && (
                      <button
                        type="button"
                        className="ai-quad__remove"
                        aria-label={`Remove ${f.name} from home`}
                        title={`Remove ${f.name}`}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeFromDashboard(f.key) }}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <span aria-hidden="true">−</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Widget>
        )
      })}
    </>
  )
}
