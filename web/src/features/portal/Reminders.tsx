import { useQuery } from '@tanstack/react-query'
import { BellRing, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* Things waiting on you.

   This was the same component as My day, so a child clicking either menu item
   got the same page — two entries in the catalogue, one screen, and no way to
   tell which one you were looking at. My day answers "what is happening";
   this answers "what have I not done", and only the second is a list that
   should ever be empty.

   The server already computed this. /api/v1/attention runs a set of probes
   filtered by what the caller may see, and emits nothing for a probe that
   counts zero — "0 payments failed" is a line of reassurance that costs a
   line of attention, and a panel of those trains people to stop reading it. */

interface Item {
  key: string
  severity: 'critical' | 'warning' | 'info' | string
  count: number
  headline: string
  detail?: string
  action: string
  href?: string
}
interface Attention {
  greeting?: string
  items: Item[]
}

const TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
}

export default function Reminders() {
  const q = useQuery({
    queryKey: ['attention', 'self'],
    queryFn: () => api.get<Attention>('/api/v1/attention'),
  })

  if (q.isLoading) return <Loading label="Checking what needs doing…" />
  if (q.error) return <ErrorState error={q.error} />

  const items = q.data?.items ?? []
  const urgent = items.filter((i) => i.severity === 'critical')

  return (
    <>
      <PageHead
        eyebrow="Reminders"
        title="Waiting on you"
        description="Homework not turned in, fees not paid, notices not acknowledged — only the things that still need an action."
      />
      <PageBody>
        {items.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing outstanding"
              body="Everything the school has asked of you is done. This list stays empty until something needs doing."
            />
          </Card>
        ) : (
          <Card>
            <CardHeader
              title={urgent.length ? `${urgent.length} needing attention now` : 'To do'}
              description="Most pressing first."
            />
            <ul className="divide-y">
              {items.map((i) => (
                <li key={i.key} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <BellRing
                    className={
                      i.severity === 'critical'
                        ? 'mt-0.5 h-4 w-4 shrink-0 text-destructive'
                        : 'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground'
                    }
                    aria-hidden
                  />
                  <div className="min-w-[14rem] flex-1">
                    <div className="font-medium">{i.headline}</div>
                    {i.detail && (
                      <div className="text-[13px] text-muted-foreground">{i.detail}</div>
                    )}
                  </div>
                  <Badge tone={TONE[i.severity] ?? 'neutral'}>{i.severity}</Badge>
                  {i.href && (
                    <Button size="sm" variant="secondary" onClick={() => (window.location.hash = i.href!)}>
                      {i.action}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {items.length > 0 && (
          <p className="flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Anything already done drops off this list on its own.
          </p>
        )}
      </PageBody>
    </>
  )
}
