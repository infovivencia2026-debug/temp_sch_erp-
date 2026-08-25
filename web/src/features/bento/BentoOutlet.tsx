import { Component, Suspense, useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useCatalog, usable } from '@/lib/catalog'
import { useLayout } from '@/lib/layout'
import { bentoComponentFor } from './bento-registry'
import { recordRecent } from '@/lib/recents'
import { cn } from '@/lib/utils'

/* The routing seam.
   ─────────────────────────────────────────────────────────────────────────
   Wraps the shell's content. It renders `children` — the classic screen, the
   application exactly as it ships — unless ALL of these hold:

     · this account has chosen the Bento layout, and
     · the URL resolves to a catalogue feature the account can open, and
     · `bento-registry.ts` names a Bento component for that feature's key.

   Otherwise `children` passes through untouched, which is the property the
   whole experiment rests on: a school that switches to Bento sees the classic
   product everywhere nobody has converted yet, and never a blank screen.

   WHY HERE. The alternative seam is inside `componentFor` in
   `web/src/features/registry.ts`, or a branch in `App.tsx`. registry.ts is a
   contention point the agent contract forbids editing and a generator parses;
   App.tsx is the classic router. Wrapping the shell's content needs neither —
   the resolution below re-derives the feature from the URL and the catalogue,
   which is public, read-only, and already how `App.tsx` decides the same
   thing. The one cost is that this must agree with FeatureRoute about which
   feature a URL means; it deliberately does so by reusing `usable()` and by
   refusing to guess where FeatureRoute would not.

   WHY IT DOES NOT LOOK AT PERMISSIONS ITSELF. It cannot see anything the
   catalogue did not already give this account: `useCatalog()` is the server's
   answer to "what may this user open". A Bento screen therefore reaches
   exactly the features the classic layout reaches, and — like every other
   screen — is still refused by the API if it asks for data outside its scope.
   Authorisation is decided on the backend; this is a rendering choice. */

/** Resolve the current URL to a catalogue feature key, or undefined.

    Mirrors `useFeature` in `lib/catalog`: an exact section+feature request is
    honoured as asked, and a bare section falls to the first feature of that
    section which actually opens. Anything else — /account, an unknown role, a
    section this account does not hold — resolves to nothing and therefore
    falls through to classic. */
function useRouteFeatureKey(override?: string): string | undefined {
  const catalog = useCatalog()
  const { pathname } = useLocation()

  /* A pane names its own path. The browser's location describes one pane of a
     split — the focused one — so resolving from it would give all four panes
     whichever screen the address bar happened to be on. */
  const at = (override ?? pathname).split('?')[0]
  const [roleKey, sectionSlug, featureSlug] = at.split('/').filter(Boolean)
  if (!roleKey || !sectionSlug) return undefined

  const role = catalog.roles.find((r) => r.key === roleKey) ?? catalog.roles[0]
  const section = role?.sections.find((s) => s.slug === sectionSlug)
  if (!section) return undefined

  const feature = featureSlug
    ? section.features.find((f) => f.slug === featureSlug)
    : section.features.find(usable)
  if (!feature) return undefined

  // A feature that is out of scope, or catalogued and unbuilt, renders the
  // classic explanation of why — which is a screen the Bento layout has no
  // business replacing with a grid of empty cells.
  if (!feature.in_scope || !feature.live) return undefined

  return feature.key
}

/* A Bento screen that throws must cost its own page, not the application.

   Falling back to the classic screen rather than to an error panel is
   deliberate: the classic screen is known to work, the person came here to do
   something, and an experimental layout is not a good enough reason to stop
   them. The throw is logged so it is not lost. */
class BentoBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[bento] screen failed, falling back to the classic screen', error)
  }

  componentDidUpdate(prev: { resetKey: string }) {
    // A new screen deserves a fresh attempt; one broken cell must not poison
    // every Bento screen for the rest of the session.
    if (prev.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** The gap a lazily-loaded Bento screen leaves behind. Deliberately plain and
    local: it must not reach into the classic layout's components. */
function BentoChunkPending() {
  return <div className="p-6" aria-busy="true" />
}

export function BentoOutlet({ children, path }: { children: ReactNode; path?: string }) {
  const { layout } = useLayout()
  const key = useRouteFeatureKey(path)
  // Inside a split, a pane is the frame — not the window. The board below is
  // measured against its container rather than the viewport, or four boards
  // would each claim the full height of the screen.
  const paned = path !== undefined

  /* Note what was opened, so the launcher can lead with it.

     Here rather than on the launcher's own click, because most navigation is
     not a click in the launcher: it is the command palette, a card's cue, a
     bookmark, the back button. Recording only our own clicks would produce a
     "recently opened" list that reflected one route in and quietly disagreed
     with what the person had actually been doing.

     recordRecent is idempotent on the head of the list, so a re-render of the
     same route does not republish and re-render every subscriber. */
  useEffect(() => {
    if (layout === 'bento' && key) recordRecent(key)
  }, [layout, key])

  /* Resolved once, because two things need the answer: what to render, and
     whether what renders is a board. A board is measured to the window and
     must not scroll; a classic screen is as tall as its table and must. */
  const Screen = layout === 'bento' && key ? bentoComponentFor(key) : undefined

  const inner = (() => {
    if (!Screen) return <>{children}</>
    return (
      <BentoBoundary resetKey={key ?? ''} fallback={<>{children}</>}>
        {/* A quiet placeholder while the Bento chunk loads — not the classic
            screen, which would mount every one of its queries only to be
            thrown away a frame later. */}
        <Suspense fallback={<BentoChunkPending />}>
          <Screen />
        </Suspense>
      </BentoBoundary>
    )
  })()

  if (layout !== 'bento') return inner

  /* The dock's clearance belongs here, not on the dashboards.

     It was on BentoPage, which meant only the handful of converted screens
     allowed for it. Every other feature — and that is most of them, since
     this outlet deliberately falls through to the classic screen wherever
     nobody has converted one — got a floating pill sitting on its first row
     of content. The layout hides the header; it does not stop the dock being
     there.

     One wrapper, so the allowance is made once for whatever renders. */
  return (
    <div
      /* The ground is painted here, not only by the screens.

         This wrapper holds the dock's clearance, and with no background of its
         own that clearance showed sixty pixels of the app's default ground
         above whatever the screen painted — a pale band across the top of
         every Bento page, exactly where the eye starts. The strip was the
         padding, made visible.

         min-h-dvh so a short screen is one colour to the bottom of the window
         rather than to the bottom of its content.

         A board is pinned to the window — h-dvh, nothing spilling — because
         its rows are sized against that height. A classic screen falling
         through here is not: it is a page-head and a table of whatever length
         the school has, and holding it to one screen with overflow hidden
         simply cut it off. The defaulters list stopped at the eleventh row
         with no way to reach the twelfth. So it gets a floor, not a ceiling,
         and scrolls in the shell's own work area. */
      className={cn(
        'bento-ground flex flex-col bg-[var(--bento-bg)] bg-cover bg-center bg-no-repeat bg-fixed',
        paned
          ? (Screen ? 'h-full overflow-hidden' : 'min-h-full')
          : (Screen ? 'h-dvh overflow-hidden' : 'min-h-dvh'),
      )}
    >
      {/* The room around the board.

          12px of top padding and 32px at the sides put the cards hard against
          the window: on a maximised browser the first card began 28px from the
          edge of the glass and the top row sat directly under the browser
          chrome, which reads as a page that has overflowed rather than one
          that has been laid out.

          The board is measured for its height AFTER this padding is applied,
          so giving it more room here costs card height rather than pushing
          anything off screen.

          The bottom allowance was the dock's own height written out as 72px,
          which is the number the dock would need if it sat on the floor. It
          floats 24px above it, so the last row of every table ended up under
          the pill. Taken from --bento-dock — the token the dock is sized from,
          so the two cannot drift — plus the clearance it floats by. */}
      <div className="flex-1 w-full pt-6 pb-[calc(var(--bento-dock)+2.5rem)] px-3 sm:px-4 lg:px-5 flex flex-col">
        {inner}
      </div>
    </div>
  )
}

export default BentoOutlet
