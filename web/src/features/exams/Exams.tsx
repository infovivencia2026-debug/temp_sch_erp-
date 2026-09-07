import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  Input, Select, Field, FormGrid, FormNotice, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'

/* The exam, and the papers everything else hangs off.
 *
 * Exams could only be created in the setup wizard, and their papers with them.
 * Afterwards there was no route at all — so an exam scheduled without papers,
 * or one that gained a class in September, could never be given any. Marks
 * entry says "no exam papers exist yet"; question paper approval has nothing to
 * approve; moderation has nothing to moderate; hall tickets have nothing to
 * print; report cards have nothing to total. One missing route stopped five
 * screens, and the only visible symptom was five empty pages that each looked
 * broken on their own.
 *
 * A paper is one subject of one class in one exam. Adding them is idempotent —
 * run it again after adding a class and only the missing ones appear — because
 * the alternative is asking somebody to work out which subjects they already
 * did.
 *
 * AND THE SAME WAS TRUE OF THE EXAM ITSELF, one level up. The note above was
 * written about papers and left the hole it describes: scheduling an exam
 * existed only inside the setup wizard, which is a thing a school is walked
 * through once, in its first week. Every exam after that one — FA2 in August,
 * SA1 in October, the re-test for the children who missed it — had to be
 * created by going back into a wizard whose own heading calls it getting
 * started. A school in the middle of its year is not getting started.
 *
 * The form below is the wizard's, on the screen that lists what it creates,
 * calling the same endpoint. Not a copy of the rules: the CCE components and
 * the marks that go with them are the school's exam policy, and two forms that
 * each decided what FA1 is out of would eventually disagree in a report card.
 */

interface Exam {
  id: string
  name: string
  kind: string
  starts_on?: string
  is_published: boolean
  papers: number
}

