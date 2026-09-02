import { useQuery } from '@tanstack/react-query'
import { BellRing, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button,
  Loading, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { useT } from '@/lib/i18n'

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
  const t = useT()
  const q = useQuery({
    queryKey: ['attention', 'self'],
    queryFn: () => api.get<Attention>('/api/v1/attention'),
  })

  if (q.isLoading) return <Loading label={t('portal.reminders.loading')} />
  if (q.error) return <ScreenError error={q.error} />

  const items = q.data?.items ?? []
  const urgent = items.filter((i) => i.severity === 'critical')

  return (
    <>
      <PageHead
        eyebrow={t('portal.reminders.eyebrow')}
        title={t('portal.reminders.title')}
        description={t('portal.reminders.description')}
      />
      <PageBody>
        {items.length === 0 ? (
          <Card>
            <EmptyState
              title={t('portal.reminders.empty_title')}
              body={t('portal.reminders.empty_body')}
            />
          </Card>
        ) : (
          <Card>
            <CardHeader
              title={
                urgent.length
                  ? t('portal.reminders.card_title_urgent', { count: urgent.length })
                  : t('portal.reminders.card_title')
              }
              description={t('portal.reminders.card_description')}
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
            {t('portal.reminders.footnote')}
          </p>
        )}
      </PageBody>
    </>
  )
}
