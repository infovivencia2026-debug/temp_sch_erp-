import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ChevronDown, Paperclip, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Button, ErrorState, FormNotice, Textarea } from '@/components/ui'
import { shrinkImage } from '@/lib/shrink-image'
import { uploadFile } from '@/features/learning/lms-shared'
import { cn } from '@/lib/utils'
import { Toast } from './StudentToast'
import { Bone, DoneCheck, DueChip, PullToRefresh, confetti, daysFrom } from './student-kit'
import { MiniRing, addDays, homeworkQuery, weekStart, type StudentHomework } from './StudentHome'

/* THE STUDENT'S HOMEWORK.

   Grouped the way a child plans: Late, Today, Tomorrow, This week, Later, and
   Done. Each piece opens in place to read what was asked, write an answer,
   take a photo of the notebook with the phone camera or attach a file, and
   hand it in. Handing in is optimistic: the row ticks at once (a check that
   draws itself, the week ring fills) and a short confirmation says it went. */

const GROUPS: { key: string; label: string; test: (h: StudentHomework) => boolean }[] = [
  { key: 'late', label: 'Late', test: (h) => !h.submitted && !!h.due_on && daysFrom(h.due_on) < 0 },
  { key: 'today', label: 'Due today', test: (h) => !h.submitted && !!h.due_on && daysFrom(h.due_on) === 0 },
  { key: 'tomorrow', label: 'Due tomorrow', test: (h) => !h.submitted && !!h.due_on && daysFrom(h.due_on) === 1 },
  { key: 'week', label: 'Later this week', test: (h) => !h.submitted && !!h.due_on && daysFrom(h.due_on) > 1 && daysFrom(h.due_on) < 7 },
  { key: 'later', label: 'Later', test: (h) => !h.submitted && (!h.due_on || daysFrom(h.due_on) >= 7) },
  { key: 'done', label: 'Handed in', test: (h) => h.submitted },
]

export default function StudentHomework() {
  const qc = useQueryClient()
  const q = useQuery(homeworkQuery)
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState<string | null>(() => params.get('open'))
  const [justDone, setJustDone] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const [showDone, setShowDone] = useState(false)
  /* The row just handed in stays where it was for a moment, so its check can
     be seen drawing, then moves down to Handed in. */
  const [linger, setLinger] = useState<string | null>(null)
  useEffect(() => { if (!linger) return; const t = setTimeout(() => setLinger(null), 1600); return () => clearTimeout(t) }, [linger])

  useEffect(() => {
    if (!open) return
    const el = document.getElementById(`hw-${open}`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open, q.data])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t) }, [toast])

  const toggle = (id: string) => {
    const next = open === id ? null : id
    setOpen(next)
    const p = new URLSearchParams(params)
    if (next) p.set('open', next); else p.delete('open')
    setParams(p, { replace: true })
  }

  const items = q.data?.items ?? []
  const ws = weekStart()
  const week = items.filter((h) => (h.due_on ?? h.assigned_on) >= ws && (h.due_on ?? h.assigned_on) < addDays(ws, 7))
  const weekDone = week.filter((h) => h.submitted).length
  const todo = items.filter((h) => !h.submitted).length

  const onHanded = (h: StudentHomework, el: Element | null) => {
    setJustDone(h.id)
    setLinger(h.id)
    setOpen(null)
    setToast({ text: `Handed in: ${h.title}` })
    const left = items.filter((x) => !x.submitted && x.id !== h.id && x.due_on && daysFrom(x.due_on) <= 1).length
    if (left === 0) confetti(el)
  }

  return (
    <PullToRefresh onRefresh={() => qc.invalidateQueries({ queryKey: homeworkQuery.queryKey })}>
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-6 pt-2 md:px-6 md:pt-6 lg:max-w-none lg:px-8">
        <div className="flex min-h-[56px] items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-semibold leading-tight">Homework</h1>
            <p className="text-[13px] text-muted-foreground">{q.data ? (todo ? `${todo} to hand in` : 'All handed in. Great work!') : ' '}</p>
          </div>
          {q.data && week.length > 0 && (
            <div className="flex items-center gap-2 text-right">
              <span className="text-[12px] leading-tight text-muted-foreground"><span className="block text-[15px] font-semibold text-foreground tabular-nums">{weekDone}/{week.length}</span>this week</span>
              <MiniRing done={weekDone} total={week.length} size={40} />
            </div>
          )}
        </div>

        {q.error ? <ErrorState error={q.error} /> : !q.data ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Bone key={i} className="h-[68px] w-full rounded-2xl" />)}</div>
        ) : !items.length ? (
          <div className="card px-4 py-8 text-center text-[15px] text-muted-foreground">No homework yet. Enjoy the free time!</div>
        ) : GROUPS.map((g) => {
          const rows = items.filter((h) => g.test(h.id === linger ? { ...h, submitted: false } : h)).sort((a, b) => (g.key === 'done' ? (b.due_on ?? '').localeCompare(a.due_on ?? '') : (a.due_on ?? '9').localeCompare(b.due_on ?? '9')))
          if (!rows.length) return null
          const collapsed = g.key === 'done' && !showDone
          return (
            <section key={g.key} aria-label={g.label}>
              {g.key === 'done' ? (
                <button type="button" onClick={() => setShowDone(!showDone)} className="flex min-h-[44px] w-full items-center gap-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.label} ({rows.length}) <ChevronDown className={cn('h-4 w-4 transition-transform', showDone && 'rotate-180')} />
                </button>
              ) : <h2 className={cn('px-1 pb-1.5 pt-2 text-[13px] font-semibold uppercase tracking-wide', g.key === 'late' ? 'text-destructive' : 'text-muted-foreground')}>{g.label}</h2>}
              {!collapsed && (
                <ul className="space-y-2">
                  {rows.map((h) => <Row key={h.id} h={h} open={open === h.id} pop={justDone === h.id} onToggle={() => toggle(h.id)} onHanded={onHanded} onFail={(m) => { setJustDone(null); setOpen(h.id); setToast({ text: m, bad: true }) }} />)}
                </ul>
              )}
            </section>
          )
        })}
      </div>
      {toast && <Toast key={toast.text} {...toast} />}
    </PullToRefresh>
  )
}

