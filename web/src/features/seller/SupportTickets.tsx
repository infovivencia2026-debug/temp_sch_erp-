import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Select, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'
import { usePlatformAction, type VendorTicket } from '../super_admin/platform-lib'

const BASE = '/api/v1/admin/platform/seller/tickets'

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
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform', 'tickets', status],
    queryFn: () => api.get<List<VendorTicket>>(status ? `${BASE}?status=${status}` : BASE),
  })
  const update = usePlatformAction('tickets')

  if (isLoading) return <SkeletonTable columns={8} />
  if (error) return <ErrorState error={error} />

  const items = data?.items ?? []
  const urgent = items.filter((t) => t.priority === 'urgent' || t.priority === 'high').length
  /* Breached, not stale.

     "Open 7 days or more" was the only alarm, and it is the wrong one: an
     Enterprise school that cannot take fees is failed after four hours, and a
     trial school's cosmetic question is not failed after five days. The
     promise comes from the plan the school actually pays for, so the number
     that matters is how many of those promises are broken right now. */
  const breached = items.filter((t) => t.breached).length
  const nearly = items.filter(
    (t) => !t.breached && t.promised_hours > 0 && t.open_hours >= t.promised_hours * 0.75,
  ).length
  const unassigned = items.filter((t) => !t.assigned_to).length

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
          <Stat label="Open" value={items.length} />
          <Stat label="High or urgent" value={urgent} />
          <Stat
            label="Past what we promised"
            value={breached}
            delta={
              breached
                ? { value: 'Owed an answer already', positive: false }
                : nearly
                  ? { value: `${nearly} close to the limit`, positive: false }
                  : { value: 'Every promise being kept', positive: true }
            }
          />
          <Stat label="Unassigned" value={unassigned} />
        </CellGrid>

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
            emptyLabel="Nothing in the queue. A school reports a fault from its own support screen, which is the only way a ticket reaches here."
          >
            {items.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">{t.school ?? '—'}</Td>
                <Td>
                  {t.subject}
                  {t.body && (
                    <span className="block max-w-[42ch] truncate text-[12px] text-muted-foreground">
                      {t.body}
                    </span>
                  )}
                </Td>
                <Td>{t.category}</Td>
                <Td>
                  <Badge tone={tone(t.priority)}>{t.priority}</Badge>
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
                <Td>{t.assigned_to ?? <span className="text-muted-foreground">Nobody</span>}</Td>
                <Td>{t.status}</Td>
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
