import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarX2, CheckCircle2, ShieldAlert, UserMinus } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  FormNotice, Input, Select, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'
import { cn } from '@/lib/utils'

/* The first job of the morning in every Indian school.

   Who is not in today, which of their periods that leaves uncovered, and who
   is free in each one. The candidate list is worked out on the server rather
   than by the person holding the timetable on paper: a proxy who is not
   actually free just moves the uncovered class somewhere else.

   A teacher who already takes the subject is offered first, because a free
   period held by somebody who knows the subject is a lesson and anybody else
   is a supervised hour. */

interface Candidate {
  user_id: string
  full_name: string
  teaches_subject: boolean
  periods_today: number
}

interface Slot {
  timetable_entry_id: string
  absent_user_id: string
  absent_teacher: string
  reason: string
  period: string
  period_sequence: number
  starts_at: string
  class_name: string
  section: string
  subject: string
  covered_by?: string
  covered_by_user_id?: string
  /* The proxy who is themselves not in.
   *
   * A substitution stands once made; the board is a morning's decisions and
   * re-shuffling them under the office's feet would be worse than staleness.
   * The one thing that must reopen a settled period is the substitute going
   * absent — leave approved at 8:40 for a proxy given at 8:20. Until now that
   * period still read "covered", and the class got nobody. */
  cover_absent?: boolean
  /** A pick waiting for the principal. */
  waiting_for?: string
  candidates: Candidate[]
}

interface BoardResponse {
  items: Slot[]
  on_date: string
  can_approve: boolean
  away: { user_id: string; full_name: string; reason: string; periods_today: boolean }[]
  summary: {
    absent_teachers: number
    periods: number
    covered: number
    uncovered: number
    no_candidate: number
  }
}

/* Today where the school is, not today in Greenwich.

   This was `new Date().toISOString().slice(0, 10)`, which is the UTC date.
   Every browser west of Greenwich crosses into the next UTC day during the
   working evening, so the screen a head teacher opens to see who is away
   opened on tomorrow — a board with nobody absent on it, because tomorrow's
   register has not been marked. Built from the local parts instead, which is
   the same date the person is standing in. */
const today = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* The date said in words beside the picker.

   `<input type="date">` prints in the browser's locale and nothing on the
   page can change that, so an Indian school on a browser set to US English
   reads 08/24/2026 and has to work out which half is the month. The input
   keeps the native picker and its keyboard; the words say which day it is. */
const spellDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return ''
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

/* ONE ABSENT TEACHER AT A TIME (Yajur, 2026-10-23). The absent list on the
   left; their periods on the right, each a card with who is free, an optional
   note for the substitute, and Send for approval. A card says Pending until
   the principal approves and Approved after; the principal's own pick is
   Pending too. Approval tells both teachers and puts the class on the
   substitute's timetable (scheduling/cover.ts). */
