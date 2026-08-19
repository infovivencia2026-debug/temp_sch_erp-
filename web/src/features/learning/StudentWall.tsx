import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, Clock, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Post {
  id: string
  category: string
  body: string
  author_name: string
  author_class?: string
  subject_name: string
  subject_class?: string
  status: string
  written_by_me: boolean
  about_me: boolean
  posted_on: string
  moderation_note?: string
  moderated_by?: string
}
interface WallResponse {
  items: Post[]
  daily_limit: number
  moderation: string
}

const CATEGORIES = [
  { value: 'helped_with_work', label: 'Helped me with my work' },
  { value: 'returned_something', label: 'Gave something back' },
  { value: 'kindness', label: 'A kindness' },
  { value: 'teamwork', label: 'Worked well together' },
  { value: 'courage', label: 'Was brave' },
  { value: 'looked_after_someone', label: 'Looked after someone' },
]
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]))

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  published: 'success',
  rejected: 'danger',
  removed: 'danger',
}

/* Children saying thank you to children, read by an adult first.

   Nothing here goes up when it is written. Every post waits for a teacher, and
   the child who wrote it sees their own sitting in the queue so it does not
   look as though it vanished. That order is deliberate and it is the whole
   safety argument: taking a cruel post down afterwards still means it was read
   by the year group first, and those are the hours that do the damage.

   Three a day, and only about somebody else. A wall one child can flood is a
   wall that child decides the subject of, and a recognition of yourself is a
   status update. Both limits are enforced on the server; this screen only
   explains them. */
export default function StudentWall() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [category, setCategory] = useState('helped_with_work')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [filter, setFilter] = useState('')
  const [reporting, setReporting] = useState('')
  const [reason, setReason] = useState('')

  const wall = useQuery({
    queryKey: ['student-wall', studentId, filter],
    queryFn: () =>
      api.get<WallResponse>(
        `/api/v1/portal/campus/wall${studentQuery(studentId, filter ? `category=${filter}` : '')}`,
      ),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['student-wall'] })

  const write = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/campus/wall', {
        student_id: studentId || undefined,
        subject_student_id: subject,
        category,
        body,
      }),
    onSuccess: () => {
      setBody('')
      setSubject('')
      refresh()
    },
  })

  const report = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/campus/wall/${id}/report`, { reason }),
    onSuccess: () => {
      setReporting('')
      setReason('')
      refresh()
    },
  })

  if (wall.isLoading && ready) return <Loading label="Reading the wall…" />
  if (wall.error) return <ErrorState error={wall.error} />

  const posts = wall.data?.items ?? []
  const limit = wall.data?.daily_limit ?? 3
  const published = posts.filter((p) => p.status === 'published')
  const waiting = posts.filter((p) => p.status === 'pending')
  const aboutMe = published.filter((p) => p.about_me)

  return (
    <>
      <PageHead
        eyebrow="Campus life"
        title="The wall"
        description="Say thank you to somebody, for something they actually did."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="The wall is written in a child's own name." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="On the wall" value={published.length} icon={Heart} />
              <Stat
                label="Yours, waiting"
                value={waiting.length}
                icon={Clock}
                hint="A teacher reads every post before it goes up"
              />
              <Stat label="About you" value={aboutMe.length} icon={ShieldCheck} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Write one"
                description={`Up to ${limit} a day, and always about somebody else.`}
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="What for" required>
                    <Select value={category} onChange={setCategory} options={CATEGORIES} />
                  </Field>
                  <Field
                    label="Who"
                    required
                    hint="Their student id. Ask them, or the class teacher."
                  >
                    <Input value={subject} onChange={setSubject} placeholder="student id" />
                  </Field>
                  <Field
                    label="What they did"
                    wide
                    required
                    hint="Say the actual thing. A wall of one-word compliments turns into a popularity contest."
                  >
                    <Textarea
                      value={body}
                      onChange={setBody}
                      rows={3}
                      placeholder="She stayed behind after the bell to explain the long division I had got wrong all week."
                    />
                  </Field>
                </FormGrid>
                <FormNotice
                  error={write.error}
                  ok={
                    write.isSuccess
                      ? 'Sent. A teacher will read it before it goes up.'
                      : undefined
                  }
                />
                <Button
                  onClick={() => write.mutate()}
                  disabled={!subject.trim() || body.trim().length < 10 || write.isPending}
                >
                  {write.isPending ? 'Sending…' : 'Send it'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="The wall"
                description="Posts a teacher has read and put up, newest first."
                action={
                  <div className="w-56">
                    <Field label="Filter">
                      <Select
                        value={filter}
                        onChange={setFilter}
                        options={[{ value: '', label: 'Everything' }, ...CATEGORIES]}
                      />
                    </Field>
                  </div>
                }
              />
              {posts.length === 0 ? (
                <EmptyState title="Nothing here yet" body="Be the first to thank somebody." />
              ) : (
                <ul className="divide-y">
                  {posts.map((p) => (
                    <li key={p.id} className="px-5 py-4">
                      <p className="text-[14px] font-medium">
                        {p.subject_name}
                        {p.subject_class && <Badge>{p.subject_class}</Badge>}
                        <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>
                          {CATEGORY_LABEL[p.category] ?? p.category}
                        </Badge>
                        {p.status !== 'published' && <Badge tone="warning">{p.status}</Badge>}
                      </p>
                      <p className="mt-1 text-[13px]">{p.body}</p>
                      <p className="mt-1 text-[12.5px] text-muted-foreground">
                        {p.written_by_me ? 'you' : p.author_name}
                        {p.author_class && !p.written_by_me ? ` (${p.author_class})` : ''} ·{' '}
                        {formatDate(p.posted_on)}
                        {p.moderation_note ? ` · ${p.moderation_note}` : ''}
                      </p>
                      {p.status === 'published' && !p.written_by_me && (
                        <div className="mt-2">
                          {reporting === p.id ? (
                            <div className="flex flex-wrap items-end gap-3">
                              <div className="w-72">
                                <Field label="What is wrong with it">
                                  <Input value={reason} onChange={setReason} />
                                </Field>
                              </div>
                              <Button
                                size="sm"
                                disabled={!reason.trim() || report.isPending}
                                onClick={() => report.mutate(p.id)}
                              >
                                Tell a teacher
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setReporting('')}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setReporting(p.id)}>
                              Report this
                            </Button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice
                  error={report.error}
                  ok={report.isSuccess ? 'A teacher has been told.' : undefined}
                />
                <p className="text-[12.5px] text-muted-foreground">
                  Reporting a post does not hide it. A teacher reads it and decides.
                </p>
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
