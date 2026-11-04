import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CellGrid, Stat, Table, Td, Badge, Button, Field, FormNotice, Input, Select, ErrorState, EmptyState, PrintButton,
} from '@/components/ui'
import { saveFile } from '@/lib/save-file'
import { cn } from '@/lib/utils'
import ChapterPlan from './ChapterPlan'

/* LESSON PLAN (owner, 2026-10-30): one row per timetabled period on a school
   date, worked out from the timetable and the calendar. The principal reads
   any teacher's or any class's plan, exports and prints it; a teacher picks
   one of their classes, writes the topic and moves the status forward
   (Not completed, Ongoing, Completed; never back). */

type Status = 'not_completed' | 'ongoing' | 'completed'
type DayType = 'TD' | 'HD' | 'ND' | 'TED' | 'NED'

interface Options {
  sees_all: boolean
  year: { from: string; to: string }
  teachers: { id: string; name: string }[]
  sections: { id: string; class_name: string; section: string }[]
  subjects: { section_id: string; class_subject_id: string; subject: string }[]
}
interface Row {
  sno: number; date: string; date_to?: string; day_type: DayType
  section_id: string; class_subject_id: string; period_id: string; period: string
  class_name: string; section: string; subject: string; teacher: string
  topic: string; status: Status | null; mine: boolean
}

