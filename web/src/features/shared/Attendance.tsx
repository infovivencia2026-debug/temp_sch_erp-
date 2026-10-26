import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List, type Section, type Student } from '@/lib/api'
import { walkRoster } from '@/lib/rosters'
import { Card, CardHeader, Table, Td, Badge, Button, Select, Loading, ErrorState, PageBody, Input } from '@/components/ui'
import { SearchBox, Showing, useSearch } from '@/components/rows'
import { ImportButton } from '@/components/DataPortActions'
import { PickerMenu } from '@/components/PickerMenu'
import { useIsPhone } from '@/components/OptionSheet'
import { useCan, useSessionIfAny } from '@/lib/session'
import { useActiveRole } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/Toast'
import { useOptimisticMutation } from '@/lib/optimistic'

const STATUSES = ['present', 'absent', 'late', 'half_day', 'leave', 'holiday'] as const
type Status = (typeof STATUSES)[number]

/* Marking a register is the most repeated action in the product: a class
   teacher does it 30-odd times, twice a day, every day. A dropdown costs three
   interactions per child -- open, find, choose -- and hides the current value
   until you open it. One tap per child, and the whole row's state readable
   without touching anything.

   Five marks, not six: holiday is a property of the day rather than of a
   child. */
/* Each mark is a bordered segment that reads as a button before it is
   pressed (owner, 2026-10-26: they looked like plain text), and fills with
   its status colour once chosen. Half-day is the fifth, after leave. */
const QUICK: { value: Status; short: string; label: string; tone: string }[] = [
  { value: 'present', short: 'P', label: 'Present', tone: 'text-success border-success bg-success/15 ring-1 ring-success' },
  { value: 'absent', short: 'A', label: 'Absent', tone: 'text-destructive border-destructive bg-destructive/15 ring-1 ring-destructive' },
  { value: 'late', short: 'L', label: 'Late', tone: 'text-warning border-warning bg-warning/15 ring-1 ring-warning' },
  { value: 'leave', short: 'Lv', label: 'On leave', tone: 'text-foreground border-foreground/60 bg-surface-hover ring-1 ring-foreground/60' },
  { value: 'half_day', short: '½', label: 'Half day', tone: 'text-foreground border-foreground/60 bg-surface-hover ring-1 ring-foreground/60' },
]

const TONE: Record<string, 'success' | 'danger' | 'primary' | 'neutral'> = {
  present: 'success', absent: 'danger', late: 'primary',
  half_day: 'primary', leave: 'neutral', holiday: 'neutral',
}

/* `embedded` is passed by the Attendance hub, which wraps this screen as a tab
   beside the monitor and follow-up. This screen has no PageHead of its own — it
   is a single Card — so there is nothing to suppress; the prop is accepted for a
   uniform signature across the three tab bodies and defaults to false so the
   standalone route (Class 360's Mark-attendance button) is unaffected. */
/* Each row tinted by its mark in a teacher's register, so it reads at a glance. */
const ROW_TINT: Partial<Record<Status, string>> = { present: 'bg-success/10', absent: 'bg-destructive/10' }

