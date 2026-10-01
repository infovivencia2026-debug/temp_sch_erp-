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
          {b && <AiLabel text="AI summary" />}
          {!failed && (!b || stale) && (
            <Button size="sm" variant="outline" pending={make.isPending} onClick={() => make.mutate()}>
              <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />{b ? 'Update' : 'Summarise'}
            </Button>
          )}
        </div>
      } />
      <div className="px-[var(--card-pad)] py-3 text-sm">
        {b && !failed ? <p className="whitespace-pre-wrap">{b.body}</p>
          : failed || fallback ? <p className="leading-relaxed">{fallback ?? 'A summary will appear here once the records are in.'}</p>
          : <p className="text-muted-foreground">A one-paragraph summary of this student from their records.</p>}
        {stale && !failed && <p className="mt-1 text-xs text-muted-foreground">The records have changed since this was written.</p>}
      </div>
    </Card>
  )
}
