import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, NotebookPen, ClipboardList } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Entry {
  on_date: string
  kind: string
  title: string
  detail?: string
  starts_at?: string
  ends_at?: string
  ref_id?: string
  done: boolean
}
interface DiaryResponse {
  student_id: string
  class_name: string
  section_name: string
  from: string
  to: string
  items: Entry[]
}

const KIND_LABEL: Record<string, string> = {
  period: 'Lesson',
  homework: 'Due',
  exam: 'Test',
  note: 'Your note',
  club_event: 'Club',
  holiday: 'Closed',
  vacation: 'Holiday',
  ptm: 'Parents’ evening',
  event: 'Event',
  working_day: 'Working day',
}
const KIND_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  period: 'neutral',
  homework: 'warning',
  exam: 'danger',
  note: 'primary',
  club_event: 'info',
  holiday: 'success',
  vacation: 'success',
}

const NOTE_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'reminder', label: 'Reminder' },
  { value: 'homework', label: 'Homework' },
  { value: 'revision', label: 'Revision' },
  { value: 'personal', label: 'Personal' },
]

const today = () => new Date().toISOString().slice(0, 10)

/* The child's own day, and the week in front of it.

   Everything but the notes is read from where it already lives — the
   timetable, the homework set for this section, the papers this class sits,
   the closures. None of it is copied here, so the day the office moves a
   period the diary moves with it rather than quietly disagreeing.

   The notes are the only thing this screen stores, and they are private. No
   teacher screen reads them, deliberately: a diary somebody else can read is
   not a diary, and a child who works that out stops writing anything true in
   it, which is the only thing it was for. */
export default function Diary() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [from, setFrom] = useState(today())
  const [days, setDays] = useState('7')
  const [noteDate, setNoteDate] = useState(today())
  const [noteKind, setNoteKind] = useState('note')
  const [noteBody, setNoteBody] = useState('')

  const to = (() => {
    const d = new Date(from)
    d.setDate(d.getDate() + (Number(days) - 1))
    return d.toISOString().slice(0, 10)
  })()

  const diary = useQuery({
    queryKey: ['diary', studentId, from, to],
    queryFn: () =>
      api.get<DiaryResponse>(
        `/api/v1/portal/diary${studentQuery(studentId, `from=${from}`, `to=${to}`)}`,
      ),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['diary'] })

  const write = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/diary/notes', {
        student_id: studentId || undefined,
        on_date: noteDate,
        kind: noteKind,
        body: noteBody,
      }),
    onSuccess: () => {
      setNoteBody('')
      refresh()
    },
  })

  const tick = useMutation({
    mutationFn: (v: { id: string; done: boolean }) =>
      api.post(`/api/v1/portal/diary/notes/${v.id}`, { done: v.done }),
    onSuccess: refresh,
  })

  const drop = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/portal/diary/notes/${id}`),
    onSuccess: refresh,
  })

  if (diary.isLoading && ready) return <Loading label="Reading your week…" />
  if (diary.error) return <ErrorState error={diary.error} />

  const items = diary.data?.items ?? []
  const byDay = items.reduce<Record<string, Entry[]>>((acc, e) => {
    ;(acc[e.on_date] ??= []).push(e)
    return acc
  }, {})
  const dueSoon = items.filter((e) => e.kind === 'homework').length
  const tests = items.filter((e) => e.kind === 'exam').length
  const openNotes = items.filter((e) => e.kind === 'note' && !e.done).length

  return (
    <>
      <PageHead
        eyebrow="Home"
        title="Diary and schedule"
        description="Your lessons, what is due, what is coming, and whatever you write down yourself."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="Each child has their own day." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Due in this window" value={dueSoon} icon={ClipboardList} />
              <Stat label="Tests coming" value={tests} icon={CalendarDays} />
              <Stat label="Notes not ticked off" value={openNotes} icon={NotebookPen} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Write a note"
                description="Only you can read these."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="Against which day" required>
                    <Input value={noteDate} onChange={setNoteDate} type="date" />
                  </Field>
                  <Field label="What kind">
                    <Select value={noteKind} onChange={setNoteKind} options={NOTE_KINDS} />
                  </Field>
                  <Field label="What" wide required>
                    <Textarea
                      value={noteBody}
                      onChange={setNoteBody}
                      rows={2}
                      placeholder="Pack the PE kit. Finish question 7 before the lesson."
                    />
                  </Field>
                </FormGrid>
                <FormNotice error={write.error} ok={write.isSuccess ? 'Written down.' : undefined} />
                <Button
                  onClick={() => write.mutate()}
                  disabled={!noteBody.trim() || write.isPending}
                >
                  {write.isPending ? 'Saving…' : 'Add it'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Your days"
                description={`${diary.data?.class_name ?? ''}-${diary.data?.section_name ?? ''}`}
                action={
                  <div className="flex flex-wrap gap-3">
                    <div className="w-40">
                      <Field label="From">
                        <Input value={from} onChange={setFrom} type="date" />
                      </Field>
                    </div>
                    <div className="w-40">
                      <Field label="How long">
                        <Select
                          value={days}
                          onChange={setDays}
                          options={[
                            { value: '1', label: 'Just today' },
                            { value: '7', label: 'A week' },
                            { value: '14', label: 'A fortnight' },
                          ]}
                        />
                      </Field>
                    </div>
                  </div>
                }
              />
              {items.length === 0 ? (
                <EmptyState
                  title="Nothing in this window"
                  body="No lessons, work or events fall in these days."
                />
              ) : (
                <div className="divide-y">
                  {Object.entries(byDay).map(([date, entries]) => (
                    <div key={date} className="px-5 py-4">
                      <p className="text-[13px] font-medium text-secondary-foreground">
                        {formatDate(date)}
                      </p>
                      <ul className="mt-2 space-y-2">
                        {entries.map((e, i) => (
                          <li
                            key={`${date}-${i}`}
                            className="flex flex-wrap items-start justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <p className="text-[14px]">
                                <Badge tone={KIND_TONE[e.kind] ?? 'neutral'}>
                                  {KIND_LABEL[e.kind] ?? e.kind}
                                </Badge>
                                <span className={e.done ? 'line-through opacity-60' : ''}>
                                  {e.title}
                                </span>
                              </p>
                              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                                {[e.starts_at, e.ends_at].filter(Boolean).join('–')}
                                {e.detail ? ` ${e.starts_at ? '· ' : ''}${e.detail}` : ''}
                              </p>
                            </div>
                            {e.kind === 'note' && e.ref_id && (
                              <div className="flex shrink-0 items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={tick.isPending}
                                  onClick={() =>
                                    tick.mutate({ id: e.ref_id as string, done: !e.done })
                                  }
                                >
                                  {e.done ? 'Undo' : 'Done'}
                                </Button>
                                <ConfirmButton
                                  question="Delete this note?"
                                  confirmLabel="Delete"
                                  tone="danger"
                                  onConfirm={() => drop.mutate(e.ref_id as string)}
                                >
                                  Delete
                                </ConfirmButton>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={tick.error ?? drop.error} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
