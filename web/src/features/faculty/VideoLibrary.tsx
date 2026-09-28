import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Film, Pencil, Trash2, Upload } from 'lucide-react'
import { actingInstitution, api } from '@/lib/api'
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Input, Loading, PageBody, PageHead, Select, Textarea,
} from '@/components/ui'
import { VideoPlayer, fmtDur } from '../learning/VideoPlayer'
import type { Unit } from '../learning/lms-shared'

/* THE LMS VIDEO LIBRARY (worker routes/teaching/videos.ts).

   A teacher uploads their own videos; the LMS Admin sees every one. The file
   goes up in parts (R2 multipart through the Worker, whose request bodies are
   capped near 100 MB): each part is retried on failure, and picking the same
   file again after a reload sends only the parts still missing. A frame is
   captured in the browser as the thumbnail. Nothing is transcoded, so the
   screen says plainly what plays where. */

export interface Video {
  id: string; title: string; description?: string | null; duration_seconds?: number | null; size_bytes: number; content_type: string
  original_name?: string | null; status: 'uploading' | 'ready' | 'failed'; subject_id?: string | null; subject?: string | null
  class_id?: string | null; class_name?: string | null; uploader?: string | null; uploaded_by?: string | null; created_at: string
  has_thumb: boolean; lessons: number; parts_received: number; part_size?: number | null
}
interface Library {
  admin: boolean; items: Video[]; subjects: { id: string; name: string }[]; classes: { id: string; name: string }[]
  usage: { max_file_bytes: number; max_total_bytes: number; used_bytes: number; videos: number; part_size: number }
}

const ACCEPT = '.mp4,.m4v,.webm,.mov,video/mp4,video/webm,video/quicktime'
export const fmtSize = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const fingerprint = (f: File) => `lms-video-upload:${f.name}:${f.size}:${f.lastModified}`
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k) } catch { /* private mode */ } },
}

/* ─── What the browser can learn about the file before sending it ──────── */

interface Probe { duration: number | null; thumb: Blob | null; hevc: boolean; playable: boolean }

/** Duration and a poster frame from a <video> and a <canvas>; HEVC by looking for its sample entry. */
async function probe(f: File): Promise<Probe> {
  const hevc = await looksHevc(f)
  const url = URL.createObjectURL(f)
  try {
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url
    const meta = await new Promise<boolean>((res) => {
      const t = window.setTimeout(() => res(false), 15_000)
      v.onloadedmetadata = () => { window.clearTimeout(t); res(true) }
      v.onerror = () => { window.clearTimeout(t); res(false) }
    })
    if (!meta) return { duration: null, thumb: null, hevc, playable: false }
    const duration = Number.isFinite(v.duration) ? v.duration : null
    const at = duration ? Math.min(2, duration * 0.1) : 0
    const seeked = await new Promise<boolean>((res) => {
      const t = window.setTimeout(() => res(false), 10_000)
      v.onseeked = () => { window.clearTimeout(t); res(true) }
      v.currentTime = at || 0.01
    })
    let thumb: Blob | null = null
    if (seeked && v.videoWidth) {
      const w = Math.min(640, v.videoWidth), h = Math.round((v.videoHeight / v.videoWidth) * w)
      const cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      cv.getContext('2d')?.drawImage(v, 0, 0, w, h)
      thumb = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', 0.8))
    }
    return { duration, thumb, hevc, playable: v.videoWidth > 0 }
  } finally { URL.revokeObjectURL(url) }
}

async function looksHevc(f: File): Promise<boolean> {
  const slices = [f.slice(0, 4 << 20), f.slice(Math.max(0, f.size - (4 << 20)))]
  for (const s of slices) {
    const b = new Uint8Array(await s.arrayBuffer())
    for (let i = 0; i + 4 <= b.length; i++) {
      if (b[i] === 0x68 && ((b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x31) || (b[i + 1] === 0x65 && b[i + 2] === 0x76 && b[i + 3] === 0x31))) return true
    }
  }
  return false
}

