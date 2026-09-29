import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, Clock, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, ErrorState, FormNotice, PageBody, PageHead } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Bone, confetti, reducedMotion } from '../portal/student-kit'

/* A QUIZ THAT PLAYS LIKE A GAME.

   One question at a time. Tapping an option checks it at once (worker
   POST /portal/lms/quizzes/{id}/check), which locks that answer, so the
   feedback is honest: green for right, a gentle red for not quite, and the
   right option named when no attempt is left. The clock is a small pill and a
   thin bar, amber in the last minute, never a flashing alarm. At the end, a
   score ring and a review of the ones that were missed. */

interface Started {
  attempt_id: string; deadline: string | null; server_now: string
  quiz: { title: string; instructions?: string | null; duration_minutes?: number | null }
  questions: { test_question_id: string; stem: string; marks: number; options: { id: string; body: string }[] }[]
}
interface Checked { right: boolean; chosen: string; correct: string | null }
interface Result { score: number; max_score: number; timed_out: boolean; review: { test_question_id: string; chosen: string | null; correct: string | null; right: boolean }[] }

export function StudentQuiz({ id, back }: { id: string; back: () => void }) {
  const start = useQuery({ queryKey: ['quiz-start', id], queryFn: () => api.post<Started>(`/api/v1/portal/lms/quizzes/${id}/start`, {}), staleTime: Infinity, retry: false, gcTime: 0 })
  const s = start.data
  const [idx, setIdx] = useState(0)
  const [checked, setChecked] = useState<Record<string, Checked>>({})
  const [left, setLeft] = useState<number | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)

  const check = useMutation({
    mutationFn: (v: { q: string; o: string }) => api.post<Checked & { test_question_id: string }>(`/api/v1/portal/lms/quizzes/${id}/check`, { attempt_id: s!.attempt_id, test_question_id: v.q, option_id: v.o }),
    onSuccess: (r, v) => {
      setChecked((c) => ({ ...c, [v.q]: { right: r.right, chosen: r.chosen, correct: r.correct } }))
      if (card.current && !reducedMotion()) {
        card.current.animate(r.right
          ? [{ transform: 'scale(1)' }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }]
          : [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 280, easing: 'ease-out' })
      }
    },
  })
  const submit = useMutation({
    mutationFn: () => api.post<Result>(`/api/v1/portal/lms/quizzes/${id}/submit`, { attempt_id: s!.attempt_id, answers: Object.fromEntries(Object.entries(checked).map(([k, v]) => [k, v.chosen])) }),
    onSuccess: (r) => { if (r.max_score && r.score / r.max_score >= 0.6) setTimeout(() => confetti(ring.current), 250) },
  })

  useEffect(() => {
    if (!s?.deadline) return
    const skew = Date.parse(s.server_now) - Date.now()
    const tick = () => {
      const ms = Date.parse(s.deadline!) - (Date.now() + skew)
      setLeft(Math.max(0, Math.floor(ms / 1000)))
      if (ms <= 0 && !submit.isPending && !submit.data) submit.mutate()
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.deadline, submit.data])

  /* Resume: answers checked before a reload are already locked on the server;
     start again at the first unanswered one. */
  const r = submit.data
  const total = s?.questions.length ?? 0
  const q = s?.questions[idx]
  const mine = q ? checked[q.test_question_id] : undefined
  const answered = Object.keys(checked).length
  const totalSec = (s?.quiz.duration_minutes ?? 0) * 60

  return (
    <>
      <PageHead eyebrow="Quiz" title={s?.quiz.title ?? 'Quiz'} actions={<Button variant="secondary" onClick={back}><ChevronLeft className="h-4 w-4" /> Back</Button>} />
      <PageBody>
        {start.error ? <ErrorState error={start.error} /> : !s ? (
          <div className="mx-auto max-w-xl space-y-3"><Bone className="h-8 w-40" /><Bone className="h-64 w-full rounded-2xl" /></div>
        ) : r ? (
          <Summary r={r} s={s} checked={checked} ringRef={ring} back={back} />
        ) : !q ? null : (
          <div className="mx-auto max-w-xl space-y-4">
            {/* Progress dots and the gentle clock. */}
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 gap-1" aria-label={`Question ${idx + 1} of ${total}`}>
                {s.questions.map((x, i) => {
                  const c = checked[x.test_question_id]
                  return <span key={x.test_question_id} className={cn('h-1.5 flex-1 rounded-full transition-colors duration-300', c ? (c.right ? 'bg-success' : 'bg-[#f43f5e]') : i === idx ? 'bg-primary' : 'bg-muted')} />
                })}
              </div>
              {left !== null && (
                <span className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium tabular-nums', left < 60 ? 'border-[#f59e0b] text-[#b45309]' : 'text-muted-foreground')} aria-label={`${Math.floor(left / 60)} minutes ${left % 60} seconds left`}>
                  <Clock className="h-3.5 w-3.5" /> {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
                </span>
              )}
            </div>
            {left !== null && totalSec > 0 && (
              <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden><div className={cn('h-full rounded-full transition-[width] duration-1000 ease-linear', left < 60 ? 'bg-[#f59e0b]' : 'bg-primary/50')} style={{ width: `${Math.min(100, (left / totalSec) * 100)}%` }} /></div>
            )}
            <div ref={card} className="card space-y-4 p-5">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Question {idx + 1} of {total} · {q.marks} mark{q.marks === 1 ? '' : 's'}</p>
              <h2 className="text-[19px] font-semibold leading-snug [overflow-wrap:anywhere]">{q.stem}</h2>
              <div className="grid gap-2" role="radiogroup" aria-label="Options">
                {q.options.map((o, i) => {
                  const picked = mine?.chosen === o.id || (check.isPending && check.variables?.o === o.id)
                  const isRight = mine && (mine.correct === o.id || (mine.right && mine.chosen === o.id))
                  const isWrong = mine && !mine.right && mine.chosen === o.id
                  return (
                    <button key={o.id} type="button" role="radio" aria-checked={picked} disabled={!!mine || check.isPending}
                      onClick={() => check.mutate({ q: q.test_question_id, o: o.id })}
                      className={cn('flex min-h-[52px] w-full items-center gap-3 rounded-xl border-2 px-4 py-2.5 text-left text-[15px] transition-colors duration-200',
                        isRight ? 'border-success bg-[color-mix(in_oklab,#10b981_10%,transparent)]'
                          : isWrong ? 'border-[#f43f5e] bg-[color-mix(in_oklab,#f43f5e_8%,transparent)]'
                            : picked ? 'border-primary' : 'border-border enabled:hover:border-primary/60 enabled:active:scale-[.99]',
                        mine && !isRight && !isWrong && 'opacity-60')}>
                      <span className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold',
                        isRight ? 'border-success bg-success text-white' : isWrong ? 'border-[#f43f5e] bg-[#f43f5e] text-white' : 'text-muted-foreground')}>
                        {isRight ? <Check className="h-4 w-4" /> : isWrong ? <X className="h-4 w-4" /> : String.fromCharCode(65 + i)}
                      </span>
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o.body}</span>
                    </button>
                  )
                })}
              </div>
              {mine && (
                <p role="status" className={cn('text-[15px] font-semibold', mine.right ? 'text-success' : 'text-[#be123c]')}>
                  {mine.right ? 'Correct! Nice one.' : mine.correct ? 'Not quite. The right answer is marked in green.' : 'Not quite. Keep going!'}
                </p>
              )}
              <FormNotice error={check.error} />
            </div>
            <div className="flex items-center gap-3">
              {idx > 0 && <Button variant="secondary" className="min-h-[48px]" onClick={() => setIdx(idx - 1)}><ChevronLeft className="h-4 w-4" /> Back</Button>}
              <span className="flex-1 text-[13px] text-muted-foreground">{answered} of {total} answered</span>
              {idx < total - 1 ? (
                <Button className="min-h-[48px] px-6" disabled={!mine} onClick={() => setIdx(idx + 1)}>Next <ChevronRight className="h-4 w-4" /></Button>
              ) : (
                <Button className="min-h-[48px] px-6" pending={submit.isPending} disabled={!mine && answered < total}
                  onClick={() => { if (answered === total || window.confirm('Some questions have no answer. Finish anyway?')) submit.mutate() }}>See my score</Button>
              )}
            </div>
            <FormNotice error={submit.error} />
          </div>
        )}
      </PageBody>
    </>
  )
}

