import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Link2, FileText, Image as ImageIcon, Film, Download, ExternalLink, Play } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Field,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'
import StoryViewer, { initials, type StoryGroup, type StoryItem, type StoryMedia } from '@/components/StoryViewer'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'
import { useOpenState } from '@/lib/motion'

interface Resource {
  id: string
  title: string
  description?: string
  kind: string
  subject?: string
  external_url?: string
  file_id?: string
  file_name?: string
  content_type?: string
  uploaded_by?: string
  posted_on: string
  posted_at?: string
  audience?: 'class' | 'school' | 'students'
  seen?: boolean
  expires_at?: string
}

const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'note', label: 'Notes' },
  { value: 'worksheet', label: 'Worksheets' },
  { value: 'reference', label: 'Reference' },
  { value: 'video', label: 'Video' },
  { value: 'link', label: 'Links' },
  { value: 'syllabus', label: 'Syllabus' },
]

const TONE: Record<string, 'info' | 'success' | 'warning' | 'neutral' | 'primary'> = {
  note: 'info',
  worksheet: 'warning',
  reference: 'neutral',
  video: 'primary',
  link: 'neutral',
  syllabus: 'success',
}

/** How many days a post stays in the status strip once it is not new. */
const STRIP_DAYS = 14

function mediaOf(r: Resource): StoryMedia {
  const ct = r.content_type ?? ''
  if (r.file_id && ct.startsWith('image/')) return 'image'
  if (r.file_id && ct.startsWith('video/')) return 'video'
  if (r.file_id && ct === 'application/pdf') return 'pdf'
  if (r.file_id) return 'file'
  return 'link'
}

function fileURL(r: Resource, inline: boolean) {
  return `/api/v1/files/${r.file_id}${inline ? '?inline=1' : ''}`
}

function toStory(r: Resource, seen: boolean): StoryItem {
  const media = mediaOf(r)
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    media,
    src: r.file_id ? fileURL(r, media !== 'file') : undefined,
    href: media === 'link' ? r.external_url : r.file_id ? fileURL(r, media === 'pdf') : undefined,
    postedAt: r.posted_at,
    seen,
    tag: r.audience === 'students' ? 'For you' : r.audience === 'school' ? 'Whole school' : r.subject,
  }
}

/* Everything the teachers have posted that this child can open.

   Four widths of audience end up here and all four are theirs: posted to
   their own section, posted against a subject their class is taught,
   posted to the whole school, and posted to them by name. The strip at the
   top shows the recent ones the way a phone shows a status: one circle per
   teacher, a bright ring while something in it is unopened, full screen
   when tapped. The list underneath is the library proper, for finding the
   worksheet from three weeks ago. */