function Row({ h, open, pop, onToggle, onHanded, onFail }: { h: StudentHomework; open: boolean; pop: boolean; onToggle: () => void; onHanded: (h: StudentHomework, el: Element | null) => void; onFail: (msg: string) => void }) {
  const qc = useQueryClient()
  const ref = useRef<HTMLLIElement>(null)
  const [text, setText] = useState(h.my_answer ?? '')
  const [file, setFile] = useState<{ id: string; name: string; preview?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = useMutation({
    mutationFn: () => api.post(`/api/v1/homework/${h.id}/submit`, { text_answer: text.trim() || undefined, file_id: file?.id }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: homeworkQuery.queryKey })
      const before = qc.getQueryData<List<StudentHomework>>(homeworkQuery.queryKey)
      qc.setQueryData<List<StudentHomework>>(homeworkQuery.queryKey, (d) => d && { ...d, items: d.items.map((x) => x.id === h.id ? { ...x, submitted: true, my_answer: text.trim() || x.my_answer, my_file_name: file?.name ?? x.my_file_name } : x) })
      onHanded(h, ref.current)
      return { before }
    },
    onError: (e, _v, ctx) => { if (ctx?.before) qc.setQueryData(homeworkQuery.queryKey, ctx.before); onFail(`Not handed in: ${e instanceof Error ? e.message : 'please try again'}`) },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: homeworkQuery.queryKey })
      qc.invalidateQueries({ queryKey: ['portal-summary'] })
      qc.invalidateQueries({ queryKey: ['portal-lms-todo'] })
    },
  })
  const pick = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setErr('')
    try {
      const small = f.type.startsWith('image/') ? await shrinkImage(f) : f
      const r = await uploadFile(small, 'homework_submission')
      setFile({ id: r.id, name: r.name, preview: f.type.startsWith('image/') ? URL.createObjectURL(small) : undefined })
    } catch (x) { setErr(x instanceof Error ? x.message : 'Upload failed') } finally { setBusy(false) }
  }
  const late = !!h.due_on && daysFrom(h.due_on) < 0
  return (
    <li id={`hw-${h.id}`} ref={ref} className="card overflow-hidden p-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-[68px] w-full items-center gap-3 px-4 py-2.5 text-left">
        <DoneCheck done={h.submitted} pop={pop} />
        <span className="min-w-0 flex-1">
          <span className={cn('block text-[15px] font-medium leading-snug [overflow-wrap:anywhere]', h.submitted && 'text-muted-foreground')}>{h.title}</span>
          <span className="block truncate text-[13px] text-muted-foreground">{[h.subject, h.teacher].filter(Boolean).join(' · ')}</span>
        </span>
        <DueChip due={h.due_on} done={h.submitted} />
      </button>
      {open && (
        <div className="space-y-3 border-t px-4 py-3 text-[14px]">
          {h.instructions && <p className="whitespace-pre-wrap">{h.instructions}</p>}
          {!!h.files?.length && (
            <p className="flex flex-wrap gap-2">{h.files.map((f) => <a key={f.file_id} href={`/api/v1/files/${f.file_id}`} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-primary"><Paperclip className="h-4 w-4" />{f.name}</a>)}</p>
          )}
          {h.submitted ? (
            <div className="rounded-xl bg-muted/50 p-3">
              <p className="font-medium">You handed this in.</p>
              {h.my_answer && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{h.my_answer}</p>}
              {h.my_file_id && <a href={`/api/v1/files/${h.my_file_id}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-primary">{h.my_file_name ?? 'Your file'}</a>}
            </div>
          ) : (
            <>
              <Textarea rows={4} value={text} onChange={setText} placeholder="Type your answer here (or take a photo of your notebook)" aria-label="Your answer" />
              <div className="flex flex-wrap items-center gap-2">
                <label className="btn inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border px-4 font-medium" data-variant="secondary">
                  <Camera className="h-5 w-5" /> {busy ? 'Uploading…' : 'Take a photo'}
                  <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
                </label>
                <label className="btn inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border px-4 font-medium" data-variant="secondary">
                  <Paperclip className="h-5 w-5" /> Attach a file
                  <input type="file" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
                </label>
              </div>
              {file && (
                <div className="flex items-center gap-3 rounded-xl border p-2">
                  {file.preview ? <img src={file.preview} alt="" className="h-14 w-14 rounded-lg object-cover" /> : <Paperclip className="h-5 w-5" />}
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button type="button" aria-label="Remove" onClick={() => setFile(null)} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground"><X className="h-4 w-4" /></button>
                </div>
              )}
              {err && <p className="text-destructive">{err}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <Button className="min-h-[48px] px-6 text-[15px]" disabled={busy || (!text.trim() && !file)} pending={submit.isPending} onClick={() => submit.mutate()}>Hand in</Button>
                {late && <span className="text-[13px] text-destructive">This will be marked late.</span>}
                <FormNotice error={submit.error} />
              </div>
            </>
          )}
        </div>
      )}
    </li>
  )
}
