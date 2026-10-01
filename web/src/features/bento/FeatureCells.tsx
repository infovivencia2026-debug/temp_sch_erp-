import { useEffect, useRef, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useShortcuts, removeFromDashboard, seedShortcuts } from '@/lib/shortcuts'
import { useCatalogIfAny, featurePath, usable, type CatalogResponse } from '@/lib/catalog'
import { useLayout, isRemoved } from '@/lib/widgets'
import { featureIcon } from './feature-icons'
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
 * On a desk each icon is a 1x1 Widget of its own, so it drags, hides and
 * reorders like any card and is exactly one cell, square. On a phone the
 * pager draws every card at the full page width (paginate in widgets.ts),
 * which would stretch one icon across the screen, so there the icons are
 * laid out four across in a row band -- each still its own icon with its
 * own target, no enclosing card -- eight to a band. See ICON_SHAPE in
 * lib/size-tiers.ts.
 *
 * The list is the shortcuts store (lib/shortcuts.ts), resolved through the
 * catalogue every render, so a shortcut to something this account may no
 * longer open stops appearing rather than 404ing on tap. Hiding an icon from
 * the board takes it off the shortcuts list, so the launcher's "Remove from
 * home" and the board's own remove agree. */

export const FEATURE_PREFIX = 'feature:'
/** A phone band of icons: four across, two rows. */
export const PHONE_BAND = 8
const BAND_PREFIX = FEATURE_PREFIX + 'band:'
export function bandId(n: number): string {
  return `${BAND_PREFIX}${n + 1}`
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

/** One app icon: the tinted square, the glyph, the name. */
export function AppIcon({ slug, section, workspace, name, size }: {
  slug: string
  section?: string
  workspace: string
  name?: string
  size?: number
}) {
  const style = {
    '--t': `var(--dom-${hueFor(workspace)}, hsl(var(--primary)))`,
    ...(size ? { '--ai-size': `${size}px` } : {}),
  } as CSSProperties
  return (
    <>
      <span className="ai-plate" style={style} aria-hidden="true">
        <span className="msr">{featureIcon(slug, section)}</span>
      </span>
      {name && <span className="ai-name">{name}</span>}
    </>
  )
}

function IconLink({ f }: { f: Found }) {
  return (
    <Link to={f.href} className="ai-tile" title={`${f.name} (${f.workspace})`} aria-label={f.name}>
      <AppIcon slug={f.slug} section={f.section} workspace={f.workspace} name={f.name} />
    </Link>
  )
}

export function FeatureCells() {
  const layer = useWidgetLayer()
  const stored = useShortcuts()
  const catalog = useCatalogIfAny()
  const { layout, place } = useLayout(layer?.dashboard ?? 'default')
  const phone = layer?.phone ?? false

  /* A NEW HOME IS A HOME SCREEN, NOT ONLY CHARTS. An account that has never
     touched its shortcuts gets a row of its role's main screens, written to
     the store once so removing one later removes only that one. */
  useEffect(() => {
    if (!catalog) return
    const d = defaultShortcuts(catalog)
    if (d.length) seedShortcuts(d)
  }, [catalog])

  const live = stored.map((k) => resolve(catalog, k)).filter((f): f is Found => f !== null)

  const bands: Found[][] = []
  for (let i = 0; i < live.length; i += PHONE_BAND) bands.push(live.slice(i, i + PHONE_BAND))
  const idOf = (f: Found, at: number) => (phone ? bandId(Math.floor(at / PHONE_BAND)) : FEATURE_PREFIX + f.key)

  /* An icon (or, on a phone, a band) hidden from the board is its shortcut
     removed: the two lists must not disagree about what is on the home. */
  const hidden = phone
    ? bands.flatMap((b, n) => (isRemoved(layout, bandId(n)) ? b.map((f) => f.key) : []))
    : live.filter((f) => isRemoved(layout, FEATURE_PREFIX + f.key)).map((f) => f.key)
  const hiddenBands = phone ? bands.map((_, n) => bandId(n)).filter((id) => isRemoved(layout, id)) : []
  useEffect(() => {
    for (const k of hidden) removeFromDashboard(k)
    /* The band's place is freed once its icons are gone, or the icons that
       slide into it next would be hidden with it. */
    for (const id of hiddenBands) place(id, 2, 1)
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
    const id = idOf(live[at], at)
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
        {bands.map((b, n) => {
          const id = bandId(n)
          const label = n === 0 ? 'App icons' : `App icons ${n + 1}`
          return (
            <Widget key={id} id={id} label={label} size="small" index={ICON_INDEX + n} fixed>
              {() => (
                <div className="ai-band" role="group" aria-label={label}>
                  {b.map((f) => <IconLink key={f.key} f={f} />)}
                </div>
              )}
            </Widget>
          )
        })}
      </>
    )
  }

  return (
    <>
      {live.map((f, i) => (
        <Widget key={f.key} id={FEATURE_PREFIX + f.key} label={f.name} size="small" index={ICON_INDEX + i} fixed>
          {() => (
            <div className="ai-cell">
              <IconLink f={f} />
            </div>
          )}
        </Widget>
      ))}
    </>
  )
}
