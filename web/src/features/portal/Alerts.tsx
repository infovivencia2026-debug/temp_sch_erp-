import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BookOpen, CalendarX2, Megaphone, Receipt } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Select,
  Field, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useT, type MessageKey } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'

/* Everything the school has told you, in the order it happened.

   This is deliberately not the "needs attention" panel. That one answers "what
   is still outstanding" and empties itself as things are dealt with; this is a
   dated log, so an alert survives the fact that produced it being resolved —
   which is what lets a parent say "you never told me" and be answered.

   The feed polls. There is no vendor push here and no device token, because a
   real phone notification means FCM or APNs and neither is wired; each poll
   materialises anything new into a durable row that carries its own read mark.
   Wiring a real sender later means reading rows this already writes. */

interface Alert {
  id: string
  kind: string
  title: string
  body?: string
  link?: string
  student_id?: string
  student_name?: string
  created_at: string
  read_at?: string
}

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  circular: Megaphone,
  attendance: CalendarX2,
  fee_due: Receipt,
  homework: BookOpen,
  ptm: Bell,
  event: Bell,
}

const TONE: Record<string, 'danger' | 'warning' | 'info' | 'primary' | 'neutral'> = {
  fee_due: 'danger',
  attendance: 'warning',
  homework: 'info',
  circular: 'neutral',
  ptm: 'primary',
  event: 'primary',
}

const LABEL: Record<string, MessageKey> = {
  fee_due: 'portal.alerts.kind_fee_due',
  attendance: 'portal.alerts.kind_attendance',
  homework: 'portal.alerts.kind_homework',
  circular: 'portal.alerts.kind_circular',
  ptm: 'portal.alerts.kind_ptm',
  event: 'portal.alerts.kind_event',
}

function when(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export default function Alerts() {
  const t = useT()
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()

  const query = useQuery({
    queryKey: ['portal-alerts', studentId],
    queryFn: () =>
      api.get<{ items: Alert[]; unread: number }>(
        `/api/v1/portal/notifications${studentId ? `?student_id=${studentId}` : ''}`,
      ),
    // Near-real-time without a vendor. Half a minute is often enough for a
    // circular and cheap enough not to matter.
    refetchInterval: 30_000,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['portal-alerts'] })
  const readOne = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/portal/notifications/${id}/read`, {}),
    onSuccess: invalidate,
  })
  const readAll = useMutation({
    mutationFn: () => api.post('/api/v1/portal/notifications/read-all', {}),
    onSuccess: invalidate,
  })

  if (query.isLoading) return <Loading label={t('portal.alerts.loading')} />
  if (query.error) return <ErrorState error={query.error} />

  const items = query.data?.items ?? []
  const unread = query.data?.unread ?? 0

  return (
    <>
      <PageHead
        eyebrow={t('portal.alerts.eyebrow')}
        title={t('portal.alerts.title')}
        description={t('portal.alerts.description')}
        actions={
          unread > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => readAll.mutate()}>
              {t('portal.alerts.action_mark_all_read')}
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.alerts.stat_unread')} value={unread} icon={Bell} />
          <Stat label={t('portal.alerts.stat_fee_alerts')} value={items.filter((a) => a.kind === 'fee_due').length} icon={Receipt} />
          <Stat label={t('portal.alerts.stat_absences_flagged')} value={items.filter((a) => a.kind === 'attendance').length} icon={CalendarX2} />
        </CellGrid>

        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label={t('portal.alerts.field_child')} hint={t('portal.alerts.field_child_hint')}>
                <Select
                  value={chosen}
                  onChange={setChosen}
                  options={[{ value: '', label: t('portal.alerts.all_children') }, ...childOptions(children)]}
                />
              </Field>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title={t('portal.alerts.card_title')}
            description={t('portal.alerts.card_description', { count: items.length })}
          />
          {items.length === 0 ? (
            <EmptyState
              title={t('portal.alerts.empty_title')}
              body={t('portal.alerts.empty_body')}
            />
          ) : (
            <ul className="divide-y">
              {items.map((a) => {
                const Icon = ICON[a.kind] ?? Bell
                return (
                  <li
                    key={a.id}
                    className={`flex items-start gap-4 px-5 py-3 ${a.read_at ? 'text-muted-foreground' : ''}`}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className={`text-[14px] ${a.read_at ? '' : 'font-medium'}`}>{a.title}</p>
                      {a.body && <p className="text-[13px] text-muted-foreground">{a.body}</p>}
                      <p className="mt-0.5 text-[12px] text-muted-foreground">
                        {when(a.created_at)}
                        {a.student_name && ` · ${a.student_name}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge tone={TONE[a.kind] ?? 'neutral'}>{LABEL[a.kind] ? t(LABEL[a.kind]) : a.kind}</Badge>
                      {!a.read_at && (
                        <Button variant="ghost" size="sm" onClick={() => readOne.mutate(a.id)}>
                          {t('portal.alerts.action_dismiss')}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}