/* ─── The upload ───────────────────────────────────────────────────────── */

function putPart(id: string, n: number, blob: Blob, onBytes: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', `/api/v1/lms/videos/${id}/parts/${n}`)
    x.withCredentials = true
    x.setRequestHeader('Content-Type', 'application/octet-stream')
    const acting = actingInstitution()
    if (acting) x.setRequestHeader('X-Acting-Institution', acting)
    x.upload.onprogress = (e) => onBytes(e.loaded)
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve()
      let msg = `part ${n} failed (${x.status})`
      try { msg = JSON.parse(x.responseText).error ?? msg } catch { /* not JSON */ }
      const err = new Error(msg) as Error & { status?: number }
      err.status = x.status
      reject(err)
    }
    x.onerror = () => reject(new Error(`part ${n}: the connection dropped`))
    x.send(blob)
  })
}

interface Job {
  file: File; id?: string; phase: 'checking' | 'uploading' | 'finishing' | 'done' | 'paused' | 'failed'
  sent: number; error?: string; probe?: Probe; resumedParts?: number
}

async function runUpload(job: Job, meta: { title: string; description: string; subject_id: string; class_id: string }, set: (j: Job) => void) {
  const f = job.file
  const upd = (p: Partial<Job>) => { Object.assign(job, p); set({ ...job }) }
  if (!job.probe) upd({ probe: await probe(f) })
  const key = fingerprint(f)
  let partSize = 0, have = new Set<number>()
  /* The same file picked again resumes the upload it started. */
  const prior = job.id ?? store.get(key)
  if (prior) {
    try {
      const v = await api.get<{ status: string; part_size: number; parts_received: number[]; size_bytes: number }>(`/api/v1/lms/videos/${prior}`)
      if (v.status === 'uploading' && v.size_bytes === f.size) { job.id = prior; partSize = v.part_size; have = new Set(v.parts_received) }
      else if (v.status === 'ready') { store.del(key); return upd({ id: prior, phase: 'done', sent: f.size }) }
    } catch { /* gone; start again */ }
  }
  if (!job.id) {
    const s = await api.post<{ id: string; part_size: number }>('/api/v1/lms/videos/uploads', {
      filename: f.name, size_bytes: f.size, title: meta.title || f.name.replace(/\.[^.]+$/, ''), description: meta.description,
      subject_id: meta.subject_id || null, class_id: meta.class_id || null, duration_seconds: job.probe?.duration ?? null,
    })
    job.id = s.id; partSize = s.part_size
    store.set(key, s.id)
    if (job.probe?.thumb) {
      await fetch(`/api/v1/lms/videos/${s.id}/thumbnail`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: job.probe.thumb }).catch(() => {})
    }
  }
  const id = job.id!
  const total = Math.ceil(f.size / partSize)
  const inFlight = new Map<number, number>()
  const doneBytes = () => [...have].reduce((a, n) => a + Math.min(partSize, f.size - (n - 1) * partSize), 0)
  const report = () => upd({ phase: 'uploading', sent: doneBytes() + [...inFlight.values()].reduce((a, b) => a + b, 0), resumedParts: job.resumedParts ?? have.size })
  report()
  const queue = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !have.has(n))
  const worker = async () => {
    for (;;) {
      const n = queue.shift()
      if (!n) return
      const blob = f.slice((n - 1) * partSize, Math.min(f.size, n * partSize))
      for (let attempt = 1; ; attempt++) {
        try {
          await putPart(id, n, blob, (b) => { inFlight.set(n, b); report() })
          inFlight.delete(n); have.add(n); report()
          break
        } catch (e) {
          inFlight.delete(n)
          const status = (e as { status?: number }).status ?? 0
          if (attempt >= 4 || (status >= 400 && status < 500)) throw e
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        }
      }
    }
  }
  try {
    await Promise.all([worker(), worker(), worker()])
  } catch (e) {
    return upd({ phase: 'paused', error: e instanceof Error ? e.message : 'upload stopped' })
  }
  upd({ phase: 'finishing', sent: f.size })
  await api.post(`/api/v1/lms/videos/${id}/complete`, { duration_seconds: job.probe?.duration ?? null })
  store.del(key)
  upd({ phase: 'done' })
}

