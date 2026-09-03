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

  /* NO FALLBACK HERE EITHER.

     This file's own header says it refuses to guess where FeatureRoute would
     not, and then guessed: `?? catalog.roles[0]` meant a path naming a
     workspace the account does not hold resolved its section against the
     user's FIRST workspace instead, so a Bento user on /faculty/... could be
     shown a screen belonging to a role they were never granted. FeatureRoute
     now refuses that path outright; returning undefined here falls through to
     the classic layout, which shows the same refusal rather than a screen. */
  const role = catalog.roles.find((r) => r.key === roleKey)
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

  /* Note what was opened, so the launcher — and the classic sidebar's Recent
     row — can lead with it.

     Here rather than on the launcher's own click, because most navigation is
     not a click in the launcher: it is the command palette, a card's cue, a
     bookmark, the back button. Recording only our own clicks would produce a
     "recently opened" list that reflected one route in and quietly disagreed
     with what the person had actually been doing.

     Recorded regardless of layout: the trace belongs to the account's usage,
     not to whichever layout happened to be active when a screen was opened.
     Bento was the only reader for a while, which is why this used to gate on
     `layout === 'bento'`; Shell.tsx now reads the same list.

     recordRecent is idempotent on the head of the list, so a re-render of the
     same route does not republish and re-render every subscriber. */
  useEffect(() => {
    if (key) recordRecent(key)
  }, [key])

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

         A BOARD IS MEASURED AGAINST ITS CONTAINER, NOT AGAINST THE WINDOW.

         It was h-dvh, which is the full height of the viewport — and the board
         does not get the full height of the viewport. The tab strip sits above
         it inside the work area, and on a role that keeps the classic chrome
         the topbar does too. So the board was reliably one strip taller than
         the room it had, the work area scrolled to make up the difference, and
         the bottom row of cards was cut off at the fold. A board that scrolls
         is not a board: its rows are sized to fit a fixed height, and the
         whole arrangement is a claim that everything is visible at once.

         h-full instead, which resolves against the work area — the height the
         board is actually given. The shell's <main> is a flex child with
         min-h-0 and therefore a definite height, so the percentage has
         something real to resolve against; that is the load-bearing part.

         A classic screen falling through here is the opposite case: a
         page-head and a table of whatever length the school has, which holding
         to one screen with overflow hidden simply cut off — the defaulters
         list stopped at the eleventh row with no way to reach the twelfth. So
         it gets a floor and not a ceiling, and scrolls in the work area as it
         always did. min-h-full rather than min-h-dvh for the same reason as
         above: the floor is the room available, not the window. */
      /* THE BOARD HOLDS ONE SCREEN ONLY WHERE ONE SCREEN IS WHAT IT IS.

         `h-full overflow-hidden` is right for the desktop board: the grid is a
         fixed fifteen-slot sheet whose rows are fractions of a measured height,
         so it fits by construction and clipping it is a backstop that never
         fires.

         Below 1024px none of that is true. The fixed-height rules live in a
         `@media (min-width: 1024px)` block in bento-theme.css, so on a phone
         the board is a one-column stack of content-sized rows -- a parent's
         home measured 1307px of cards inside a 631px ground. `overflow-hidden`
         then did exactly what it says: over half of it was cut off, with no
         scroll anywhere to reach it, because <main> only scrolls when its child
         is taller than it is and this child was pinned to exactly its height.
         The fee card, the homework card and the bus card simply did not exist
         on a phone.

         So the ceiling is applied at the same breakpoint that earns it, and
         below it the ground grows and the work area scrolls, which is what it
         already does for a classic screen falling through this same branch. */
      className={cn(
        'bento-ground flex flex-col bg-[var(--bento-bg)] bg-cover bg-center bg-no-repeat bg-fixed',
        Screen ? 'min-h-full lg:h-full lg:overflow-hidden' : 'min-h-full',
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

          The bottom allowance was the dock's own height plus the distance it
          floats by, because the dock is fixed and the last row of every table
          ended up under the pill.

          THE SCROLLER RESERVES THAT NOW, AND THIS WAS RESERVING IT AGAIN. The
          shell's <main> carries `pb-[var(--dock-reserve)]`, which used to be
          zero above 1024px on the belief that the dock returns to the layout
          on a desktop; it does not, and that zero was removed. So from then on
          both this wrapper and the scroller above it were holding the dock's
          height back: 112px here and 96px there, 208px of clearance on an
          844px phone, which is why a board of three cards stopped a long way
          short of the page dots.

          One reserve, in the scroller, because that is the element that
          scrolls and the one the dock actually overlaps. What is left here is
          ordinary bottom padding, matching the top. */}
      {/* THE GUTTER IS IN PIXELS, AND IT WAS NOT.

          px-3 is 0.75rem, and index.css pins the root font to 14px for the
          dense desktop baseline, so it resolved to 10.5px rather than the 12
          the number says. Measured on a phone: cards sat 10.5px from each
          edge, which is not a gutter so much as a hairline, and every screen
          in this layout inherited it. sm and lg were short by the same eighth.

          This is the fourth thing in this product to be caught by that root:
          a 44px touch minimum written in rem came out 38.5, h-11 the same, and
          a drawer meant to reach the screen edge stopped 26px short. The rule
          that came out of those applies here too, so the gutter says what it
          means: 16 on a phone, which is the width every platform's own home
          screen leaves beside a tile, then 20 and 24 as the window earns them. */}
      <div className="flex-1 w-full pt-6 pb-6 px-[16px] sm:px-[20px] lg:px-[24px] flex flex-col">
        {inner}
      </div>
    </div>
  )
}

export default BentoOutlet