export default function Attendance({ embedded = false }: { embedded?: boolean } = {}) {
  void embedded
  const can = useCan()
  /* A teacher's register (Yajur, 2026-10-21): no import or exports here (those
     live in Reports), clear Mark all buttons and rows tinted by their mark.
     Other roles with this screen keep it as it was. */
  const teacherView = useActiveRole()?.key === 'faculty'
  const phone = useIsPhone()
  /* The WhatsApp / SMS / Email ticks are a school setting
     (attendance.absent_channels, module 'attendance_absent_channels'): on
     unless the school switched it off. Off, parents are told in the app only. */
  const offerChannels = useSessionIfAny()?.modules
    ?.find((m) => m.module === 'attendance_absent_channels')?.enabled !== false
  const [sectionId, setSectionId] = useState('')
  // Today on this device's calendar (toISOString is UTC, which is yesterday before 05:30 in India).
  const [onDate, setOnDate] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [draft, setDraft] = useState<Record<string, Status>>({})

  /* Whether this account keeps the register for the whole school, which is
     the same permission the server checks when it accepts one. */
  const marksAnySection = can('academics.attendance.write.any')

  /* The sections whose register this person actually keeps.

     mine=true is every section they teach anything in, and the server now
     accepts a register only from the section's class teacher — so a subject
     teacher was offered five sections and refused on submit for all of them.
     Offering a choice that cannot be taken is worse than offering none: the
     work is done by the time they find out. */
  const sections = useQuery({
    queryKey: ['sections', marksAnySection ? 'all' : 'class_teacher'],
    /* WHOLE-SCHOOL REACH ASKS A DIFFERENT QUESTION.

       This always asked for the sections the signed-in person is CLASS
       TEACHER of, which is right for a class teacher and empty for everybody
       else -- including an attendance officer whose whole job is the register
       for every section in the school. Granting them the permission changed
       nothing, because the screen never asked the server a question whose
       answer that permission could widen: 0 sections came back, and the
       picker read as "nothing in your scope" on an account that had just
       been given all of it. Measured on the live server: 16 sections
       unfiltered, 0 with mine=class_teacher, same account, same moment.

       academics.attendance.write.any is the permission that means "any
       section's register", and it is what the server checks when it decides
       whether to accept one. The screen asks for what that person may
       actually mark. */
    queryFn: () => api.get<List<Section>>(
      '/api/v1/academics/sections' + (marksAnySection ? '' : '?mine=class_teacher'),
    ),
    /* Which sections this person may mark is authority, not convenience: after a
       just-granted whole-school reach, opening this screen must fetch the live
       list, never a cached empty one that reads as "nothing in your scope". So
       always revalidate on mount. It is a small list, so this is cheap. */
    staleTime: 0,
    refetchOnMount: 'always',
  })

  // The register needs every student in the section, not only those already
  // marked, so the roster comes from /students and existing marks are layered
  // on top by student_id.
  const roster = useQuery({
    queryKey: ['roster', sectionId],
    // Walked to the end: a merged or oversized section past 200 was silently
    // dropping children off the register with no sign the list was short.
    queryFn: () => walkRoster<Student>('/api/v1/students', { section_id: sectionId }),
    enabled: !!sectionId,
  })

  const informedQ = useQuery({
    queryKey: ['attendance-informed', sectionId, onDate],
    queryFn: () => api.get<{ items: { student_id: string; reason: string; status: string }[] }>(`/api/v1/attendance/informed?section_id=${sectionId}&on_date=${onDate}`),
    enabled: !!sectionId,
  })
  const informed = new Map((informedQ.data?.items ?? []).map((x) => [x.student_id, x]))
  const marks = useQuery({
    queryKey: ['attendance', sectionId, onDate],
    queryFn: () =>
      api.call('GET /attendance', { query: { section_id: sectionId, on_date: onDate } }),
    enabled: !!sectionId,
  })

  const toast = useToast()

  /* WHICH CHANNELS, beyond the app.

     The in-app alert always goes and is not offered as a choice: it costs
     nothing and it is the record a parent can go back to. These three cost
     money per message, so they are the teacher's to tick — and the choice is
     remembered, because a school that texts every absence would otherwise
     re-tick the same boxes every morning of the year. */
  const [channels, setChannels] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('attendance.absentChannels') ?? '[]')
    } catch { return [] }
  })
  const toggleChannel = (ch: string) => {
    const next = channels.includes(ch)
      ? channels.filter((x) => x !== ch)
      : [...channels, ch]
    setChannels(next)
    try { localStorage.setItem('attendance.absentChannels', JSON.stringify(next)) } catch { /* a private window is not an error */ }
  }
  // Back-filling a fortnight-old register should not text every parent about
  // an absence they already know about.
  const [silent, setSilent] = useState(false)

  /* SHOWN AS SAVED THE MOMENT SAVE IS PRESSED (lib/optimistic).

     The ticks were already instant -- a draft over the recorded marks -- but
     Save then held the button for the round trip. Now the draft is written
     into the cached register at once, the draft empties, and the button
     runs its pending mark while the request goes out behind it. If the
     server refuses, the register goes back to what it was and the ticks
     come back as a draft, so nothing a teacher marked is lost; Retry sends
     the same entries. The success line still reports what the SERVER did
     (how many parents were told), which is not guessed at. */
  type Entry = { student_id: string; status: Status }
  const save = useOptimisticMutation<Entry[], { parents_told?: number; messages_queued?: number }>({
    mutationFn: (entries) =>
      api.call('POST /attendance', { body: {
        section_id: sectionId, on_date: onDate, entries,
        notify_channels: offerChannels ? channels : [], silent: offerChannels && silent,
      } }),
    queryKeys: [['attendance', sectionId, onDate]],
    apply: (old, entries) => {
      const d = old as { items: { student_id: string; status: string }[] }
      const byId = new Map(entries.map((e) => [e.student_id, e.status]))
      const kept = d.items.map((m) => (byId.has(m.student_id) ? { ...m, status: byId.get(m.student_id)! } : m))
      const known = new Set(d.items.map((m) => m.student_id))
      const added = entries.filter((e) => !known.has(e.student_id)).map((e) => ({ student_id: e.student_id, status: e.status }))
      return { ...d, items: [...kept, ...added] }
    },
    failure: "Couldn't save the register",
    onError: (_err, entries) =>
      setDraft((cur) => ({ ...Object.fromEntries(entries.map((e) => [e.student_id, e.status])), ...cur })),
    onSuccess: (res, entries) => {
      // The count matters: a register saved with three of forty marked is the
      // failure a teacher discovers a week later, and silence hides it.
      const absent = entries.filter((e) => e.status === 'absent').length
      /* What actually went out, not what was intended. A teacher who ticks
         WhatsApp and is told "Register saved" has no way of knowing the school
         never configured a gateway — and the families were not told. */
      const sent: string[] = []
      if (res?.parents_told) sent.push(`${res.parents_told} told in the app`)
      if (res?.messages_queued) sent.push(`${res.messages_queued} messages sent`)
      toast.ok(
        `Register saved · ${entries.length} marked${absent ? `, ${absent} absent` : ''}`
        + (sent.length ? ` · ${sent.join(', ')}` : ''),
      )
    },
  })

  const existing = new Map((marks.data?.items ?? []).map((m) => [m.student_id, m.status]))
  const students = roster.data?.items ?? []
  /* Sixty names in roll order, and the child being marked is somewhere in the
     middle of them. */
  const { q: term, setQ: setTerm, shown } = useSearch(students,
    (s) => [s.admission_no, s.full_name])
  const dirty = Object.keys(draft).length > 0

  const markAll = (status: Status) =>
    setDraft(Object.fromEntries(students.map((s) => [s.id, status])))
  const saveDraft = () => {
    const entries = Object.entries(draft).map(([student_id, status]) => ({ student_id, status }))
    setDraft({})
    save.mutate(entries)
  }

  /* The running tally, over the WHOLE section rather than the filtered view: a
     search that hides half the class must not make the count of who is in look
     like the class shrank. Effective mark = the unsaved draft if there is one,
     otherwise what is already recorded. Everything without either is "not
     marked", which is the number that catches a register saved half-done. */
  const tally = students.reduce(
    (acc, s) => {
      const v = draft[s.id] ?? existing.get(s.id)
      if (v === 'present') acc.present++
      else if (v === 'absent') acc.absent++
      else if (v === 'late') acc.late++
      else if (v === 'leave') acc.leave++
      else if (v === 'half_day') acc.half++
      else acc.unmarked++
      return acc
    },
    { present: 0, absent: 0, late: 0, leave: 0, half: 0, unmarked: 0 },
  )

  /* The page gutter: without it this screen's card started at the pixel
     the sidebar ended and ran to the window's right edge. */
  return (
    <PageBody top>
    <Card>
      <CardHeader
        title="Attendance register"
        description={sectionId ? `${students.length} students` : 'Choose a section to begin'}
        action={
          /* A tidy two-column grid on a phone: the five controls used to
             wrap into a ragged staircase of odd widths. */
          <div className="grid w-full grid-cols-2 items-center gap-2 sm:flex sm:w-auto sm:flex-wrap [&>*]:min-w-0 [&_button]:w-full sm:[&_button]:w-auto">
            <div className="col-span-2 sm:col-span-1"><Select
              value={sectionId}
              onChange={(v) => { setSectionId(v); setDraft({}) }}
              placeholder="Select section"
              options={(sections.data?.items ?? []).map((s) => ({
                value: s.id, label: `${s.class_name}-${s.name}`,
              }))}
            /></div>
            {/* A teacher marks today; the date picker is the office's (Yajur, 2026-10-21). */}
            {!teacherView && <div className={can('academics.attendance.write') ? undefined : 'col-span-2'}><Input
              type="date"
              value={onDate}
              onChange={(v) => { setOnDate(v); setDraft({}) }}
              srLabel="Date"
              className="w-full sm:w-auto"
            /></div>}
            {!teacherView && can('academics.attendance.write') && (
              <ImportButton
                entity="attendance"
                title="Import attendance"
                hint="One row per student per day, with the mark. Back-filling a term's registers from a sheet rather than a screen."
              />
            )}
          </div>
        }
      />

      {!sectionId ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          Select a section and date.
        </p>
      ) : roster.isLoading || marks.isLoading ? (
        <Loading />
      ) : roster.error ? (
        <ErrorState error={roster.error} />
      ) : (
        <>
          {can('academics.attendance.write') && (
            /* On a phone: Mark all present, Mark all absent and Save as one
               row of three equal buttons (owner, 2026-10-26). */
            phone ? (
            <div className="grid grid-cols-3 gap-2 border-b px-4 py-3 [&>*]:min-w-0 [&_button]:w-full">
              <Button variant="outline" onClick={() => markAll('present')}>All present</Button>
              <Button variant="outline" onClick={() => markAll('absent')}>All absent</Button>
              <Button
                disabled={!dirty}
                pending={save.isPending}
                onClick={saveDraft}
              >
                {`Save ${Object.keys(draft).length || ''}`.trim()}
              </Button>
            </div>
            ) :
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              {teacherView ? (
                <>
                  <Button variant="outline" onClick={() => markAll('present')}>Mark all present</Button>
                  <Button variant="outline" onClick={() => markAll('absent')}>Mark all absent</Button>
                </>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">Mark all:</span>
                  <Button variant="ghost" onClick={() => markAll('present')}>Present</Button>
                  <Button variant="ghost" onClick={() => markAll('absent')}>Absent</Button>
                </>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {save.isSuccess && !dirty && <span className="text-xs text-success">Saved</span>}
                <Button
                  disabled={!dirty}
                  pending={save.isPending}
                  onClick={saveDraft}
                >
                  {`Save ${Object.keys(draft).length || ''}`.trim()}
                </Button>
              </div>
            </div>
          )}
          {can('academics.attendance.write') && offerChannels && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/20 px-4 py-2.5 text-[13px]">
              <span className="text-muted-foreground">
                Absent parents are told in the app. Also send by:
              </span>
              {(['whatsapp', 'sms', 'email'] as const).map((ch) => (
                <label key={ch} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={channels.includes(ch)}
                    onChange={() => toggleChannel(ch)}
                    disabled={silent}
                  />
                  {ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : 'Email'}
                </label>
              ))}
              <label className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} />
                Tell nobody (back-filling an old register)
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 px-5 pb-3 pt-3">
            <SearchBox value={term} onChange={setTerm} placeholder="Name or admission no." />
            <Showing shown={shown.length} total={students.length} noun="students" />
            {/* ONE Export (owner, 2026-10-26: three export buttons on one
                screen). Day: this date, every section this person can see,
                every child marked or "not marked", from the register's own
                endpoint and scope. Last 90 days: the whole register the
                school's scope allows. A class teacher's register has none;
                whoever keeps the whole school's register does (owner,
                2026-10-26). */}
            {(!teacherView || marksAnySection) && <PickerMenu<'day' | '90'>
              value={'' as 'day'}
              ariaLabel="Export attendance"
              placeholder="Export"
              /* Shown but not highlighted (owner, 2026-10-26): the ghost
                 look, no card fill or lift, so it sits quietly beside search. */
              className="ml-auto bg-transparent text-muted-foreground shadow-none hover:text-foreground"
              options={[
                { value: 'day', label: `Day (${onDate}, all sections)` },
                { value: '90', label: 'Last 90 days' },
              ]}
              onChange={(v) => window.location.assign(v === 'day'
                ? `/api/v1/attendance/day.csv?on_date=${onDate}`
                : '/api/v1/export/attendance')}
            />}
          </div>
          {/* The running count, so a teacher sees the class add up as they mark
              and catches a half-done register before saving it. Present and
              Absent lead; the rest and the not-marked count follow. */}
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-5 py-2.5 text-[13px]">
            <span className="rounded-md border border-success/40 bg-success/10 px-2 py-1 font-semibold text-success">
              Present {tally.present}
            </span>
            <span className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 font-semibold text-destructive">
              Absent {tally.absent}
            </span>
            {tally.late > 0 && (
              <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-warning">
                Late {tally.late}
              </span>
            )}
            {tally.leave > 0 && (
              <span className="rounded-md border border-border-strong bg-surface-hover px-2 py-1 text-secondary-foreground">
                Leave {tally.leave}
              </span>
            )}
            {tally.half > 0 && (
              <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-warning">
                Half-day {tally.half}
              </span>
            )}
            <span className="ml-auto text-muted-foreground">
              {tally.unmarked > 0
                ? `${tally.unmarked} not marked`
                : 'All marked'}{' '}
              · {students.length} total
            </span>
          </div>
          {/* On a phone the row is one cell (owner, 2026-10-26: the rows showed
              only admission numbers, the rest cut off): the name first, the
              admission number and what is recorded under it, the marks below
              across the full width. Desktop keeps its four columns. */}
          <Table head={phone ? ['Student'] : ['Admission no.', 'Student', 'Recorded', 'Mark']} empty={!shown.length} noExport>
            {shown.map((s) => {
              const saved = existing.get(s.id)
              const value = draft[s.id] ?? (saved as Status | undefined) ?? ''
              const recorded = saved
                ? <Badge tone={TONE[saved]}>{saved}</Badge>
                : <span className="text-xs text-muted-foreground">Not marked</span>
              /* The parent already told the school: say so here, so the
                 child is marked On leave instead of absent and chased. */
              const told = informed.get(s.id) && (
                <span className="mt-1 flex flex-wrap items-center gap-2 text-[12px] font-normal">
                  <span className="rounded-md bg-[#fef3c7] px-2 py-0.5 font-semibold text-[#b45309]">
                    Leave from parent{informed.get(s.id)!.status === 'approved' ? ' (approved)' : ''}
                  </span>
                  <span className="text-muted-foreground">{informed.get(s.id)!.reason}</span>
                  {value !== 'leave' && (
                    <button type="button" onClick={() => setDraft((d) => ({ ...d, [s.id]: 'leave' }))}
                      className="tap-inline rounded-md border px-2 py-0.5 font-semibold text-primary hover:bg-primary/10">
                      Mark On leave
                    </button>
                  )}
                </span>
              )
              const markButtons = (
                <div className={cn('flex items-center gap-1.5', phone ? 'mt-2.5 w-full' : 'flex-wrap')}>
                  {QUICK.map((q) => {
                    const on = value === q.value
                    return (
                      <button
                        key={q.value}
                        type="button"
                        aria-pressed={on}
                        aria-label={`${q.label} · ${s.full_name}`}
                        title={q.label}
                        disabled={!can('academics.attendance.write')}
                        /* Tapping the mark a child already has clears it,
                           so a misclick is one tap to undo rather than a
                           hunt for a blank option. */
                        onClick={() =>
                          setDraft((d) => {
                            const next = { ...d }
                            if (next[s.id] === q.value) delete next[s.id]
                            else next[s.id] = q.value
                            return next
                          })
                        }
                        className={cn(
                          'rounded-full border text-[13px] font-semibold',
                          phone ? 'h-12 min-w-0 flex-1 text-[16px]' : 'h-9 min-w-[40px] px-2.5',
                          'transition-colors duration-100',
                          'disabled:pointer-events-none disabled:opacity-40',
                          on
                            ? q.tone
                            : 'border-border-strong bg-card text-foreground hover:bg-surface-hover',
                        )}
                      >
                        {q.short}
                      </button>
                    )
                  })}
                </div>
              )
              return (
                <tr key={s.id} className={teacherView && value ? ROW_TINT[value] : undefined}>
                  {phone ? (
                    <Td className="min-w-0 whitespace-normal">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 break-words text-[16px] font-medium">{s.full_name}</span>
                        <span className="shrink-0">{recorded}</span>
                      </div>
                      <div className="font-mono text-[12px] text-muted-foreground">{s.admission_no}</div>
                      {told}
                      {markButtons}
                    </Td>
                  ) : (
                    <>
                      <Td className="font-mono text-xs">{s.admission_no}</Td>
                      <Td className="font-medium">
                        {s.full_name}
                        {told}
                      </Td>
                      <Td>{recorded}</Td>
                      <Td>{markButtons}</Td>
                    </>
                  )}
                </tr>
              )
            })}
          </Table>
        </>
      )}
    </Card>
    </PageBody>
  )
}