function Uploader({ lib, onChange, onUploaded }: { lib: Library; onChange: () => void; onUploaded?: (id: string, title: string) => void }) {
  const [job, setJob] = useState<Job | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [subject, setSubject] = useState('')
  const [klass, setKlass] = useState('')
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const busy = job && ['checking', 'uploading', 'finishing'].includes(job.phase)

  const start = async (j: Job) => {
    setErr('')
    try {
      await runUpload(j, { title, description, subject_id: subject, class_id: klass }, setJob)
      if (j.phase === 'done' && j.id) onUploaded?.(j.id, title || j.file.name.replace(/\.[^.]+$/, ''))
    } catch (e) { setJob({ ...j, phase: 'failed', error: e instanceof Error ? e.message : 'upload failed' }) }
    onChange()
  }
  const pick = async (f: File | undefined) => {
    if (!f) return
    const ext = f.name.toLowerCase().split('.').pop() ?? ''
    if (!['mp4', 'm4v', 'webm', 'mov'].includes(ext)) { setErr('Choose an mp4, webm or mov video.'); return }
    if (f.size > lib.usage.max_file_bytes) { setErr(`This file is ${fmtSize(f.size)}; the school's limit is ${fmtSize(lib.usage.max_file_bytes)} per video.`); return }
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''))
    const j: Job = { file: f, phase: 'checking', sent: 0 }
    setJob(j)
    await start(j)
  }
  const pct = job ? Math.round((100 * job.sent) / job.file.size) : 0
  const p = job?.probe
  return (
    <Card>
      <CardHeader title="Upload a video" />
      <div className="space-y-3 px-[var(--card-pad)] pb-4">
        <p className="text-[13px] text-muted-foreground">
          mp4 (H.264) plays everywhere: iPhone, Android and every desktop browser. webm and mov are accepted, but videos are not converted,
          so a .mov or an HEVC (H.265) video may not play on some Android phones and browsers. Up to {fmtSize(lib.usage.max_file_bytes)} per video.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title"><Input value={title} onChange={setTitle} placeholder="Taken from the file name if empty" /></Field>
          <Field label="Subject (optional)"><Select value={subject} onChange={setSubject} placeholder="Any subject" options={[{ value: '', label: 'Any subject' }, ...lib.subjects.map((s) => ({ value: s.id, label: s.name }))]} /></Field>
          <Field label="Class (optional)"><Select value={klass} onChange={setKlass} placeholder="Any class" options={[{ value: '', label: 'Any class' }, ...lib.classes.map((s) => ({ value: s.id, label: s.name }))]} /></Field>
          <Field label="Description (optional)"><Input value={description} onChange={setDescription} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="btn inline-flex h-11 w-full cursor-pointer items-center justify-center gap-1.5 rounded-sm border px-4 text-[15px] sm:h-9 sm:w-auto sm:text-[14px]" data-variant="primary" aria-disabled={!!busy}>
            <Upload className="h-4 w-4" /> {busy ? 'Uploading…' : 'Choose a video'}
            <input ref={fileRef} type="file" accept={ACCEPT} className="sr-only" disabled={!!busy} data-testid="video-file"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pick(f) }} />
          </label>
          <span className="text-[13px] text-muted-foreground">To resume an upload that stopped, choose the same file again.</span>
        </div>
        {err && <p className="text-[13px] text-destructive">{err}</p>}
        {job && (
          <div className="space-y-2 rounded-md border p-3" data-testid="upload-job">
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <Film className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 break-all font-medium">{job.file.name}</span>
              <span className="text-muted-foreground">{fmtSize(job.file.size)}{p?.duration ? ` · ${fmtDur(p.duration)}` : ''}</span>
              <span className="ml-auto whitespace-nowrap">
                {job.phase === 'checking' ? 'Reading the video…' : job.phase === 'uploading' ? `${pct}% · ${fmtSize(job.sent)} of ${fmtSize(job.file.size)}`
                  : job.phase === 'finishing' ? 'Finishing…' : job.phase === 'done' ? <Badge tone="success">Uploaded</Badge> : <Badge tone="danger">Stopped</Badge>}
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={`h-full transition-[width] ${job.phase === 'paused' || job.phase === 'failed' ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
            </div>
            {!!job.resumedParts && job.phase !== 'done' && <p className="text-[13px] text-muted-foreground">Resumed: {job.resumedParts} part{job.resumedParts === 1 ? ' was' : 's were'} already on the server.</p>}
            {p && (p.hevc || /\.mov$/i.test(job.file.name) || !p.playable) && (
              <p className="text-[13px] text-warning">
                {p.hevc ? 'This video is HEVC (H.265). ' : !p.playable ? 'This browser could not open the video, so it has no thumbnail. ' : 'This is a .mov file. '}
                It may not play on some Android phones and browsers. For a video everyone can watch, export it as mp4 (H.264) and upload that instead.
              </p>
            )}
            {(job.phase === 'paused' || job.phase === 'failed') && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-destructive">{job.error}</span>
                {job.phase === 'paused' && <Button onClick={() => { setJob({ ...job, phase: 'uploading', error: undefined }); void start(job) }}>Retry</Button>}
                {job.id && <Button variant="secondary" onClick={async () => { await api.post(`/api/v1/lms/videos/${job.id}/abort`, {}).catch(() => {}); store.del(fingerprint(job.file)); setJob(null); onChange() }}>Cancel upload</Button>}
              </div>
            )}
            {job.phase === 'done' && <Button variant="secondary" onClick={() => { setJob(null); setTitle(''); setDescription('') }}>Upload another</Button>}
          </div>
        )}
      </div>
    </Card>
  )
}

/* ─── The library ──────────────────────────────────────────────────────── */

export default function VideoLibrary({ back }: { back?: () => void }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [subject, setSubject] = useState('')
  const [klass, setKlass] = useState('')
  const [status, setStatus] = useState('')
  const [mine, setMine] = useState(false)
  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (subject) params.set('subject_id', subject)
  if (klass) params.set('class_id', klass)
  if (status) params.set('status', status)
  if (mine) params.set('mine', '1')
  const key = ['lms-videos', params.toString()]
  const lq = useQuery({ queryKey: key, queryFn: () => api.get<Library>(`/api/v1/lms/videos?${params}`) })
  const refresh = () => qc.invalidateQueries({ queryKey: ['lms-videos'] })
  const [playing, setPlaying] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [using, setUsing] = useState<Video | null>(null)
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/v1/lms/videos/${id}`), onSuccess: refresh })
  const d = lq.data
  return (
    <>
      <PageHead eyebrow="LMS" title="Video library" actions={back && <Button variant="secondary" onClick={back}><ChevronLeft className="h-4 w-4" /> Courses</Button>} />
      <PageBody>
        {lq.error ? <ErrorState error={lq.error} /> : !d ? <Loading /> : (
          <div className="space-y-4">
            {d.admin && <Usage u={d.usage} onSaved={refresh} />}
            <Uploader lib={d} onChange={refresh} />
            {using && <UseInLesson v={using} done={() => { setUsing(null); refresh() }} />}
            <Card>
              <CardHeader title={d.admin && !mine ? `Every video in the school (${d.items.length})` : `My videos (${d.items.length})`} />
              <div className="flex flex-wrap items-end gap-3 px-[var(--card-pad)] pb-3">
                <div className="w-full sm:w-64"><Field label="Search"><Input value={q} onChange={setQ} placeholder="Title or description" /></Field></div>
                <div className="w-full sm:w-48"><Field label="Subject"><Select value={subject} onChange={setSubject} options={[{ value: '', label: 'Any subject' }, ...d.subjects.map((s) => ({ value: s.id, label: s.name }))]} /></Field></div>
                <div className="w-full sm:w-40"><Field label="Class"><Select value={klass} onChange={setKlass} options={[{ value: '', label: 'Any class' }, ...d.classes.map((s) => ({ value: s.id, label: s.name }))]} /></Field></div>
                <div className="w-full sm:w-40"><Field label="Status"><Select value={status} onChange={setStatus} options={[{ value: '', label: 'Any' }, { value: 'ready', label: 'Ready' }, { value: 'uploading', label: 'Uploading' }, { value: 'failed', label: 'Failed' }]} /></Field></div>
                {d.admin && <label className="flex h-9 items-center gap-2 text-[14px]"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine</label>}
              </div>
              {!d.items.length ? <EmptyState title="No videos yet" body="Upload a video above; it can then be used in any of your lessons." /> : (
                <ul className="divide-y border-t">
                  {d.items.map((v) => (
                    <li key={v.id} className="px-[var(--card-pad)] py-3" data-testid="video-row">
                      <div className="flex flex-wrap items-start gap-3">
                        <button type="button" className="relative h-[72px] w-32 shrink-0 overflow-hidden rounded-md border bg-muted" disabled={v.status !== 'ready'} onClick={() => setPlaying(playing === v.id ? null : v.id)} title="Play">
                          {v.has_thumb ? <img src={`/api/v1/lms/videos/${v.id}/thumbnail`} alt="" className="h-full w-full object-cover" /> : <Film className="m-auto h-6 w-6 text-muted-foreground" />}
                          {v.duration_seconds ? <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[11px] text-white">{fmtDur(v.duration_seconds)}</span> : null}
                        </button>
                        <div className="min-w-0 flex-1 space-y-1 text-[14px]">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{v.title}</span>
                            {v.status === 'ready' ? null : v.status === 'uploading' ? <Badge tone="warning">Uploading, {v.part_size ? Math.min(100, Math.round((100 * v.parts_received * v.part_size) / v.size_bytes)) : 0}%</Badge> : <Badge tone="danger">Failed</Badge>}
                            {/quicktime/.test(v.content_type) && <Badge tone="warning">mov: may not play on some Android browsers</Badge>}
                          </div>
                          <p className="text-[13px] text-muted-foreground">
                            {[v.subject, v.class_name, fmtSize(v.size_bytes), v.uploader && d.admin ? `by ${v.uploader}` : null, new Date(v.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
                              v.lessons ? `in ${v.lessons} lesson${v.lessons === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
                          </p>
                          {v.description && <p className="text-[13px]">{v.description}</p>}
                          {v.status === 'uploading' && <p className="text-[13px] text-muted-foreground">To finish, choose the same file again above; only the missing parts are sent.</p>}
                        </div>
                        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                          {v.status === 'ready' && <Button size="sm" onClick={() => { setUsing(v); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Use in lesson</Button>}
                          {v.status === 'ready' && <Button size="sm" variant="secondary" className="sm:hidden" onClick={() => setPlaying(playing === v.id ? null : v.id)}>{playing === v.id ? 'Close' : 'Play'}</Button>}
                          <Button size="sm" variant="ghost" title="Rename" onClick={() => setEditing(editing === v.id ? null : v.id)}><Pencil className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" title="Delete video" onClick={() => {
                            if (window.confirm(`Delete "${v.title}"?${v.lessons ? ` It is used in ${v.lessons} lesson${v.lessons === 1 ? '' : 's'}, which will lose it.` : ''} This cannot be undone.`)) del.mutate(v.id)
                          }}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </div>
                      {editing === v.id && <EditVideo v={v} lib={d} done={() => { setEditing(null); refresh() }} />}
                      {playing === v.id && <div className="mt-3"><VideoPlayer videoId={v.id} lesson={{ id: '', unit_id: '', title: v.title, kind: 'video', sequence: 0, video_id: v.id, video_thumb: v.has_thumb }} /></div>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="px-[var(--card-pad)] pb-3"><FormNotice error={del.error} /></div>
            </Card>
          </div>
        )}
      </PageBody>
    </>
  )
}

function Usage({ u, onSaved }: { u: Library['usage']; onSaved: () => void }) {
  const [edit, setEdit] = useState(false)
  const [file, setFile] = useState(String(Math.round(u.max_file_bytes / 1024 ** 2)))
  const [total, setTotal] = useState(String(Math.round(u.max_total_bytes / 1024 ** 3)))
  const save = useMutation({
    mutationFn: () => api.put('/api/v1/lms/videos/limits', { max_file_bytes: Number(file) * 1024 ** 2, max_total_bytes: Number(total) * 1024 ** 3 }),
    onSuccess: () => { setEdit(false); onSaved() },
  })
  const pct = Math.min(100, Math.round((100 * u.used_bytes) / u.max_total_bytes))
  return (
    <Card>
      <CardHeader title="School video storage" action={<Button size="sm" variant="secondary" onClick={() => setEdit(!edit)}>{edit ? 'Close' : 'Change limits'}</Button>} />
      <div className="space-y-2 px-[var(--card-pad)] pb-4 text-[14px]">
        <p>{fmtSize(u.used_bytes)} of {fmtSize(u.max_total_bytes)} used by {u.videos} video{u.videos === 1 ? '' : 's'} ({pct}%). Up to {fmtSize(u.max_file_bytes)} per video.</p>
        <div className="h-2 w-full max-w-xl overflow-hidden rounded-full bg-muted"><div className={`h-full ${pct > 90 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} /></div>
        {edit && (
          <div className="flex flex-wrap items-end gap-3 pt-2">
            <div className="w-full sm:w-40"><Field label="Per video (MB)"><Input type="number" value={file} onChange={setFile} /></Field></div>
            <div className="w-full sm:w-40"><Field label="School total (GB)"><Input type="number" value={total} onChange={setTotal} /></Field></div>
            <Button pending={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <FormNotice error={save.error} />
          </div>
        )}
      </div>
    </Card>
  )
}

function EditVideo({ v, lib, done }: { v: Video; lib: Library; done: () => void }) {
  const [title, setTitle] = useState(v.title)
  const [description, setDescription] = useState(v.description ?? '')
  const [subject, setSubject] = useState(v.subject_id ?? '')
  const [klass, setKlass] = useState(v.class_id ?? '')
  const save = useMutation({
    mutationFn: () => api.patch(`/api/v1/lms/videos/${v.id}`, { title, description, subject_id: subject || null, class_id: klass || null }),
    onSuccess: done,
  })
  return (
    <div className="mt-3 grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
      <Field label="Title"><Input value={title} onChange={setTitle} /></Field>
      <Field label="Subject"><Select value={subject} onChange={setSubject} options={[{ value: '', label: 'Any subject' }, ...lib.subjects.map((s) => ({ value: s.id, label: s.name }))]} /></Field>
      <Field label="Class"><Select value={klass} onChange={setKlass} options={[{ value: '', label: 'Any class' }, ...lib.classes.map((s) => ({ value: s.id, label: s.name }))]} /></Field>
      <Field label="Description"><Textarea rows={2} value={description} onChange={setDescription} /></Field>
      <div className="flex items-center gap-3"><Button disabled={!title.trim()} pending={save.isPending} onClick={() => save.mutate()}>Save</Button><FormNotice error={save.error} /></div>
    </div>
  )
}

interface CourseRow { section_id: string; section_name: string; class_name: string; class_subject_id: string; subject: string }

/** "Use in lesson": pick a course and a unit, name the lesson, and it is made. */
function UseInLesson({ v, done }: { v: Video; done: () => void }) {
  const qc = useQueryClient()
  const courses = useQuery({ queryKey: ['lms-courses'], queryFn: () => api.get<{ items: CourseRow[] }>('/api/v1/lms/courses') })
  const [course, setCourse] = useState('')
  const [unit, setUnit] = useState('')
  const [title, setTitle] = useState(v.title)
  const [day, setDay] = useState('')
  const c = courses.data?.items.find((x) => x.section_id + '|' + x.class_subject_id === course)
  const detail = useQuery({
    queryKey: ['lms-course', c?.section_id, c?.class_subject_id], enabled: !!c,
    queryFn: () => api.get<{ units: Unit[] }>(`/api/v1/lms/course?section_id=${c!.section_id}&class_subject_id=${c!.class_subject_id}`),
  })
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/lms/lessons', { unit_id: unit, title, kind: 'video', video_id: v.id, day: day ? Number(day) : null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lms-course'] }); qc.invalidateQueries({ queryKey: ['lms-courses'] }); done() },
  })
  return (
    <Card>
      <CardHeader title={`Use "${v.title}" in a lesson`} action={<Button size="sm" variant="secondary" onClick={done}>Close</Button>} />
      <div className="grid gap-3 px-[var(--card-pad)] pb-4 sm:grid-cols-2">
        <Field label="Course"><Select value={course} onChange={(x) => { setCourse(x); setUnit('') }} placeholder="Choose a course"
          options={(courses.data?.items ?? []).map((x) => ({ value: x.section_id + '|' + x.class_subject_id, label: `${x.subject} · ${x.class_name} ${x.section_name}` }))} /></Field>
        <Field label="Unit" hint={c && detail.data && !detail.data.units.length ? 'This course has no units yet: add one in the course first.' : undefined}>
          <Select value={unit} onChange={setUnit} placeholder="Choose a unit" options={(detail.data?.units ?? []).map((u) => ({ value: u.id, label: u.title }))} />
        </Field>
        <Field label="Lesson title"><Input value={title} onChange={setTitle} /></Field>
        <Field label="Day of the unit (optional)"><Input type="number" value={day} onChange={setDay} /></Field>
        <div className="flex items-center gap-3"><Button disabled={!unit || !title.trim()} pending={save.isPending} onClick={() => save.mutate()}>Add the lesson</Button><FormNotice error={save.error} /></div>
      </div>
    </Card>
  )
}

/** For a module's "Add source": upload a new video into the library, then hand its id back. */
export function VideoUpload({ onUploaded }: { onUploaded: (id: string, title: string) => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['lms-videos', 'status=ready'], queryFn: () => api.get<Library>('/api/v1/lms/videos?status=ready') })
  if (q.error) return <ErrorState error={q.error} />
  if (!q.data) return <Loading />
  return <Uploader lib={q.data} onChange={() => qc.invalidateQueries({ queryKey: ['lms-videos'] })} onUploaded={onUploaded} />
}

/** For the lesson form: pick a ready video from the library. */
export function VideoPick({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const q = useQuery({ queryKey: ['lms-videos', 'status=ready'], queryFn: () => api.get<Library>('/api/v1/lms/videos?status=ready') })
  if (q.isLoading) return <Loading />
  const items = q.data?.items ?? []
  if (!items.length) return <p className="text-[13px] text-muted-foreground">Your video library is empty. Upload a video in LMS → Video library first.</p>
  return <Select value={value} onChange={onChange} placeholder="Choose a video" options={items.map((v) => ({ value: v.id, label: `${v.title}${v.duration_seconds ? ` (${fmtDur(v.duration_seconds)})` : ''}` }))} />
}
