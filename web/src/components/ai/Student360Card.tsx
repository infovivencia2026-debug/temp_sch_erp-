import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, GraduationCap, IndianRupee, Loader2, Sparkles } from 'lucide-react'
import { Button, Card, CardHeader } from '@/components/ui'
import { aiApi, AiLabel } from './aiApi'

/* Student 360: one paragraph over marks, attendance, homework and conduct,
   written on request and cached until the student's records change. */
/* When the assistant is off or its key is refused, the card still answers:
   `fallback` is a plain summary written from the child's own records, so a
   school never sees a server error where a summary should be. */
export default function Student360Card({ studentId, fallback }: { studentId: string; fallback?: string }) {
  const qc = useQueryClient()
  /* Nothing until asked: the owner wanted the card empty until Summarise is pressed. */
  const [asked, setAsked] = useState(false)
  /* A moment of "Summarising…" so the press visibly does something, longer
     if the AI request is still out. */
  const [busy, setBusy] = useState(false)
  const key = ['ai-student-360', studentId]
  const q = useQuery({ queryKey: key, queryFn: () => aiApi.student360(studentId), retry: false })
  const make = useMutation({ mutationFn: () => aiApi.makeStudent360(studentId), onSuccess: (d) => qc.setQueryData(key, d) })
  const failed = q.isError || make.isError || !!make.data?.message || q.data?.configured === false
  const b = q.data?.brief
  const stale = !!b && q.data && !q.data.fresh
  return (
    <Card>
      <CardHeader title="Student 360" action={
        <div className="flex items-center gap-2">
          {asked && b && !failed && <AiLabel text="AI summary" />}
          {(!asked || (!failed && stale)) && (
            <Button size="sm" variant="outline" pending={make.isPending} onClick={() => {
              setAsked(true)
              setBusy(true)
              setTimeout(() => setBusy(false), 700)
              if (!failed && (!b || stale)) make.mutate()
            }}>
              <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />{asked ? 'Update' : 'Summarise'}
            </Button>
          )}
        </div>
      } />
      {/* Shown the moment it is pressed: the record summary at once, replaced
          by the AI one if and when that arrives. Waiting on the AI left the
          card empty while the request hung. */}
      {asked && (busy || make.isPending) && (
        <div className="flex items-center gap-2 px-[var(--card-pad)] py-5 text-[14px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Summarising…
        </div>
      )}
      {asked && !busy && !make.isPending && (
        <div className="px-[var(--card-pad)] py-4">
          {b && !failed ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{b.body}</p> : <Sections text={fallback} />}
        </div>
      )}
    </Card>
  )
}

/* The record summary as three tinted blocks rather than grey paragraphs:
   each "Label: sentence" paragraph gets its colour and its icon. */
const LOOK: Record<string, { icon: typeof Sparkles; tone: string }> = {
  Attendance: { icon: CalendarCheck, tone: 'border-[#86efac] bg-[#f0fdf4] text-[#15803d]' },
  Academics: { icon: GraduationCap, tone: 'border-primary/25 bg-primary/[0.06] text-primary' },
  Fees: { icon: IndianRupee, tone: 'border-[#fcd34d] bg-[#fffbeb] text-[#b45309]' },
}
function Sections({ text }: { text?: string }) {
  if (!text) return <p className="text-[14px] text-muted-foreground">A summary will appear here once the records are in.</p>
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {text.split(/\n\n+/).map((para, i) => {
        const at = para.indexOf(': ')
        const label = at > 0 ? para.slice(0, at) : ''
        const body = at > 0 ? para.slice(at + 2) : para
        const look = LOOK[label] ?? { icon: Sparkles, tone: 'border-border bg-muted/40 text-foreground' }
        const Icon = look.icon
        return (
          <div key={i} className={'rounded-xl border px-4 py-3 ' + look.tone}>
            <div className="mb-1 flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide">
              <Icon className="h-4 w-4" /> {label || 'Summary'}
            </div>
            <p className="text-[14px] leading-relaxed text-foreground">{body}</p>
          </div>
        )
      })}
    </div>
  )
}