export default function Resources() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const [kind, setKind] = useState('')
  const [open, setOpen] = useOpenState<number | null>(null)
  const [seenNow, setSeenNow] = useState<Set<string>>(() => new Set())
  const ready = readyFor(children, studentId)
  const qc = useQueryClient()

  const resources = useQuery({
    queryKey: ['learning-resources', studentId, kind],
    queryFn: () =>
      api.get<List<Resource>>(
        `/api/v1/portal/learning/resources${studentQuery(studentId, kind ? `kind=${kind}` : '')}`,
      ),
    enabled: ready,
  })

  const rows = useMemo(() => resources.data?.items ?? [], [resources.data])
  const isSeen = useCallback((r: Resource) => Boolean(r.seen) || seenNow.has(r.id), [seenNow])

  /* The strip: recent posts grouped by who posted them, the ones with
     something unopened first. */
  const groups = useMemo<StoryGroup[]>(() => {
    const cutoff = Date.now() - STRIP_DAYS * 86400000
    const byPoster = new Map<string, StoryGroup>()
    for (const r of rows) {
      const posted = new Date(r.posted_at ?? r.posted_on).getTime()
      if (!(posted >= cutoff || r.expires_at)) continue
      const name = r.uploaded_by ?? 'School'
      let g = byPoster.get(name)
      if (!g) {
        g = { id: name, name, items: [] }
        byPoster.set(name, g)
      }
      g.items.push(toStory(r, isSeen(r)))
    }
    const list = Array.from(byPoster.values())
    for (const g of list) g.items.reverse() // oldest first inside a poster, as a status plays
    list.sort((a, b) => {
      const ua = a.items.some((i) => !i.seen) ? 0 : 1
      const ub = b.items.some((i) => !i.seen) ? 0 : 1
      return ua - ub
    })
    return list
  }, [rows, isSeen])

  const markSeen = useCallback(
    (item: StoryItem) => {
      setSeenNow((prev) => (prev.has(item.id) ? prev : new Set(prev).add(item.id)))
      void api.post(`/api/v1/portal/learning/resources/${item.id}/seen${studentQuery(studentId)}`, {}).catch(() => undefined)
    },
    [studentId],
  )
  const closeViewer = useCallback(() => {
    setOpen(null)
    void qc.invalidateQueries({ queryKey: ['learning-resources', studentId] })
  }, [qc, studentId])

  if (resources.isLoading && ready) return <SkeletonTiles count={3} label="Fetching your resources…" />
  if (resources.error) return <ErrorState error={resources.error} />

  const subjects = new Set(rows.map((r) => r.subject).filter(Boolean))
  const unseen = rows.filter((r) => !isSeen(r)).length

  return (
    <>
      <PageHead
        eyebrow="Learning"
        title="Digital library"
        description="Notes, pictures, recordings and reading your teachers have shared with you."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState
            title="Choose a child"
            body="Resources follow the class, so the list is different for each child."
          />
        ) : (
          <>
            {groups.length > 0 && (
              <Card>
                <div className="flex gap-4 overflow-x-auto px-5 py-4" role="list" aria-label="Recently shared">
                  {groups.map((g, idx) => {
                    const hasUnseen = g.items.some((i) => !i.seen)
                    return (
                      <button
                        key={g.id}
                        type="button"
                        role="listitem"
                        onClick={() => setOpen(idx)}
                        className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 text-center"
                        aria-label={`${g.name}, ${g.items.length} item${g.items.length === 1 ? '' : 's'}${hasUnseen ? ', new' : ''}`}
                      >
                        <span
                          className={cn('grid size-[66px] place-items-center rounded-full p-[3px]', !hasUnseen && 'bg-border')}
                          style={hasUnseen ? { background: 'conic-gradient(from 200deg, #3d6cff, #18bca6, #ff3c9e, #3d6cff)' } : undefined}
                        >
                          <span className="grid size-full place-items-center rounded-full border-2 border-card bg-muted text-[15px] font-semibold">
                            {initials(g.name)}
                          </span>
                        </span>
                        <span className={cn('w-full truncate text-[12px]', hasUnseen ? 'font-medium' : 'text-muted-foreground')}>
                          {g.name}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </Card>
            )}

            <CellGrid cols={3}>
              <Stat label="Items shared" value={rows.length} icon={FolderOpen} />
              <Stat label="Not opened yet" value={unseen} icon={Play} />
              <Stat label="Subjects covered" value={subjects.size} icon={FileText} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Shared with you"
                description="Newest first. Pictures and videos open full screen; documents and links open in a new tab."
                action={
                  <div className="w-52">
                    <Field label="Kind">
                      <Select value={kind} onChange={setKind} options={KINDS} />
                    </Field>
                  </div>
                }
              />
              {rows.length === 0 ? (
                <EmptyState
                  title="Nothing shared yet"
                  body="When a teacher posts notes, a picture or a worksheet for you it appears here."
                />
              ) : (
                <ul className="divide-y">
                  {rows.map((r) => (
                    <ResourceRow
                      key={r.id}
                      r={r}
                      seen={isSeen(r)}
                      onOpen={() => {
                        const gi = groups.findIndex((g) => g.items.some((i) => i.id === r.id))
                        if (gi >= 0 && (mediaOf(r) === 'image' || mediaOf(r) === 'video')) setOpen(gi)
                        else markSeen(toStory(r, isSeen(r)))
                      }}
                    />
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>

      {open !== null && groups.length > 0 && (
        <StoryViewer groups={groups} start={open} onClose={closeViewer} onSeen={markSeen} />
      )}
    </>
  )
}

function ResourceRow({ r, seen, onOpen }: { r: Resource; seen: boolean; onOpen: () => void }) {
  const media = mediaOf(r)
  const Icon = media === 'image' ? ImageIcon : media === 'video' ? Film : media === 'link' ? Link2 : FileText
  const plays = media === 'image' || media === 'video'
  const href = media === 'link' ? r.external_url : r.file_id ? fileURL(r, media === 'pdf') : undefined
  return (
    <li className="flex gap-3 px-5 py-4">
      <div className="relative shrink-0">
        {media === 'image' && r.file_id ? (
          <button type="button" onClick={onOpen} className="block size-14 overflow-hidden rounded-lg bg-muted" aria-label={`Open ${r.title}`}>
            <img src={fileURL(r, true)} alt="" loading="lazy" className="size-full object-cover" />
          </button>
        ) : (
          <button type="button" onClick={plays ? onOpen : undefined} className="grid size-14 place-items-center rounded-lg bg-muted text-muted-foreground" aria-hidden={!plays} tabIndex={plays ? 0 : -1}>
            <Icon className="size-5" />
          </button>
        )}
        {!seen && <span className="absolute -right-1 -top-1 size-3 rounded-full bg-primary ring-2 ring-card" aria-label="New" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-[14px] font-medium">
            {plays ? (
              <button type="button" onClick={onOpen} className="text-left underline-offset-2 hover:underline">
                {r.title}
              </button>
            ) : href ? (
              <a
                href={href}
                /* A file downloads; opening it in a new tab left a blank tab
                   behind the save, which on a phone read as nothing having
                   happened. Links still get a tab of their own. */
                target={media === 'file' ? undefined : '_blank'}
                download={media === 'file' ? r.title : undefined}
                rel="noreferrer noopener"
                onClick={onOpen}
                className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-primary"
              >
                {r.title}
                {media === 'link' ? <ExternalLink className="size-3.5" aria-hidden /> : media === 'file' ? <Download className="size-3.5" aria-hidden /> : null}
              </a>
            ) : (
              r.title
            )}
          </p>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge tone={TONE[r.kind] ?? 'neutral'}>{r.kind}</Badge>
            {r.audience === 'students' ? (
              <Badge tone="primary">For you</Badge>
            ) : r.subject ? (
              <Badge>{r.subject}</Badge>
            ) : (
              <Badge>Whole school</Badge>
            )}
          </div>
        </div>
        {r.description && (
          <p className="mt-1 text-[13px] text-muted-foreground">{r.description}</p>
        )}
        <p className="mt-1.5 text-[12.5px] text-muted-foreground">
          {formatDate(r.posted_on)}
          {r.uploaded_by ? ` · ${r.uploaded_by}` : ''}
          {r.file_name ? ` · ${r.file_name}` : ''}
          {r.expires_at ? ` · until ${formatDate(r.expires_at)}` : ''}
        </p>
      </div>
    </li>
  )
}
