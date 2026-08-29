import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, CheckCircle2, ChevronLeft, Clock, Eye, Paperclip, Plus, Send, Users } from 'lucide-react'
import { api, type List, type Section, type Subject } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState, Table, Td,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { formatDate } from '@/lib/utils'
import { useToast } from '@/components/Toast'

/* The homework diary, from both ends.

   The same endpoint serves a teacher and a child, and the server decides which
   is which — a teacher sees what they set and how many of the class have
   turned it in, a student sees what they owe and whether they have submitted.
   One screen rather than two, because the difference between them is one
   field, and a second screen would be the same list with a different heading
   drifting slowly out of sync. */

interface Homework {
  id: string
  title: string
  kind: string
  subject?: string
  class_name?: string
  section_name?: string
  assigned_on: string
  due_on?: string
  instructions?: string
  overdue: boolean
  submissions: number
  strength: number
  submitted: boolean
  teacher?: string
  /* What the teacher attached, and what this reader turned in. */
  files?: { file_id: string; name: string; content_type?: string; size_bytes?: number }[]
  my_answer?: string
  my_file_id?: string
  my_file_name?: string
}

interface Filters {
  kind: string
  class_id: string
  section_id: string
  subject_id: string
  from: string
  to: string
}

const NO_FILTERS: Filters = { kind: '', class_id: '', section_id: '', subject_id: '', from: '', to: '' }

