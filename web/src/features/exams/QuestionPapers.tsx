import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  Select, Textarea, Field, FormGrid, FormNotice, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import FileView, { type ViewableFile } from '@/components/FileView'
import { useRouteFeature } from '@/lib/catalog'
import { formatDate } from '@/lib/utils'

/* The paper, read before it is printed.
 *
 * Every school does this and none of it was here: a teacher sets the paper, a
 * head of department reads it against the syllabus and the time allowed, and it
 * either goes to the press or comes back. It was happening on WhatsApp, which
 * means there was no record of who approved what — and when a paper goes out
 * carrying a question from a chapter not yet taught, that record is the only
 * thing the school has.
 *
 * One screen for both people. A teacher opens it and sees their own papers and
 * the exams they still owe one for; a head of department sees the queue. A head
 * of department is both, so their own papers appear too — marked, and without
 * the Approve button, because approving your own paper is the thing this exists
 * to prevent.
 */

interface Paper {
  id: string
  exam_name: string
  exam_date: string | null
  class: string
  subject: string
  max_marks: string
  duration_minutes: number | null
  file_id: string | null
  notes: string | null
  status: 'draft' | 'submitted' | 'approved' | 'changes_needed'
  set_by: string
  submitted_at: string
  reviewed_by: string | null
  review_note: string | null
  mine: boolean
}

interface Slot {
  exam_subject_id: string
  exam_name: string
  exam_date: string | null
  class: string
  subject: string
  max_marks: string
  status: string | null
}

