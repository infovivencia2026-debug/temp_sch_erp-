import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useActiveRole, featurePath, usable, type ApiSection } from '@/lib/catalog'
import { useT } from '@/lib/i18n'

/* Everything the role can open, on one surface, reachable by pointing at it.

   The palette answers "I know what I want"; it shows eight items until you
   type, so it cannot answer "what is there". A principal's job is partly
   noticing things, and a layout that can only be searched has taken that away
   — so this is the sidebar's discovery, without the sidebar.

   Grouped by workspace and section, exactly as the rail grouped them, so a
   person who knew where something lived still knows.

   Blur belongs here and nowhere else on these screens: a transient surface
   over a canvas, dismissed with Escape, never over text being read. */
export function BentoLauncher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const role = useActiveRole()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const t = useT()
  const [q, setQ] = useState('')

  useEffect(() => { if (open) setQ('') }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /* Workspace -> sections, mirroring the rail's own grouping. A section whose
     features are all out of reach is dropped rather than shown empty: an
     enabled-looking group that opens onto nothing is worse than an absent one. */
  const groups = useMemo(() => {
    const out: { name: string; sections: ApiSection[] }[] = []
    for (const s of role?.sections ?? []) {
      if (!s.features.some(usable)) continue
      const name = s.workspace || 'Other'
      let g = out.find((x) => x.name === name)
      if (!g) { g = { name, sections: [] }; out.push(g) }
      g.sections.push(s)
    }
    return out
  }, [role])

  const needle = q.trim().toLowerCase()
  const total = useMemo(
    () => (role?.sections ?? []).reduce((n, s) => n + s.features.filter(usable).length, 0),
    [role],
  )
  if (!open) return null

  const go = (sectionSlug: string, slug: string) => {
    navigate(featurePath(role.key, sectionSlug, slug))
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.launcher.title')}
      className="fixed inset-0 z-[60] overflow-y-auto bg-background/70 backdrop-blur-xl"
      onClick={onClose}
    >
      <div className="mx-auto max-w-6xl p-6 sm:p-10" onClick={(e) => e.stopPropagation()}>
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {role?.name}
            </p>
            <h2 className="text-[22px] font-semibold">{t('bento.launcher.title')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border bg-popover px-3.5 py-2 text-[12.5px] transition-colors
                       hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('bento.launcher.close')}
          </button>
        </div>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('bento.launcher.filter', { count: String(total) })}
          aria-label={t('bento.launcher.filter', { count: String(total) })}
          className="mb-8 w-full rounded-lg border bg-popover px-3.5 py-2.5 text-[13.5px]
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />

        {groups.map((g) => {
          const secs = g.sections
            .map((s) => ({
              s,
              feats: s.features.filter(
                (f) => usable(f) && (!needle || f.name.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle)),
              ),
            }))
            .filter((x) => x.feats.length)
          if (!secs.length) return null
          return (
            <section key={g.name} className="mb-9">
              <h3 className="mb-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {g.name}
              </h3>
              <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {secs.map(({ s, feats }) => (
                  <div key={s.slug} className="rounded-xl border bg-popover/80 p-4 [--tile-row:34px]">
                    <p className="mb-1 flex h-[var(--tile-row)] items-center px-2 text-[12.5px] font-medium text-secondary-foreground">{s.name}</p>
                    <ul className="space-y-0.5">
                      {feats.map((f) => {
                        const href = featurePath(role.key, s.slug, f.slug)
                        return (
                          <li key={f.key}>
                            <button
                              type="button"
                              onClick={() => go(s.slug, f.slug)}
                              aria-current={pathname === href ? 'page' : undefined}
                              className={
                                'flex h-[var(--tile-row)] w-full items-center rounded px-2 text-left text-[13px] transition-colors hover:bg-accent ' +
                                (pathname === href ? 'bg-accent font-medium' : '')
                              }
                            >
                              {f.name}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