export default function SubstitutionBoard() {
  const nav = useRouteFeature()
  const qc = useQueryClient()
  const [onDate, setOnDate] = useState(today())
  const [who, setWho] = useState('')

  const board = useQuery({
    queryKey: ['substitution-board', onDate],
    queryFn: () => api.get<BoardResponse>(`/api/v1/academics/admin/substitution-board?on_date=${onDate}`),
  })

  if (board.isLoading && !board.data) return <SkeletonTiles count={4} label="Reading this morning’s register…" />
  if (board.error) return <ErrorState error={board.error} />

  const rows = board.data?.items ?? []
  const s = board.data?.summary
  const canApprove = board.data?.can_approve ?? false
  const away = board.data?.away ?? []
  const periodsOf = (id: string) => rows.filter((r) => r.absent_user_id === id)
  const selected = away.find((a) => a.user_id === who) ?? away.find((a) => a.periods_today) ?? away[0]
  const theirs = selected ? periodsOf(selected.user_id) : []

  return (
    <>
      <PageHead
        eyebrow={nav.section?.name ?? 'Academics'}
        title={nav.feature?.name ?? 'Substitutions'}
        description="Pick an absent teacher, then a free teacher for each of their periods."
        actions={
          <div className="flex items-center gap-2">
            <Input type="date" value={onDate} onChange={(v) => { setOnDate(v); setWho('') }} aria-label="Date" className="w-44" />
            <span className="text-[13px] text-muted-foreground">{spellDate(onDate)}</span>
          </div>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Absent" value={away.length} icon={UserMinus} />
          <Stat label="Periods to cover" value={s?.periods ?? 0} icon={CalendarX2} />
          <Stat label="Approved" value={s?.covered ?? 0} icon={CheckCircle2} />
          <Stat label="Nobody free" value={s?.no_candidate ?? 0} icon={ShieldAlert} />
        </CellGrid>

        {away.length === 0 ? (
          <Card>
            <EmptyState title="Nobody is absent" body="Mark absent teachers in the Staff register, or approve their leave; they then appear here to cover." />
          </Card>
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
            <Card className="min-w-0">
              <CardHeader title="Absent" />
              <ul className="flex flex-col gap-2 p-3">
                {away.map((a) => {
                  const n = periodsOf(a.user_id).length
                  const on = selected?.user_id === a.user_id
                  return (
                    <li key={a.user_id}>
                      <button type="button" onClick={() => setWho(a.user_id)} aria-pressed={on}
                        className={cn('flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-[14px] font-medium transition-colors',
                          on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-surface-hover')}>
                        <span className="min-w-0 truncate">{a.full_name}</span>
                        <Badge tone={n ? 'danger' : 'neutral'} className="shrink-0">{n} {n === 1 ? 'class' : 'classes'}</Badge>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Card>

            <div className="flex min-w-0 flex-col gap-4">
              {selected && (
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
                    <h2 className="text-[16px] font-bold">{selected.full_name}</h2>
                    <span className="text-[13px] text-muted-foreground">
                      {selected.reason === 'absent' ? 'Marked absent' : 'On leave'} · {theirs.length} {theirs.length === 1 ? 'period' : 'periods'} to cover
                    </span>
                  </div>
                </Card>
              )}
              {selected && theirs.length === 0 && (
                <Card><EmptyState title="No classes today" body="Nothing to cover for this teacher on this date." /></Card>
              )}
              {theirs.map((r) => (
                <PeriodCard key={r.timetable_entry_id} slot={r} onDate={onDate} canApprove={canApprove}
                  onDone={() => qc.invalidateQueries({ queryKey: ['substitution-board'] })} />
              ))}
            </div>
          </div>
        )}
      </PageBody>
    </>
  )
}

/** One period of the absent teacher: who takes it, a note, and where it stands. */
function PeriodCard({ slot, onDate, canApprove, onDone }: { slot: Slot; onDate: string; canApprove: boolean; onDone: () => void }) {
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  const teachers = useQuery({
    queryKey: ['timetable-teachers'],
    queryFn: () => api.call('GET /timetable/teachers'),
    staleTime: 5 * 60_000,
  })
  const send = useMutation({
    mutationFn: () => api.post('/api/v1/timetable-cover/propose', { timetable_entry_id: slot.timetable_entry_id, substitute_user_id: pick, on_date: onDate, note }),
    onSuccess: () => { setPick(''); setNote(''); onDone() },
  })
  const approve = useMutation({
    mutationFn: () => api.post('/api/v1/timetable-cover/approve', { timetable_entry_id: slot.timetable_entry_id, on_date: onDate }),
    onSuccess: onDone,
  })
  const free = new Set(slot.candidates.map((c) => c.user_id))
  const others = (teachers.data?.items ?? []).filter((t) => !free.has(t.user_id) && t.user_id !== slot.absent_user_id)
  const approved = !!slot.covered_by && !slot.cover_absent

  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <Badge tone="neutral" className="tabular-nums">{slot.period} · {slot.starts_at}</Badge>
            <span className="text-[14.5px] font-semibold">{slot.class_name} - {slot.section}</span>
            <Badge tone="info">{slot.subject}</Badge>
          </div>
          <span className="text-[13px] text-muted-foreground">{slot.candidates.length} free</span>
        </div>

        {approved ? (
          <Badge tone="success" className="self-start">Approved · {slot.covered_by} is taking this class</Badge>
        ) : slot.waiting_for ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">Pending · {slot.waiting_for}</Badge>
            {canApprove && <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate()}>Approve</Button>}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
            <Select value={pick} onChange={setPick}
              placeholder={slot.candidates.length ? 'Choose a free teacher' : 'Nobody free, choose anyway'}
              options={[
                ...slot.candidates.map((c) => ({ value: c.user_id, label: `${c.full_name}, free${c.teaches_subject ? `, takes ${slot.subject}` : ''}` })),
                ...others.map((t) => ({ value: t.user_id, label: `${t.full_name}, busy this period` })),
              ]} />
            <Input value={note} onChange={setNote} placeholder="Note for the substitute (optional)" />
            <Button disabled={!pick || send.isPending} onClick={() => send.mutate()}>
              Send for approval
            </Button>
          </div>
        )}
        {slot.cover_absent && slot.covered_by && (
          <p className="text-[13.5px] text-destructive">{slot.covered_by} was covering this and is now absent too; choose somebody else.</p>
        )}
        <FormNotice error={send.error ?? approve.error} />
      </div>
    </Card>
  )
}
