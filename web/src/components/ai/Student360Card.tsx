import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
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
              if (!failed && (!b || stale)) make.mutate()
            }}>
              <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />{asked ? 'Update' : 'Summarise'}
            </Button>
          )}
        </div>
      } />
      {asked && !make.isPending && (
        <div className="px-[var(--card-pad)] py-3 text-sm">
          {b && !failed ? <p className="whitespace-pre-wrap leading-relaxed">{b.body}</p>
            : <p className="whitespace-pre-wrap leading-relaxed">{fallback ?? 'A summary will appear here once the records are in.'}</p>}
        </div>
      )}
    </Card>
  )
}
