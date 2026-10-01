import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Select, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'
import { type VendorTicket } from '../super_admin/platform-lib'
import { useOptimisticMutation } from '@/lib/optimistic'

const BASE = '/api/v1/admin/platform/seller/tickets'

const STATUS_NAME: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting', resolved: 'Resolved', closed: 'Closed' }
const STATUS_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral'> = { open: 'info', in_progress: 'warning', waiting: 'neutral', resolved: 'success', closed: 'neutral' }

/**
 * The vendor's support queue.
 *
 * Narrow on purpose. support_tickets carries two things that look identical
 * and could not be more different in who may read them: a school reporting a
 * fault to the vendor, and a parent raising a concern with the school about a
 * named teacher, a child's discipline record or a safety incident.
 *
 * Only the first kind appears here. The filter is a column on the ticket, and
 * it is not a convention a later query can forget — the schema refuses to mark
 * a ticket vendor-visible while it names a child.
 */
export default function SupportTickets() {
  const [status, setStatus] = useState('')
  const [focus, setFocus] = useState<{ by: string; key: string } | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform', 'tickets', status],
    queryFn: () => api.get<List<VendorTicket>>(status ? `${BASE}?status=${status}` : BASE),
  })
  /* Take and Resolve answer at once (lib/optimistic). The ticket changes in
     every open filter of this queue the moment it is pressed; the server's
     answer then replaces the guess, or puts it back with the reason. */
  const update = useOptimisticMutation<{ path: string; body: { status: string } }>({
    mutationFn: ({ path, body }) => api.post(`/api/v1/admin/platform${path}`, body),
    queryKeys: [['platform', 'tickets']],
    apply: (old, v, key) => {
      const l = old as List<VendorTicket>
      const id = v.path.split('/').pop()
      const filter = String((key as unknown[])[2] ?? '')
      const next = l.items.map((t) => (t.id === id ? { ...t, status: v.body.status, breached: v.body.status === 'resolved' ? false : t.breached } : t))
      // In a filtered view a ticket that no longer matches leaves it.
      return { ...l, items: filter ? next.filter((t) => t.status === filter) : next }
    },
    failure: "Couldn't update the ticket",
  })

  if (isLoading && !data) return <SkeletonTable columns={8} />
  if (error) return <ErrorState error={error} />

  const all = data?.items ?? []
  /* Breached, not stale.

     "Open 7 days or more" was the only alarm, and it is the wrong one: an
     Enterprise school that cannot take fees is failed after four hours, and a
     trial school's cosmetic question is not failed after five days. The
     promise comes from the plan the school actually pays for, so the number
     that matters is how many of those promises are broken right now. */
  const close = (t: VendorTicket) => !t.breached && t.promised_hours > 0 && t.open_hours >= t.promised_hours * 0.75
  const sla = (t: VendorTicket) => (t.breached ? 'past' : close(t) ? 'close' : 'kept')

  /* THE FIGURES ARE THE FILTERS. Each card says what its number is made of,
     and pressing a part of it narrows the table to exactly those tickets;
     pressing it again, or Clear, shows them all. One focus at a time. */
  const tests: Record<string, (t: VendorTicket, key: string) => boolean> = {
    status: (t, k) => t.status === k,
    priority: (t, k) => t.priority === k,
    sla: (t, k) => sla(t) === k,
    owner: (t, k) => (k === 'none' ? !t.assigned_to : t.assigned_to === k),
  }
  const items = focus ? all.filter((t) => tests[focus.by](t, focus.key)) : all
  const pick = (by: string) => (key: string | null) => setFocus(key ? { by, key } : null)
  const on = (by: string) => (focus?.by === by ? focus.key : null)
  const count = <K extends string>(of: (t: VendorTicket) => K) => {
    const m = new Map<K, number>()
    for (const t of all) m.set(of(t), (m.get(of(t)) ?? 0) + 1)
    return m
  }
  const byStatus = count((t) => t.status), byPriority = count((t) => t.priority), bySla = count(sla)
  const byOwner = count((t) => t.assigned_to ?? '')
  const urgent = (byPriority.get('urgent') ?? 0) + (byPriority.get('high') ?? 0)
  const breached = bySla.get('past') ?? 0, nearly = bySla.get('close') ?? 0
  const unassigned = byOwner.get('') ?? 0
  const age = (h: number) => (h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`)
  const oldest = all.reduce<VendorTicket | null>((a, t) => (!a || t.open_hours > a.open_hours ? t : a), null)
  const worst = all.filter((t) => t.breached).reduce<VendorTicket | null>((a, t) => (!a || t.open_hours - t.promised_hours > a.open_hours - a.promised_hours ? t : a), null)
  const waiting = all.filter((t) => !t.assigned_to).reduce<VendorTicket | null>((a, t) => (!a || t.open_hours > a.open_hours ? t : a), null)
  const busiest = [...byOwner].filter(([k]) => k).sort((a, b) => b[1] - a[1])[0]
  /* Raised per day over the last fortnight, from the tickets on screen. */
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86_400_000)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { label: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }), value: all.filter((t) => t.created_at.slice(0, 10) === iso).length }
  })
  const focusName = focus
    ? focus.by === 'status' ? STATUS_NAME[focus.key] ?? focus.key
      : focus.by === 'priority' ? `${focus.key[0].toUpperCase()}${focus.key.slice(1)} priority`
      : focus.by === 'sla' ? { past: 'Past what we promised', close: 'Close to the limit', kept: 'Within the promise' }[focus.key] ?? focus.key
      : focus.key === 'none' ? 'Unassigned' : `Held by ${focus.key}`
    : ''

  const tone = (p: string) =>
    p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : p === 'normal' ? 'neutral' : 'info'

  return (
    <>
      <PageHead
        eyebrow="Support"
        title="Support tickets"
        description="Faults schools have reported to the vendor, with the tenant, severity, owner and time open."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="In the queue"
            value={all.length}
            detail={oldest ? <>Oldest has waited <b className="font-semibold text-foreground">{age(oldest.open_hours)}</b>, from {oldest.school ?? 'a school'}.</> : 'Nothing is waiting.'}
            parts={['open', 'in_progress', 'waiting', 'resolved', 'closed'].map((k) => ({ key: k, label: STATUS_NAME[k], value: byStatus.get(k) ?? 0, tone: k === 'open' ? ('primary' as const) : STATUS_TONE[k] }))}
            onPart={pick('status')}
            activePart={on('status')}
            trend={all.length ? days : undefined}
            period={all.length ? 'Raised per day, last 14 days. Point at the line for a day.' : undefined}
          />
          <Stat
            label="High or urgent"
            value={urgent}
            detail={urgent ? `${byPriority.get('urgent') ?? 0} urgent and ${byPriority.get('high') ?? 0} high, out of ${all.length}.` : 'Nothing marked high or urgent.'}
            parts={(['urgent', 'high', 'normal', 'low'] as const).map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1), value: byPriority.get(k) ?? 0, tone: tone(k) }))}
            onPart={pick('priority')}
            activePart={on('priority')}
          />
          <Stat
            label="Past what we promised"
            value={breached}
            detail={
              worst
                ? <>Furthest over: <b className="font-semibold text-foreground">{age(worst.open_hours - worst.promised_hours)}</b> past the {worst.promised_hours} h promised to {worst.school ?? 'a school'}.</>
                : nearly ? `None broken yet; ${nearly} within a quarter of the limit.` : all.length ? 'Every promise is being kept.' : 'No promises running.'
            }
            parts={[
              { key: 'past', label: 'Past', value: breached, tone: 'danger' as const },
              { key: 'close', label: 'Close', value: nearly, tone: 'warning' as const },
              { key: 'kept', label: 'Within', value: bySla.get('kept') ?? 0, tone: 'success' as const },
            ]}
            onPart={pick('sla')}
            activePart={on('sla')}
          />
          <Stat
            label="Unassigned"
            value={unassigned}
            detail={
              waiting
                ? <>Longest without an owner: <b className="font-semibold text-foreground">{age(waiting.open_hours)}</b>.{busiest ? ` ${busiest[0]} holds the most, ${busiest[1]}.` : ''}</>
                : all.length ? `Every ticket has an owner.${busiest ? ` ${busiest[0]} holds the most, ${busiest[1]}.` : ''}` : 'Nothing to assign.'
            }
            parts={[
              { key: 'none', label: 'Nobody', value: unassigned, tone: 'warning' as const },
              ...[...byOwner].filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => ({ key: k, label: k.split(' ')[0], value: n, tone: 'success' as const })),
            ]}
            onPart={pick('owner')}
            activePart={on('owner')}
          />
        </CellGrid>

        {focus && (
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">Showing</span>
            <span className="rounded-full bg-primary/10 px-2.5 py-1 font-semibold text-primary">{focusName} · {items.length}</span>
            <Button variant="ghost" size="sm" onClick={() => setFocus(null)}>Clear</Button>
          </p>
        )}

        <Card>
          <CardHeader
            title="Queue"
            description="Grievances a parent raised with their school are not in this table and cannot be put in it"
            action={
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'Everything not closed' },
                  { value: 'open', label: 'Open' },
                  { value: 'in_progress', label: 'In progress' },
                  { value: 'waiting', label: 'Waiting' },
                  { value: 'resolved', label: 'Resolved' },
                  { value: 'closed', label: 'Closed' },
                ]}
              />
            }
          />
          <Table
            head={['School', 'Subject', 'Category', 'Priority', 'Open', 'Owner', 'Status', '']}
            empty={!items.length}
            emptyLabel={focus ? 'No ticket matches that. Press Clear to see the whole queue.' : "Nothing in the queue. A school reports a fault from its own support screen, which is the only way a ticket reaches here."}
          >
            {items.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">{t.school ?? '-'}</Td>
                <Td>
                  {t.subject}
                  {t.body && (
                    <span className="block max-w-[42ch] truncate text-[12px] text-muted-foreground">
                      {t.body}
                    </span>
                  )}
                </Td>
                <Td className="capitalize">{t.category.replace(/_/g, ' ')}</Td>
                <Td>
                  <Badge tone={tone(t.priority)}><span className="capitalize">{t.priority}</span></Badge>
                </Td>
                {/* The clock against the promise, in one cell. Two numbers
                    side by side say more than either alone: 30h against a
                    promise of 8h is a different conversation from 30h against
                    72h, and the queue could not tell them apart. */}
                <Td className="num">
                  <span className={t.breached ? 'font-medium text-destructive' : undefined}>
                    {t.open_hours < 48 ? `${t.open_hours}h` : `${t.open_days}d`}
                  </span>
                  {t.promised_hours > 0 && (
                    <span className="block text-[12px] text-muted-foreground">
                      {t.breached ? 'past ' : 'of '}
                      {t.promised_hours}h
                      {t.plan_name ? ` · ${t.plan_name}` : ' · no plan'}
                    </span>
                  )}
                </Td>
                <Td className="whitespace-nowrap">{t.assigned_to ?? <span className="text-muted-foreground">Unassigned</span>}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>{STATUS_NAME[t.status] ?? t.status}</Badge>
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {t.status === 'open' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({ path: `/seller/tickets/${t.id}`, body: { status: 'in_progress' } })
                        }
                      >
                        Take
                      </Button>
                    )}
                    {t.status !== 'resolved' && t.status !== 'closed' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({ path: `/seller/tickets/${t.id}`, body: { status: 'resolved' } })
                        }
                      >
                        Resolve
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
          {update.isError && (
            <div className="border-t p-5">
              <FormNotice error={update.error} />
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
