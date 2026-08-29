import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileQuestion, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import {
  DIFFICULTIES, useTeachingClasses, useTeachingSubjects, label,
  type BankQuestion, type OnlineTest, type OnlineTestDetail,
} from './teaching'

/* Building an objective test from the bank.

   Only auto-markable kinds may go on the paper — multiple choice, true/false
   and fill-in-the-blank. Nothing in the product can mark prose, so a long
   answer here would produce a test that silently never finishes marking; the
   picker does not offer them and the server refuses them.

   A test is created as a draft and cannot be published empty. */

export default function OnlineTests() {
  const [composing, setComposing] = useState(false)
  const [openID, setOpenID] = useState('')

  const list = useQuery({
    queryKey: ['online-tests'],
    queryFn: () => api.get<List<OnlineTest>>('/api/v1/teaching/online-tests'),
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []
  const { q: term, setQ: setTerm, shown } = useSearch(rows,
    (t) => [t.title, t.subject, t.class_name, t.section, t.status])

  return (
    <>
      <PageHead
        eyebrow="Question papers & online tests"
        title="Objective online test creation"
        description="Assemble an auto-marked test from your question bank and publish it to a class."
        actions={
          <Button onClick={() => setComposing((c) => !c)}>
            <Plus className="h-3.5 w-3.5" />
            {composing ? 'Close' : 'New test'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Tests" value={rows.length} icon={FileQuestion} />
          <Stat label="Published" value={rows.filter((t) => t.status === 'published').length} />
          <Stat label="Drafts" value={rows.filter((t) => t.status === 'draft').length} />
        </CellGrid>

        {composing && <Compose onDone={() => setComposing(false)} />}

        <Card>
          <CardHeader title="Tests" description="Most recent first" />
          {rows.length === 0 ? (
            <EmptyState
              title="No tests yet"
              body="Create one, add questions from the bank, then publish it."
            />
          ) : (
            <>
            <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
              <SearchBox value={term} onChange={setTerm} placeholder="Title, subject or class" />
              <Showing shown={shown.length} total={rows.length} noun="tests" />
              <ExportRows
                rows={shown}
                name="online-tests"
                columns={[
                  { header: 'Title', value: (t) => t.title },
                  { header: 'Class', value: (t) => `${t.class_name} ${t.section ?? ''}`.trim() },
                  { header: 'Subject', value: (t) => t.subject },
                  { header: 'Opens', value: (t) => t.opens_at },
                  { header: 'Minutes', value: (t) => t.duration_minutes },
                  { header: 'Status', value: (t) => t.status },
                ]}
              />
            </div>
            <Table head={['Title', 'Class', 'Subject', 'Opens', 'Questions', 'Marks', 'Status', '']}>
              {shown.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <span className="font-medium">{t.title}</span>
                    {t.duration_minutes && (
                      <span className="block text-[12px] text-muted-foreground">
                        {t.duration_minutes} minutes
                      </span>
                    )}
                  </Td>
                  <Td>{t.class_name} {t.section}</Td>
                  <Td>{t.subject}</Td>
                  <Td>{t.opens_at ? formatDate(t.opens_at) : '—'}</Td>
                  <Td>{t.questions}</Td>
                  <Td>{t.total_marks ?? 0}</Td>
                  <Td>
                    <Badge
                      tone={
                        t.status === 'published' ? 'success'
                          : t.status === 'closed' ? 'neutral' : 'warning'
                      }
                    >
                      {t.status}
                    </Badge>
                  </Td>
                  <Td>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setOpenID(openID === t.id ? '' : t.id)}
                    >
                      {openID === t.id ? 'Close' : 'Build'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
            </>
          )}
        </Card>

        {openID && <Builder testID={openID} />}
      </PageBody>
    </>
  )
}

function Compose({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const classes = useTeachingClasses()
  const subjects = useTeachingSubjects()

  const [sectionID, setSectionID] = useState('')
  const [classSubjectID, setClassSubjectID] = useState('')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [opensAt, setOpensAt] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const [duration, setDuration] = useState('')
  const [shuffle, setShuffle] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/teaching/online-tests', {
        section_id: sectionID,
        class_subject_id: classSubjectID,
        title,
        instructions: instructions || undefined,
        opens_at: opensAt ? `${opensAt}:00+05:30` : undefined,
        closes_at: closesAt ? `${closesAt}:00+05:30` : undefined,
        duration_minutes: duration ? Number(duration) : undefined,
        shuffle_questions: shuffle,
      }),
    onSuccess: () => {
      toast.ok('Draft created — now add questions')
      qc.invalidateQueries({ queryKey: ['online-tests'] })
      onDone()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not create'),
  })

  return (
    <Card>
      <CardHeader
        title="New test"
        description="Created as a draft; it cannot be published until it has questions."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Class" required>
            <Select
              value={sectionID}
              onChange={setSectionID}
              placeholder="Choose a class"
              options={(classes.data?.items ?? []).map((c) => ({
                value: c.section_id,
                label: `${c.class_name} ${c.section_name}`,
              }))}
            />
          </Field>
          <Field label="Subject" required>
            <Select
              value={classSubjectID}
              onChange={setClassSubjectID}
              placeholder="Choose a subject"
              options={(subjects.data?.items ?? []).map((s) => ({
                value: s.class_subject_id,
                label: `${s.class_name} · ${s.subject}`,
              }))}
            />
          </Field>
          <Field label="Title" required>
            <Input value={title} onChange={setTitle} placeholder="Mental maths — week 6" />
          </Field>
          <Field label="Minutes allowed" hint="Leave blank for an untimed test">
            <Input value={duration} onChange={setDuration} placeholder="20" />
          </Field>
          <Field label="Opens">
            <Input value={opensAt} onChange={setOpensAt} type="datetime-local" />
          </Field>
          <Field label="Closes">
            <Input value={closesAt} onChange={setClosesAt} type="datetime-local" />
          </Field>
        </FormGrid>
        <Field label="Instructions">
          <Textarea value={instructions} onChange={setInstructions} rows={2} />
        </Field>
        <div className="mt-3">
          <Checkbox
            checked={shuffle}
            onChange={setShuffle}
            label="Shuffle the questions for each child"
          />
        </div>
        <FormNotice error={save.error} />
        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => save.mutate()}
            disabled={!sectionID || !classSubjectID || !title.trim()}
          >
            Create draft
          </Button>
          <Button variant="secondary" onClick={onDone}>Cancel</Button>
        </div>
      </div>
    </Card>
  )
}

/* The paper builder.

   The bank is filtered to the test's own subject and to auto-markable kinds
   only, so a teacher cannot pick a question the marker could never handle. */
function Builder({ testID }: { testID: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [picked, setPicked] = useState<string[]>([])

  const test = useQuery({
    queryKey: ['online-test', testID],
    queryFn: () => api.get<OnlineTestDetail>(`/api/v1/teaching/online-tests/${testID}`),
  })

  const bank = useQuery({
    queryKey: ['question-bank', test.data?.class_subject_id],
    enabled: !!test.data?.class_subject_id,
    queryFn: () =>
      api.get<List<BankQuestion>>(
        `/api/v1/teaching/question-bank?class_subject_id=${test.data!.class_subject_id}`,
      ),
  })

  const setPaper = useMutation({
    mutationFn: (ids: string[]) =>
      api.put(`/api/v1/teaching/online-tests/${testID}/questions`, {
        questions: ids.map((question_id) => ({ question_id })),
      }),
    onSuccess: () => {
      toast.ok('Paper saved')
      setPicked([])
      qc.invalidateQueries({ queryKey: ['online-test', testID] })
      qc.invalidateQueries({ queryKey: ['online-tests'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save the paper'),
  })

  const publish = useMutation({
    mutationFn: (status: string) =>
      api.put(`/api/v1/teaching/online-tests/${testID}`, { status }),
    onSuccess: () => {
      toast.ok('Test updated')
      qc.invalidateQueries({ queryKey: ['online-test', testID] })
      qc.invalidateQueries({ queryKey: ['online-tests'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not publish'),
  })

  if (test.isLoading) return <Loading />
  if (test.error) return <ErrorState error={test.error} />
  const detail = test.data!
  const onPaper = detail.paper.map((p) => p.question_id)
  // Only auto-markable questions are offered; the server refuses the rest.
  const available = (bank.data?.items ?? []).filter(
    (q) => q.objective && !onPaper.includes(q.id),
  )
  const selection = picked.length > 0 ? picked : onPaper

  return (
    <>
      <Card>
        <CardHeader
          title={`Paper — ${detail.title}`}
          description={`${detail.paper.length} questions, ${detail.total_marks ?? 0} marks`}
          action={
            <>
              {detail.status !== 'published' && (
                <Button
                  onClick={() => publish.mutate('published')}
                  disabled={detail.paper.length === 0}
                  title={
                    detail.paper.length === 0
                      ? 'Add at least one question first'
                      : undefined
                  }
                >
                  Publish
                </Button>
              )}
              {detail.status === 'published' && (
                <Button variant="secondary" onClick={() => publish.mutate('closed')}>
                  Close the test
                </Button>
              )}
            </>
          }
        />
        {detail.paper.length === 0 ? (
          <EmptyState
            title="No questions on this paper yet"
            body="Pick from the bank below, then save the paper."
          />
        ) : (
          <Table head={['#', 'Question', 'Answer', 'Kind', 'Difficulty', 'Marks']}>
            {detail.paper.map((q) => (
              <tr key={q.question_id}>
                <Td>{q.sequence}</Td>
                <Td>{q.stem}</Td>
                <Td>
                  {q.answer_key.filter((o) => o.is_correct).map((o) => o.body).join(', ') || '—'}
                </Td>
                <Td>{q.kind}</Td>
                <Td>{label(DIFFICULTIES, q.difficulty)}</Td>
                <Td>{q.marks}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Add from the bank"
          description="Only auto-markable questions for this subject are listed."
          action={
            <Button
              onClick={() => setPaper.mutate(selection)}
              disabled={picked.length === 0}
            >
              Save paper
            </Button>
          }
        />
        {available.length === 0 ? (
          <EmptyState
            title="Nothing left to add"
            body="Bank more objective questions for this subject to lengthen the paper."
          />
        ) : (
          <Table head={['', 'Question', 'Chapter', 'Kind', 'Difficulty', 'Marks']}>
            {available.map((q) => (
              <tr key={q.id}>
                <Td>
                  <Checkbox
                    checked={picked.includes(q.id)}
                    onChange={(v) =>
                      setPicked((p) =>
                        v ? [...onPaper, ...p.filter((x) => x !== q.id), q.id]
                          : p.filter((x) => x !== q.id),
                      )
                    }
                    label=""
                    srLabel={`Add to the paper: ${q.stem}`}
                  />
                </Td>
                <Td>{q.stem}</Td>
                <Td>{q.chapter ?? '—'}</Td>
                <Td>{q.kind}</Td>
                <Td>{label(DIFFICULTIES, q.difficulty)}</Td>
                <Td>{q.default_marks}</Td>
              </tr>
            ))}
          </Table>
        )}
        <FormNotice error={setPaper.error} />
      </Card>
    </>
  )
}
