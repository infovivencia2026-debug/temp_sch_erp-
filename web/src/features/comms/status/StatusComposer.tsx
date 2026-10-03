import { useEffect, useMemo, useRef, useState } from 'react'
import { useAutoGrow } from '@/lib/auto-grow'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Image as ImageIcon, Type, Video } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Dialog, FormNotice, Select } from '@/components/ui'
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
export function AddChooser({ onPick, onText, onClose, allowVideo = true, raised = false, asSchool = false, openPicker }: {
  onPick: (f: File) => void; onText: () => void; onClose: () => void; allowVideo?: boolean; raised?: boolean; asSchool?: boolean
  /* PICKERS THAT OUTLIVE THE POP-UP. On a phone the gallery opening could
     close this dialog, unmounting the file input inside it, so the chosen
     photo arrived nowhere and the person was left on the home screen. When
     the page supplies its own always-mounted inputs, the tiles click those. */
  openPicker?: (kind: 'photo' | 'video' | 'camera') => void
}) {
  /* The owner's design: tall rounded tiles, a soft round mark, bold label. */
  const tile = 'flex min-h-[132px] flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-card p-4 text-[15px] font-semibold text-foreground transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring'
  const icon = 'grid size-14 place-items-center rounded-full bg-primary/10 text-primary'
  return (
    <Dialog onClose={onClose} title={asSchool ? 'Post as the school' : 'Add a status'} size="sm" raised={raised}>
      <div className="grid grid-cols-2 gap-4" role="list">
        {openPicker ? (
          <>
            <button type="button" onClick={() => openPicker('photo')} className={tile}><span className={icon}><ImageIcon className="size-6" strokeWidth={1.8} /></span>Photo</button>
            {allowVideo && <button type="button" onClick={() => openPicker('video')} className={tile}><span className={icon}><Video className="size-6" strokeWidth={1.8} /></span>Video</button>}
            <button type="button" onClick={() => openPicker('camera')} className={tile}><span className={icon}><Camera className="size-6" strokeWidth={1.8} /></span>Camera</button>
          </>
        ) : (<>
        <StatusFileInput onPick={onPick} accept="image/*" capture={false} label="Photo" className={tile}>
          <span className={icon}><ImageIcon className="size-6" strokeWidth={1.8} /></span>Photo
        </StatusFileInput>
        {allowVideo && (
          <StatusFileInput onPick={onPick} accept="video/*" capture={false} label="Video" className={tile}>
            <span className={icon}><Video className="size-6" strokeWidth={1.8} /></span>Video
          </StatusFileInput>
        )}
        <StatusFileInput onPick={onPick} accept={allowVideo ? 'image/*,video/*' : 'image/*'} label="Camera" className={tile}>
          <span className={icon}><Camera className="size-6" strokeWidth={1.8} /></span>Camera
        </StatusFileInput>
        </>)}
        <button type="button" onClick={onText} className={tile}>
          <span className={icon}><Type className="size-6" strokeWidth={1.8} /></span>Text
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
  // The status text grows with its lines, from five to twelve, then scrolls (lib/auto-grow).
  const captionBox = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(captionBox, { minRows: 5, maxRows: 12 }, caption)
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

  /* PIN IT AS YOU POST IT.

     A status disappears after 24 hours unless it is pinned to the class
     gallery, and pinning was only reachable afterwards, from the viewer --
     so the sports day photograph everybody wanted kept had to be posted,
     found again and pinned, and mostly was not. The decision is made while
     choosing the picture, so it is asked while choosing the picture.

     It is a second request after the post, because the create endpoint takes
     no pin and inventing a field it ignores would be a switch that does
     nothing. A pin that fails leaves the status posted and says so rather
     than failing the post itself. */
  const [pin, setPin] = useState(false)

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
    onSuccess: async (r) => {
      if (pin && r.id) {
        await api.post(`/api/v1/status/posts/${r.id}/pin`, { pinned: true }).catch(() => {
          setProblem('Posted, but it could not be pinned. Pin it from the status itself.')
        })
      }
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
          {/* Why it did not post, beside the button where it is seen, not
              at the foot of a form that has scrolled away. */}
          {(problem || send.error) && (
            <span className="mr-auto max-w-[60%] text-[12.5px] font-medium text-destructive">
              {problem || (send.error as Error).message}
            </span>
          )}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button pending={send.isPending} disabled={text ? !caption.trim() : !file} onClick={() => { const why = check(); setProblem(why); if (!why) send.mutate() }}>Post</Button>
        </>
      )}
    >
      {done ? <FormNotice ok={done} /> : (
        <div className="grid gap-4">
          {text ? (
            <div className="grid place-items-center overflow-hidden rounded-md bg-primary p-5 text-primary-foreground" style={{ aspectRatio: '9 / 16', maxHeight: '46vh' }}>
              <textarea
                ref={captionBox}
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
              <video src={preview} className="size-full object-contain" controls playsInline />
            ) : (
              <img src={preview} alt="" className="size-full object-contain" />
            )}
          </div>
          </>)}

          {/* THE CAPTION SITS ON THE PICTURE'S OWN CARD, not in a labelled
              form field. A caption is part of the thing being posted, and a
              label reading "Caption · Optional · Shown along the bottom" is
              three facts about a box that holds one sentence. */}
          {!text && (
            <div className="rounded-2xl border bg-surface-sunken/50 px-3.5 py-2.5">
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value.slice(0, 700))}
                rows={2}
                aria-label="Caption"
                placeholder="Add a caption…"
                className="w-full resize-none bg-transparent text-[14px] leading-snug outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}

          {/* THE SETTINGS, AS ONE INSET GROUP.

              Two decisions -- who sees it, and whether it outlives the day --
              drawn as rows in a single rounded panel with a hairline between
              them, the way a phone draws a short form. They were a labelled
              Select and nothing at all: pinning could only be done afterwards,
              from the viewer, which is why so little is ever pinned. */}
          <div className="divide-y overflow-hidden rounded-2xl border">
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <span className="shrink-0 text-[14px]">Who is it for</span>
              <span className="min-w-0 max-w-[58%] flex-1">
              <Select
                value={choice}
                onChange={setChoice}
                options={options}
                placeholder={aud.isLoading ? 'Loading…' : 'Choose'}
              />
              </span>
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-3">
              <span className="min-w-0">
                <span className="block text-[14px]">Keep in the class gallery</span>
                <span className="block text-[12px] text-muted-foreground">
                  Pinned, so it does not disappear tomorrow
                </span>
              </span>
              <input
                type="checkbox"
                checked={pin}
                onChange={(e) => setPin(e.target.checked)}
                className="size-[22px] shrink-0 accent-[var(--primary,theme(colors.primary.DEFAULT))]"
              />
            </label>
          </div>

          <p className="text-center text-[12px] text-muted-foreground">
            {pin
              ? 'Kept in the class gallery until somebody removes it.'
              : 'Seen for 24 hours, then it goes.'}
          </p>

          {aud.data?.needs_approval && <p className="text-[13px] text-muted-foreground">The principal approves statuses at this school before anyone sees them.</p>}
          <FormNotice error={problem || send.error || aud.error} />
        </div>
      )}
    </Dialog>
  )
}
