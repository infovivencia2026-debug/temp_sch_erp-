import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Image as ImageIcon, Type, Video } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Dialog, Field, FormNotice, Select, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import { MAX_BYTES, makeThumb, postStatus, preparePhoto, videoSeconds, type AddMode, type Audiences, type TargetPick } from './status-api'

/* The composer: who it is for, the picture or clip, a caption, Post.

   Opened with a file already chosen (the Add ring is itself the file input,
   so the camera opens on the tap that asked for it -- a picker opened later
   from an effect is blocked on iPhone). "Change" picks again. A photo is
   shrunk on the phone before it goes; a video is checked against the
   school's length and the 25 MB cap before a byte is sent. */

export function StatusFileInput({ onPick, className, children, label, accept = 'image/*,video/*', capture = true }: {
  onPick: (f: File) => void; className?: string; children: React.ReactNode; label: string
  /** Narrowed by the Add chooser: 'image/*' for Photo, 'video/*' for Video. */
  accept?: string
  /** Straight to the camera (the Camera choice, and the old one-tap ring). */
  capture?: boolean
}) {
  return (
    <label className={cn('cursor-pointer', className)} aria-label={label}>
      {children}
      <input
        type="file"
        accept={accept}
        capture={capture ? 'environment' : undefined}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onPick(f)
        }}
      />
    </label>
  )
}

/* THE ADD CHOOSER: what kind of status. Photo and Video open the library
   filtered to that type, Camera opens the camera, Text writes words on the
   school's colour. Each media choice is itself the file input, so the picker
   opens on the tap that asked for it (iPhone blocks one opened later). */
export function AddChooser({ onPick, onText, onClose, allowVideo = true, raised = false, asSchool = false }: {
  onPick: (f: File) => void; onText: () => void; onClose: () => void; allowVideo?: boolean; raised?: boolean; asSchool?: boolean
}) {
  const tile = 'flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-xl border bg-card p-3 text-[13px] font-medium transition-colors hover:bg-muted focus-within:ring-2 focus-within:ring-ring'
  const icon = 'grid size-11 place-items-center rounded-full bg-primary/10 text-primary'
  return (
    <Dialog onClose={onClose} title={asSchool ? 'Post as the school' : 'Add a status'} size="sm" raised={raised}>
      <div className="grid grid-cols-2 gap-3" role="list">
        <StatusFileInput onPick={onPick} accept="image/*" capture={false} label="Photo" className={tile}>
          <span className={icon}><ImageIcon className="size-5" /></span>Photo
        </StatusFileInput>
        {allowVideo && (
          <StatusFileInput onPick={onPick} accept="video/*" capture={false} label="Video" className={tile}>
            <span className={icon}><Video className="size-5" /></span>Video
          </StatusFileInput>
        )}
        <StatusFileInput onPick={onPick} accept={allowVideo ? 'image/*,video/*' : 'image/*'} label="Camera" className={tile}>
          <span className={icon}><Camera className="size-5" /></span>Camera
        </StatusFileInput>
        <button type="button" onClick={onText} className={tile}>
          <span className={icon}><Type className="size-5" /></span>Text
        </button>
      </div>
    </Dialog>
  )
}

/* Who the status is for, as one value in the picker. */
type Choice = string // 'school' | 'staff' | 'class:<id>' | 'section:<id>'
const toTarget = (c: Choice): TargetPick => {
  const [kind, id] = c.split(':') as [TargetPick['kind'], string | undefined]
  return id ? { kind, id } : { kind }
}

