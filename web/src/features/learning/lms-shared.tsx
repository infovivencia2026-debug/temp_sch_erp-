import { useState } from 'react'
import { FileText, Link2, PlayCircle, Paperclip } from 'lucide-react'

/* Pieces both sides of the LMS use: the teacher's (faculty/TeacherLMS.tsx)
   and the child's (learning/StudentCourses.tsx). */

export interface Lesson {
  id: string; unit_id: string; title: string; kind: 'text' | 'file' | 'pdf' | 'video' | 'link'
  body?: string | null; file_id?: string | null; file_name?: string | null; url?: string | null
  sequence: number; day?: number | null; publish_at?: string | null
  is_published?: boolean; completed?: number; done?: boolean
}
export interface Unit { id: string; title: string; description?: string | null; lessons: Lesson[] }
export interface RubricRow { criterion: string; max: number }

/** Uploads one file to POST /api/v1/files and returns its id and name. */
export async function uploadFile(f: File, purpose: string): Promise<{ id: string; name: string }> {
  const fd = new FormData()
  fd.append('file', f)
  fd.append('purpose', purpose)
  const res = await fetch('/api/v1/files', { method: 'POST', body: fd, credentials: 'same-origin' })
  if (!res.ok) {
    let msg = 'Could not upload that file.'
    try { msg = (await res.json()).error ?? msg } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const made = await res.json()
  return { id: made.file_id, name: made.name }
}

export function FilePick({ purpose, onDone, label = 'Attach a file' }: { purpose: string; onDone: (f: { id: string; name: string } | null) => void; label?: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[13px]">
      <label className="btn inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-sm border px-3" data-variant="secondary">
        <Paperclip className="h-4 w-4" />
        {busy ? 'Uploading…' : label}
        <input
          type="file"
          className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            setBusy(true); setErr('')
            try { const r = await uploadFile(f, purpose); setName(r.name); onDone(r) } catch (x) { setErr(x instanceof Error ? x.message : 'Upload failed') } finally { setBusy(false) }
          }}
        />
      </label>
      {name && (
        <span>
          {name}{' '}
          <button type="button" className="underline text-muted-foreground" onClick={() => { setName(''); onDone(null) }}>remove</button>
        </span>
      )}
      {err && <span className="text-destructive">{err}</span>}
    </span>
  )
}

/** A YouTube or Vimeo address as an embeddable player address, or null. */
export function embedOf(url: string): string | null {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/)
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`
  const vm = url.match(/vimeo\.com\/(\d+)/)
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`
  return null
}

export const KIND_LABEL: Record<string, string> = { text: 'Reading', file: 'File', pdf: 'PDF', video: 'Video', link: 'Link' }
export function KindIcon({ kind }: { kind: string }) {
  const C = kind === 'video' ? PlayCircle : kind === 'link' ? Link2 : kind === 'file' ? Paperclip : FileText
  return <C className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
}

/** The body of a lesson: text, a player, a file to open, or a link. */
export function LessonContent({ l }: { l: Lesson }) {
  const embed = l.kind === 'video' && l.url ? embedOf(l.url) : null
  return (
    <div className="space-y-3 text-[14px]">
      {l.body && <div className="whitespace-pre-wrap leading-relaxed">{l.body}</div>}
      {embed && (
        <div className="aspect-video w-full max-w-2xl overflow-hidden rounded-md border">
          <iframe src={embed} title={l.title} className="h-full w-full" allowFullScreen allow="encrypted-media; picture-in-picture" />
        </div>
      )}
      {l.file_id && l.kind === 'pdf' && (
        <iframe src={`/api/v1/files/${l.file_id}?inline=1`} title={l.title} className="h-[70vh] w-full max-w-3xl rounded-md border" />
      )}
      {l.file_id && (
        <a href={`/api/v1/files/${l.file_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline">
          <Paperclip className="h-4 w-4" /> Download {l.file_name ?? 'the file'}
        </a>
      )}
      {l.url && !embed && (
        <a href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline">
          <Link2 className="h-4 w-4" /> Open {l.kind === 'video' ? 'the video' : 'the link'}
        </a>
      )}
    </div>
  )
}

export const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
