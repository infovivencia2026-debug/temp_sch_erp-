import { Fragment, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen, ClipboardList, Download, ExternalLink, FileText, Headphones, Image as ImageIcon, Link2, ListChecks, Paperclip, PlayCircle, Presentation,
} from 'lucide-react'
import { VideoPlayer, fmtDur } from './VideoPlayer'

/* Pieces both sides of the LMS use: the teacher's (faculty/TeacherLMS.tsx,
   faculty/TeacherModules.tsx) and the child's (learning/StudentCourses.tsx).

   A course is a list of modules (syllabus units). A module holds sources
   (lms_lessons rows, one kind each) and may hold the course's assignments
   and quizzes, all in one order the teacher sets (worker 0011). */

export type SourceKind = 'text' | 'file' | 'pdf' | 'video' | 'link' | 'image' | 'audio' | 'doc'
export type ItemType = SourceKind | 'quiz' | 'assignment'

export interface Lesson {
  id: string; unit_id: string; title: string; kind: SourceKind
  body?: string | null; file_id?: string | null; file_name?: string | null; file_size?: number | null; file_type?: string | null; url?: string | null
  sequence: number; day?: number | null; publish_at?: string | null; duration_minutes?: number | null; created_at?: string
  is_published?: boolean; completed?: number; done?: boolean; is_new?: boolean; viewed_at?: string | null
  /* A library video (worker routes/teaching/videos.ts) instead of a link. */
  video_id?: string | null; video_title?: string | null; video_duration?: number | null; video_thumb?: number | boolean | null; video_type?: string | null
  video_position?: number | null; video_percent?: number | null; video_watched?: string | null; video_bucket?: number | null
}
export interface Unit {
  id: string; title: string; description?: string | null; sequence?: number; starts_on?: string | null; ends_on?: string | null
  is_active?: boolean; lessons: Lesson[]
}
export interface RubricRow { criterion: string; max: number }
/** What an assignment or a quiz needs to sit in a module. */
export interface Placed { id: string; title: string; lms_unit_id?: string | null; lms_sequence?: number | null }

/** Uploads one file to POST /api/v1/files and returns its id and name. */
export async function uploadFile(f: File, purpose: string): Promise<{ id: string; name: string; size: number; type: string }> {
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
  return { id: made.file_id, name: made.name, size: made.size_bytes, type: made.content_type }
}

export function FilePick({ purpose, onDone, label = 'Attach a file', accept }: { purpose: string; onDone: (f: { id: string; name: string } | null) => void; label?: string; accept?: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[13px]">
      <label className="btn inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-sm border px-3" data-variant="secondary">
        <Paperclip className="h-4 w-4" />
        {busy ? 'Uploading…' : label}
        <input
          type="file"
          accept={accept}
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
        <span className="min-w-0 break-all">
          {name}{' '}
          <button type="button" className="min-h-10 underline text-muted-foreground" onClick={() => { setName(''); onDone(null) }}>remove</button>
        </span>
      )}
      {err && <span className="text-destructive">{err}</span>}
    </span>
  )
}

/** A YouTube or Vimeo address as an embeddable player address (inline on iPhone), or null. */
export function embedOf(url: string): string | null {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{6,})/)
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}?playsinline=1&rel=0`
  const vm = url.match(/vimeo\.com\/(\d+)/)
  if (vm) return `https://player.vimeo.com/video/${vm[1]}?playsinline=1`
  return null
}

