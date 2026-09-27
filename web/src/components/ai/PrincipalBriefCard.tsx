import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { Button, Card, CardHeader } from '@/components/ui'
import { aiApi, AiLabel } from './aiApi'

/* The principal's morning brief: 5-8 bullets written at 07:00 school time
   (or now, on first open), each linking to the screen that deals with it.
   Without a Google key it shows the same facts as plain bullets and says so. */
export default function PrincipalBriefCard() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['ai-principal-brief'], queryFn: aiApi.principalBrief, staleTime: 5 * 60_000, retry: false })
  const refresh = useMutation({ mutationFn: aiApi.refreshPrincipalBrief, onSuccess: (d) => qc.setQueryData(['ai-principal-brief'], d) })
  if (q.isError) return null // not for this person (403) or the brief is unavailable; the dashboard stands without it
  const b = q.data?.brief
  const bullets = b?.facts.bullets ?? []
  return (
    <Card>
      <CardHeader title="Morning brief" action={
        <div className="flex items-center gap-2">
          {b && <AiLabel text={b.label} />}
          <Button size="sm" variant="ghost" title="Write it again from the latest figures" pending={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      } />
      <div className="px-[var(--card-pad)] py-3">
        {q.isLoading && <p className="text-sm text-muted-foreground">Reading today's figures...</p>}
        {b && (
          <ul className="space-y-1.5 text-sm">
            {bullets.map((x, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="text-muted-foreground">•</span>
                {x.link ? <Link className="hover:underline" to={x.link}>{x.text}</Link> : <span>{x.text}</span>}
              </li>
            ))}
          </ul>
        )}
        {(q.data?.message || refresh.data?.message) && <p className="mt-2 text-xs text-muted-foreground">{refresh.data?.message ?? q.data?.message}</p>}
        {refresh.isError && <p className="mt-2 text-xs text-destructive">{(refresh.error as Error).message}</p>}
        {b && <p className="mt-2 text-[11px] text-muted-foreground">For {b.period_key}. Check the figures on their screens before acting.</p>}
      </div>
    </Card>
  )
}