function Summary({ r, s, checked, ringRef, back }: { r: Result; s: Started; checked: Record<string, Checked>; ringRef: React.RefObject<HTMLDivElement>; back: () => void }) {
  const pct = r.max_score ? Math.round((100 * r.score) / r.max_score) : 0
  const size = 132, rad = (size - 12) / 2, c = 2 * Math.PI * rad
  const [shown, setShown] = useState(reducedMotion() ? pct : 0)
  useEffect(() => { const t = requestAnimationFrame(() => setShown(pct)); return () => cancelAnimationFrame(t) }, [pct])
  const reviewOf = (qid: string) => r.review.find((x) => x.test_question_id === qid)
  const wrong = s.questions.filter((q) => {
    const rv = reviewOf(q.test_question_id); const ck = checked[q.test_question_id]
    return rv ? !rv.right : ck ? !ck.right : true
  })
  const right = s.questions.length - wrong.length
  const optBody = (q: Started['questions'][number], oid?: string | null) => q.options.find((o) => o.id === oid)?.body
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="card flex flex-col items-center gap-2 p-6 text-center">
        <div ref={ringRef} className="relative" style={{ width: size, height: size }}>
          <svg width={size} height={size} className="-rotate-90" aria-hidden>
            <circle cx={size / 2} cy={size / 2} r={rad} fill="none" strokeWidth={10} className="stroke-muted" />
            <circle cx={size / 2} cy={size / 2} r={rad} fill="none" strokeWidth={10} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (c * shown) / 100}
              className={cn('transition-[stroke-dashoffset] duration-1000 ease-out', pct >= 60 ? 'stroke-success' : 'stroke-primary')} />
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[30px] font-semibold tabular-nums leading-none">{r.score}/{r.max_score}</span>
            <span className="text-[13px] text-muted-foreground">{pct}%</span>
          </span>
        </div>
        <p className="text-[18px] font-semibold">{pct >= 90 ? 'Brilliant!' : pct >= 60 ? 'Well done!' : pct >= 40 ? 'Good try!' : 'Keep practising!'}</p>
        <p className="text-[14px] text-muted-foreground">{right} of {s.questions.length} right.{r.timed_out ? ' The time ran out; answers you checked in time still count.' : ''}</p>
        <Button className="mt-2 min-h-[48px] px-6" onClick={back}>Back to the course</Button>
      </div>
      {wrong.length > 0 && (
        <div className="card overflow-hidden p-0">
          <h3 className="border-b px-4 py-3 text-[15px] font-semibold">Review your mistakes</h3>
          <ol className="divide-y">
            {wrong.map((q) => {
              const rv = reviewOf(q.test_question_id); const ck = checked[q.test_question_id]
              const chosen = rv?.chosen ?? ck?.chosen
              const correct = rv?.correct ?? ck?.correct
              return (
                <li key={q.test_question_id} className="space-y-1 px-4 py-3 text-[14px]">
                  <p className="font-medium [overflow-wrap:anywhere]">{s.questions.indexOf(q) + 1}. {q.stem}</p>
                  <p className="flex items-start gap-1.5 text-[#be123c]"><X className="mt-0.5 h-4 w-4 shrink-0" /> {chosen ? `You chose: ${optBody(q, chosen)}` : 'Not answered'}</p>
                  {correct ? <p className="flex items-start gap-1.5 text-success"><Check className="mt-0.5 h-4 w-4 shrink-0" /> Right answer: {optBody(q, correct)}</p>
                    : <p className="text-muted-foreground">The right answer is shown once you have used every attempt.</p>}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}
