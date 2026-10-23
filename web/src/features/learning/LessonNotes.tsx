import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Button, FormNotice, Textarea } from '@/components/ui'
import { stamp, type YTPlayer } from './YouTubeLesson'

/* MY NOTES, AGAINST THE SECOND I WAS WATCHING.
 *
 * The child writes these. Nothing here is generated, and nothing is derived
 * from the video, its captions or its description -- a machine summary of
 * somebody else's recording is derived from their work, and this product
 * does not make one. What a child writes in their own words is theirs, and
 * it raises no question at all. The teacher's own "Key points" sit above,
 * written by the teacher, for the same reason.
 *
 * PRIVATE. The endpoint filters every read and every write on the caller's
 * own user id; there is no sharing switch here and no column in the table to
 * add one by accident later.
 *
 * THE TIMESTAMP IS THE POINT. A note that says "this bit is the one for the
 * exam" is worth nothing without where "this bit" is, so a note taken while
 * the video is playing remembers the second, and pressing it jumps the
 * player back there. Without a player -- a lesson that is a document, or
 * YouTube blocked on the school's network -- notes still work; they simply
 * have no time against them.
 */

interface Note {
  id: string
  at_seconds: number | null
  body: string
  created_at: string
  updated_at: string
}

export function LessonNotes({ lessonId, player }: { lessonId: string; player?: YTPlayer | null }) {
  const qc = useQueryClient()
  const key = ['lesson-notes', lessonId]
  const notes = useQuery({
    queryKey: key,
    queryFn: () => api.get<List<Note>>(`/api/v1/portal/lms/lessons/${lessonId}/notes`),
  })
  const [draft, setDraft] = useState('')
  /* Captured when the child starts writing, not when they press Save: by the
     time a sentence is typed the video has moved on, and the note belongs to
     the moment that prompted it. */
  const [at, setAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const nowAt = (): number | null => {
    try { const t = player?.getCurrentTime(); return typeof t === 'number' && Number.isFinite(t) ? Math.floor(t) : null }
    catch { return null }
  }

  const add = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/portal/lms/lessons/${lessonId}/notes`, { body: draft.trim(), at_seconds: at }),
    onSuccess: () => { setDraft(''); setAt(null); qc.invalidateQueries({ queryKey: key }) },
  })
  const save = useMutation({
    mutationFn: (n: Note) =>
      api.patch(`/api/v1/portal/lms/lessons/${lessonId}/notes/${n.id}`, { body: editText.trim() }),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: key }) },
  })
  const drop = useMutation({
    mutationFn: (n: Note) => api.del(`/api/v1/portal/lms/lessons/${lessonId}/notes/${n.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })

  const items = notes.data?.items ?? []

  return (
    <section className="rounded-[14px] border bg-card p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold">My notes</h3>
        <span className="text-[12.5px] text-muted-foreground">
          {items.length === 0 ? 'Only you can see these' : `${items.length} note${items.length === 1 ? '' : 's'} · only you`}
        </span>
      </div>

      <Textarea
        value={draft}
        onChange={(v) => { if (!draft && v) setAt(nowAt()); setDraft(v) }}
        rows={3}
        placeholder="Write what you want to remember…"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!draft.trim() || add.isPending}
          onClick={() => add.mutate()}
        >
          {add.isPending ? 'Saving…' : at !== null ? `Save at ${stamp(at)}` : 'Save note'}
        </Button>
        {at !== null && (
          <button type="button" onClick={() => setAt(null)}
                  className="text-[12.5px] text-muted-foreground underline">
            not about this moment
          </button>
        )}
      </div>
      <FormNotice error={add.error ?? save.error ?? drop.error ?? notes.error} />

      {items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((n) => (
            <li key={n.id} className="rounded-[10px] border bg-muted/30 p-3">
              {editing === n.id ? (
                <>
                  <Textarea value={editText} onChange={setEditText} rows={3} />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" disabled={!editText.trim() || save.isPending} onClick={() => save.mutate(n)}>
                      {save.isPending ? 'Saving…' : 'Save'}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    {n.at_seconds !== null ? (
                      <button
                        type="button"
                        /* Jumping is only possible with a player on screen;
                           without one the stamp is still worth showing, so
                           the button becomes plain text. */
                        disabled={!player}
                        onClick={() => { try { player?.seekTo(n.at_seconds as number, true) } catch { /* the iframe went away */ } }}
                        className={player
                          ? 'shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[12px] font-semibold text-primary'
                          : 'shrink-0 rounded-full bg-muted px-2 py-0.5 text-[12px] font-semibold text-muted-foreground'}
                      >
                        {stamp(n.at_seconds)}
                      </button>
                    ) : <span className="shrink-0 text-[12px] text-muted-foreground">whole lesson</span>}
                    <span className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" title="Edit this note"
                              onClick={() => { setEditing(n.id); setEditText(n.body) }}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" tone="danger" title="Delete this note"
                              disabled={drop.isPending} onClick={() => drop.mutate(n)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-[14px]">{n.body}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The teacher's own words about the video. Read-only on the child's side. */
export function KeyPoints({ text }: { text: string }) {
  return (
    <section className="rounded-[14px] border border-primary/25 bg-primary/[0.05] p-4">
      <h3 className="mb-1.5 text-[15px] font-semibold">Key points from your teacher</h3>
      <p className="whitespace-pre-wrap text-[14px]">{text}</p>
    </section>
  )
}
