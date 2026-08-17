import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, CheckCheck, Inbox, IndianRupee, PencilLine } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { cn, formatPaise } from '@/lib/utils'
import { useToast } from '@/components/Toast'

/* One queue instead of three.

   Leave sat on the HR screen, attendance corrections on the attendance screen
   and fee concessions on the finance screen. Nothing told a principal that any
   of them were waiting, so the answer to "is anything blocked on me?" was to
   remember to visit three places. Teachers learned to walk to the office
   instead, which is the failure mode an approval workflow exists to prevent.

   The server decides what belongs here from the viewer's permissions, so an
   accountant sees only the concessions and a head of school sees all three. */

interface Approval {
  id: string
  kind: string
  title: string
  detail: string
  requested_by?: string
  raised_at: string
  decide_url: string
  amount_paise?: number
}
interface Inboxed {
  items: Approval[]
  total: number
  by_kind: Record<string, number>
}

const KINDS: Record<string, { label: string; icon: typeof CalendarDays }> = {
  leave: { label: 'Leave', icon: CalendarDays },
  attendance_correction: { label: 'Attendance', icon: PencilLine },
  fee_concession: { label: 'Concession', icon: IndianRupee },
}

export default function Approvals() {
  const toast = useToast()
  const qc = useQueryClient()
  const [note, setNote] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.get<Inboxed>('/api/v1/workflow/approvals'),
    refetchInterval: 60_000,
  })

  const decide = useMutation({
    mutationFn: ({ url, approve, reason }: { url: string; approve: boolean; reason?: string }) =>
      api.post(url, { decision: approve ? 'approved' : 'rejected', note: reason }),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      toast.ok(v.approve ? 'Approved' : 'Rejected — the requester is told')
    },
  })

  if (isLoading) return <Loading label="Checking what is waiting on you…" />
  if (error) return <ErrorState error={error} />
  const d = data!
  const items = filter ? d.items.filter((i) => i.kind === filter) : d.items

  return (
    <>
      <PageHead
        eyebrow="Approvals"
        title={d.total === 0 ? 'Nothing is waiting on you' : `${d.total} waiting on you`}
        description="Leave, attendance corrections and fee concessions, in the order they were raised."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Waiting" value={d.total} icon={Inbox} />
          {Object.entries(KINDS).map(([key, k]) => (
            <Stat key={key} label={k.label} value={d.by_kind[key] ?? 0} icon={k.icon} />
          ))}
        </CellGrid>

        <Card>
          <CardHeader
            title="Queue"
            description={
              d.total === 0
                ? 'Every request has been decided.'
                : 'Oldest first — the one at the top has waited longest.'
            }
            action={
              <div className="flex gap-1.5">
                <FilterChip on={!filter} onClick={() => setFilter('')}>
                  All
                </FilterChip>
                {Object.entries(KINDS)
                  .filter(([k]) => (d.by_kind[k] ?? 0) > 0)
                  .map(([k, v]) => (
                    <FilterChip key={k} on={filter === k} onClick={() => setFilter(k)}>
                      {v.label} {d.by_kind[k]}
                    </FilterChip>
                  ))}
              </div>
            }
          />
          {items.length === 0 ? (
            <EmptyState
              title="Clear"
              body="Nothing of this kind is pending. New requests appear here as they are raised."
            />
          ) : (
            <ul className="divide-y">
              {items.map((it) => {
                const K = KINDS[it.kind] ?? { label: it.kind, icon: Inbox }
                const Icon = K.icon
                return (
                  <li key={it.id} className="px-5 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 gap-3">
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium">{it.title}</p>
                          <p className="mt-0.5 text-[14px] text-muted-foreground">{it.detail}</p>
                          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                            <Badge>{K.label}</Badge>
                            {it.requested_by && <span>raised by {it.requested_by}</span>}
                            <span>{waited(it.raised_at)}</span>
                            {it.amount_paise != null && (
                              <span className="tabular-nums">{formatPaise(it.amount_paise)}</span>
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Input
                          value={note[it.id] ?? ''}
                          onChange={(x) => setNote({ ...note, [it.id]: x })}
                          placeholder="Note (optional)"
                          className="w-40"
                        />
                        <Button
                          size="sm"
                          disabled={decide.isPending}
                          onClick={() =>
                            decide.mutate({ url: it.decide_url, approve: true, reason: note[it.id] })
                          }
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={decide.isPending}
                          onClick={() =>
                            decide.mutate({ url: it.decide_url, approve: false, reason: note[it.id] })
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {decide.isError && (
            <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
              {decide.error instanceof Error ? decide.error.message : 'Could not record the decision'}
            </p>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-0.5 text-[13px] transition-colors duration-150',
        on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}

/**
 * How long this has sat unanswered.
 *
 * An absolute timestamp makes a reader do arithmetic. The number that matters
 * to whoever is holding up a teacher's leave is the elapsed one.
 */
function waited(iso: string) {
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return 'just now'
  const hours = mins / 60
  if (hours < 24) return `${Math.round(hours)}h waiting`
  return `${Math.round(hours / 24)}d waiting`
}
