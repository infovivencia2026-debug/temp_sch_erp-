import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'

/* SETUP: HOW FAR EACH SCHOOL HAS GOT, AND WHO HAS STOPPED.

   Nine milestones from "created" to "first parent signed in", each with the
   date it was first seen in the school's own records. Stalled means no
   progress for over a week inside the first sixty days, which is where a
   rollout quietly dies; those schools sort first. Nudge emails the school's
   administrator a checklist of what is left. */

interface Milestone { key: string; label: string; at: string | null }
interface Item {
  institution_id: string; school: string; status: string; created_at: string; milestones: Milestone[]
  done: number; total: number; complete: boolean; last_progress_at: string; days_since_progress: number; age_days: number
  stalled: boolean; next_steps: string[]; checked_at: string | null; scan_error: string | null; last_nudged_at: string | null; nudge_count: number
}
interface Resp { items: Item[]; milestones: { key: string; label: string }[]; stalled: number; checked_at: string | null; stall_days: number; window_days: number }
interface NudgeResult { queued: boolean; recipient: string | null; reason?: string; development: boolean; checklist: string[] }

const KEY = ['seller-onboarding']

export default function Onboarding() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<Resp>('/api/v1/seller/onboarding') })
  const scan = useMutation({
    mutationFn: () => api.post('/api/v1/seller/onboarding/scan'),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
  const [onlyStalled, setOnlyStalled] = useState(false)

  if (q.isLoading && !q.data) return <SkeletonTable columns={6} label="Reading each school's progress…" />
  if (q.error) return <ErrorState error={q.error} />
  const data = q.data!
  const items = [...data.items]
    .filter((x) => !onlyStalled || x.stalled)
    .sort((a, b) => Number(b.stalled) - Number(a.stalled) || Number(a.complete) - Number(b.complete) || b.days_since_progress - a.days_since_progress)
  const inWindow = data.items.filter((x) => x.age_days <= data.window_days)

  return (
    <>
      <PageHead
        eyebrow="Schools"
        title="Setup"
        description="How far each new school has got, and which step it is stuck on."
        actions={<Button variant="secondary" pending={scan.isPending} onClick={() => scan.mutate()}>Check schools now</Button>}
      />
      <PageBody>
        <FormNotice error={scan.error} />
        <CellGrid cols={4}>
          <Stat label="Stalled" value={data.stalled} hint={`No progress for over ${data.stall_days} days in the first ${data.window_days}`}
                active={onlyStalled} onClick={() => setOnlyStalled((s) => !s)} />
          <Stat label="In their first 60 days" value={inWindow.length} />
          <Stat label="Fully set up" value={data.items.filter((x) => x.complete).length} />
          <Stat label="Last checked" value={data.checked_at ? formatDateTime(data.checked_at) : 'Never'} />
        </CellGrid>
        <Card>
          <CardHeader title={onlyStalled ? 'Stalled schools' : 'Every school'} />
          <Table head={['School', 'Progress', 'Last progress', 'Next step', '']} empty={!items.length}
                 emptyLabel={onlyStalled ? 'No school is stalled.' : 'No schools yet.'}>
            {items.map((x) => <OnboardingRow key={x.institution_id} x={x} />)}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

function OnboardingRow({ x }: { x: Item }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const nudge = useMutation({
    mutationFn: () => api.post<NudgeResult>(`/api/v1/seller/onboarding/${x.institution_id}/nudge`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
  const sent = nudge.data
  return (
    <>
      <tr>
        <Td className="font-medium">
          <button type="button" className="text-left hover:underline" onClick={() => setOpen((o) => !o)}>{x.school}</button>
          <div className="text-[12px] text-muted-foreground">Created {formatDate(x.created_at)} · day {x.age_days}</div>
        </Td>
        <Td>
          <div className="flex items-center gap-1" aria-label={`${x.done} of ${x.total} milestones`}>
            {x.milestones.map((m) => (
              <span key={m.key} title={`${m.label}${m.at ? ': ' + formatDate(m.at) : ''}`}
                    className={cn('h-2.5 w-2.5 rounded-full', m.at ? 'bg-success' : 'bg-muted-foreground/25')} />
            ))}
            <span className="ml-2 text-[12px] tabular-nums text-muted-foreground">{x.done}/{x.total}</span>
          </div>
        </Td>
        <Td>
          {x.complete ? <Badge tone="success">Complete</Badge> : (
            <>
              {x.days_since_progress} days ago
              {x.stalled && <Badge tone="danger" className="ml-2">Stalled</Badge>}
            </>
          )}
        </Td>
        <Td>{x.next_steps[0] ?? '-'}{x.scan_error && <Badge tone="warning" className="ml-2">Could not read</Badge>}</Td>
        <Td>
          {!x.complete && (
            <Button size="sm" variant={x.stalled ? 'primary' : 'secondary'} pending={nudge.isPending} onClick={() => nudge.mutate()}>Nudge</Button>
          )}
          {x.last_nudged_at && <div className="mt-1 text-[12px] text-muted-foreground">Nudged {formatDate(x.last_nudged_at)} ({x.nudge_count}×)</div>}
          {sent && (
            <div className="mt-1 text-[12px] text-muted-foreground">
              {sent.queued ? `Queued to ${sent.recipient}` : `Not sent: ${sent.reason ?? 'unknown'}`}
            </div>
          )}
          <FormNotice error={nudge.error} />
        </Td>
      </tr>
      {open && (
        <tr>
          <Td colSpan={5}>
            <ul className="grid gap-1 sm:grid-cols-3">
              {x.milestones.map((m) => (
                <li key={m.key} className="flex items-center gap-2 text-[13px]">
                  {m.at ? <Check className="h-3.5 w-3.5 text-success" /> : <span className="h-3.5 w-3.5 rounded-full border" />}
                  <span className={m.at ? '' : 'text-muted-foreground'}>{m.label}</span>
                  {m.at && <span className="text-muted-foreground">{formatDate(m.at)}</span>}
                </li>
              ))}
            </ul>
          </Td>
        </tr>
      )}
    </>
  )
}
