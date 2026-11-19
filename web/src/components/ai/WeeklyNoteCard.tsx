import { useAiFeature, AI_STATUS_KEY } from './useAiStatus'
import { useSession } from '@/lib/session'
import { useQuery } from '@tanstack/react-query'
import { Card, CardHeader } from '@/components/ui'
import { aiApi, AiLabel } from './aiApi'

/* The weekly note about a child, written on Saturday mornings from the
   week's attendance, homework, marks and teachers' notes. Shows nothing
   until the first one exists. */
function WeeklyNoteCardInner({ studentId }: { studentId?: string }) {
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

/** Hidden entirely when the school switched this AI feature off. */
export default function WeeklyNoteCard(props: Parameters<typeof WeeklyNoteCardInner>[0]) {
  /* The endpoint needs self.profile.read; asking without it was a 403 on
     every home load (owner test, 2026-11-19). */
  const may = useSession().permissions.includes('self.profile.read')
  /* Asked only once the school's AI status says the feature is ON. While the
     status was loading (or refused to a parent) useAiFeature reads "on", and
     the server's own feature check answered 403 (owner re-check, 2026-11-19). */
  const status = useQuery({ queryKey: AI_STATUS_KEY, queryFn: aiApi.status, staleTime: 5 * 60_000, retry: false, enabled: may })
  const on = status.data?.features?.parent_weekly === true
  return useAiFeature('parent_weekly') && may && on ? <WeeklyNoteCardInner {...props} /> : null
}
