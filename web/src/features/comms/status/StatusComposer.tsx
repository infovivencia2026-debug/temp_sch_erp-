import { useEffect, useMemo, useRef, useState } from 'react'
import { useAutoGrow } from '@/lib/auto-grow'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Image as ImageIcon, Type, Upload, Video, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { api } from '@/lib/api'
import { Dialog, Select } from '@/components/ui'
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
  const tile = 'flex min-h-[132px] flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-card p-4 text-[15px] font-semibold text-foreground transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-primary/30 hover:bg-primary/[0.03] hover:shadow-[0_8px_20px_-8px_rgba(15,23,42,0.18)] active:translate-y-0 active:scale-[0.97] focus-within:ring-2 focus-within:ring-ring [&:hover>span:first-child]:scale-110'
  const icon = 'grid size-14 place-items-center rounded-full bg-primary/10 text-primary transition-transform duration-200 ease-[cubic-bezier(0.2,0.85,0.32,1.2)]'
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

export default function StatusComposer({ file: initial, asSchool = false, onClose, mode, raised = false, pinByDefault = false }: {
  file: File | null; asSchool?: boolean; onClose: () => void
  /** From the School gallery: the post is pinned, so it stays there. */
  pinByDefault?: boolean
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
  /* More classes beside the first (owner: "what if they want to select few classes"). */
  const [more, setMore] = useState<string[]>([])
  const wholeSchool = choice === 'school' || choice === 'staff'
  const targets = () => [choice, ...(wholeSchool ? [] : more.filter((m) => m !== choice))].map((x) => toTarget(x as Choice))
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    setProblem('')
    if (file.type.startsWith('video/')) void videoSeconds(file).then((d) => {
      setDuration(d)
      // Too long is said at once, not after Post.
      const max = aud.data?.max_video_seconds
      if (max && d > max + 0.5) setProblem(`A video can be at most ${max} seconds; this one is ${Math.round(d)}. Trim it and choose it again.`)
    })
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
  const [pin, setPin] = useState(pinByDefault)

  const send = useMutation({
    mutationFn: async () => {
      const why = check()
      if (why) throw new Error(why)
      if (text) return postStatus({ text: true, caption: caption.trim(), targets: targets(), asSchool })
      const f = isVideo ? file! : await preparePhoto(file!)
      if (f.size > MAX_BYTES) throw new Error('This photo is over 25 MB.')
      // A cheap picture for the bell; the post goes without it if it cannot be drawn.
      const thumb = await makeThumb(f).catch(() => null)
      return postStatus({ file: f, thumb, caption: caption.trim(), targets: targets(), asSchool, duration: isVideo ? Math.max(0.1, duration) : undefined })
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

  /* WHO IT IS FOR, as one pill on the picture (owner's story design). Tap it
     for a list: Whole school (or Staff) on its own, or any number of classes
     and sections ticked together. */
  const [audOpen, setAudOpen] = useState(false)
  const picked = choice ? (wholeSchool ? [choice] : [choice, ...more.filter((m) => m !== choice)]) : []
  const toggle = (v: string) => {
    if (v === 'school' || v === 'staff') { setChoice(v); setMore([]); setAudOpen(false); return }
    const cur = wholeSchool ? [] : picked
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
    if (!next.length) return
    setChoice(next[0]); setMore(next.slice(1))
  }
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? ''
  const share = () => { const why = check(); setProblem(why); if (!why) send.mutate() }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (audOpen) setAudOpen(false); else onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [audOpen, onClose])

  /* The one still in the select, waiting to be added as a chip. */
  const addable = options.filter((o) => !picked.includes(o.value))
  const [next, setNext] = useState('')
  useEffect(() => { if (next && picked.includes(next)) setNext('') }, [next, picked])

  return createPortal(
    /* THE COMPOSER IS A SHEET, NOT A STORY CARD (owner's mockup).

       It was a black full-bleed card with the controls floating on the
       picture, which is how a social app composes a story: one picture, one
       caption, post. A school's status is not that -- it is addressed, it is
       kept or not kept, and a teacher has to be able to read back who it is
       going to before pressing Post. White ground, fields that look like
       fields, and the two decisions (who, and keep) stated in words.

       The footer never scrolls. The body between the header and it does, so
       Post is reachable with the keyboard up, which on a phone is the whole
       difference between a form you can finish and one you cannot. */
    <div
      className={cn('fixed inset-0 flex flex-col justify-end bg-[#0f172a]/65 backdrop-blur-[3px] sm:items-center sm:justify-center sm:p-4',
        raised ? 'z-[140]' : 'z-[100]')}
      role="dialog" aria-label={asSchool ? 'Post as the school' : 'New status'}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="flex max-h-[92%] w-full flex-col overflow-hidden rounded-t-3xl bg-card text-foreground
                      shadow-[0_-10px_40px_-10px_rgba(15,23,42,0.4)] sm:max-h-[88vh] sm:max-w-[430px] sm:rounded-3xl">
        {/* The grab handle: it says which way the sheet moves. */}
        <span aria-hidden className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30 sm:hidden" />

        <header className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-extrabold tracking-[-0.01em]">
              {asSchool ? 'Post as the school' : 'New status'}
            </h2>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Seen for 24 hours, unless kept in the gallery
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground
                       transition-colors hover:bg-muted/80 hover:text-foreground [@media(pointer:coarse)]:size-10">
            <X className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
          {text ? (
            <textarea ref={captionBox} value={caption} onChange={(e) => setCaption(e.target.value.slice(0, 700))} rows={4}
              aria-label="Status text" placeholder="Type a status" autoFocus
              className="w-full resize-none rounded-xl bg-primary p-4 text-center text-[20px] font-semibold leading-snug
                         text-primary-foreground outline-none placeholder:text-primary-foreground/60" />
          ) : !preview ? (
            <StatusFileInput onPick={setFile} label="Take or choose a photo or video"
              className="grid h-40 w-full place-items-center gap-2 rounded-xl border border-dashed bg-surface-sunken/50 p-6 text-center text-[13px] text-muted-foreground">
              <Camera className="mx-auto size-7" />
              <span>Take or choose a photo or video</span>
            </StatusFileInput>
          ) : (
            <div className="relative h-40 w-full shrink-0 overflow-hidden rounded-xl bg-foreground/90">
              {isVideo ? (
                <video src={preview} className="size-full object-cover" autoPlay loop muted playsInline
                  onError={() => setProblem('This video format cannot be played. Save it as an MP4 (H.264) and choose it again.')} />
              ) : (
                <img src={preview} alt="" className="size-full object-cover" />
              )}
              <span className="absolute left-2 top-2 rounded bg-black/75 px-2 py-0.5 text-[11px] font-bold text-white">
                {isVideo ? 'Video' : 'Photo'}
              </span>
              <StatusFileInput onPick={setFile} label="Choose another photo or video"
                className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-black/65 text-white">
                <Upload className="size-4" />
              </StatusFileInput>
            </div>
          )}

          {!text && (
            <textarea value={caption} onChange={(e) => setCaption(e.target.value.slice(0, 700))} rows={2}
              aria-label="Caption" placeholder="Add a caption"
              className="w-full resize-none rounded-xl border bg-surface-sunken/50 px-3 py-2.5 text-[14px] outline-none
                         focus:border-primary focus:bg-card [@media(pointer:coarse)]:text-[16px]" />
          )}

          {/* WHO IT IS FOR: what is chosen, then how to add another.

              The chips are the answer and the select is the question, in that
              order, because the thing a teacher checks before posting is the
              list, not the control that built it. */}
          <div className="flex flex-col gap-2.5 rounded-xl border bg-surface-sunken/50 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-extrabold">Who is it for</span>
              <span className="text-[11px] text-muted-foreground">
                {picked.length ? `${picked.length} chosen` : 'Choose at least one'}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {picked.length === 0 && <span className="text-[12.5px] text-muted-foreground">Nobody yet.</span>}
              {picked.map((v) => (
                <span key={v} className="inline-flex items-center gap-1.5 rounded-md border bg-card py-1 pl-2.5 pr-1.5 text-[12.5px] font-bold">
                  {labelOf(v)}
                  {/* The last one cannot go: a status with no audience is not
                      a draft, it is a post that cannot be sent. */}
                  {picked.length > 1 && (
                    <button type="button" onClick={() => toggle(v)} aria-label={`Not ${labelOf(v)}`}
                      className="text-muted-foreground transition-colors hover:text-destructive">
                      <X className="size-3.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>

            <div className="flex gap-1.5">
              <div className="min-w-0 flex-1">
                <Select value={next} onChange={setNext}
                  placeholder={aud.isLoading ? 'Loading' : 'Whole school, a class or a section'}
                  options={addable.map((o) => ({ value: o.value, label: o.label }))} />
              </div>
              <button type="button" disabled={!next} onClick={() => { toggle(next); setNext('') }}
                className="shrink-0 rounded-lg bg-foreground px-3.5 text-[12.5px] font-bold text-background transition-opacity disabled:opacity-40
                           [@media(pointer:coarse)]:min-h-[44px]">
                + Add
              </button>
            </div>

            {/* KEEP IT, OR LET IT GO AFTER A DAY. */}
            <label className="flex cursor-pointer items-center justify-between gap-3 border-t pt-2.5">
              <span className="min-w-0">
                <span className="block text-[12.5px] font-bold">Keep in the class gallery</span>
                <span className="block text-[11px] text-muted-foreground">Pinned, so it does not disappear</span>
              </span>
              <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} className="peer sr-only" />
              <span className="relative h-5 w-9 shrink-0 rounded-full bg-muted-foreground/30 transition-colors after:absolute after:left-0.5 after:top-0.5
                               after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4" />
            </label>
          </div>

          {(problem || send.error || aud.error) && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[12.5px] font-medium text-destructive">
              {problem || ((send.error || aud.error) as Error).message}
            </p>
          )}
          {aud.data?.needs_approval && (
            <p className="text-center text-[11.5px] text-muted-foreground">
              The principal approves statuses before anyone sees them.
            </p>
          )}
          {done && (
            <p className="rounded-lg bg-success/10 px-3 py-2 text-center text-[13px] font-medium text-success">{done}</p>
          )}
        </div>

        <footer className="flex shrink-0 gap-2.5 border-t bg-card px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2.5">
          {done ? (
            <button type="button" onClick={onClose}
              className="h-11 flex-1 rounded-full bg-primary text-[14px] font-bold text-primary-foreground">Done</button>
          ) : (
            <>
              <button type="button" onClick={onClose}
                className="h-11 flex-1 rounded-full border bg-card text-[13.5px] font-bold text-muted-foreground transition-colors hover:text-foreground">
                Cancel
              </button>
              <button type="button" onClick={share} disabled={send.isPending || (text ? !caption.trim() : !file)}
                className="h-11 flex-[2] rounded-full bg-primary text-[13.5px] font-bold text-primary-foreground
                           shadow-[0_4px_12px_rgba(201,42,42,0.3)] transition-transform active:scale-[0.98] disabled:opacity-50">
                {send.isPending ? 'Posting' : 'Post'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}
