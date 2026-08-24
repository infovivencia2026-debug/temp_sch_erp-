import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Scale, ShieldAlert, Clock } from 'lucide-react'
import { api, ApiError, type List } from '@/lib/api'
import { formatDate, WEEKDAYS } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'

/* Staff shift and duty rostering.

   Non-teaching duty: the gate, the ground, exam invigilation, the transport
   escort, the library and the labs. Teaching load is not here — it lives in
   the timetable, and this screen reads it rather than restating it.

   The three checks are enforced at three different strengths, and the screen
   shows which is which because a user who cannot tell a hard rule from a
   warning will treat both as noise:

     double-booking   refused outright. Two duties at one time is never a
                      decision somebody meant to make.
     approved leave   refused outright. Rostering somebody who is away is how
                      a gate ends up unmanned at seven in the morning.
     teaching clash   reported, and overridable with a reason. Exam
                      invigilation legitimately replaces the lesson it clashes
                      with, and refusing that would block the commonest correct
                      roster in the school year.

   The conflicts tab recomputes rather than reading a stored verdict: leave is
   approved and timetables are republished after a roster is written, so a
   check that only ran at assignment time is stale by the following Monday. */

interface Shift {
  id: string
  code: string
  name: string
  duty_kind: string
  starts_at: string
  ends_at: string
  weekdays: number[]
  headcount: number
  is_onerous: boolean
  location?: string
  is_active: boolean
}

interface Duty {
  id: string
  shift_id: string
  shift_code: string
  shift_name: string
  duty_kind: string
  is_onerous: boolean
  user_id: string
  full_name: string
  employee_code?: string
  department?: string
  on_date: string
  starts_at: string
  ends_at: string
  status: string
  override_reason?: string
}

interface Clash {
  on_date: string
  user: string
  kind: string
  detail: string
}

interface Fairness {
  user_id: string
  full_name: string
  employee_code?: string
  department?: string
  duties: number
  onerous_duties: number
  hours: number
  onerous_index?: number
}

/* Somebody who can be given a duty.
 *
 * From the staff list, not the timetable. The dropdown used to read
 * /api/v1/timetable/teachers, which is behind academics.timetable.read — a
 * permission HR does not hold and should not: reading the school's timetable is
 * not part of rostering gate duty. So the request came back 403 and the form
 * offered nobody, on the one screen whose entire purpose is choosing a person.
 *
 * A duty is assigned to a user account rather than to an employee record,
 * because it has to appear on that person's own screen. Somebody appointed but
 * not yet given a login therefore cannot be rostered — said plainly below,
 * rather than by leaving them out of a list and hoping nobody looks. */
interface Teacher {
  id: string
  user_id?: string
  full_name?: string
  name?: string
  periods_this_week?: number
}

const TABS = [
  ['roster', 'Roster', CalendarClock],
  ['conflicts', 'Conflicts', ShieldAlert],
  ['fairness', 'Fair share', Scale],
] as const

const CLASH_TONE: Record<string, 'danger' | 'warning'> = {
  leave: 'danger',
  teaching: 'warning',
  unavailable: 'warning',
}

// The month around today, which is what a roster screen is almost always
// asked about.
function thisMonth() {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(first), to: iso(last) }
}

