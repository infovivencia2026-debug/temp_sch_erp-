import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, GraduationCap, Sun, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

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

  if (cal.isLoading) return <Loading label="Reading the year…" />
  if (cal.error) return <ErrorState error={cal.error} />

  const rows = cal.data?.items ?? []
  const s = cal.data?.summary
  const shut = rows.filter((r) => r.kind === 'holiday' || r.kind === 'vacation').length

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Academic calendar"
        description="Holidays, vacations, exams, parents’ meetings and the days pulled back to make up for them."
      />
      <PageBody>
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

        <Card>
          <CardHeader
            title="The year"
            description="Exams and terms are shown as they are set elsewhere; only the school’s own entries can be changed here."
            action={
              <Select
                value={kind}
                onChange={setKind}
                options={KINDS}
                placeholder="Every kind"
              />
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