export default function Exams() {
  const qc = useQueryClient()
  const [marks, setMarks] = useState('100')
  const [done, setDone] = useState('')
  const [scheduling, setScheduling] = useState(false)

  const exams = useQuery({
    queryKey: ['exams-list'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })

  const addPapers = useMutation({
    mutationFn: (examID: string) =>
      api.post<{ papers_added: number }>(`/api/v1/exams/${examID}/papers`, {
        max_marks: Number(marks) || 100,
      }),
    onSuccess: (r) => {
      setDone(
        `${r.papers_added} papers created — one for every subject each class studies. ` +
          'Marks entry, question paper approval and report cards can run now.',
      )
      qc.invalidateQueries({ queryKey: ['exams-list'] })
    },
    onError: () => setDone(''),
  })

  if (exams.isLoading) return <SkeletonTable columns={6} />
  if (exams.error) return <ErrorState error={exams.error} />
  const rows = exams.data?.items ?? []
  const empty = rows.filter((e) => e.papers === 0)

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Exams & papers"
        description="Every exam the school has scheduled, and how many papers it holds. Nothing downstream — marks, moderation, hall tickets, report cards — can run until an exam has papers."
      />
      <PageBody>
        {/* Open when there are none, because then it is the only thing to do
            here; behind a button once exams exist, so the list somebody came
            to read is not underneath a form. */}
        {scheduling || rows.length === 0 ? (
          <ScheduleExam
            onCancel={rows.length === 0 ? undefined : () => setScheduling(false)}
            onDone={(name) => {
              setScheduling(false)
              setDone(`${name} scheduled. Give it papers below before marks entry can run.`)
              qc.invalidateQueries({ queryKey: ['exams-list'] })
            }}
          />
        ) : (
          <div className="flex justify-end">
            <Button onClick={() => setScheduling(true)}>Schedule an exam</Button>
          </div>
        )}

        {done && <FormNotice ok={done} />}
        {addPapers.error && <FormNotice error={addPapers.error} />}

        {empty.length > 0 && (
          <Card>
            <CardHeader
              title={`${empty.length} ${empty.length === 1 ? 'exam has' : 'exams have'} no papers`}
              description="An exam with no papers cannot be marked, moderated, or turned into a report card. Creating them makes one paper for every subject each class studies."
            />
            <FormGrid>
              <Field label="Each paper is out of" hint="20 for a formative, 80 for a summative, 100 for a term exam.">
                <Input type="number" value={marks} onChange={setMarks} />
              </Field>
            </FormGrid>
          </Card>
        )}

        <Card>
          <CardHeader title="Exams" description="Most recently starting first." />
          {rows.length === 0 ? (
            <EmptyState
              title="No exams scheduled yet."
              body="Schedule one on School setup → Exams, then create its papers here."
            />
          ) : (
            <Table head={['Exam', 'Kind', 'Starts', 'Papers', 'Published', '']}>
              {rows.map((e) => (
                <tr key={e.id}>
                  <Td className="font-medium">{e.name}</Td>
                  <Td>{e.kind}</Td>
                  <Td className="text-muted-foreground">
                    {e.starts_on ? formatDate(e.starts_on) : '—'}
                  </Td>
                  <Td>
                    {e.papers > 0 ? (
                      e.papers
                    ) : (
                      /* Said as the consequence, not as a zero. A zero in this
                         column is the reason five other screens are empty. */
                      <Badge tone="warning">none — nothing can be marked</Badge>
                    )}
                  </Td>
                  <Td>
                    {e.is_published ? <Badge tone="success">published</Badge> : '—'}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant={e.papers === 0 ? 'primary' : 'ghost'}
                      disabled={addPapers.isPending}
                      onClick={() => addPapers.mutate(e.id)}
                    >
                      {e.papers === 0 ? 'Create papers' : 'Add missing papers'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}


/* SCHEDULING ONE, WITH THE SAME RULES THE WIZARD USES.

   Under CCE the four formative assessments are out of 20 and the three
   summative ones out of 80, so choosing the component sets the marks rather
   than asking twice and letting the two answers differ. Papers are created for
   every subject each chosen class studies, which is what makes the exam usable
   by marks entry, moderation, hall tickets and report cards -- an exam with no
   papers stops all four, and looks like four broken screens rather than one
   unfinished exam. */
const CCE = [
  { value: 'FA1', label: 'FA1 — formative, 20 marks' },
  { value: 'FA2', label: 'FA2 — formative, 20 marks' },
  { value: 'FA3', label: 'FA3 — formative, 20 marks' },
  { value: 'FA4', label: 'FA4 — formative, 20 marks' },
  { value: 'SA1', label: 'SA1 — summative, 80 marks' },
  { value: 'SA2', label: 'SA2 — summative, 80 marks' },
  { value: 'SA3', label: 'SA3 — summative, 80 marks' },
]

interface Klass { id: string; name: string }

function ScheduleExam({
  onDone,
  onCancel,
}: {
  onDone: (name: string) => void
  onCancel?: () => void
}) {
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const [f, setF] = useState({
    name: '', kind: 'formative', cce_component: 'FA1',
    starts_on: '', ends_on: '', max_marks: '20',
  })
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/setup/exams', {
        ...f,
        max_marks: Number(f.max_marks) || 20,
        class_ids: [...picked],
      }),
    onSuccess: () => onDone(f.name.trim() || 'The exam'),
  })

  const list = classes.data?.items ?? []
  const ready = f.name.trim() !== '' && picked.size > 0

  return (
    <Card>
      <CardHeader
        title="Schedule an exam"
        description="Choosing a CCE component sets what it is out of. A paper is created for every subject each selected class studies — without papers, marks entry, moderation, hall tickets and report cards all have nothing to work on."
      />
      <form
        className="px-5 pb-5"
        onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate() }}
      >
        <FormGrid>
          <Field label="Exam name" required>
            <Input
              value={f.name}
              onChange={(x) => setF({ ...f, name: x })}
              placeholder="Formative Assessment 2"
            />
          </Field>
          <Field label="CCE component">
            <Select
              value={f.cce_component}
              onChange={(x) =>
                setF({
                  ...f,
                  cce_component: x,
                  kind: x.startsWith('FA') ? 'formative' : 'summative',
                  max_marks: x.startsWith('FA') ? '20' : '80',
                })
              }
              options={CCE}
            />
          </Field>
          <Field label="Starts on">
            <Input type="date" value={f.starts_on} onChange={(x) => setF({ ...f, starts_on: x })} />
          </Field>
          <Field label="Ends on">
            <Input type="date" value={f.ends_on} onChange={(x) => setF({ ...f, ends_on: x })} />
          </Field>
        </FormGrid>

        <p className="eyebrow mb-2 mt-4">Classes sitting it</p>
        {classes.isLoading ? (
          <p className="text-[13px] text-muted-foreground">Reading the classes…</p>
        ) : list.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No classes yet. Add them under Academics → Class Setup first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() =>
                setPicked(picked.size === list.length ? new Set() : new Set(list.map((c) => c.id)))
              }
              className="rounded-md border px-2.5 py-1 text-[13px] hover:bg-accent"
            >
              {picked.size === list.length ? 'None' : 'All classes'}
            </button>
            {list.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  const n = new Set(picked)
                  if (n.has(c.id)) n.delete(c.id)
                  else n.add(c.id)
                  setPicked(n)
                }}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
                  picked.has(c.id)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        <FormNotice error={save.error} />

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!ready || save.isPending}>
            {save.isPending ? 'Scheduling…' : 'Schedule exam'}
          </Button>
          {onCancel && (
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          )}
          <span className="text-[12.5px] text-muted-foreground">
            {f.name.trim() === ''
              ? 'Give it a name first.'
              : picked.size === 0
                ? 'Choose at least one class.'
                : `${picked.size} ${picked.size === 1 ? 'class' : 'classes'}, out of ${f.max_marks}.`}
          </span>
        </div>
      </form>
    </Card>
  )
}
