import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { shortcutLabel } from '@/lib/platform'
import { useOverlayHistory } from '@/lib/overlay-history'
import { useNavigate } from 'react-router-dom'
import { Search, CornerDownLeft, GraduationCap, UserRound } from 'lucide-react'
import { useCatalog, featurePath } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { aliasText } from '@/lib/search-aliases'
import { api } from '@/lib/api'
import ScrollBox from './ScrollBox'
import { useSession } from '@/lib/session'

/* A child or a parent, found by name, admission number or mobile.

   The palette searched 470 screens and no people, so the commonest question in
   a school office — "find Anika Goud" — meant knowing which screen holds
   children and searching again inside it. A parent was worse: guardians were
   reachable only through a child, so a mother at the counter with nothing but
   her phone number had no answer at all.

   Server-side, because a school's roll does not belong in the browser and
   because the match has to cover an admission number and a mobile, which no
   client-side index of screen names ever could. */
interface PersonHit {
  kind: 'student' | 'guardian'
  id: string
  name: string
  detail: string
  student_id: string
}

/**
 * Command search over everything the user can reach.
 *
 * With 470 catalogued features on a two-axis navigation, "where do I issue a
 * transfer certificate?" is a real question with a non-obvious answer. The
 * catalog is already loaded client-side, so searching it costs nothing and
 * removes the need to know which section a feature was filed under.
 */
