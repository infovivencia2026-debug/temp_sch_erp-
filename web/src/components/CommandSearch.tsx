import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { shortcutLabel } from '@/lib/platform'
import { useNavigate } from 'react-router-dom'
import { Search, CornerDownLeft } from 'lucide-react'
import { useCatalog, featurePath } from '@/lib/catalog'
import { cn } from '@/lib/utils'

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
            haystack: `${f.name} ${section.name} ${role.name} ${f.summary}`.toLowerCase(),
          })),
        ),
      ),
    [catalog],
  )

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) {
      // With no query, offer what actually works rather than an arbitrary slice.
      return index.filter((i) => i.live).slice(0, 8)
    }
    const scored = index
      .map((i) => {
        // Name matches beat description matches, and a prefix beats a
        // mid-string hit — otherwise "fee" surfaces a dozen summaries that
        // merely mention fees before the fee counter itself.
        const n = i.name.toLowerCase()
        let score = -1
        if (n.startsWith(needle)) score = 0
        else if (n.includes(needle)) score = 1
        else if (i.haystack.includes(needle)) score = 2
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
        className="hidden items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent sm:flex"
        aria-label="Search features"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search</span>
        <kbd className="rounded border px-1 font-mono text-[10px]">{shortcutLabel('K')}</kbd>
      </button>
    )
  }

  const go = (h: (typeof hits)[number]) => {
    navigate(featurePath(h.roleKey, h.sectionSlug, h.slug))
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
        className="fixed left-1/2 top-[12vh] z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2"
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
              placeholder="Search every screen — try “transfer certificate” or “defaulters”"
              className="h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul className="max-h-[52vh] overflow-y-auto py-1">
            {hits.length === 0 && (
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

          <div className="flex items-center gap-3 border-t px-4 py-2 text-[12px] text-muted-foreground">
            <span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
