import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, CheckCircle2, Clock, Plus, Send } from 'lucide-react'
import { api, type List, type Section, type Subject } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
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
}

export default function Homework() {
  const qc = useQueryClient()
  const [composing, setComposing] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['homework'],
    queryFn: () => api.get<List<Homework>>('/api/v1/homework'),
  })
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  const canPublish = session?.permissions.includes('academics.homework.write') ?? false

  const submit = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/homework/${id}/submit`, { text_answer: 'Submitted' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['homework'] }),
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

        <Card>
          <CardHeader title="Diary" description={`${items.length} entries`} />
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
            <ul className="divide-y">
              {items.map((h) => (
                <li key={h.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
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
                    {canPublish ? (
                      <span className="text-[13px] tabular-nums text-muted-foreground">
                        {h.submissions}/{h.strength} submitted
                      </span>
                    ) : h.submitted ? (
                      <Badge tone="success">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Turned in
                      </Badge>
                    ) : (
                      <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate(h.id)}>
                        <Send className="h-3.5 w-3.5" />
                        Turn in
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
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
function Compose({ canPublish, onClose }: { canPublish: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  // The section and subject lists are staff-only. Gating them on canPublish is
  // redundant with the composer only opening for a teacher, and worth stating
  // anyway: it records at the point of use which data a family may not read,
  // and keeps a future refactor from quietly issuing a 403 on a child's screen.
  const { data: sections } = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
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

  const toast = useToast()

  const publish = useMutation({
    mutationFn: () => api.post('/api/v1/homework', f),
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
          <Field label="Kind">
            <Select
              value={f.kind}
              onChange={(x) => setF({ ...f, kind: x })}
              options={[
                { value: 'homework', label: 'Homework' },
                { value: 'assignment', label: 'Assignment' },
                { value: 'project', label: 'Project' },
                { value: 'notice', label: 'Diary note' },
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