export function CommandSearch() {
  const catalog = useCatalog()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  /* Back closes the panel rather than the app. See useOverlayHistory: this is
     state, not a route, so nothing was on the history stack for the phone's
     back gesture to land on. */
  const close = useCallback(() => setOpen(false), [])
  useOverlayHistory(open, close)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Flattened once; the catalog does not change during a session.
  const index = useMemo(
    () =>
      catalog.roles.flatMap((role) =>
        role.sections.flatMap((section) =>
          section.features.map((f) => ({
            key: f.key,
            name: f.name,
            role: role.name,
            roleKey: role.key,
            section: section.name,
            sectionSlug: section.slug,
            slug: f.slug,
            summary: f.summary,
            live: f.live,
            inScope: f.in_scope,
            /* The words somebody would type, not only the words the
               product uses. See lib/search-aliases.ts: a principal hunting
               for the screen that sends a notice types "notice", and the
               screen is called Circulars. */
            haystack: `${f.name} ${section.name} ${role.name} ${f.summary} ${aliasText(f.slug)}`
              .toLowerCase(),
            aliases: aliasText(f.slug).toLowerCase(),
          })),
        ),
      ),
    [catalog],
  )

  /* Only for desks that may read a child. A parent signed in here would
     otherwise fire a search on every keystroke that comes back 403, and see a
     permanent error under a box they were only using to find a screen. */
  const session = useSession()
  const mayReadPeople = session.permissions.includes('students.read')

  const needleForPeople = q.trim()
  const people = useQuery({
    queryKey: ['people-search', needleForPeople],
    queryFn: () =>
      api.get<{ items: PersonHit[] }>(
        `/api/v1/people/search?q=${encodeURIComponent(needleForPeople)}`,
      ),
    enabled: mayReadPeople && needleForPeople.length >= 2,
    // The roll does not change while somebody types, and a palette reopened a
    // second later should not re-ask.
    staleTime: 30_000,
  })
  const peopleHits = people.data?.items ?? []

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) {
      // With no query, offer what actually works rather than an arbitrary slice.
      return index.filter((i) => i.live).slice(0, 8)
    }
    /* Every word has to land somewhere, in any order.

       The whole query was matched as one substring, so "send notice" and
       "fee report" found nothing at all -- not because the feature was
       missing but because nobody had written those two words adjacently in
       that order. Splitting on whitespace and requiring each word to hit
       somewhere is what makes typing a half-remembered phrase work, which is
       how people search when they do not know what the screen is called. */
    const words = needle.split(/\s+/).filter(Boolean)
    const scored = index
      .map((i) => {
        const n = i.name.toLowerCase()
        // Every word must land, or this is not a hit at all.
        if (!words.every((w) => i.haystack.includes(w))) return { i, score: -1 }
        /* Ranked by where the match landed, best first. A name match beats a
           description match and a prefix beats a mid-string hit -- otherwise
           "fee" surfaces a dozen summaries that merely mention fees before
           the fee counter itself.

           An alias sits between the two: somebody typing "notice" wants
           Circulars above every screen whose summary happens to say the word,
           but not above a screen actually named for what they typed. */
        let score = 3
        if (n.startsWith(needle)) score = 0
        else if (n.includes(needle)) score = 1
        else if (i.aliases.includes(needle)) score = 2
        return { i, score }
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || Number(b.i.live) - Number(a.i.live))
    return scored.slice(0, 12).map((x) => x.i)
  }, [q, index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      // Focus after paint, or the input is not in the document yet.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => setCursor(0), [q])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        /* Fully round, to sit inside the Bento dock without arguing with it.

           The dock is a pill and every other control in it is a pill; this was
           a 6px rectangle in the middle of them, which read as a field that had
           been dropped into the bar rather than built into it. The classic
           header takes the same shape, where a rounded search is unremarkable
           — one component, one radius, rather than a prop threaded through to
           make the same button two shapes in two places. */
        className="hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent sm:flex"
        aria-label="Search features"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search</span>
        <kbd className="shrink-0 whitespace-nowrap rounded border px-1 font-mono text-[10px]">{shortcutLabel('K')}</kbd>
      </button>
    )
  }

  const go = (h: (typeof hits)[number]) => {
    navigate(featurePath(h.roleKey, h.sectionSlug, h.slug))
    setOpen(false)
  }

  /* Both kinds open the child's own screen — a student because that is who was
     asked for, a guardian because a parent's record IS a page of their child's.
     The 360 screen reads ?student= and opens straight on that record. */
  const goPerson = (p: PersonHit) => {
    navigate(`/institution_admin/students/student_360?student=${p.student_id}`)
    setOpen(false)
  }

  /* Rendered into the body, not where it is mounted.

     This component lives inside the Bento dock, and the dock carries
     backdrop-blur. A backdrop-filter establishes a containing block, so a
     fixed-position descendant anchors to the blurred element rather than to
     the viewport — the scrim stopped being full-screen and became a dark layer
     painted across the dock itself, with the palette hanging underneath it.

     BentoLauncher already had to be moved outside the pill for exactly this
     reason and left a comment saying so; this is the same trap one component
     along. A portal fixes it at the source, so the palette is correct wherever
     anybody mounts it next. */
  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
      <div
        role="dialog"
        aria-label="Search features"
        /* CENTRED BY MARGINS, NOT BY A TRANSFORM.

           This was `left-1/2 -translate-x-1/2`, and the translate did not
           survive: measured on the live site the computed transform was the
           identity matrix while --tw-translate-x still read -50%, so the panel
           began at exactly half the viewport and ran off the right edge. At
           768px that put 256px of a 640px panel off-screen, the search field
           among it, which is the one control the panel exists for.

           Insetting to both edges and centring with auto margins asks the
           layout engine for the same result without going through a transform
           that something else can flatten. It also keeps the 1rem gutter on a
           narrow window, which the width calc was already trying to hold. */
        className="fixed inset-x-4 top-[12vh] z-50 mx-auto w-auto max-w-[640px]"
        /* Fixed elements escape the body's notch padding; 12vh from the top
           edge is not always 12vh below the clock. Zero in a browser and on
           Android. */
        style={{ marginTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="overflow-hidden rounded-md border bg-popover shadow-pop">
          <div className="flex items-center gap-2.5 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
                if (e.key === 'Enter' && hits[cursor]) { e.preventDefault(); go(hits[cursor]) }
              }}
              placeholder="Search screens, children and parents — a name, an admission number or a mobile"
              className="h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Same treatment as the record menu: a list that runs past its box
              says so with a control, not by slicing a row in half. */}
          <ScrollBox className="max-h-[52vh]">
          <ul className="py-1">
            {peopleHits.length > 0 && (
              <>
                <li className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  People
                </li>
                {peopleHits.map((p) => (
                  <li key={`${p.kind}-${p.id}`}>
                    <button
                      onClick={() => goPerson(p)}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent"
                    >
                      {p.kind === 'student' ? (
                        <GraduationCap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px]">{p.name}</span>
                        {p.detail && (
                          <span className="block truncate text-[12px] text-muted-foreground">
                            {p.detail}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
                <li className="mx-4 my-1 border-t" aria-hidden />
              </>
            )}
            {hits.length === 0 && peopleHits.length === 0 && (
              <li className="px-4 py-6 text-center text-[14px] text-muted-foreground">
                Nothing matches “{q}”.
              </li>
            )}
            {hits.map((h, i) => (
              <li key={h.key}>
                <button
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(h)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2 text-left',
                    i === cursor && 'bg-accent',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      h.live ? 'bg-primary' : 'bg-border',
                    )}
                    title={h.live ? 'Built' : 'Catalogued, not built'}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{h.name}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {h.role} · {h.section}
                      {!h.inScope && ' · nothing in your scope'}
                    </span>
                  </span>
                  {i === cursor && (
                    <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              </li>
            ))}
          </ul>
          </ScrollBox>

          <div className="flex items-center gap-3 border-t px-4 py-2 text-[12px] text-muted-foreground">
            <span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
