import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Dialog, Field, FormNotice, Select, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import { MAX_BYTES, postStatus, preparePhoto, videoSeconds, type Audiences, type TargetPick } from './status-api'

/* The composer: who it is for, the picture or clip, a caption, Post.

   Opened with a file already chosen (the Add ring is itself the file input,
   so the camera opens on the tap that asked for it -- a picker opened later
   from an effect is blocked on iPhone). "Change" picks again. A photo is
   shrunk on the phone before it goes; a video is checked against the
   school's length and the 25 MB cap before a byte is sent. */

export function StatusFileInput({ onPick, className, children, label }: {
  onPick: (f: File) => void; className?: string; children: React.ReactNode; label: string
}) {
  return (
    <label className={cn('cursor-pointer', className)} aria-label={label}>
      {children}
      <input
        type="file"
        accept="image/*,video/*"
        capture="environment"
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

/* Who the status is for, as one value in the picker. */
type Choice = string // 'school' | 'staff' | 'class:<id>' | 'section:<id>'
const toTarget = (c: Choice): TargetPick => {
  const [kind, id] = c.split(':') as [TargetPick['kind'], string | undefined]
  return id ? { kind, id } : { kind }
}

export default function StatusComposer({ file: initial, asSchool = false, onClose }: { file: File | null; asSchool?: boolean; onClose: () => void }) {
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
      const f = isVideo ? file! : await preparePhoto(file!)
      if (f.size > MAX_BYTES) throw new Error('This photo is over 25 MB.')
      return postStatus({ file: f, caption: caption.trim(), targets: [toTarget(choice)], asSchool, duration: isVideo ? Math.max(0.1, duration) : undefined })
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
      title={asSchool ? 'Post as the school' : 'New status'}
      description="Seen for 24 hours, unless you pin it to the class gallery."
      footer={done ? <Button onClick={onClose}>Done</Button> : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button pending={send.isPending} disabled={!file} onClick={() => { setProblem(check()); send.mutate() }}>Post</Button>
        </>
      )}
    >
      {done ? <FormNotice ok={done} /> : (
        <div className="grid gap-4">
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
          <Field label="Who is it for" required>
            <Select value={choice} onChange={setChoice} options={options} placeholder={aud.isLoading ? 'Loading…' : 'Choose'} />
          </Field>
          <Field label="Caption" hint="Optional. Shown along the bottom.">
            <Textarea value={caption} onChange={setCaption} rows={2} placeholder="What is happening" />
          </Field>
          {aud.data?.needs_approval && <p className="text-[13px] text-muted-foreground">The principal approves statuses at this school before anyone sees them.</p>}
          <FormNotice error={problem || send.error || aud.error} />
        </div>
      )}
    </Dialog>
  )
}