export const KIND_LABEL: Record<string, string> = {
  text: 'Notes', pdf: 'PDF', file: 'File', video: 'Video', link: 'Web link', image: 'Image', audio: 'Audio', doc: 'Slides / doc', quiz: 'Quiz', assignment: 'Assignment',
}
const ICONS: Record<string, typeof FileText> = {
  text: BookOpen, pdf: FileText, file: Paperclip, video: PlayCircle, link: Link2, image: ImageIcon, audio: Headphones, doc: Presentation, quiz: ListChecks, assignment: ClipboardList,
}
export function KindIcon({ kind, className = 'h-4 w-4 shrink-0 text-muted-foreground' }: { kind: string; className?: string }) {
  const C = ICONS[kind] ?? FileText
  return <C className={className} aria-hidden strokeWidth={1.75} />
}
/** The type's icon in a soft square, the leading mark of a source row. */
export function KindChip({ kind, done }: { kind: string; done?: boolean }) {
  return (
    <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${done ? 'bg-success/10 text-success' : 'bg-primary/[0.07] text-primary'}`} title={KIND_LABEL[kind]}>
      <KindIcon kind={kind} className="h-[18px] w-[18px]" />
    </span>
  )
}

export const fmtSize = (n?: number | null) => (!n ? '' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const host = (u?: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : '' } catch { return '' } }

/** How long or how big a source is: "12:30", "5 min read", "2.4 MB", "youtube.com". */
export function sourceMeta(l: Lesson): string {
  if (l.duration_minutes) return l.kind === 'text' ? `${l.duration_minutes} min read` : `${l.duration_minutes} min`
  if (l.kind === 'video' && l.video_duration) return fmtDur(l.video_duration)
  if (l.kind === 'text' && l.body) return `${Math.max(1, Math.round(l.body.split(/\s+/).length / 180))} min read`
  if (l.file_size) return fmtSize(l.file_size)
  if (l.url) return host(l.url)
  return ''
}

export type ModuleItem =
  | { type: 'lesson'; id: string; seq: number; lesson: Lesson }
  | { type: 'assignment'; id: string; seq: number; title: string }
  | { type: 'quiz'; id: string; seq: number; title: string }

/** A module's sources, assignments and quizzes in the teacher's order. */
export function moduleItems(u: Unit, assignments: Placed[], quizzes: Placed[]): ModuleItem[] {
  const rank = { lesson: 0, assignment: 1, quiz: 2 }
  const out: ModuleItem[] = [
    ...u.lessons.map((l) => ({ type: 'lesson' as const, id: l.id, seq: l.sequence ?? 0, lesson: l })),
    ...assignments.filter((a) => a.lms_unit_id === u.id).map((a) => ({ type: 'assignment' as const, id: a.id, seq: a.lms_sequence ?? 9999, title: a.title })),
    ...quizzes.filter((q) => q.lms_unit_id === u.id).map((q) => ({ type: 'quiz' as const, id: q.id, seq: q.lms_sequence ?? 9999, title: q.title })),
  ]
  return out.sort((a, b) => a.seq - b.seq || rank[a.type] - rank[b.type])
}
export const itemKind = (i: ModuleItem): ItemType => (i.type === 'lesson' ? i.lesson.kind : i.type)

/** "3 videos · 2 PDFs · 1 quiz": the module's sources counted by type, as small icon chips. */
export function TypeCounts({ items }: { items: ModuleItem[] }) {
  const n = new Map<string, number>()
  for (const i of items) n.set(itemKind(i), (n.get(itemKind(i)) ?? 0) + 1)
  if (!n.size) return null
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
      {[...n.entries()].map(([k, c]) => (
        <span key={k} className="inline-flex items-center gap-1" title={`${c} ${KIND_LABEL[k]}`}>
          <KindIcon kind={k} className="h-3.5 w-3.5" /> {c} <span className="sr-only">{KIND_LABEL[k]}</span>
        </span>
      ))}
    </span>
  )
}

/** "1–7 Oct", "from 1 Oct", "Day 3". */
export function dateRange(a?: string | null, b?: string | null): string {
  const f = (d: string, y = false) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' } : {}) })
  if (a && b) return a === b ? f(a) : a.slice(0, 7) === b.slice(0, 7) ? `${Number(a.slice(8))}–${f(b)}` : `${f(a)} – ${f(b)}`
  if (a) return `From ${f(a)}`
  if (b) return `Until ${f(b)}`
  return ''
}

export function ProgressRing({ pct, size = 44, label }: { pct: number; size?: number; label?: string }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct))
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} role="img" aria-label={label ?? `${p}% done`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={4} className="stroke-muted" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={4} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (c * p) / 100}
          className={p >= 100 ? 'stroke-success' : 'stroke-primary'} />
      </svg>
      <span className="absolute text-[11px] font-semibold tabular-nums">{p}%</span>
    </span>
  )
}

/* ─── Notes: a small, safe rich text ──────────────────────────────────
   Teachers write with a toolbar that inserts a few marks: **bold**,
   *italic*, "# " a heading, "- " a list item, "1. " a numbered item and
   [text](https://link). Drawn as React elements, never as HTML, so nothing
   typed can run. Plain text (every older lesson) reads as paragraphs. */

function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g
  let last = 0, m: RegExpExecArray | null, i = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(<strong key={`${key}b${i++}`}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('[')) {
      const mm = t.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)!
      out.push(<a key={`${key}a${i++}`} href={mm[2]} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{mm[1]}</a>)
    } else out.push(<em key={`${key}i${i++}`}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

export function NotesView({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = [], list: { ordered: boolean; items: string[] } | null = null
  const flushPara = () => {
    if (!para.length) return
    const k = `p${blocks.length}`
    blocks.push(<p key={k}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l, `${k}-${i}`)}</Fragment>)}</p>)
    para = []
  }
  const flushList = () => {
    if (!list) return
    const k = `l${blocks.length}`, L = list.ordered ? 'ol' : 'ul'
    blocks.push(<L key={k} className={`space-y-1 pl-5 ${list.ordered ? 'list-decimal' : 'list-disc'}`}>{list.items.map((x, i) => <li key={i}>{inline(x, `${k}-${i}`)}</li>)}</L>)
    list = null
  }
  const flush = () => { flushPara(); flushList() }
  for (const raw of lines) {
    const l = raw.trimEnd()
    const h = l.match(/^(#{1,3})\s+(.*)$/), ul = l.match(/^\s*[-*•]\s+(.*)$/), ol = l.match(/^\s*\d+[.)]\s+(.*)$/)
    if (!l.trim()) { flush(); continue }
    if (h) { flush(); const k = `h${blocks.length}`; blocks.push(h[1].length === 1 ? <h3 key={k} className="text-[17px] font-semibold">{inline(h[2], k)}</h3> : <h4 key={k} className="text-[15px] font-semibold">{inline(h[2], k)}</h4>); continue }
    if (ul || ol) {
      flushPara()
      const ordered = !!ol
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push((ul ?? ol)![1])
      continue
    }
    flushList()
    para.push(l)
  }
  flush()
  return <div className="space-y-3 text-[15px] leading-relaxed [overflow-wrap:anywhere]">{blocks}</div>
}

/** A text box with a small toolbar that writes the marks NotesView reads. */
export function NotesEditor({ value, onChange, rows = 10 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [preview, setPreview] = useState(false)
  const wrap = (before: string, after = before, placeholder = 'text') => {
    const el = ref.current
    if (!el) return
    const a = el.selectionStart, b = el.selectionEnd, sel = value.slice(a, b) || placeholder
    const next = value.slice(0, a) + before + sel + after + value.slice(b)
    onChange(next)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + before.length, a + before.length + sel.length) })
  }
  const line = (prefix: string) => {
    const el = ref.current
    if (!el) return
    const a = el.selectionStart, start = value.lastIndexOf('\n', a - 1) + 1
    onChange(value.slice(0, start) + prefix + value.slice(start))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + prefix.length, a + prefix.length) })
  }
  const tools: [string, string, () => void][] = [
    ['B', 'Bold', () => wrap('**')], ['I', 'Italic', () => wrap('*')], ['H', 'Heading', () => line('# ')],
    ['•', 'Bulleted list', () => line('- ')], ['1.', 'Numbered list', () => line('1. ')], ['Link', 'Link', () => wrap('[', '](https://)', 'link text')],
  ]
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-1.5 py-1" role="toolbar" aria-label="Formatting">
        {tools.map(([t, name, f]) => (
          <button key={name} type="button" title={name} aria-label={name} disabled={preview} onClick={f}
            className={`min-h-10 min-w-10 rounded px-2 text-[14px] hover:bg-muted disabled:opacity-40 ${t === 'B' ? 'font-bold' : t === 'I' ? 'italic' : ''}`}>{t}</button>
        ))}
        <button type="button" className="ml-auto min-h-10 rounded px-2.5 text-[13px] hover:bg-muted" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
      </div>
      {preview ? <div className="min-h-[10rem] p-3">{value.trim() ? <NotesView text={value} /> : <p className="text-muted-foreground">Nothing written yet.</p>}</div> : (
        <textarea ref={ref} value={value} rows={rows} onChange={(e) => onChange(e.target.value)} aria-label="Notes"
          className="block w-full resize-y border-0 bg-transparent p-3 text-[14px] leading-relaxed outline-none [@media(pointer:coarse)]:text-[16px]"
          placeholder="Write the notes. Select words and press B to make them bold." />
      )}
    </div>
  )
}

/* ─── The viewer for one source ────────────────────────────────────── */

const fileUrl = (id: string, inline = false) => `/api/v1/files/${id}${inline ? '?inline=1' : ''}`
const isPdf = (l: Lesson) => (l.file_type ?? '').includes('pdf') || /\.pdf($|\?)/i.test(l.file_name ?? l.url ?? '')

function DownloadCard({ l, label = 'Download' }: { l: Lesson; label?: string }) {
  const href = l.file_id ? fileUrl(l.file_id) : l.url ?? '#'
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
      <KindChip kind={l.kind} />
      <div className="min-w-0 flex-1">
        <p className="break-all text-[14px] font-medium">{l.file_name || host(l.url) || l.title}</p>
        <p className="text-[13px] text-muted-foreground">{[fmtSize(l.file_size), KIND_LABEL[l.kind]].filter(Boolean).join(' · ')}</p>
      </div>
      <a href={href} target="_blank" rel="noreferrer" className="btn inline-flex h-10 items-center gap-1.5 rounded-sm border px-3 text-[14px]" data-variant="primary">
        {l.file_id ? <Download className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />} {l.file_id ? label : 'Open'}
      </a>
    </div>
  )
}

/** The body of a source: the player, the inline PDF, the reader, the picture, or a download.
    `track` saves the child's place in a library video (their own login only). */
export function LessonContent({ l, track, onFinished }: { l: Lesson; track?: boolean; onFinished?: () => void }) {
  const embed = l.kind === 'video' && l.url ? embedOf(l.url) : null
  const note = l.kind !== 'text' && l.body ? <NotesView text={l.body} /> : null
  return (
    <div className="space-y-4 text-[14px]">
      {l.kind === 'text' && (l.body ? <NotesView text={l.body} /> : <p className="text-muted-foreground">These notes are empty.</p>)}
      {l.kind === 'video' && l.video_id && <VideoPlayer lesson={l} track={track} onFinished={onFinished} />}
      {l.kind === 'video' && !l.video_id && !l.url && <p className="text-muted-foreground">The video for this source has been removed from the library.</p>}
      {embed && (
        <div className="aspect-video w-full max-w-3xl overflow-hidden rounded-lg border bg-black">
          <iframe src={embed} title={l.title} className="h-full w-full" allowFullScreen allow="encrypted-media; picture-in-picture; fullscreen" />
        </div>
      )}
      {l.kind === 'video' && l.url && !embed && (/\.(mp4|webm|m4v)($|\?)/i.test(l.url)
        ? <video src={l.url} controls playsInline preload="metadata" className="aspect-video w-full max-w-3xl rounded-lg border bg-black" />
        : <DownloadCard l={l} />)}
      {(l.kind === 'pdf' || (l.kind === 'doc' && isPdf(l))) && (l.file_id || l.url) && (
        <>
          <iframe src={l.file_id ? fileUrl(l.file_id, true) : l.url!} title={l.title} className="h-[70vh] min-h-[420px] w-full max-w-4xl rounded-lg border bg-white" />
          <a href={l.file_id ? fileUrl(l.file_id, true) : l.url!} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 text-primary underline-offset-2 hover:underline">
            <ExternalLink className="h-4 w-4" /> Open the PDF full screen
          </a>
        </>
      )}
      {l.kind === 'image' && (l.file_id || l.url) && (
        <a href={l.file_id ? fileUrl(l.file_id, true) : l.url!} target="_blank" rel="noreferrer" className="block w-fit max-w-full">
          <img src={l.file_id ? fileUrl(l.file_id, true) : l.url!} alt={l.title} className="max-h-[75vh] max-w-full rounded-lg border bg-white object-contain" loading="lazy" />
        </a>
      )}
      {l.kind === 'audio' && (l.file_id || l.url) && (
        <audio src={l.file_id ? fileUrl(l.file_id, true) : l.url!} controls preload="metadata" className="w-full max-w-xl" />
      )}
      {((l.kind === 'doc' && !isPdf(l)) || l.kind === 'file') && (l.file_id || l.url) && <DownloadCard l={l} />}
      {l.kind === 'link' && l.url && (
        <a href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3 hover:border-primary">
          <KindChip kind="link" />
          <span className="min-w-0 flex-1"><span className="block font-medium">{l.title}</span><span className="block break-all text-[13px] text-muted-foreground">{l.url}</span></span>
          <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
        </a>
      )}
      {(l.kind === 'pdf' || l.kind === 'image' || l.kind === 'audio') && l.file_id && (
        <a href={fileUrl(l.file_id)} className="inline-flex min-h-10 items-center gap-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          <Download className="h-4 w-4" /> Download {l.file_name ?? 'the file'}{l.file_size ? ` (${fmtSize(l.file_size)})` : ''}
        </a>
      )}
      {note && <div className="rounded-lg border bg-muted/20 p-3">{note}</div>}
    </div>
  )
}

export const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
