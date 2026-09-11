import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, GraduationCap, Sun, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { MonthGrid, type CalendarEntry } from '../shared/MonthGrid'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea, Reload, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import CalendarDay from './CalendarDay'
import YearPlan from './YearPlan'
import BulkImport from '@/components/BulkImport'

/* The school year on one page.

   Three things a school keeps in three different books — the holiday list, the
   exam board and the term dates — shown as one dated sequence, because "when
   are we shut" and "when are the exams" are the same question to everybody who
   asks it.

   Only the school's own entries are editable here. An exam belongs to the exam
   module and a term to the year; showing them read-only is the difference
   between a calendar and a third place to enter the same dates. */

interface Entry {
  id: string
  source: 'calendar' | 'exam' | 'term'
  name: string
  starts_on: string
  ends_on: string
  kind: string
  applies_to: string
  description?: string
  campus?: string
  days: number
}

interface CalendarResponse {
  items: Entry[]
  from: string
  to: string
  summary: {
    days_in_range: number
    instructional_days: number
    declared_working: number
    has_declared_figure: boolean
    entries: number
  }
}

const KIND_TONE: Record<string, 'neutral' | 'warning' | 'success' | 'danger' | 'info'> = {
  holiday: 'danger',
  vacation: 'danger',
  exam: 'warning',
  event: 'info',
  ptm: 'info',
  working_day: 'success',
  term: 'neutral',
}

const KINDS = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'vacation', label: 'Vacation' },
  { value: 'event', label: 'Event' },
  { value: 'ptm', label: 'Parents’ meeting' },
  { value: 'exam', label: 'Exam' },
  { value: 'working_day', label: 'Working day' },
]