export default function StatusComposer({ file: initial, asSchool = false, onClose, mode, raised = false }: {
  file: File | null; asSchool?: boolean; onClose: () => void
  /** 'text': words on the school's colour, no media. */
  mode?: AddMode
  raised?: boolean
}) {
  const text = mode === 'text'
  const qc = useQueryClient()
  const aud = useQuery({ queryKey: ['class-status-audiences'], queryFn: () => api.get<Audiences>('/api/v1/status/audiences') })
  const [file, setFile] = useState<File | null>(initial)
  const [preview, setPreview] = useState('')
  const [duration, setDuration] = useState(0)
  const [caption, setCaption] = useState('')
  const [choice, setChoice] = useState<Choice>('')
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    setProblem('')
    if (file.type.startsWith('video/')) void videoSeconds(file).then(setDuration)
    else setDuration(0)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const options = useMemo(() => {
    const a = aud.data
    if (!a) return []
    const out: { value: string; label: string }[] = []
    out.push({ value: 'school', label: 'Whole school' })
    if (asSchool) out.push({ value: 'staff', label: 'Staff only' })
    for (const c of a.classes) out.push({ value: `class:${c.id}`, label: `${c.name} (all sections)` })
    for (const s of a.sections) out.push({ value: `section:${s.id}`, label: s.name })
    return out
  }, [aud.data, asSchool])

  useEffect(() => {
    // A teacher of one section almost always means that section.
    if (!choice && aud.data?.sections.length) setChoice(`section:${aud.data.sections[0].id}`)
    else if (!choice && asSchool) setChoice('school')
  }, [aud.data, choice, asSchool])

  const isVideo = !!file?.type.startsWith('video/')
  const check = (): string => {
    if (text) {
      if (!caption.trim()) return 'Write something for the status.'
      if (!choice) return 'Choose who it is for.'
      return ''
    }
    if (!file) return 'Choose a photo or a video.'
    if (!file.type.startsWith('image/') && !isVideo) return 'A status is a photo or a video.'
    if (isVideo && aud.data && !aud.data.allow_video) return 'This school takes photos only.'
    if (isVideo && aud.data && duration > aud.data.max_video_seconds + 0.5) return `A video can be at most ${aud.data.max_video_seconds} seconds; this one is ${Math.round(duration)}.`
    if (isVideo && file.size > MAX_BYTES) return 'This video is over 25 MB. Record a shorter one.'
    if (!choice) return 'Choose who it is for.'
    return ''
  }

  const send = useMutation({
    mutationFn: async () => {
      const why = check()
      if (why) throw new Error(why)
      if (text) return postStatus({ text: true, caption: caption.trim(), targets: [toTarget(choice)], asSchool })
      const f = isVideo ? file! : await preparePhoto(file!)
      if (f.size > MAX_BYTES) throw new Error('This photo is over 25 MB.')
      // A cheap picture for the bell; the post goes without it if it cannot be drawn.
      const thumb = await makeThumb(f).catch(() => null)
      return postStatus({ file: f, thumb, caption: caption.trim(), targets: [toTarget(choice)], asSchool, duration: isVideo ? Math.max(0.1, duration) : undefined })
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['notifications'] })
      void qc.invalidateQueries({ queryKey: ['class-status-mine'] })
      void qc.invalidateQueries({ queryKey: ['class-status-admin'] })
      if (r.status === 'pending') setDone('Sent to the principal. It goes live once approved.')
      else onClose()
    },
  })

  return (
    <Dialog
      onClose={onClose}
      raised={raised}
      title={asSchool ? 'Post as the school' : text ? 'New text status' : 'New status'}
      description="Seen for 24 hours, unless you pin it to the class gallery."
      footer={done ? <Button onClick={onClose}>Done</Button> : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button pending={send.isPending} disabled={text ? !caption.trim() : !file} onClick={() => { setProblem(check()); send.mutate() }}>Post</Button>
        </>
      )}
    >
      {done ? <FormNotice ok={done} /> : (
        <div className="grid gap-4">
          {text ? (
            <div className="grid place-items-center overflow-hidden rounded-md bg-primary p-5 text-primary-foreground" style={{ aspectRatio: '9 / 16', maxHeight: '46vh' }}>
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value.slice(0, 700))}
                rows={5}
                aria-label="Status text"
                placeholder="Type a status"
                className="w-full resize-none bg-transparent text-center text-[22px] font-semibold leading-snug text-primary-foreground outline-none placeholder:text-primary-foreground/60"
              />
            </div>
          ) : (<>
          <div className="grid place-items-center overflow-hidden rounded-md bg-black" style={{ aspectRatio: '9 / 16', maxHeight: '46vh' }}>
            {!preview ? (
              <StatusFileInput onPick={setFile} label="Take or choose a photo or video" className="grid place-items-center gap-2 p-6 text-center text-white/80">
                <Camera className="size-8" />
                <span className="text-sm">Take or choose a photo or video</span>
              </StatusFileInput>
            ) : isVideo ? (
              <video src={preview} className="size-full object-contain" controls playsInline muted />
            ) : (
              <img src={preview} alt="" className="size-full object-contain" />
            )}
          </div>
          {preview && (
            <StatusFileInput onPick={setFile} label="Choose another" className="justify-self-start text-sm underline">
              Choose another
            </StatusFileInput>
          )}
          </>)}
          <Field label="Who is it for" required>
            <Select value={choice} onChange={setChoice} options={options} placeholder={aud.isLoading ? 'Loading…' : 'Choose'} />
          </Field>
          {!text && (
            <Field label="Caption" hint="Optional. Shown along the bottom.">
              <Textarea value={caption} onChange={setCaption} rows={2} placeholder="What is happening" />
            </Field>
          )}
          {aud.data?.needs_approval && <p className="text-[13px] text-muted-foreground">The principal approves statuses at this school before anyone sees them.</p>}
          <FormNotice error={problem || send.error || aud.error} />
        </div>
      )}
    </Dialog>
  )
}
