import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Images, Film, ArrowLeft } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Select,
  Field, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

/* Photographs and video from the school's own events.

   What is shown is metadata, not the pictures themselves. Handing out a
   viewable link means presigning an object key from a family endpoint, and
   that decision belongs in the file service where it can be made once —
   listPortalDocuments draws the same line for a child's certificates. Until it
   is wired the album is honest about it rather than rendering broken images,
   which is the version a parent reports as a fault.

   An album whose photographs the school has withdrawn shows as empty rather
   than disappearing: the event still happened. */

interface Album {
  id: string
  name: string
  kind: string
  on_date: string
  venue?: string
  description?: string
  photo_count: number
  video_count: number
  cover_file_id?: string
  section?: string
}

interface Item {
  id: string
  file_id: string
  media_kind: 'photo' | 'video' | string
  caption?: string
  original_name: string
  content_type: string
  size_bytes: number
  published_on: string
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Gallery() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const [open, setOpen] = useState<string | null>(null)

  const albums = useQuery({
    queryKey: ['gallery-albums', studentId],
    queryFn: () =>
      api.get<List<Album>>(
        `/api/v1/portal/school-life/gallery${studentId ? `?student_id=${studentId}` : ''}`,
      ),
  })
  const album = useQuery({
    queryKey: ['gallery-album', open, studentId],
    enabled: open !== null,
    queryFn: () =>
      api.get<{ album: Album; items: Item[] }>(
        `/api/v1/portal/school-life/gallery/${open}${studentId ? `?student_id=${studentId}` : ''}`,
      ),
  })

  if (albums.isLoading) return <Loading label="Looking up the gallery…" />
  if (albums.error) return <ErrorState error={albums.error} />

  const rows = albums.data?.items ?? []
  const photos = rows.reduce((n, a) => n + a.photo_count, 0)
  const videos = rows.reduce((n, a) => n + a.video_count, 0)

  if (open !== null) {
    const items = album.data?.items ?? []
    return (
      <>
        <PageHead
          eyebrow="School life"
          title={album.data?.album.name ?? 'Album'}
          description={[album.data?.album.venue, album.data && formatDate(album.data.album.on_date)]
            .filter(Boolean)
            .join(' · ')}
          actions={
            <Button variant="secondary" size="sm" onClick={() => setOpen(null)}>
              <ArrowLeft className="h-4 w-4" /> All albums
            </Button>
          }
        />
        <PageBody>
          {album.isLoading ? (
            <Loading label="Opening the album…" />
          ) : album.error ? (
            <ErrorState error={album.error} />
          ) : items.length === 0 ? (
            <Card>
              <EmptyState
                title="Nothing published yet"
                body="The school has not released photographs from this event."
              />
            </Card>
          ) : (
            <Card>
              <CardHeader
                title="Media"
                description={`${items.length} items the school has published to families.`}
              />
              <ul className="divide-y">
                {items.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3">
                    <Badge tone={it.media_kind === 'video' ? 'info' : 'primary'}>
                      {it.media_kind}
                    </Badge>
                    <span className="min-w-0 flex-1 text-[14px]">
                      {it.caption ?? it.original_name}
                      <span className="block text-[13px] text-muted-foreground">
                        {it.original_name} · {fileSize(it.size_bytes)} · published {formatDate(it.published_on)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHead
        eyebrow="School life"
        title="Photographs & video"
        description="Sports day, annual day and everything else the school has shared."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Albums" value={rows.length} icon={Images} />
          <Stat label="Photographs" value={photos} />
          <Stat label="Videos" value={videos} icon={Film} />
        </CellGrid>

        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label="Child" hint="An album for one class is shown only to that class.">
                <Select
                  value={chosen}
                  onChange={setChosen}
                  options={[{ value: '', label: 'All my children' }, ...childOptions(children)]}
                />
              </Field>
            </div>
          </Card>
        )}

        {rows.length === 0 ? (
          <Card>
            <EmptyState
              title="No albums yet"
              body="When the school publishes photographs from an event they will appear here."
            />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y">
              {rows.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">{a.name}</p>
                    <p className="text-[13px] text-muted-foreground">
                      {[formatDate(a.on_date), a.venue, a.section && `Class ${a.section}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {a.description && (
                      <p className="mt-1 text-[13px] text-muted-foreground">{a.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-[13px] text-muted-foreground">
                      {a.photo_count} photos · {a.video_count} videos
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={a.photo_count + a.video_count === 0}
                      onClick={() => setOpen(a.id)}
                    >
                      Open
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </PageBody>
    </>
  )
}