const STATUS: Record<Paper['status'], { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = {
  draft: { label: 'Not sent yet', tone: 'neutral' },
  submitted: { label: 'Waiting', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  changes_needed: { label: 'Sent back', tone: 'danger' },
}

export default function QuestionPapers() {
  const nav = useRouteFeature()
  const qc = useQueryClient()
  const [done, setDone] = useState('')
  const [returning, setReturning] = useState<string | null>(null)
  const [note, setNote] = useState('')

  // Composing a new one.
  const [slot, setSlot] = useState('')
  const [file, setFile] = useState<UploadedFile | null>(null)
  const [notes, setNotes] = useState('')
  const [viewFile, setViewFile] = useState<ViewableFile | null>(null)
  /* Papers accumulate every term and nothing ever leaves, so the table grows
     past the screen and buries the form above it. */
  const [showAll, setShowAll] = useState(false)

  const q = useQuery({
    queryKey: ['question-papers'],
    queryFn: () =>
      api.get<{ items: Paper[]; decides: boolean; whole_school: boolean }>(
        '/api/v1/exams/question-papers',
      ),
  })
  const slots = useQuery({
    queryKey: ['question-paper-slots'],
    queryFn: () => api.get<{ items: Slot[] }>('/api/v1/exams/question-papers/slots'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['question-papers'] })
    qc.invalidateQueries({ queryKey: ['question-paper-slots'] })
  }

  const submit = useMutation({
    mutationFn: (send: boolean) =>
      api.post('/api/v1/exams/question-papers', {
        exam_subject_id: slot,
        file_id: file?.file_id ?? null,
        notes,
        submit: send,
      }),
    onSuccess: (_r, send) => {
      setDone(send ? 'Sent for approval.' : 'Saved. It has not gone anywhere yet.')
      setSlot('')
      setFile(null)
      setNotes('')
      refresh()
    },
  })

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'changes_needed'; note?: string }) =>
      api.post(`/api/v1/exams/question-papers/${v.id}/decide`, {
        decision: v.decision,
        note: v.note ?? '',
      }),
    onSuccess: (_r, v) => {
      setDone(v.decision === 'approved' ? 'Approved.' : 'Sent back to the teacher.')
      setReturning(null)
      setNote('')
      refresh()
    },
  })

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data!

  const open = slots.data?.items.filter((s) => !s.status) ?? []

  return (
    <>
      {viewFile && <FileView file={viewFile} onClose={() => setViewFile(null)} />}
      {/* The breadcrumb the rest of the product has. Every other screen opens
          with "section / page" above its title; this one opened with the
          title alone, so the one screen a head of department reaches from
          two different menus never said which menu it was under. Taken from
          the catalogue, which is also what the menu and the search read. */}
      <PageHead
        eyebrow={nav.section?.name}
        title={nav.feature?.name ?? 'Question papers'}
        description={
          d.decides
            ? d.whole_school
              ? 'Papers waiting to be read, from every class in the school.'
              : "Papers waiting to be read, for your department's classes."
            : 'Papers you have set, and where each of them has got to.'
        }
      />
      <PageBody>
        {done && <FormNotice ok={done} />}
        {(submit.error || decide.error) && (
          <FormNotice error={submit.error ?? decide.error} />
        )}

        {/* Nothing to set a paper against.
         *
         * The form only appears when there is an exam paper to attach one to,
         * and when there is not, the screen used to show an empty list whose
         * own words said "set one above" — pointing at a control that was not
         * there. Somebody reading that concludes the button is broken, not
         * that the school has no exams yet. So the reason is said, with the
         * one thing that fixes it. */}
        {open.length === 0 && slots.data && (
          <EmptyState
            title="No exam papers to write against yet."
            body={
              (slots.data.items.length ?? 0) > 0
                ? 'Every exam paper for your classes already has a paper submitted. There is nothing left to set.'
                : 'This school has no exams scheduled for your classes. Once the office schedules one, each subject you teach appears here to attach a paper to.'
            }
          />
        )}

        {open.length > 0 && (
          <Card>
            <CardHeader
              title="Set a paper"
              description={`${open.length} of your exams have no paper yet.`}
            />
            {/* Padded, like every other card in the product. FormGrid draws
                no padding of its own, so the fields, the attach button and the
                two actions were all flush against the card's edges. */}
            <div className="px-5 pb-5 pt-4">
            <FormGrid>
              <Field label="Which exam">
                <Select
                  value={slot}
                  onChange={setSlot}
                  placeholder="Choose…"
                  options={open.map((s) => ({
                    value: s.exam_subject_id,
                    label:
                      `${s.class} · ${s.subject} · ${s.exam_name}` +
                      (s.exam_date ? ` · ${formatDate(s.exam_date)}` : ''),
                  }))}
                />
              </Field>
              <Field label="Anything the reader should know" hint="Optional.">
                <Textarea
                  rows={2}
                  value={notes}
                  onChange={setNotes}
                  placeholder="Covers units 1–4. Section C is the new pattern."
                />
              </Field>
            </FormGrid>
            <FilePicker
              value={file}
              onChange={setFile}
              purpose="question_paper"
              label="Attach the paper"
              hint="A PDF, a document, or a photograph of the paper. Any file type is accepted. It is not shown to students."
            />
            <div className="flex flex-wrap items-center gap-2 pt-4">
              <Button
                onClick={() => submit.mutate(true)}
                disabled={!slot || !file || submit.isPending}
              >
                Send for approval
              </Button>
              {/* Saving without sending exists so that a half-finished paper is
                  not lost, and so that "send" always means "somebody is now
                  waiting on this". */}
              <Button variant="ghost" onClick={() => submit.mutate(false)} disabled={!slot || submit.isPending}>
                Save without sending
              </Button>
            </div>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title={d.decides ? 'Papers' : 'My papers'} />
          {d.items.length === 0 ? (
            <EmptyState
              title="No papers yet."
              body={
                d.decides
                  ? 'When a teacher sends one for approval it appears here.'
                  : 'Papers you set appear here with where each has got to.'
              }
            />
          ) : (
            <>
            <Table head={['Exam', 'Class & subject', 'Set by', 'Status', '']}>
              {(showAll ? d.items : d.items.slice(0, 8)).map((p) => (
                <tr key={p.id}>
                  <Td>
                    {p.exam_name}
                    {p.exam_date && (
                      <span className="block text-[11.5px] text-muted-foreground">
                        {formatDate(p.exam_date)}
                        {p.duration_minutes ? ` · ${p.duration_minutes} min` : ''}
                        {` · out of ${p.max_marks}`}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {p.class} · {p.subject}
                    {p.notes && (
                      <span className="block text-[11.5px] text-muted-foreground">{p.notes}</span>
                    )}
                  </Td>
                  <Td>{p.mine ? 'You' : p.set_by}</Td>
                  <Td>
                    <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                    {p.review_note && (
                      <span className="block text-[11.5px] text-muted-foreground">
                        {p.reviewed_by ? `${p.reviewed_by}: ` : ''}
                        {p.review_note}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Read here, not downloaded. A head approving a paper
                          reads it and moves on; a copy of an unsat exam paper
                          in somebody's Downloads folder is the last thing a
                          school wants lying about. */}
                      {p.file_id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setViewFile({
                            file_id: p.file_id!,
                            name: `${p.exam_name} — ${p.subject}`,
                          })}
                        >
                          Open paper
                        </Button>
                      )}
                      {/* Deciding is offered only on somebody else's paper that
                          is actually waiting. */}
                      {d.decides && p.status === 'submitted' && !p.mine && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => decide.mutate({ id: p.id, decision: 'approved' })}
                            disabled={decide.isPending}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setReturning(returning === p.id ? null : p.id)
                              setNote('')
                            }}
                          >
                            Send back
                          </Button>
                        </>
                      )}
                    </div>
                    {returning === p.id && (
                      <div className="mt-2 space-y-2">
                        <Textarea
                          rows={2}
                          value={note}
                          onChange={setNote}
                          placeholder="What needs changing? The teacher sees this."
                        />
                        <Button
                          size="sm"
                          onClick={() =>
                            decide.mutate({ id: p.id, decision: 'changes_needed', note })
                          }
                          disabled={!note.trim() || decide.isPending}
                        >
                          Send it back
                        </Button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
            {d.items.length > 8 && !showAll && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full border-t px-5 py-3 text-left text-[13px] font-medium text-primary hover:bg-muted/40"
              >
                Show all {d.items.length} — including {d.items.length - 8} older
              </button>
            )}
            </>
          )}
        </Card>
      </PageBody>
    </>
  )
}
