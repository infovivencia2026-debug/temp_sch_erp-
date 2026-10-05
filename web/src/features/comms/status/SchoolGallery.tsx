import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Play, Plus, Star, Type } from 'lucide-react'
import HeartButton from './HeartButton'
import { useChildren } from '@/features/portal/use-children'
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
  /* WHAT A FAMILY FILTERS BY, AND WHAT STAFF DO NOT.

     A parent has exactly two questions of a school gallery: what went to the
     whole school, and what went to my child's class. Those are the two pills.
     Staff get no filter at all here (the owner's instruction): they have the
     Class Status screen, which filters by class, by poster and by state.

     The media filter is everybody's: a gallery that is mostly photos is hard
     to find one video in. */
  /* '' = everything, 'school' = whole school, 'class' = any child's class,
     or a child's id = that child's class. Tapping the chosen pill again goes
     back to everything (it used to stick on Whole school, hiding class videos). */
  const [scope, setScope] = useState<string>('')
  const [kind, setKind] = useState<'' | 'photo' | 'video'>('')
  const [open, setOpen] = useState<string | null>(null)
  const [choose, setChoose] = useState(false)
  const [compose, setCompose] = useState<{ file: File | null; mode?: AddMode } | null>(null)
  const photoIn = useRef<HTMLInputElement>(null)
  const videoIn = useRef<HTMLInputElement>(null)
  const cameraIn = useRef<HTMLInputElement>(null)

  const staff = !(session.user?.roles ?? []).every((r) => r === 'parent' || r === 'student')
  /* WHOSE GALLERY THIS IS (owner's mockup).

     A parent of two opening the gallery sees pictures from two classes and
     a filter called "My child's class", and nothing on the screen says which
     child that means. The pill answers it before the question is asked, and
     for a family with one child it is simply the child's name, which is the
     thing they came to look for. Staff see nothing here: it is not about one
     child for them. */
  const kids = useChildren()
  const kid = staff ? null : kids.child
  const shown = items
    .filter((p) => !scope || (scope === 'school' ? p.scope === 'school' : scope === 'class' ? p.scope === 'class' : p.scope === 'class' && (p.for_kids ?? []).includes(scope)))
    .filter((p) => !kind || p.media_kind === kind)
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
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">School gallery</h2>
        {kid && (
          <span className="mr-auto inline-flex min-w-0 items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
            <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-extrabold text-primary">
              {(kid.full_name || '?').trim().charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[10px] text-muted-foreground">Parent of</span>
              <span className="block truncate text-[12.5px] font-bold">
                {kid.full_name}
                {kid.class_name ? ` (${kid.class_name}${kid.section_name ? '-' + kid.section_name : ''})` : ''}
              </span>
            </span>
          </span>
        )}
        {!kid && <span className="mr-auto" />}
        {/* Nothing here for staff: the owner asked for no filters on their
            side, and Class Status already filters by class and by poster. */}
        {!staff && <FamilyScope value={scope} onChange={setScope} />}
        {/* Photos, videos, or everything. */}
        <div className="flex items-center gap-1 rounded-full bg-muted p-1">
          {([['', 'All'], ['photo', 'Photos'], ['video', 'Videos']] as const).map(([v, label]) => (
            <button key={v || 'all'} type="button" onClick={() => setKind(v)}
              className={cn('rounded-full px-3 py-1.5 text-[13px] font-bold transition-colors',
                kind === v ? 'bg-card text-foreground shadow-[0_2px_6px_-1px_rgba(15,23,42,0.12)]' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        {feed.data?.can_post && (
          <button type="button" onClick={() => setChoose(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-transform active:scale-[0.97]">
            <Plus className="size-4" /> Add to gallery
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {feed.data?.storage_warning && (
          <p role="status" className="mb-4 rounded-lg bg-[#fef3c7] px-3 py-2 text-[13px] font-medium text-[#92400e]">{feed.data.storage_warning}</p>
        )}
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
              {/* A CARD, NOT A CONTACT SHEET (owner's mockup).

                  Square thumbnails in a six-wide grid are how a phone shows
                  a camera roll, where every picture is the viewer's own and
                  needs no caption. This is somebody else's: a parent wants to
                  know what it is, when it was, and to say they liked it --
                  so each one is a card with its own title, date and heart,
                  and the picture keeps the shape it was taken in. */}
              <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
                {list.map((p) => (
                  <article key={p.id}
                    className="group flex flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_4px_18px_-2px_rgba(15,23,42,0.05)]
                               transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_16px_32px_-4px_rgba(15,23,42,0.12)]">
                    <button type="button" onClick={() => setOpen(p.id)}
                      className="relative block aspect-[16/10] w-full overflow-hidden bg-foreground/90 text-left">
                      {p.media_kind === 'text' ? (
                        <span className="grid size-full place-items-center bg-primary p-4 text-center text-[13px] font-semibold text-primary-foreground">
                          <Type className="mb-1 size-5 opacity-80" />{(p.caption ?? '').slice(0, 90)}
                        </span>
                      ) : p.thumb || p.media_kind === 'photo' ? (
                        <img src={p.thumb ?? p.url} alt={p.caption ?? ''} loading="lazy"
                             className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                      ) : (
                        <span className="grid size-full place-items-center bg-black/80 text-white"><Play className="size-7" /></span>
                      )}
                      {/* Staff are told which list it went to; a family is not. */}
                      {staff && p.audience && (
                        <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[11.5px] font-bold text-white backdrop-blur">
                          {p.audience}
                        </span>
                      )}
                      {p.media_kind === 'video' && (
                        <>
                          {/* The play mark arrives on hover, as in the mockup: a
                              still frame with a button already on it reads as a
                              video that failed to start. */}
                          <span className="absolute inset-0 grid place-items-center bg-black/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            <span className="grid size-[52px] place-items-center rounded-full bg-white/95 shadow-[0_8px_24px_rgba(0,0,0,0.3)] transition-transform duration-200 group-hover:scale-100 scale-90">
                              <Play className="size-5 fill-primary text-primary" />
                            </span>
                          </span>
                          <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-md bg-black/85 px-2 py-0.5 text-[11.5px] font-semibold text-white">
                            <Play className="size-2.5 fill-current" />
                            {p.duration_seconds ? `0:${String(Math.round(p.duration_seconds)).padStart(2, '0')}` : ''}
                          </span>
                        </>
                      )}
                    </button>

                    <div className="flex flex-1 flex-col gap-3 px-4 py-3.5">
                      <div className="min-w-0">
                        <h4 className="truncate text-[15px] font-bold">
                          {p.caption || (p.media_kind === 'video' ? 'Video' : 'Photo')}
                        </h4>
                        <p className="mt-0.5 text-[12.5px] font-medium text-muted-foreground">
                          {new Date(p.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </p>
                      </div>
                      <div className="mt-auto flex items-center justify-between border-t pt-2.5">
                        <HeartButton post={p} />
                      </div>
                    </div>
                  </article>
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

/* All, Whole school, then each child's class by name (one child: "My child's
   class"). Owner: "no my child switching". */
function FamilyScope({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { children } = useChildren()
  const opts: [string, string][] = [['', 'All'], ['school', 'Whole school']]
  if (children.length > 1) for (const ch of children) opts.push([ch.student_id, `${ch.full_name.split(' ')[0]}'s class`])
  else opts.push(['class', "My child's class"])
  return (
    <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full bg-muted p-1">
      {opts.map(([v, label]) => (
        <button key={v || 'all'} type="button" onClick={() => onChange(value === v ? '' : v)}
          className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-bold transition-colors',
            value === v ? 'bg-card text-primary shadow-[0_2px_6px_-1px_rgba(15,23,42,0.12)]' : 'text-muted-foreground hover:text-foreground')}>
          {v !== '' && v !== 'school' && <Star className="size-3.5 fill-current" aria-hidden="true" />}
          {label}
        </button>
      ))}
    </div>
  )
}
