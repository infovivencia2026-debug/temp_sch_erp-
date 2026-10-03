import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Play, Plus, Type } from 'lucide-react'
import StoryViewer from '@/components/StoryViewer'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import type { StatusItem } from '@shared/api/feature_class_status'
import StatusComposer, { AddChooser } from './StatusComposer'
import { toGroups } from './StatusRings'
import { FEED_KEY, useStatusFeed, type AddMode } from './status-api'

/* THE SCHOOL GALLERY.

   Every status that was pinned, kept: sports day, annual day, a class trip.
   A grid of thumbnails, newest first, grouped by month, with a filter by who
   it was for (whole school, a class, a section). Each person sees only what
   was meant for them -- the server builds the feed per person. Tap a tile and
   it plays full screen like a status. "Add to gallery" posts a status and
   pins it in one go. Opened from Notifications > Activity, the owner's one
   home for status. */
export default function SchoolGallery({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const session = useSession()
  const feed = useStatusFeed(true)
  /* Every pinned post: the feed's gallery holds those past their 24 hours;
     one pinned while still live sits in its poster's ring, so it is taken
     from there too (it showed nowhere in the gallery before). */
  const items = useMemo(() => {
    const seen = new Set<string>(); const out: StatusItem[] = []
    for (const p of [...(feed.data?.gallery ?? []), ...(feed.data?.rings ?? []).flatMap((r) => r.posts)]) {
      if (!p.pinned || seen.has(p.id)) continue
      seen.add(p.id); out.push(p)
    }
    return out
  }, [feed.data])
  const [who, setWho] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [choose, setChoose] = useState(false)
  const [compose, setCompose] = useState<{ file: File | null; mode?: AddMode } | null>(null)
  const photoIn = useRef<HTMLInputElement>(null)
  const videoIn = useRef<HTMLInputElement>(null)
  const cameraIn = useRef<HTMLInputElement>(null)

  const audiences = useMemo(() => [...new Set(items.map((p) => p.audience).filter(Boolean))].sort(), [items])
  const shown = items.filter((p) => !who || p.audience === who)
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
  const months = new Map<string, StatusItem[]>()
  for (const p of shown) {
    const m = new Date(p.published_at).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    months.set(m, [...(months.get(m) ?? []), p])
  }
  const groups = feed.data ? toGroups({ ...feed.data, rings: [], gallery: shown }, session.institution?.display_name ?? 'School', undefined, () => {}) : []
  const gIndex = groups.findIndex((g) => g.id === 'gallery')

  const openComposer = (next: { file: File | null; mode?: AddMode }) => {
    setChoose(false)
    window.setTimeout(() => setCompose(next), 350)
  }
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) openComposer({ file: f })
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex flex-col bg-background" role="dialog" aria-label="School gallery">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-4 py-3 sm:px-6">
        <button type="button" onClick={onClose} aria-label="Back" className="grid size-9 place-items-center rounded-full hover:bg-muted">
          <ArrowLeft className="size-5" />
        </button>
        <h2 className="mr-auto text-[19px] font-bold tracking-[-0.02em]">School gallery</h2>
        {audiences.length > 1 && (
          <select value={who} onChange={(e) => setWho(e.target.value)}
            className="rounded-full border bg-card px-3 py-1.5 text-[13px] font-medium">
            <option value="">Everything</option>
            {audiences.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {feed.data?.can_post && (
          <button type="button" onClick={() => setChoose(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-transform active:scale-[0.97]">
            <Plus className="size-4" /> Add to gallery
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {feed.isLoading ? (
          <p className="py-20 text-center text-[14px] text-muted-foreground">Loading the gallery…</p>
        ) : shown.length === 0 ? (
          <div className="mx-auto max-w-md py-20 text-center">
            <p className="text-[16px] font-semibold">Nothing in the gallery yet</p>
            <p className="mt-1 text-[14px] text-muted-foreground">
              Photos and videos land here when a status is pinned{feed.data?.can_post ? ', or added with Add to gallery' : ''}.
            </p>
          </div>
        ) : (
          [...months.entries()].map(([month, list]) => (
            <section key={month} className="mb-7">
              <h3 className="mb-3 text-[12px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{month}</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {list.map((p) => (
                  <button key={p.id} type="button" onClick={() => setOpen(p.id)}
                    className="group relative aspect-square overflow-hidden rounded-xl bg-muted transition-transform active:scale-[0.98]">
                    {p.media_kind === 'text' ? (
                      <span className="grid size-full place-items-center bg-primary p-2 text-center text-[12px] font-semibold text-primary-foreground">
                        <Type className="mb-1 size-4 opacity-80" />{(p.caption ?? '').slice(0, 60)}
                      </span>
                    ) : p.thumb || p.media_kind === 'photo' ? (
                      <img src={p.thumb ?? p.url} alt={p.caption ?? ''} loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-105" />
                    ) : (
                      <span className="grid size-full place-items-center bg-black/80 text-white"><Play className="size-6" /></span>
                    )}
                    {p.media_kind === 'video' && (
                      <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                        <Play className="size-3" />{p.duration_seconds ? `0:${String(Math.round(p.duration_seconds)).padStart(2, '0')}` : ''}
                      </span>
                    )}
                    <span className={cn('absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-5 text-left text-[11px] font-medium text-white', p.media_kind === 'video' && 'pl-14')}>
                      {p.audience}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <input ref={photoIn} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={picked} />
      <input ref={videoIn} type="file" accept="video/*" className="sr-only" tabIndex={-1} aria-hidden onChange={picked} />
      <input ref={cameraIn} type="file" accept="image/*,video/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={picked} />
      {choose && (
        <AddChooser raised allowVideo={feed.data?.allow_video ?? true} onClose={() => setChoose(false)}
          onPick={(f) => openComposer({ file: f })}
          onText={() => openComposer({ file: null, mode: 'text' })}
          openPicker={(k) => (k === 'photo' ? photoIn : k === 'video' ? videoIn : cameraIn).current?.click()} />
      )}
      {compose && (
        <StatusComposer raised pinByDefault file={compose.file} mode={compose.mode}
          onClose={() => { setCompose(null); void qc.invalidateQueries({ queryKey: FEED_KEY }) }} />
      )}
      {open && gIndex >= 0 && (
        <StoryViewer groups={groups} start={gIndex} startId={open} onClose={() => setOpen(null)} onSeen={(it) => {
          /* Opening a pinned post counts as seeing it, as it does from the ring. */
          const p = items.find((x) => x.id === it.id)
          if (p && !p.mine && !p.seen) void api.post(p.seen_url ?? `/api/v1/status/posts/${p.id}/view`).catch(() => undefined)
        }} />
      )}
    </div>,
    document.body,
  )
}
