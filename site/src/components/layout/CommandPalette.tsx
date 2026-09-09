import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@/lib/nav'
import { CornerDownLeft, Home, LayoutGrid, Plus, Search, type LucideIcon } from 'lucide-react'
import { useApp } from '@/hooks/useAppState'
import { INDUSTRIES, modulesForRole } from '@/industries'
import { isSingleIndustry } from '@/lib/deployment'
import { cx } from '@/lib/utils'

interface Entry { label: string; hint: string; to: string; icon: LucideIcon }

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, role, industryId, industry } = useApp()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const entries = useMemo<Entry[]>(() => {
    // Nothing to switch to on a single-vertical site.
    const out: Entry[] = isSingleIndustry ? [] : [{ label: 'All industries — home', hint: 'Home', to: '/', icon: Home }]
    for (const m of modulesForRole(role)) {
      // The module's own icon, so a row is recognisable before it is read.
      out.push({ label: m.label, hint: m.group, to: `/${m.id}`, icon: m.icon })
      for (const tab of m.tabs) out.push({ label: `${m.label} › ${tab.label}`, hint: 'Tab', to: `/${m.id}/${tab.id}`, icon: m.icon })
    }
    // Two things a role can do, offered without being searched for.
    for (const qa of industry.quickCreate.slice(0, 2)) {
      if (modulesForRole(role).some((m) => m.id === qa.to.split('/')[1])) {
        out.push({ label: qa.label, hint: 'Action', to: qa.to, icon: Plus })
      }
    }
    // Switching vertical is a search away, not a trip back to the home page —
    // on a single-vertical site there is nowhere to switch to.
    for (const ind of isSingleIndustry ? [] : INDUSTRIES) {
      if (ind.id === industryId) continue
      out.push({ label: `Switch to ${ind.label}`, hint: 'Industry', to: `/${ind.id}/dashboard`, icon: LayoutGrid })
    }
    return out
  }, [role, industryId])

  const results = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return entries.filter((e) => e.hint !== 'Tab').slice(0, 12)
    return entries.filter((e) => e.label.toLowerCase().includes(n)).slice(0, 14)
  }, [q, entries])

  useEffect(() => {
    if (!paletteOpen) return
    setQ(''); setIdx(0)
    // Focus goes to the field, and back to whatever opened the palette on close
    // — closing it otherwise dropped focus onto the body and the next Tab
    // restarted from the top of the page.
    const opener = document.activeElement as HTMLElement | null
    const t = setTimeout(() => inputRef.current?.focus(), 20)
    return () => { clearTimeout(t); opener?.focus?.() }
  }, [paletteOpen])
  useEffect(() => { setIdx(0) }, [q])

  if (!paletteOpen) return null

  const go = (e?: Entry) => { if (!e) return; setPaletteOpen(false); nav(e.to) }

  const quick = entries.filter((e) => e.hint === 'Action').slice(0, 2)

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center p-4 pt-[12vh]"
      role="dialog" aria-modal="true" aria-label="Search">
      <div className="absolute inset-0 bg-foreground/45 backdrop-blur-[6px]" onClick={() => setPaletteOpen(false)} />
      <div
        className="cmdk relative flex w-full max-w-[680px] flex-col overflow-hidden rounded-[18px] bg-[hsl(var(--card))]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPaletteOpen(false)
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)) }
          if (e.key === 'Enter') { e.preventDefault(); go(results[idx]) }
          if (e.key === 'Tab') e.preventDefault()   // the palette is the whole surface
        }}
      >
        <div className="cmdk-field flex items-center gap-3 px-5">
          <Search className="h-4 w-4 shrink-0 muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search students, classes, books, pages…"
            aria-label="Search"
            /* The palette is the focus; ringing the field inside it only makes
               the surface look like a boxed form. */
            data-plain-focus
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:muted"
          />
          <kbd className="cmdk-kbd shrink-0">Esc</kbd>
        </div>
        <div className="max-h-[54vh] overflow-y-auto overscroll-contain p-1.5">
          {results.length === 0 && <p className="px-3 py-10 text-center text-sm muted">No matches for “{q}”.</p>}
          {results.length > 0 && (
            <p className="px-3 pb-1.5 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] muted">
              {q.trim() ? 'Results' : 'Recent'}
            </p>
          )}
          {results.map((e, i) => (
            <button
              key={e.to + e.label}
              onPointerEnter={() => setIdx(i)}
              onClick={() => go(e)}
              className={cx('cmdk-row flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-left',
                i === idx && 'is-active')}
            >
              {/* A pastel tile rather than a bare row of text: the row is
                  recognisable before it is read. */}
              <span className={cx('cmdk-tile grid h-10 w-10 shrink-0 place-items-center rounded-xl', `tint-${i % 5}`)}>
                <e.icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{e.label}</span>
                <span className="block truncate text-[12px] muted">{e.hint}</span>
              </span>
              {i === idx && (
                <span className="hidden items-center gap-1 text-[11px] muted sm:flex">
                  <CornerDownLeft className="h-3.5 w-3.5" /> Open
                </span>
              )}
            </button>
          ))}
        </div>

        {quick.length > 0 && !q.trim() && (
          <div className="cmdk-divider px-4 py-3">
            <p className="pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] muted">Quick actions</p>
            <div className="flex flex-wrap gap-1.5">
              {quick.map((e) => (
                <button key={e.to + e.label} onClick={() => go(e)}
                  className="cmdk-quick flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium">
                  <e.icon className="h-4 w-4" /> {e.label}
                </button>
              ))}
              <button onClick={() => { setPaletteOpen(false); nav('/dashboard') }}
                className="cmdk-quick flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium">
                <Plus className="h-4 w-4" /> More
              </button>
            </div>
          </div>
        )}

        <div className="cmdk-divider flex items-center gap-5 px-5 py-2.5 text-[11px] muted">
          <span><kbd className="cmdk-kbd">↑↓</kbd> Navigate</span>
          <span><kbd className="cmdk-kbd">↵</kbd> Open</span>
          <span><kbd className="cmdk-kbd">Esc</kbd> Close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
