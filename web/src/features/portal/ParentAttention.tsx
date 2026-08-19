import { useQuery } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardHeader, Badge, Button } from '@/components/ui'

/* What needs a parent, on the dashboard itself.
 *
 * The same items had a screen of their own, one click away — and one click
 * away is where an unpaid fee or an unexplained absence goes to be missed. A
 * parent opens this application because something needs them; making them find
 * it on a second tab inverts the reason they came.
 *
 * Silent when there is nothing. A card that says "nothing needs you" every day
 * teaches people to skip the place where the thing that does need them will
 * eventually appear.
 */

interface Item {
  key: string
  severity: string
  headline: string
  detail?: string
  href?: string
  action?: string
}

const TONE: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
}

export default function ParentAttention() {
  const q = useQuery({
    queryKey: ['attention', 'self'],
    queryFn: () => api.get<{ items: Item[] }>('/api/v1/attention'),
  })

  const items = q.data?.items ?? []
  if (q.isLoading || q.error || !items.length) return null

  const urgent = items.filter((i) => i.severity === 'critical').length

  return (
    <Card className="mb-4">
      <CardHeader
        title={urgent ? `${urgent} ${urgent === 1 ? 'thing needs' : 'things need'} you now` : 'Needs you'}
        description="Fees, absences and anything the school is waiting on."
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
              {i.detail && <div className="text-[13px] text-muted-foreground">{i.detail}</div>}
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
  )
}