export default function Homework() {
  const qc = useQueryClient()
  const [composing, setComposing] = useState(false)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [openRegister, setOpenRegister] = useState<string | null>(null)
  /* WHICH ROW IS OPEN IN FULL.

     The list is `max-h-[34rem] overflow-y-auto` with every row truncated to
     fit, so a task whose title is "complete ex : 4.2 1 to 9 problems" is cut
     mid-sentence and the instructions under it are never shown at all. That is
     right for a list — twenty tasks each showing three lines is not a list —
     but it left nowhere to read the whole thing.

     View opens one row in full: the title unclipped, the instructions the
     teacher wrote, every worksheet, and what was sent back. */
  const [viewing, setViewing] = useState<string | null>(null)

  /* Filtering happens on the server, and the query key carries the filters so
     the cache does not serve one narrowing's answer to another's question.
     The list is capped at a hundred rows there, which is the reason this is
     not a filter over what has already arrived: narrowing a page that has
     already dropped the rows being looked for finds nothing and looks like an
     empty term. */
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () =>
      api.get<{ permissions: string[]; user?: { roles?: string[] } }>('/api/v1/session'),
  })
  const canPublish = session?.permissions.includes('academics.homework.write') ?? false

  /* Only the child turns their own work in.

     The screen decided what to show from one flag: if you cannot publish
     homework you must be a student, so a PARENT was handed a Turn-in button
     and could mark their child's homework done. The endpoint allowed it too —
     a guardian has the child in scope — so nothing stopped it.

     A parent needs to see what was set and whether it has been turned in.
     Doing it for them is not a convenience; it is the one part of homework
     that only means something if the child did it. */

  /* A teacher's diary is the work that teacher set.

     The list showed everything set for any section the caller touches, and
     touch is not teach: a head of department who takes one Maths class read a
     list mostly belonging to the colleagues who share those sections. Opening
     on your own and widening is the right way round — the whole-section view
     is what a class teacher and the office want, so it stays one click away
     rather than being taken off them. */
  const [onlyMine, setOnlyMine] = useState(true)
  const mine = canPublish && onlyMine

  const query = new URLSearchParams([
    ...Object.entries(filters).filter(([, v]) => v !== ''),
    ...(mine ? [['mine', '1'] as [string, string]] : []),
  ]).toString()

  const { data, isLoading, error } = useQuery({
    queryKey: ['homework', query],
    queryFn: () => api.get<List<Homework>>('/api/v1/homework' + (query ? `?${query}` : '')),
  })

  /* Which task is open for answering, and what has been written into it. */
  const [answering, setAnswering] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [attached, setAttached] = useState<UploadedFile | null>(null)

  const submit = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/homework/${id}/submit`, {
      text_answer: answer.trim() || undefined,
      file_id: attached?.file_id,
    }),
    onSuccess: () => {
      setAnswering(null)
      setAnswer('')
      setAttached(null)
      qc.invalidateQueries({ queryKey: ['homework'] })
    },
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  const items = data?.items ?? []

  const due = items.filter((h) => !h.overdue)
  const mineOutstanding = items.filter((h) => !h.submitted && !h.overdue).length

  return (
    <>
      <PageHead
        eyebrow="Homework & diary"
        title={canPublish ? 'Work you have set' : 'Your homework'}
        description={
          canPublish
            ? 'Published straight to the class and their parents. Submission counts update as they come in.'
            : 'Everything set for your class, newest first.'
        }
        actions={
          canPublish && (
            <Button onClick={() => setComposing((c) => !c)}>
              <Plus className="h-3.5 w-3.5" />
              {composing ? 'Close' : 'Set homework'}
            </Button>
          )
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Open" value={due.length} icon={BookOpen} />
          <Stat label="Overdue" value={items.length - due.length} icon={Clock} />
          {canPublish ? (
            <Stat
              label="Submissions"
              value={items.reduce((n, h) => n + h.submissions, 0)}
              hint="Across everything you have set"
            />
          ) : (
            <Stat
              label="Not yet turned in"
              value={mineOutstanding}
              delta={{ value: mineOutstanding === 0 ? 'All done' : 'Still owing', positive: mineOutstanding === 0 }}
            />
          )}
        </CellGrid>

        {composing && <Compose canPublish={canPublish} onClose={() => setComposing(false)} />}

        <FilterBar
          canPublish={canPublish}
          value={filters}
          onChange={setFilters}
        />

        <Card>
          <CardHeader
            /* Not "Diary".

               The product has a diary — the digital diary a child reads at
               home — and this is the homework register on the homework screen.
               One word for two things is how a teacher ends up looking for
               yesterday's classwork in the wrong place. */
            title={canPublish ? 'Homework set' : 'Homework you have been set'}
            action={
              /* Two choices, both drawn, one selected.

                 It was one button labelled with the state it was already in —
                 "Only mine" — so the label read as a description and pressing
                 it did something nobody could predict. What it does and what
                 it is doing are different questions, and a single toggle
                 answers whichever one the reader guesses at.

                 Only where there is a distinction to make: a student's list is
                 their own by definition, and offering to widen it would offer
                 them somebody else's homework. */
              canPublish ? (
                <span className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">
                    {items.length} showing
                  </span>
                  <span className="flex overflow-hidden rounded-sm border">
                    <Button
                      size="sm"
                      variant={mine ? 'primary' : 'ghost'}
                      onClick={() => setOnlyMine(true)}
                      title="Only the homework you set yourself"
                    >
                      Set by me
                    </Button>
                    <Button
                      size="sm"
                      variant={!mine ? 'primary' : 'ghost'}
                      onClick={() => setOnlyMine(false)}
                      title="Everything set for these sections, by any teacher"
                    >
                      Set by anyone
                    </Button>
                  </span>
                </span>
              ) : undefined
            }
          />
          {items.length === 0 ? (
            <EmptyState
              title="Nothing set"
              body={
                canPublish
                  ? 'Homework you publish appears here, with a running count of who has submitted.'
                  : 'When a teacher sets work it shows up here and in your parents’ portal.'
              }
            />
          ) : (
            /* A term is a few hundred rows. Left to grow, the list runs past
               the filters above it, and the filters are what somebody came
               back to the top for. */
            <ul className="max-h-[34rem] divide-y overflow-y-auto">
              {items.map((h) => (
                <li key={h.id} className="px-5 py-4">
                 <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">
                      {h.subject && <span className="text-muted-foreground">{h.subject} · </span>}
                      {h.title}
                    </p>
                    {h.instructions && (
                      <p className="mt-0.5 text-[14px] text-muted-foreground">{h.instructions}</p>
                    )}
                    <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                      {h.class_name && (
                        <Badge>
                          {h.class_name}
                          {h.section_name && `-${h.section_name}`}
                        </Badge>
                      )}
                      {h.due_on ? (
                        <span className={h.overdue ? 'text-destructive' : undefined}>
                          {h.overdue ? 'was due ' : 'due '}
                          {formatDate(h.due_on)}
                        </span>
                      ) : (
                        <span>no due date</span>
                      )}
                      {h.teacher && <span>set by {h.teacher}</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Always offered, to everybody. A teacher checking what
                        they set and a child checking what was asked are the
                        same need, and the row shows neither in full. */}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setViewing(viewing === h.id ? null : h.id)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {viewing === h.id ? 'Close' : 'View'}
                    </Button>
                    {canPublish ? (
                      /* The count was the whole answer, and "14 of 32" tells a
                         teacher that eighteen children have not done the work
                         and nothing about which eighteen. Opening it names
                         them. */
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setOpenRegister(openRegister === h.id ? null : h.id)}
                      >
                        <Users className="h-3.5 w-3.5" />
                        {h.submissions}/{h.strength} submitted
                      </Button>
                    ) : h.submitted ? (
                      /* "Done", matching the button that gets you here. A
                         child who presses Done and is then told "Turned in"
                         has to work out that those are the same word. */
                      <Badge tone="success">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Done
                      </Badge>
                    ) : (
                      /* The child, or the family on their behalf.

                         A parent used to see the state and nothing else, on
                         the grounds that handing work in for a child is not a
                         convenience. True, and it did not stop the work being
                         done for them — it stopped it being handed in, from a
                         house where the phone belongs to a parent and the
                         nine-year-old has no login. The row records who
                         submitted, so a teacher can still tell. */
                      <span className="flex items-center gap-2">
                        {h.overdue && !h.submitted && <Badge tone="danger">Overdue</Badge>}
                        <Button
                          size="sm"
                          onClick={() => {
                            setAnswering(answering === h.id ? null : h.id)
                            setAnswer('')
                            setAttached(null)
                          }}
                        >
                          <Send className="h-3.5 w-3.5" />
                          {answering === h.id ? 'Close' : 'Done'}
                        </Button>
                      </span>
                    )}
                  </div>
                 </div>
                  {/* The worksheet the teacher set.

                      homework_attachments existed from the first migration and
                      nothing ever wrote to it, so "here is the sheet" — which
                      is most of what setting homework means — had nowhere to
                      live. */}
                  {!!h.files?.length && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                      {h.files.map((f) => (
                        <a
                          key={f.file_id}
                          href={`/api/v1/files/${f.file_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[13px] text-primary hover:bg-accent"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                          {f.name}
                        </a>
                      ))}
                    </div>
                  )}

                  {/* What this child turned in, once they have. */}
                  {h.submitted && (h.my_answer || h.my_file_id) && (
                    <div className="mt-3 border-t pt-3 text-[13px]">
                      <p className="text-muted-foreground">What you sent</p>
                      {h.my_answer && <p className="mt-1 whitespace-pre-wrap">{h.my_answer}</p>}
                      {h.my_file_id && (
                        <a
                          href={`/api/v1/files/${h.my_file_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1.5 text-primary"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                          {h.my_file_name ?? 'your file'}
                        </a>
                      )}
                    </div>
                  )}

                  {/* Answering it.

                      This used to post the literal word "Submitted". The child
                      pressed a button and the system recorded that they had
                      pressed it — nothing they wrote, nothing they photographed,
                      nothing a teacher could mark. */}
                  {answering === h.id && (
                    <div className="mt-3 border-t pt-4">
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Your answer</span>
                        <Textarea
                          value={answer}
                          onChange={setAnswer}
                          rows={4}
                          placeholder="Type your answer, or attach a photo of the page below."
                        />
                      </label>
                      <div className="mt-3 max-w-sm">
                        <FilePicker
                          value={attached}
                          onChange={setAttached}
                          purpose="homework_submission"
                          label="Attach your work"
                          hint="A photo of the page is fine."
                        />
                      </div>
                      <FormNotice error={submit.error} />
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          disabled={submit.isPending || (!answer.trim() && !attached)}
                          onClick={() => submit.mutate(h.id)}
                        >
                          {submit.isPending ? 'Turning in…' : 'Turn it in'}
                        </Button>
                        <Button variant="ghost" onClick={() => setAnswering(null)}>Cancel</Button>
                        {!answer.trim() && !attached && (
                          <span className="text-[12.5px] text-muted-foreground">
                            Write something or attach a page &mdash; an empty submission
                            tells your teacher nothing.
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {openRegister === h.id && <Register homeworkId={h.id} />}
                </li>
              ))}
            </ul>
          )}
          {/* THE WHOLE TASK, NEARLY FULL SCREEN.

              It was an inline panel under its own row, which kept the list in
              view and made the thing you opened compete with it for width. A
              worksheet title, the instructions and three attachments do not
              read well in a 34rem box that is already scrolling.

              A sheet at 94vw by 92vh instead, with the two controls a person
              actually wants there: Back to the list, and Done to hand the work
              in without going back for it. Escape closes it and the page
              behind is scroll-locked, so a phone does not lose its place. */}
          {viewing && (() => {
            const h = items.find((x) => x.id === viewing)
            if (!h) return null
            return (
              <HomeworkSheet
                h={h}
                canSubmit={!canPublish && !h.submitted}
                pending={submit.isPending}
                onDone={() => {
                  setAnswering(h.id)
                  setViewing(null)
                }}
                onClose={() => setViewing(null)}
              />
            )
          })()}

          {submit.isError && (
            <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
              {submit.error instanceof Error ? submit.error.message : 'Could not submit'}
            </p>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/**
 * Setting work.
 *
 * The subject is chosen by name; the server resolves it to the class-subject
 * link. A teacher knows they teach Class 6 maths — they do not know, and
 * should not have to look up, the row that joins those two together.
 */
/** One task, nearly full screen.

    Portalled to the body rather than rendered in the list. The list is a
    scrolling box with its own max height, and a panel inside it inherits that
    clip — the very thing this exists to escape.

    Two controls, because there are two things a person wants from here. Back
    returns to the list, which is where they came from and what the browser's
    own back button will NOT do (this opened no route). Done hands the work in,
    so a child who has just read the instructions does not have to find the row
    again to act on them.
*/
function HomeworkSheet({
  h, canSubmit, pending, onDone, onClose,
}: {
  h: Homework
  canSubmit: boolean
  pending: boolean
  onDone: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={h.title}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-2 sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[92vh] w-[94vw] max-w-[900px] flex-col overflow-hidden rounded-[4px]
                   border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <Button size="sm" variant="secondary" onClick={onClose}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          {h.submitted ? (
            <Badge tone="success">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Done
            </Badge>
          ) : canSubmit ? (
            <Button size="sm" disabled={pending} onClick={onDone}>
              <Send className="h-3.5 w-3.5" />
              Done
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <p className="text-[18px] font-medium leading-snug">{h.title}</p>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13.5px] text-muted-foreground">
            {h.subject && <span>{h.subject}</span>}
            {h.class_name && (
              <span>
                {h.class_name}
                {h.section_name && `-${h.section_name}`}
              </span>
            )}
            <span>set {formatDate(h.assigned_on)}</span>
            <span className={h.overdue ? 'text-destructive' : undefined}>
              {h.due_on ? `${h.overdue ? 'was due' : 'due'} ${formatDate(h.due_on)}` : 'no due date'}
            </span>
            {h.teacher && <span>set by {h.teacher}</span>}
          </p>

          {h.instructions ? (
            <p className="mt-5 whitespace-pre-wrap text-[15px] leading-relaxed">{h.instructions}</p>
          ) : (
            <p className="mt-5 text-[14px] text-muted-foreground">
              No further instructions were given.
            </p>
          )}

          {!!h.files?.length && (
            <div className="mt-6">
              <p className="mb-2 text-[13px] text-muted-foreground">Worksheets</p>
              <div className="flex flex-wrap gap-2">
                {h.files.map((f) => (
                  <a
                    key={f.file_id}
                    href={`/api/v1/files/${f.file_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-[3px] border px-3 py-2 text-[14px] text-primary hover:bg-accent"
                  >
                    <Paperclip className="h-4 w-4" />
                    {f.name}
                  </a>
                ))}
              </div>
            </div>
          )}

          {h.submitted && (h.my_answer || h.my_file_id) && (
            <div className="mt-6 border-t pt-4">
              <p className="text-[13px] text-muted-foreground">What you sent</p>
              {h.my_answer && <p className="mt-1 whitespace-pre-wrap text-[15px]">{h.my_answer}</p>}
              {h.my_file_id && (
                <a
                  href={`/api/v1/files/${h.my_file_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-[14px] text-primary"
                >
                  <Paperclip className="h-4 w-4" />
                  {h.my_file_name ?? 'your file'}
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Compose({ canPublish, onClose }: { canPublish: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  // The section and subject lists are staff-only. Gating them on canPublish is
  // redundant with the composer only opening for a teacher, and worth stating
  // anyway: it records at the point of use which data a family may not read,
  // and keeps a future refactor from quietly issuing a 403 on a child's screen.
  const { data: sections } = useQuery({
    queryKey: ['sections', 'mine'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections?mine=true'),
    enabled: canPublish,
  })
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<List<Subject>>('/api/v1/academics/subjects'),
    enabled: canPublish,
  })
  const [f, setF] = useState({
    section_id: '',
    subject_id: '',
    title: '',
    instructions: '',
    due_on: tomorrow(),
    kind: 'homework',
  })
  /* The worksheet. Uploaded first, linked on publish — the file store checks
     the size and refuses a program before this screen ever sees an id. */
  const [sheet, setSheet] = useState<UploadedFile | null>(null)

  const toast = useToast()

  const publish = useMutation({
    mutationFn: () => api.post('/api/v1/homework', {
      ...f,
      file_ids: sheet ? [sheet.file_id] : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['homework'] })
      toast.ok('Homework published to the class and their parents')
      onClose()
    },
  })

  return (
    <Card>
      <CardHeader
        title="Set homework"
        description="Visible to the class and their parents the moment it is published."
      />
      <form
        className="px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          publish.mutate()
        }}
      >
        <FormGrid>
          <Field label="Section" required>
            <Select
              value={f.section_id}
              onChange={(x) => setF({ ...f, section_id: x })}
              placeholder="Choose a section you teach"
              options={(sections?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.class_name}-${s.name}`,
              }))}
            />
          </Field>
          <Field label="Subject" required>
            <Select
              value={f.subject_id}
              onChange={(x) => setF({ ...f, subject_id: x })}
              placeholder="Choose a subject"
              options={(subjects?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="What to do" required wide>
            <Input
              value={f.title}
              onChange={(x) => setF({ ...f, title: x })}
              placeholder="Exercise 4.2, sums 1 to 8"
            />
          </Field>
          <Field label="Instructions" wide hint="Anything the parent should know when they check the diary.">
            <Input
              value={f.instructions}
              onChange={(x) => setF({ ...f, instructions: x })}
              placeholder="Show every step. Bring the graph sheet."
            />
          </Field>
          <Field label="Due on">
            <Input type="date" value={f.due_on} onChange={(x) => setF({ ...f, due_on: x })} />
          </Field>
          <Field
            label="Worksheet"
            hint="The sheet, the reading, a photo of the board. Optional."
            wide
          >
            <FilePicker
              value={sheet}
              onChange={setSheet}
              purpose="homework_attachment"
              label="Attach the sheet"
            />
          </Field>
          <Field label="Kind">
            <Select
              value={f.kind}
              onChange={(x) => setF({ ...f, kind: x })}
              /* 'notice' was offered here and the homework table's CHECK
                 constraint does not allow it, so choosing "Diary note" failed
                 the insert. Classwork was missing and is the entry a teacher
                 makes most days — the diary is now this list rather than a
                 separate screen, which is the other half of the same fix. */
              options={[
                { value: 'homework', label: 'Homework' },
                { value: 'classwork', label: 'Classwork (today’s diary)' },
                { value: 'assignment', label: 'Assignment' },
                { value: 'project', label: 'Project' },
              ]}
            />
          </Field>
        </FormGrid>
        <FormNotice error={publish.error} />
        <div className="mt-4 flex items-center gap-2">
          <Button type="submit" disabled={publish.isPending || !f.section_id || !f.title.trim()}>
            {publish.isPending ? 'Publishing…' : 'Publish to the class'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

function tomorrow() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Narrowing the diary.
 *
 * Six filters, all optional, all applied by the server. A teacher with five
 * sections and three subjects sets a few hundred tasks a term and was shown
 * the most recent hundred of all of them together; "Class 8B, maths, this
 * week" is how anybody actually looks for one.
 *
 * A family gets the date range and nothing else. Class, section and subject
 * are lists of the school's own records, which is staff data, and a child has
 * exactly one section anyway — the filter would narrow a list to itself.
 */
function FilterBar({
  canPublish,
  value,
  onChange,
}: {
  canPublish: boolean
  value: Filters
  onChange: (f: Filters) => void
}) {
  const { data: sections } = useQuery({
    queryKey: ['sections', 'mine'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections?mine=true'),
    enabled: canPublish,
  })
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<List<Subject>>('/api/v1/academics/subjects'),
    enabled: canPublish,
  })

  const set = (k: keyof Filters) => (v: string) => onChange({ ...value, [k]: v })
  const active = Object.values(value).some((v) => v !== '')

  return (
    <Card>
      <CardHeader
        title="Find"
        description="Every box is optional. Leave them all blank for everything."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Kind">
            <Select
              value={value.kind}
              onChange={set('kind')}
              placeholder="Any kind"
              options={[
                { value: '', label: 'Any kind' },
                { value: 'homework', label: 'Homework' },
                { value: 'classwork', label: 'Classwork' },
                { value: 'assignment', label: 'Assignment' },
                { value: 'project', label: 'Project' },
              ]}
            />
          </Field>
          {canPublish && (
            <>
              <Field label="Class and section">
                <Select
                  value={value.section_id}
                  onChange={set('section_id')}
                  placeholder="Any section"
                  options={[
                    { value: '', label: 'Any section' },
                    ...(sections?.items ?? []).map((x) => ({
                      value: x.id,
                      label: `${x.class_name}-${x.name}`,
                    })),
                  ]}
                />
              </Field>
              <Field label="Subject">
                <Select
                  value={value.subject_id}
                  onChange={set('subject_id')}
                  placeholder="Any subject"
                  options={[
                    { value: '', label: 'Any subject' },
                    ...(subjects?.items ?? []).map((x) => ({ value: x.id, label: x.name })),
                  ]}
                />
              </Field>
            </>
          )}
          <Field label="Set on or after">
            <Input type="date" value={value.from} onChange={set('from')} />
          </Field>
          <Field label="Set on or before">
            <Input type="date" value={value.to} onChange={set('to')} />
          </Field>
        </FormGrid>
        {active && (
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={() => onChange(NO_FILTERS)}>
              Clear filters
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

/**
 * Who did it, and who did not.
 *
 * Built from the enrolment register rather than from the submissions, because
 * the children being looked for are precisely the ones with no submission row
 * — a query over submissions cannot return a child who never made one.
 *
 * Roll order, because that is the order the teacher's own mark list is in.
 */
function Register({ homeworkId }: { homeworkId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['homework-submissions', homeworkId],
    queryFn: () =>
      api.get<List<Submitter>>(`/api/v1/homework/${homeworkId}/submissions`),
  })

  if (isLoading) return <div className="pt-3"><Loading /></div>
  if (error) return <div className="pt-3"><ErrorState error={error} /></div>

  const rows = data?.items ?? []
  const done = rows.filter((x) => x.status !== 'pending')

  return (
    <div className="mt-3 rounded-md border bg-muted/30">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5">
        <span className="text-[13px] font-medium">Submission register</span>
        <span className="text-[13px] text-muted-foreground">
          {done.length} of {rows.length} turned in
          {rows.length - done.length > 0 && ` · ${rows.length - done.length} still owing`}
        </span>
      </div>
      <Table wide head={['Roll', 'Name', 'Status', 'What they turned in', 'When']}>
        {rows.map((x) => (
          <tr key={x.student_id} className="border-t">
            <Td className="tabular-nums">{x.roll_no ?? '—'}</Td>
            <Td>{x.full_name}</Td>
            <Td>
              {x.status === 'pending' ? (
                <Badge tone="warning">Not turned in</Badge>
              ) : (
                <Badge tone="success">{x.status}</Badge>
              )}
            </Td>
            <Td>
              {/* The work itself, beside the tick.

                  A register that says only who pressed the button is a
                  register of button presses; the teacher opened it to mark
                  something. */}
              {x.text_answer && (
                <span className="block max-w-md whitespace-pre-wrap">{x.text_answer}</span>
              )}
              {/* Whose hands it came from, where that is not the child's.

                  A parent may hand work in now, and a teacher marking it is
                  entitled to know which of the thirty came that way — that is
                  the whole of what the old rule was protecting. */}
              {x.submitted_by && (
                <span className="mt-0.5 block text-[12px] text-muted-foreground">
                  handed in by {x.submitted_by}
                </span>
              )}
              {x.file_id && (
                <a
                  href={`/api/v1/files/${x.file_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {x.file_name ?? 'their file'}
                </a>
              )}
              {!x.text_answer && !x.file_id && (
                <span className="text-muted-foreground">&mdash;</span>
              )}
            </Td>
            <Td className="text-muted-foreground">
              {x.submitted_at ? formatDate(x.submitted_at.slice(0, 10)) : '—'}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  )
}

interface Submitter {
  file_id?: string
  file_name?: string
  /* Present only where a guardian handed it in. Absent means the child. */
  submitted_by?: string
  student_id: string
  roll_no?: string
  full_name: string
  status: string
  submitted_at?: string
  text_answer?: string
}