export default function Rostering() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('roster')
  const [range, setRange] = useState(thisMonth)

  const q = `?from=${range.from}&to=${range.to}`
  const shifts = useQuery({
    queryKey: ['hr-growth', 'shifts'],
    queryFn: () => api.get<List<Shift>>('/api/v1/hr-growth/roster/shifts'),
  })
  const roster = useQuery({
    queryKey: ['hr-growth', 'roster', range],
    queryFn: () => api.get<List<Duty>>(`/api/v1/hr-growth/roster${q}`),
  })
  const conflicts = useQuery({
    queryKey: ['hr-growth', 'conflicts', range],
    queryFn: () => api.get<List<Clash>>(`/api/v1/hr-growth/roster/conflicts${q}`),
  })

  /* "Nothing clashes" means two different things, and the check is only as
   * good as the timetable behind it. Somebody with no timetabled periods
   * cannot clash with a lesson — six of this school's twelve teachers — so a
   * clean result is read as assurance nobody was in a position to give. */
  const staff = useQuery({
    queryKey: ['hr-employees', 'active'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/hr/employees?status=active'),
    retry: false,
  })

  if (shifts.isLoading) return <Loading label="Reading the duty shifts…" />
  if (shifts.error) return <ErrorState error={shifts.error} />

  const duties = roster.data?.items ?? []
  const clashes = conflicts.data?.items ?? []
  const untimetabled = (staff.data?.items ?? []).filter((t) => !t.periods_this_week).length
  const onLeave = clashes.filter((c) => c.kind === 'leave')
  const onerous = duties.filter((d) => d.is_onerous).length
  const people = new Set(duties.map((d) => d.user_id)).size

  return (
    <>
      <PageHead
        eyebrow="Attendance"
        title="Staff duty roster"
        description="Assign staff to campus duties — gate, ground, exam supervision, bus escort, library and lab. You are warned if a duty clashes with a lesson they are already teaching."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input value={range.from} onChange={(v) => setRange({ ...range, from: v })} type="date" />
            <span className="text-[13px] text-muted-foreground">to</span>
            <Input value={range.to} onChange={(v) => setRange({ ...range, to: v })} type="date" />
          </div>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Duties rostered" value={duties.length} icon={CalendarClock}
            period={`${formatDate(range.from)} – ${formatDate(range.to)}`} />
          <Stat label="Staff on the roster" value={people} />
          <Stat label="Extra duties" value={onerous} icon={Clock}
            hint="Gate, ground, dispersal and escort" />
          <Stat label="Conflicts" value={clashes.length} icon={ShieldAlert}
            delta={onLeave.length
              ? { value: `${onLeave.length} rostered while on leave`, positive: false }
              : clashes.length
                ? { value: 'Teaching clashes only', positive: false }
                : untimetabled > 0
                  ? { value: `${untimetabled} staff have no timetable to check`, positive: false }
                  : { value: 'Nothing clashes', positive: true }} />
        </CellGrid>

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-current={tab === k}
              className={tab === k
                ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
              {k === 'conflicts' && clashes.length > 0 && (
                <span className="ml-0.5 rounded-sm bg-destructive/12 px-1.5 text-[12px] text-destructive">
                  {clashes.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === 'roster' && <RosterTab shifts={shifts.data?.items ?? []} duties={duties} />}
        {tab === 'conflicts' && <ConflictsTab clashes={clashes} />}
        {tab === 'fairness' && <FairnessTab range={range} />}
      </PageBody>
    </>
  )
}

/* Assigning a duty and cancelling one are employees.write
   (hr_growth.go:128-129); the roster, the shifts, the conflicts and the
   fairness figures are all reads on the group's employees.read, so a reader
   sees the whole roster and is not offered the buttons that would 403. */
function RosterTab({ shifts, duties }: { shifts: Shift[]; duties: Duty[] }) {
  const mayWrite = useCan()('hr.employees.write')
  const qc = useQueryClient()
  const [shift, setShift] = useState('')
  const [user, setUser] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [clashes, setClashes] = useState<Clash[]>([])

  /* Change who, what or when and the clash list and the override both lapse.

     The reason is written onto every duty it covers, so it is a record of why
     this person was rostered over that period — and it survived a change of
     person. Typing "Board practical; the period is suspended" for one teacher,
     then picking another from the list, left the reason in the box, the old
     clashes on screen describing an assignment nobody was making any more, and
     the button still reading "Roster anyway" — so a second teacher could be
     rostered carrying the first one's explanation, or over a clash-free slot
     that never needed one. */
  const retarget = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setClashes([])
    setReason('')
  }

  const teachers = useQuery({
    queryKey: ['hr-employees', 'active'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/hr/employees?status=active'),
    retry: false,
  })
  const rosterable = (teachers.data?.items ?? []).filter((t) => t.user_id)
  const withoutLogin = (teachers.data?.items ?? []).length - rosterable.length
  const invalidate = () => qc.invalidateQueries({ queryKey: ['hr-growth'] })

  const assign = useMutation({
    mutationFn: async () => {
      setClashes([])
      return api.post('/api/v1/hr-growth/roster', {
        shift_id: shift,
        user_ids: [user],
        from_date: from,
        to_date: to || undefined,
        override_reason: reason || undefined,
      })
    },
    onSuccess: () => {
      setReason('')
      invalidate()
    },
    onError: (e: unknown) => {
      // A teaching clash comes back as a 409. Naming what clashed is the
      // difference between a reason typed knowingly and one typed to make the
      // message go away, so the list is fetched and shown before the override
      // box appears. Through api.get rather than fetch, so it carries the same
      // credentials and acting-institution header as every other call.
      if (e instanceof ApiError && e.code === 'roster_clash') {
        void api
          .get<List<Clash>>(
            `/api/v1/hr-growth/roster/conflicts?from=${from}&to=${to || from}`,
          )
          .then((body) => setClashes(body.items ?? []))
          .catch(() => setClashes([]))
      }
    },
  })

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/hr-growth/roster/${id}/cancel`, {}),
    onSuccess: invalidate,
  })

  const nameOf = (t: Teacher) => t.full_name ?? t.name ?? t.id
  const chosen = shifts.find((s) => s.id === shift)

  // Grouped by day, because that is how a roster is read and pinned up.
  const byDate = duties.reduce<Record<string, Duty[]>>((acc, d) => {
    ;(acc[d.on_date] ??= []).push(d)
    return acc
  }, {})

  return (
    <>
      <Card>
        <CardHeader
          title="Roster somebody"
          description="A date or a range. A range is expanded into one duty per day using the shift's own weekday pattern, so every day can be checked, swapped or cancelled on its own."
        />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Shift" required
              hint={chosen ? `${chosen.starts_at}–${chosen.ends_at}, ${chosen.weekdays.map((d) => WEEKDAYS[d - 1]).join(' ')}` : undefined}>
              <Select value={shift} onChange={retarget(setShift)} placeholder="Choose a duty"
                options={shifts.filter((s) => s.is_active).map((s) => ({
                  value: s.id,
                  label: `${s.name} (${s.starts_at}–${s.ends_at})${s.is_onerous ? ' ·  unpopular' : ''}`,
                }))} />
            </Field>
            <Field
              label="Member of staff"
              required
              hint={
                teachers.error
                  ? 'The staff list could not be loaded, so there is nobody to choose.'
                  : withoutLogin > 0
                    ? `${withoutLogin} of your staff have no login yet, so they cannot be given a duty. Issue one on Staff records.`
                    : undefined
              }
            >
              <Select value={user} onChange={retarget(setUser)}
                placeholder={teachers.error ? 'Unavailable' : 'Choose'}
                options={rosterable.map((t) => ({ value: t.user_id!, label: nameOf(t) }))} />
            </Field>
            <Field label="From" required><Input value={from} onChange={retarget(setFrom)} type="date" /></Field>
            <Field label="To" hint="Leave blank for a single day"><Input value={to} onChange={retarget(setTo)} type="date" /></Field>
          </FormGrid>

          {clashes.length > 0 && (
            <div className="space-y-2 rounded-sm border border-warning/40 bg-warning/8 p-4">
              <p className="text-[14px] font-medium">
                This clashes with the timetable. Nothing has been rostered.
              </p>
              <ul className="space-y-0.5 text-[13px] text-muted-foreground">
                {clashes.map((c, i) => (
                  <li key={i}>{formatDate(c.on_date)} — {c.user}: {c.detail}</li>
                ))}
              </ul>
              <Field label="Why roster them anyway" wide
                hint="Recorded on every duty it applies to, so the roster carries its own explanation">
                <Textarea value={reason} onChange={setReason} rows={2}
                  placeholder="Board practical; the period is suspended for the whole section." />
              </Field>
            </div>
          )}

          <FormNotice error={assign.error} />
          <Button onClick={() => assign.mutate()}
            disabled={!mayWrite || !shift || !user || !from || assign.isPending ||
              (clashes.length > 0 && !reason.trim())}>
            {assign.isPending ? 'Rostering…' : clashes.length > 0 ? 'Roster anyway' : 'Roster'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="The roster" description="By day, as it goes on the staff room wall." />
        {duties.length === 0 ? (
          <EmptyState title="Nothing rostered in this range"
            body="Choose a shift and a person above, or widen the dates." />
        ) : (
          <div className="divide-y">
            {Object.entries(byDate).map(([date, rows]) => (
              <div key={date} className="p-5">
                <p className="mb-3 text-[14px] font-medium">{formatDate(date)}</p>
                <Table head={['Duty', 'Time', 'Who', 'Note', '']}>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <Td>
                        {d.shift_name}
                        {d.is_onerous && (
                          <span className="ml-2"><Badge tone="warning" solid>unpopular</Badge></span>
                        )}
                      </Td>
                      <Td>{d.starts_at}–{d.ends_at}</Td>
                      <Td>
                        <span className="font-medium">{d.full_name}</span>
                        {d.department && (
                          <span className="block text-[12.5px] text-muted-foreground">{d.department}</span>
                        )}
                      </Td>
                      <Td>
                        {d.override_reason
                          ? <span className="text-[12.5px] text-warning">{d.override_reason}</span>
                          : '—'}
                      </Td>
                      <Td className="text-right">
                        {mayWrite && (
                          <ConfirmButton
                            confirmLabel="Cancel duty"
                            question="The slot will be left unfilled until somebody else is rostered."
                            onConfirm={() => cancel.mutate(d.id)}
                          >
                            Cancel
                          </ConfirmButton>
                        )}
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}

function ConflictsTab({ clashes }: { clashes: Clash[] }) {
  return (
    <Card>
      <CardHeader
        title="Conflicts"
        description="Recomputed every time this is opened, not read from a stored verdict. Leave is approved and timetables are republished after a roster is written, so a check that only ran at assignment time is stale by the following Monday."
      />
      <Table head={['Date', 'Who', 'Kind', 'Detail']}
        empty={clashes.length === 0}
        emptyLabel="Nothing on this roster clashes with leave, teaching or a declared unavailability.">
        {clashes.map((c, i) => (
          <tr key={i}>
            <Td>{formatDate(c.on_date)}</Td>
            <Td><span className="font-medium">{c.user}</span></Td>
            <Td>
              <Badge tone={CLASH_TONE[c.kind] ?? 'neutral'}>
                {c.kind === 'leave' ? 'On approved leave'
                  : c.kind === 'teaching' ? 'Teaching that period'
                  : 'Declared unavailable'}
              </Badge>
            </Td>
            <Td>{c.detail}</Td>
          </tr>
        ))}
      </Table>
      {clashes.some((c) => c.kind === 'leave') && (
        <div className="border-t px-5 py-4 text-[13px] text-muted-foreground">
          A duty on a day of approved leave can only arise from leave granted
          <em> after</em> the roster was written — the database refuses it at the
          point of rostering. Cancel the duty and roster somebody else.
        </div>
      )}
    </Card>
  )
}

/* "Why is it always me."

   The staff room's actual question, and it is only answerable because shifts
   are marked as unpopular or not. Without that, three library slots and three
   seven o'clock gates look identical, and the fair-spread conversation stays
   a matter of opinion. */
function FairnessTab({ range }: { range: { from: string; to: string } }) {
  const fairness = useQuery({
    queryKey: ['hr-growth', 'fairness', range],
    queryFn: () =>
      api.get<List<Fairness>>(
        `/api/v1/hr-growth/roster/fairness?from=${range.from}&to=${range.to}`,
      ),
  })

  const rows = fairness.data?.items ?? []
  const carrying = rows.filter((r) => (r.onerous_index ?? 0) > 1.5)

  return (
    <Card>
      <CardHeader
        title="Fair share of the unpopular duties"
        description="Each person's share of the gate, the ground, dispersal and the escort, against the average. Two means twice everybody else's."
      />
      {carrying.length > 0 && (
        <div className="border-b bg-warning/8 px-5 py-3 text-[13px]">
          {carrying.length} member{carrying.length === 1 ? '' : 's'} of staff
          {carrying.length === 1 ? ' is' : ' are'} carrying more than half again
          the average share of the duties nobody volunteers for.
        </div>
      )}
      <Table
        head={['Staff', 'Department', { label: 'Duties', align: 'right' },
          { label: 'Unpopular', align: 'right' }, { label: 'Hours', align: 'right' },
          'Share of the unpopular']}
        empty={rows.length === 0}
        emptyLabel="Nobody has been rostered in this range."
      >
        {rows.map((r) => (
          <tr key={r.user_id}>
            <Td>
              <span className="font-medium">{r.full_name}</span>
              {r.employee_code && (
                <span className="block text-[12.5px] text-muted-foreground">{r.employee_code}</span>
              )}
            </Td>
            <Td>{r.department ?? '—'}</Td>
            <Td className="text-right">{r.duties}</Td>
            <Td className="text-right">{r.onerous_duties}</Td>
            <Td className="text-right">{r.hours.toFixed(1)}</Td>
            <Td>
              {r.onerous_index == null ? '—' : (
                <Badge tone={r.onerous_index > 1.5 ? 'danger' : r.onerous_index < 0.5 ? 'info' : 'success'}>
                  {r.onerous_index.toFixed(2)}× average
                </Badge>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
