import { useQuery } from '@tanstack/react-query'
import { Card, CardHeader } from '@/components/ui'
import { aiApi, AiLabel } from './aiApi'

/* The weekly note about a child, written on Saturday mornings from the
   week's attendance, homework, marks and teachers' notes. Shows nothing
   until the first one exists. */
export default function WeeklyNoteCard({ studentId }: { studentId?: string }) {
  const q = useQuery({ queryKey: ['ai-weekly', studentId ?? ''], queryFn: () => aiApi.weekly(studentId), retry: false })
  const b = q.data?.brief
  if (!b) return null
  return (
    <Card>
      <CardHeader title="This week" action={<AiLabel text="AI summary" />} />
      <div className="px-[var(--card-pad)] py-3 text-sm">
        <p className="whitespace-pre-wrap">{b.body}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">Week {b.period_key.split('-W')[1]}, summarised by AI from the school's records. Ask the class teacher about anything that looks wrong.</p>
      </div>
    </Card>
  )
}
