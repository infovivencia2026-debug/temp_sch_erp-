import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarX2, CheckCircle2, ShieldAlert, UserMinus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge,
  FormNotice, Input, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'

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
  candidates: Candidate[]
}

interface BoardResponse {
  items: Slot[]
  on_date: string
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

export default function SubstitutionBoard() {
  const nav = useRouteFeature()
  const qc = useQueryClient()
  const [onDate, setOnDate] = useState(today())

  const board = useQuery({
    queryKey: ['substitution-board', onDate],
    queryFn: () =>
      api.get<BoardResponse>(
        `/api/v1/academics/admin/substitution-board?on_date=${onDate}`,
      ),
  })

  // The write already exists on the timetable module; this screen decides who,
  // and that endpoint refuses a proxy who turns out not to be free after all.
  const cover = useMutation({
    mutationFn: (v: { timetable_entry_id: string; substitute_user_id: string }) =>
      api.post('/api/v1/timetable-admin/substitutions', {
        ...v,
        on_date: onDate,
        reason: 'Cover for an absent teacher',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['substitution-board'] }),
  })

  if (board.isLoading) return <Loading label="Reading this morning’s register…" />
  if (board.error) return <ErrorState error={board.error} />

  const rows = board.data?.items ?? []
  const s = board.data?.summary
  /* Somebody away with no timetabled periods used to make the whole board say
   * "nobody is absent", which is not "nothing to arrange" — it is "we have no
   * idea". Six of this school's twelve teachers have no periods at all. */
  const awayWithoutPeriods = (board.data?.away ?? []).filter((a) => !a.periods_today)

  return (
    <>
      <PageHead
        eyebrow={nav.section?.name ?? 'Academics'}
        title={nav.feature?.name ?? 'Substitutions'}
        description="Who is absent, the periods that leaves open, and the staff actually free to take them."
        actions={
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={onDate}
              onChange={setOnDate}
              aria-label="Board date"
              className="w-44"
            />
            <span className="text-[13px] text-muted-foreground">{spellDate(onDate)}</span>
          </div>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Absent today" value={s?.absent_teachers ?? 0} icon={UserMinus} />
          <Stat label="Periods affected" value={s?.periods ?? 0} icon={CalendarX2} />
          <Stat label="Covered" value={s?.covered ?? 0} icon={CheckCircle2} />
          <Stat
            label="Nobody free"
            value={s?.no_candidate ?? 0}
            icon={ShieldAlert}
            hint="Merge the class or send it to the library"
          />
        </CellGrid>

        {awayWithoutPeriods.length > 0 && (
          <Card>
            <CardHeader
              title="Away today, with nothing timetabled"
              description="Nothing to cover for these — they have no periods on the timetable. Worth knowing: it usually means their subjects were never allocated, not that they teach nothing."
            />
            <ul className="divide-y">
              {awayWithoutPeriods.map((a) => (
                <li key={a.user_id} className="flex items-center gap-3 px-1 py-2 text-[14px]">
                  <span className="font-medium">{a.full_name}</span>
                  <span className="text-muted-foreground">{a.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {rows.length === 0 ? (

          <Card>
            <EmptyState
              title="Nobody is absent"
              body="Absence is read from the staff register and from approved leave. Both are empty for this date."
            />
          </Card>
        ) : (
          <Card>
            <CardHeader
              title="Periods to cover"
              description="A teacher who already takes the subject is offered first; everybody listed is genuinely free in the period."
            />
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.timetable_entry_id} className="px-5 py-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium">
                        {r.period} · {r.starts_at} — {r.class_name}-{r.section} · {r.subject}
                      </p>
                      <p className="mt-0.5 text-[14px] text-muted-foreground">
                        {r.absent_teacher} is{' '}
                        {r.reason === 'leave' ? 'on leave' : 'marked absent'}
                      </p>
                      {/* Said, not silently un-covered. A period that goes
                          back on the list without explanation looks like the
                          board losing the morning's work. */}
                      {r.cover_absent && r.covered_by && (
                        <p className="mt-0.5 text-[13.5px] text-destructive">
                          {r.covered_by} was covering this and is now absent too — it needs
                          somebody else.
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {r.covered_by && !r.cover_absent ? (
                        <Badge tone="success">covered by {r.covered_by}</Badge>
                      ) : (
                        /* A dropdown rather than four buttons.
                         *
                         * The board printed the first four free teachers as
                         * buttons and silently dropped the rest, so a period
                         * with nine free teachers offered four of them and a
                         * head of department who wanted the fifth had no way
                         * to say so. And "nobody free" was shown as a dead end
                         * — which is exactly the period somebody has to be
                         * asked to cover anyway.
                         *
                         * Free teachers come first, marked with what they are
                         * carrying today and whether they take the subject.
                         * Everybody else follows under a heading that says
                         * what choosing them means, because the person doing
                         * this at eight in the morning already knows their
                         * staff and is entitled to overrule the list. */
                        <AssignSelect
                          slot={r}
                          busy={cover.isPending}
                          onAssign={(userID) =>
                            cover.mutate({
                              timetable_entry_id: r.timetable_entry_id,
                              substitute_user_id: userID,
                            })
                          }
                        />
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="px-5 py-4">
              <FormNotice error={cover.error} />
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}


/**
 * Choosing who takes the period.
 *
 * Two groups in one list. The server worked out who is genuinely free in this
 * slot — no class of their own, not already promised elsewhere, not absent
 * themselves — and those are offered first with their load for the day. The
 * rest of the staff follow, labelled as busy, because a period nobody is free
 * for still has to be covered by somebody and the alternative on offer was a
 * red badge saying it could not be done.
 */
function AssignSelect({
  slot,
  busy,
  onAssign,
}: {
  slot: Slot
  busy: boolean
  onAssign: (userID: string) => void
}) {
  const teachers = useQuery({
    queryKey: ['timetable-teachers'],
    queryFn: () => api.get<List<{ user_id: string; full_name: string }>>('/api/v1/timetable/teachers'),
    staleTime: 5 * 60_000,
  })

  const free = new Set(slot.candidates.map((c) => c.user_id))
  const others = (teachers.data?.items ?? []).filter(
    (t) => !free.has(t.user_id) && t.user_id !== slot.absent_user_id,
  )

  return (
    <div className="min-w-[16rem]">
      <Select
        value=""
        onChange={(v) => v && onAssign(v)}
        placeholder={
          slot.candidates.length
            ? `${slot.candidates.length} free — choose one`
            : 'Nobody free — choose anyway'
        }
        options={[
          ...slot.candidates.map((c) => ({
            value: c.user_id,
            label:
              `${c.full_name} — free` +
              (c.teaches_subject ? `, takes ${slot.subject}` : '') +
              `, ${c.periods_today} today`,
          })),
          ...others.map((t) => ({
            value: t.user_id,
            label: `${t.full_name} — busy this period`,
          })),
        ]}
      />
      {busy && <p className="mt-1 text-[12px] text-muted-foreground">Assigning…</p>}
    </div>
  )
}