export default function AcademicCalendar() {
  const qc = useQueryClient()
  const [kind, setKind] = useState('')

  const cal = useQuery({
    queryKey: ['admin-calendar', kind],
    queryFn: () =>
      api.get<CalendarResponse>(
        '/api/v1/academics/admin/calendar' + (kind ? `?kind=${kind}` : ''),
      ),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/academics/admin/calendar/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-calendar'] }),
  })

  if (cal.isLoading) return <SkeletonTable columns={6} label="Reading the year…" />
  if (cal.error) return <ErrorState error={cal.error} />

  const rows = cal.data?.items ?? []
  const s = cal.data?.summary

  /* The same rows the list below shows, drawn as a month.

     This screen already had every entry in the year; what it did not have was
     the shape of them. "Is that week clear" and "does this land on a holiday"
     are the two questions a school asks of a calendar, and a table sorted by
     date answers neither. The grid reads the response already fetched, so
     there is no second request and the two halves cannot disagree. */
  const gridEntries: CalendarEntry[] = rows.map((e) => ({
    date: e.starts_on,
    end_date: e.ends_on,
    kind: e.kind,
    title: e.name,
    detail: e.description ?? e.campus,
    ref_id: e.id,
  }))
  const shut = rows.filter((r) => r.kind === 'holiday' || r.kind === 'vacation').length

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Academic calendar"
        description="Holidays, vacations, exams, parents’ meetings and the days pulled back to make up for them."
      />
      <PageBody>
        <MonthGrid
          entries={gridEntries}
          description="Every holiday, vacation, exam and meeting in the year, on the month it falls in. The filter below does not narrow this grid."
        />
        <CellGrid cols={4}>
          <Stat
            label="Instructional days"
            value={s?.instructional_days ?? 0}
            icon={GraduationCap}
            hint={
              s?.has_declared_figure
                ? `${s.declared_working} declared for the year`
                : 'Counted from this calendar, not declared'
            }
          />
          <Stat label="Days in the year" value={s?.days_in_range ?? 0} icon={CalendarDays} />
          <Stat label="Days shut" value={shut} icon={Sun} />
          <Stat label="Entries" value={s?.entries ?? 0} />
        </CellGrid>

        <CalendarDay />

        <YearPlan />

        <Card>
          <CardHeader
            title="The year"
            description="Exams and terms are shown as they are set elsewhere; only the school’s own entries can be changed here."
            action={
              <div className="flex items-center gap-2">
                <Select
                  value={kind}
                  onChange={setKind}
                  options={KINDS}
                  placeholder="Every kind"
                />
                <Reload onClick={() => cal.refetch()} busy={cal.isFetching} label="Re-read the year" />
              </div>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing on the calendar yet"
              body="Add the first holiday below and the working-day count follows from it."
            />
          ) : (
            <Table head={['Date', 'Entry', 'Kind', 'Applies to', 'Days', '']}>
              {rows.map((r) => (
                <tr key={`${r.source}-${r.id}`}>
                  <Td className="whitespace-nowrap font-medium">
                    {formatDate(r.starts_on)}
                    {r.ends_on !== r.starts_on && (
                      <span className="text-muted-foreground"> — {formatDate(r.ends_on)}</span>
                    )}
                  </Td>
                  <Td>
                    {r.name}
                    {r.description && (
                      <span className="block text-[12px] text-muted-foreground">
                        {r.description}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={KIND_TONE[r.kind] ?? 'neutral'}>
                      {r.kind.replace('_', ' ')}
                    </Badge>
                  </Td>
                  <Td className="text-muted-foreground">
                    {r.source === 'calendar' ? r.applies_to : `set in ${r.source}s`}
                  </Td>
                  <Td className="tabular-nums">{r.days}</Td>
                  <Td>
                    {r.source === 'calendar' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        tone="danger"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(r.id)}
                        title="Remove this entry"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <FormNotice error={remove.error} />
        </Card>

        <NewEntry />

        {/* THE WHOLE YEAR IN ONE GO.

            The form above is for the bandh declared on Tuesday. The twenty-
            eight entries a school types in April are a sheet the office
            already has, with a Day column beside every date, and retyping
            them one at a time is how the calendar stays empty until October.
            The template carries that Day column so the office can paste its
            own list in without editing it. */}
        <details className="mt-4 rounded-[10px] border bg-card">
          <summary className="cursor-pointer px-5 py-3 text-[13.5px] text-muted-foreground">
            Upload the whole year — terms, holidays, exams, events — as one sheet
          </summary>
          <div className="border-t p-5">
            <BulkImport
              entity="holidays"
              title="The school year, from one sheet"
              hint={
                'Three columns: date, day, event — the way a school calendar is already ' +
                'written. Put the kind in the "kind" column: term, holiday, vacation, exam, ' +
                'event, ptm, or working_day for a Saturday the school opens; blank means ' +
                'holiday. Anything that runs for days — a term, a vacation, an exam week — ' +
                'gets its end in "to". Dates can be 2026-08-15 or 15.08.26. The day column ' +
                'is read by nobody; the date decides it. Uploading a corrected sheet again ' +
                'updates rather than doubles.'
              }
              onDone={() => {
                qc.invalidateQueries({ queryKey: ['admin-calendar'] })
                qc.invalidateQueries({ queryKey: ['calendar-terms'] })
              }}
            />
          </div>
        </details>

        <Terms />
      </PageBody>
    </>
  )
}

/** The form. Deliberately below the year rather than in a dialog: a school
    entering a holiday list types twenty of them in a row. */
function NewEntry() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [onDate, setOnDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [kind, setKind] = useState('holiday')
  const [appliesTo, setAppliesTo] = useState('all')
  const [description, setDescription] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/calendar', {
        name,
        on_date: onDate,
        to_date: toDate,
        kind,
        applies_to: appliesTo,
        description,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-calendar'] })
      setName('')
      setToDate('')
      setDescription('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Add to the calendar"
        description="A working day pulls a Sunday back into the count — which is what a school does after a bandh."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Name" required>
            <Input value={name} onChange={setName} placeholder="Diwali" />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={setKind} options={KINDS} />
          </Field>
          <Field label="From" required>
            <Input type="date" value={onDate} onChange={setOnDate} />
          </Field>
          <Field label="To" hint="Leave blank for a single day.">
            <Input type="date" value={toDate} onChange={setToDate} />
          </Field>
          <Field label="Applies to">
            <Select
              value={appliesTo}
              onChange={setAppliesTo}
              options={[
                { value: 'all', label: 'Everybody' },
                { value: 'students', label: 'Students only' },
                { value: 'staff', label: 'Staff only' },
              ]}
            />
          </Field>
          <Field label="Note" wide>
            <Textarea
              value={description}
              onChange={setDescription}
              rows={2}
              placeholder="Anything the office will need to remember next year"
            />
          </Field>
        </FormGrid>
        <div className="mt-5 flex items-center gap-3">
          <Button
            disabled={save.isPending || !name.trim() || !onDate}
            onClick={() => save.mutate()}
          >
            Add entry
          </Button>
          <FormNotice error={save.error} ok={save.isSuccess ? 'Added.' : undefined} />
        </div>
      </div>
    </Card>
  )
}

/* TERM DATES.

   This screen has always drawn three things as one sequence -- holidays,
   exams and terms -- and could write only the first. Terms had no writer
   anywhere in the product, so the row a school saw for "Term 1" was one it
   had no way to put there, and every screen that files something under a
   term found none to offer.

   Its own card rather than a kind on the form above, because a term is not
   an entry in the calendar. It is a span the calendar sits inside: three of
   them a year, set once in April, and a report card belongs to one. */
function Terms() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [sequence, setSequence] = useState('1')

  const terms = useQuery({
    queryKey: ['calendar-terms'],
    queryFn: () => api.get<{ items: CalTerm[] }>('/api/v1/academics/calendar/terms'),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/calendar/terms', {
        name,
        starts_on: startsOn,
        ends_on: endsOn,
        sequence: Number(sequence) || 1,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar-terms'] })
      qc.invalidateQueries({ queryKey: ['admin-calendar'] })
      setName('')
      setStartsOn('')
      setEndsOn('')
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/academics/calendar/terms/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar-terms'] })
      qc.invalidateQueries({ queryKey: ['admin-calendar'] })
    },
  })

  const rows = terms.data?.items ?? []

  return (
    <Card className="mt-4">
      <CardHeader
        title="Terms"
        description="The spans the year is divided into. A report card, a fee instalment and a co-scholastic grade each belong to one."
      />
      <div className="px-5 pb-5">
        {rows.length > 0 && (
          <ul className="mb-4 divide-y rounded-lg border">
            {rows.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-8 text-[12.5px] tabular-nums text-muted-foreground">
                  {t.sequence}
                </span>
                <span className="flex-1">
                  <span className="text-[14px] font-medium">{t.name}</span>
                  {t.is_current && <> <Badge tone="success">now</Badge></>}
                  <span className="block text-[12.5px] text-muted-foreground">
                    {t.starts_on} to {t.ends_on} · {t.academic_year}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => remove.mutate(t.id)}
                  className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-destructive"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <FormGrid>
          <Field label="Name" required>
            <Input value={name} onChange={setName} placeholder="Term 1" />
          </Field>
          <Field label="Which term" hint="1, 2, 3 — the order they run in.">
            <Input value={sequence} onChange={setSequence} />
          </Field>
          <Field label="Starts" required>
            <Input type="date" value={startsOn} onChange={setStartsOn} />
          </Field>
          <Field label="Ends" required>
            <Input type="date" value={endsOn} onChange={setEndsOn} />
          </Field>
        </FormGrid>
        <div className="mt-5 flex items-center gap-3">
          <Button
            disabled={save.isPending || !name.trim() || !startsOn || !endsOn}
            onClick={() => save.mutate()}
          >
            Add term
          </Button>
          <FormNotice
            error={save.error ?? remove.error}
            ok={save.isSuccess ? 'Added.' : undefined}
          />
        </div>
      </div>
    </Card>
  )
}

interface CalTerm {
  id: string
  name: string
  starts_on: string
  ends_on: string
  sequence: number
  academic_year: string
  is_current: boolean
}
