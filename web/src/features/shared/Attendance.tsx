import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Section, type AttendanceRow, type Student } from '@/lib/api'
import { walkRoster } from '@/lib/rosters'
import { Card, CardHeader, Table, Td, Badge, Button, Select, Loading, ErrorState } from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { ImportButton, ExportButton } from '@/components/DataPortActions'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/Toast'

const STATUSES = ['present', 'absent', 'late', 'half_day', 'leave', 'holiday'] as const
type Status = (typeof STATUSES)[number]

/* Marking a register is the most repeated action in the product: a class
   teacher does it 30-odd times, twice a day, every day. A dropdown costs three
   interactions per child -- open, find, choose -- and hides the current value
   until you open it. One tap per child, and the whole row's state readable
   without touching anything.

   Four marks, not six. Holiday is a property of the day rather than of a
   child, and half-day is rare enough to belong behind "more" rather than
   taking a quarter of the width on every row. */
const QUICK: { value: Status; short: string; label: string; tone: string }[] = [
  { value: 'present', short: 'P', label: 'Present', tone: 'text-success border-success/40 bg-success/10' },
  { value: 'absent', short: 'A', label: 'Absent', tone: 'text-destructive border-destructive/40 bg-destructive/10' },
  { value: 'late', short: 'L', label: 'Late', tone: 'text-warning border-warning/40 bg-warning/10' },
  { value: 'leave', short: 'Lv', label: 'On leave', tone: 'text-secondary-foreground border-border-strong bg-surface-hover' },
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
export default function Attendance({ embedded = false }: { embedded?: boolean } = {}) {
  void embedded
  const can = useCan()
  const qc = useQueryClient()
  const [sectionId, setSectionId] = useState('')
  const [onDate, setOnDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [draft, setDraft] = useState<Record<string, Status>>({})

  /* The sections whose register this person actually keeps.

     mine=true is every section they teach anything in, and the server now
     accepts a register only from the section's class teacher — so a subject
     teacher was offered five sections and refused on submit for all of them.
     Offering a choice that cannot be taken is worse than offering none: the
     work is done by the time they find out. */
  const sections = useQuery({
    queryKey: ['sections', 'class_teacher'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections?mine=class_teacher'),
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

  const marks = useQuery({
    queryKey: ['attendance', sectionId, onDate],
    queryFn: () =>
      api.get<List<AttendanceRow>>(`/api/v1/attendance?section_id=${sectionId}&on_date=${onDate}`),
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

  const save = useMutation({
    mutationFn: (entries: { student_id: string; status: Status }[]) =>
      api.post<{
        newly_absent?: number; parents_told?: number; messages_queued?: number
      }>('/api/v1/attendance', {
        section_id: sectionId, on_date: onDate, entries,
        notify_channels: channels, silent,
      }),
    onSuccess: (res, entries) => {
      setDraft({})
      qc.invalidateQueries({ queryKey: ['attendance', sectionId, onDate] })
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
        `Register saved — ${entries.length} marked${absent ? `, ${absent} absent` : ''}`
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

  return (
    <Card>
      <CardHeader
        title="Attendance register"
        description={sectionId ? `${students.length} students` : 'Choose a section to begin'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={sectionId}
              onChange={(v) => { setSectionId(v); setDraft({}) }}
              placeholder="Select section"
              options={(sections.data?.items ?? []).map((s) => ({
                value: s.id, label: `${s.class_name}-${s.name}`,
              }))}
            />
            <input
              type="date"
              value={onDate}
              onChange={(e) => { setOnDate(e.target.value); setDraft({}) }}
              /* A finger is not a mouse pointer: the visible box is unchanged on a
                 desk, and only a coarse pointer grows it to the 44px tap floor the
                 Button component already keeps. */
              className="rounded-md border bg-background px-2.5 py-1.5 text-sm [@media(pointer:coarse)]:min-h-[44px]"
            />
            {can('academics.attendance.write') && (
              <ImportButton
                entity="attendance"
                title="Import attendance"
                hint="One row per student per day, with the mark. Back-filling a term's registers from a sheet rather than a screen."
              />
            )}
            {/* The whole register the school's scope allows, not just the
                section on screen — what an inspector asks for by date. */}
            <ExportButton name="attendance" />
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
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <span className="text-xs text-muted-foreground">Mark all:</span>
              <Button variant="ghost" onClick={() => markAll('present')}>Present</Button>
              <Button variant="ghost" onClick={() => markAll('absent')}>Absent</Button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {save.isError && <ErrorMessage error={save.error} />}
                {save.isSuccess && !dirty && <span className="text-xs text-success">Saved</span>}
                <Button
                  disabled={!dirty || save.isPending}
                  onClick={() =>
                    save.mutate(Object.entries(draft).map(([student_id, status]) => ({ student_id, status })))
                  }
                >
                  {save.isPending ? 'Saving…' : `Save ${Object.keys(draft).length || ''}`.trim()}
                </Button>
              </div>
            </div>
          )}
          {can('academics.attendance.write') && (
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

          <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
            <SearchBox value={term} onChange={setTerm} placeholder="Name or admission no." />
            <Showing shown={shown.length} total={students.length} noun="students" />
            {/* The register as it stands, which is what a school hands to an
                inspector asking who was in on a given day. */}
            <ExportRows
              rows={students}
              name="attendance"
              columns={[
                { header: 'Admission no', value: (s) => s.admission_no },
                { header: 'Student', value: (s) => s.full_name },
                { header: 'Mark', value: (s) => existing.get(s.id) ?? draft[s.id] ?? 'not marked' },
              ]}
            />
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
          <Table head={['Admission no.', 'Student', 'Recorded', 'Mark']} empty={!shown.length}>
            {shown.map((s) => {
              const saved = existing.get(s.id)
              const value = draft[s.id] ?? (saved as Status | undefined) ?? ''
              return (
                <tr key={s.id}>
                  <Td className="font-mono text-xs">{s.admission_no}</Td>
                  <Td className="font-medium">{s.full_name}</Td>
                  <Td>{saved ? <Badge tone={TONE[saved]}>{saved}</Badge> : <span className="text-xs text-muted-foreground">Not marked</span>}</Td>
                  <Td>
                    {/* Six 44px touch targets can't sit in one row on a phone;
                        let them wrap instead of pushing the card off-screen. */}
                    <div className="flex flex-wrap items-center gap-1">
                      {QUICK.map((q) => {
                        const on = value === q.value
                        return (
                          <button
                            key={q.value}
                            type="button"
                            aria-pressed={on}
                            aria-label={`${q.label} — ${s.full_name}`}
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
                              'h-8 w-8 rounded-[7px] border text-[12px] font-semibold',
                              // The register is the most-tapped screen in the
                              // product; on a touch device each mark grows to the
                              // 44px floor (min- so the 32px desk size is kept).
                              '[@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]',
                              'transition-colors duration-100',
                              'disabled:pointer-events-none disabled:opacity-40',
                              on
                                ? q.tone
                                : 'border-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                            )}
                          >
                            {q.short}
                          </button>
                        )
                      })}
                      {/* Half-day is real but rare; it does not earn a column
                          of its own on every row. */}
                      <button
                        type="button"
                        aria-label={`Half day — ${s.full_name}`}
                        title="Half day"
                        disabled={!can('academics.attendance.write')}
                        onClick={() =>
                          setDraft((d) => {
                            const next = { ...d }
                            if (next[s.id] === 'half_day') delete next[s.id]
                            else next[s.id] = 'half_day'
                            return next
                          })
                        }
                        className={cn(
                          'h-8 rounded-[7px] border px-2 text-[12px]',
                          '[@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]',
                          'transition-colors duration-100',
                          'disabled:pointer-events-none disabled:opacity-40',
                          value === 'half_day'
                            ? 'border-warning/40 bg-warning/10 text-warning'
                            : 'border-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                        )}
                      >
                        ½
                      </button>
                    </div>
                  </Td>
                </tr>
              )
            })}
          </Table>
        </>
      )}
    </Card>
  )
}

function ErrorMessage({ error }: { error: unknown }) {
  return (
    <span className="text-xs text-destructive">
      {error instanceof Error ? error.message : 'Save failed'}
    </span>
  )
}