const STATUS: { value: Status; label: string }[] = [
  { value: 'not_completed', label: 'Not completed' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'completed', label: 'Completed' },
]
const statusLabel = (s: Status) => STATUS.find((x) => x.value === s)!.label
// The school's codes, as on its own sheet; the full words show on hover.
const DAY_TYPE: Record<DayType, string> = { TD: 'Teaching day', HD: 'Holiday', ND: 'Non-teaching day', TED: 'Teaching and event day', NED: 'Non-teaching event day' }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`
const weekday = (d: string) => WEEKDAYS[new Date(d + 'T00:00:00Z').getUTCDay()]
const rowKey = (r: Row) => `${r.section_id}|${r.class_subject_id}|${r.date}|${r.period_id || 'day'}`

export default function LessonRegister() {
  const opts = useQuery({ queryKey: ['lesson-register-options'], queryFn: () => api.get<Options>('/api/v1/academics/lesson-register/options') })
  const [by, setBy] = useState<'teacher' | 'class'>('class')
  const [teacher, setTeacher] = useState('')
  const [section, setSection] = useState('')
  const [subject, setSubject] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  /* Filters first, then the chapters of that class and subject (owner,
     2026-11-04: "no need of todays classes"). Day by day is the old sheet. */
  const [view, setView] = useState<'chapters' | 'days'>('chapters')
  const o = opts.data
  const all = o?.sees_all ?? false

  const subjects = useMemo(() => (o?.subjects ?? []).filter((s) => s.section_id === section), [o, section])
  // A class with one subject (a teacher's usual case) needs no second choice.
  useEffect(() => { if (subjects.length === 1) setSubject(subjects[0].class_subject_id) }, [subjects])

  const params = new URLSearchParams()
  if (all && by === 'teacher') { if (teacher) params.set('teacher_user_id', teacher) }
  else if (section && subject) { params.set('section_id', section); params.set('class_subject_id', subject) }
  const ready = params.toString() !== ''
  // Blank dates mean the whole academic year.
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const badRange = !!from && !!to && from > to
  const reg = useQuery({
    queryKey: ['lesson-register', params.toString()],
    queryFn: () => api.get<{ items: Row[] }>(`/api/v1/academics/lesson-register?${params}`),
    enabled: ready && !badRange,
  })

  /* A card pressed shows only its rows; pressed again, all rows (owner, 2026-10-30). */
  const [only, setOnly] = useState<'planned' | Status | null>(null)
  // Edits made here, shown at once over what the server sent.
  const [edits, setEdits] = useState<Record<string, { topic?: string; status?: Status }>>({})
  const save = useMutation({
    mutationFn: (v: { row: Row; topic?: string; status?: Status }) => api.put<{ topic: string; status: Status }>('/api/v1/academics/lesson-register', {
      section_id: v.row.section_id, class_subject_id: v.row.class_subject_id, period_id: v.row.period_id, on_date: v.row.date,
      ...(v.topic !== undefined ? { topic: v.topic } : {}), ...(v.status ? { status: v.status } : {}),
    }),
    onMutate: (v) => setEdits((e) => ({ ...e, [rowKey(v.row)]: { ...e[rowKey(v.row)], ...(v.topic !== undefined ? { topic: v.topic } : {}), ...(v.status ? { status: v.status } : {}) } })),
    onSuccess: (res, v) => setEdits((e) => ({ ...e, [rowKey(v.row)]: res })),
    onError: (_e, v) => setEdits((e) => { const n = { ...e }; delete n[rowKey(v.row)]; return n }),
  })

  const rows = (reg.data?.items ?? []).map((r) => ({ ...r, ...edits[rowKey(r)] }))
  const showClass = all && by === 'teacher'
  const sectionLabel = (s: { class_name: string; section: string }) => `${s.class_name} - ${s.section}`

  if (opts.isError) return <ErrorState error={opts.error} />

  // The figures a head looks for first: how much of the plan is done.
  const planned = rows.filter((r) => r.status)
  const pick = (k: 'planned' | Status) => setOnly((v) => (v === k ? null : k))
  const shown = only === 'planned' ? planned : only ? rows.filter((r) => r.status === only) : rows
  const count = (s: Status) => planned.filter((r) => r.status === s).length
  const exportSheet = () => {
    const q = new URLSearchParams(params); q.set('format', 'xlsx')
    return saveFile(`/api/v1/academics/lesson-register?${q}`, 'lesson-plan.xlsx')
  }

  const head = [
    '#', 'Date & day', 'Day type',
    ...(showClass ? ['Class', 'Subject'] : []),
    'Period', 'Topic', 'Status',
  ]

  return (
    <>
      <PageHead eyebrow="Academics" title="Lesson plan" actions={rows.length ? (
        <>
          <Button variant="secondary" onClick={() => void exportSheet()}>Export to Excel</Button>
          <PrintButton title="Lesson plan" subtitle={`${ddmmyyyy(rows[0].date)} to ${ddmmyyyy(rows[rows.length - 1].date_to ?? rows[rows.length - 1].date)}`} />
        </>
      ) : undefined} />
      <PageBody>
        <>
        <Card className="p-4 sm:p-5">
          {/* Every filter on one line on a wide screen: five with View by and a class, four otherwise. */}
          <div className={cn('grid gap-4 sm:grid-cols-2', all && by === 'class' ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
            {all && (
              <Field label="View by">
                <Select value={by} onChange={(v) => setBy(v as 'teacher' | 'class')}
                  options={[{ value: 'class', label: 'Class' }, { value: 'teacher', label: 'Teacher' }]} />
              </Field>
            )}
            {all && by === 'teacher' ? (
              <Field label="Teacher">
                <Select value={teacher} onChange={setTeacher} placeholder="Choose a teacher"
                  options={(o?.teachers ?? []).map((t) => ({ value: t.id, label: t.name }))} />
              </Field>
            ) : (
              <>
                <Field label="Class and section">
                  <Select value={section} onChange={(v) => { setSection(v); setSubject('') }} placeholder="Choose a class"
                    options={(o?.sections ?? []).map((s) => ({ value: s.id, label: sectionLabel(s) }))} />
                </Field>
                <Field label="Subject">
                  <Select value={subject} onChange={setSubject} placeholder={section ? 'Choose a subject' : 'Choose a class first'}
                    options={subjects.map((s) => ({ value: s.class_subject_id, label: s.subject }))} />
                </Field>
              </>
            )}
            {!(all && by === 'teacher') && (
              <Field label="Show">
                <Select value={view} onChange={(v) => setView(v as 'chapters' | 'days')}
                  options={[{ value: 'chapters', label: 'Chapters' }, { value: 'days', label: 'Day by day' }]} />
              </Field>
            )}
            {(view === 'days' || (all && by === 'teacher')) && <>
            <Field label="From date">
              <Input type="date" value={from} onChange={setFrom} />
            </Field>
            <Field label="To date">
              <Input type="date" value={to} onChange={setTo} min={from || undefined} />
            </Field>
            </>}
          </div>
          {badRange && <p role="alert" className="mt-3 text-[14px] text-destructive">The from date is after the to date.</p>}
        </Card>

        {save.isError && <FormNotice error={save.error} />}

        {view === 'chapters' && !(all && by === 'teacher') ? (
          section && subject ? <ChapterPlan sectionId={section} classSubjectId={subject} />
            : <EmptyState title="Choose a class and subject" body="Every chapter of that subject shows here, with its progress." />
        ) : !ready ? (
          <EmptyState title={all && by === 'teacher' ? 'Choose a teacher' : 'Choose a class and subject'}
            body={opts.data && !opts.data.sections.length ? 'No classes are in the timetable for this year yet.' : 'The lesson plan for every period in the timetable shows here.'} />
        ) : reg.isError ? <ErrorState error={reg.error} /> : (
          <>
          {planned.length > 0 && (
            <CellGrid cols={4}>
              <Stat label="Planned days" value={planned.length} tint onClick={() => pick('planned')} active={only === 'planned'} />
              <Stat label="Completed" value={count('completed')} tint onClick={() => pick('completed')} active={only === 'completed'} />
              <Stat label="Ongoing" value={count('ongoing')} tint onClick={() => pick('ongoing')} active={only === 'ongoing'} />
              <Stat label="Not completed" value={count('not_completed')} tint onClick={() => pick('not_completed')} active={only === 'not_completed'} />
            </CellGrid>
          )}
          <Table head={head} loading={reg.isPending} empty={!shown.length} emptyLabel={only ? 'No periods with this status.' : 'No periods for this choice in the timetable.'} noExport>
            {shown.map((r) => {
              const edit = r.mine
              return (
                <tr key={rowKey(r)} className={cn(r.day_type === 'HD' && 'bg-muted/40 text-muted-foreground')}>
                  <Td className="num w-[56px] font-semibold text-muted-foreground">{r.sno}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="font-semibold tabular-nums text-foreground">{ddmmyyyy(r.date)}{r.date_to && <> to {ddmmyyyy(r.date_to)}</>}</span>
                    <span className="mt-0.5 block text-[12px] text-muted-foreground">{weekday(r.date)}{r.date_to && <> to {weekday(r.date_to)}</>}</span>
                  </Td>
                  <Td><span title={DAY_TYPE[r.day_type]}><Badge tone={r.day_type === 'HD' ? 'danger' : r.day_type === 'ND' || r.day_type === 'NED' ? 'warning' : r.day_type === 'TED' ? 'info' : 'neutral'} className="rounded-md px-2.5 py-1 font-semibold">{r.day_type}</Badge></span></Td>
                  {showClass && <Td><Badge tone="primary" className="rounded-lg px-3 py-1 font-semibold">{sectionLabel(r)}</Badge></Td>}
                  {showClass && <Td className="font-semibold">{r.subject}</Td>}
                  <Td>{r.period && <Badge className="rounded-md border border-border px-2.5 py-1">{r.period}</Badge>}</Td>
                  <Td className="min-w-[240px] max-w-[560px] whitespace-normal leading-relaxed">
                    {edit ? <TopicCell value={r.topic} onSave={(topic) => topic !== r.topic && save.mutate({ row: r, topic })} />
                      : r.topic || (r.period_id ? <span className="text-[13px] italic text-muted-foreground">Not written</span> : null)}
                  </Td>
                  <Td className="min-w-[160px]">
                    {r.status && <StatusBadge status={r.status} />}
                  </Td>
                </tr>
              )
            })}
          </Table>
          </>
        )}
        </>
      </PageBody>
    </>
  )
}

/** The topic: a Save button shows once it is changed (Enter or leaving the box saves too), then "Saved". */
function TopicCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  const [asked, setAsked] = useState(false)
  useEffect(() => setV(value), [value])
  const dirty = v.trim() !== value
  const commit = () => { if (dirty) { setAsked(true); onSave(v.trim()) } }
  return (
    <div className="flex items-center gap-2" onKeyDown={(e) => { if (e.key === 'Enter') commit() }}>
      <div className="min-w-0 flex-1"><Input value={v} onChange={(x) => { setV(x); setAsked(false) }} onBlur={commit} placeholder="Write the topic" srLabel="Topic" /></div>
      {dirty ? <Button size="sm" onClick={commit}>Save</Button>
        : asked && <span role="status" className="shrink-0 text-[13px] font-medium text-success">Saved</span>}
    </div>
  )
}

function StatusBadge({ status }: { status: Status }) {
  return <Badge tone={status === 'completed' ? 'success' : status === 'ongoing' ? 'warning' : 'danger'} className="rounded-full px-3 py-1 font-semibold">{statusLabel(status)}</Badge>
}
