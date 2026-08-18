import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Field, FormNotice,
  Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useChildren, childOptions } from './use-children'

/* Writing to your child's teacher.

   Bounded on purpose. The address book lists the people who actually teach the
   child — the class teacher first, then whoever is timetabled to their section
   — and the server accepts a message only to somebody on that list. An
   unbounded parent-to-anyone channel would turn the portal into a way of
   reaching the principal, the accountant, or another parent.

   Messages mark themselves read when the thread is opened, so the teacher's
   unread count means what it says. */

interface Teacher {
  user_id: string
  full_name: string
  subject?: string
  class_teacher: boolean
  unread: number
}

interface Message {
  id: string
  body: string
  sent_at: string
  sender_name: string
  mine: boolean
  read_at?: string
}

export default function TeacherMessages() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen, query } = useChildren()
  const [teacher, setTeacher] = useState('')
  const [draft, setDraft] = useState('')

  const teachers = useQuery({
    queryKey: ['portal-teachers', studentId],
    queryFn: () =>
      api.get<List<Teacher>>(`/api/v1/portal/messages/teachers?student_id=${studentId}`),
    enabled: studentId !== '',
  })

  // Opening on the class teacher is the right default: they are who a parent
  // means by "my child's teacher", and picking nobody left the screen blank.
  useEffect(() => {
    const list = teachers.data?.items ?? []
    if (teacher === '' && list.length > 0) setTeacher(list[0].user_id)
  }, [teachers.data, teacher])

  const thread = useQuery({
    queryKey: ['portal-thread', studentId, teacher],
    queryFn: () =>
      api.get<List<Message>>(
        `/api/v1/portal/messages?student_id=${studentId}&teacher_user_id=${teacher}`,
      ),
    enabled: studentId !== '' && teacher !== '',
  })

  const send = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/messages', {
        student_id: studentId,
        teacher_user_id: teacher,
        body: draft,
      }),
    onSuccess: () => {
      setDraft('')
      qc.invalidateQueries({ queryKey: ['portal-thread', studentId, teacher] })
      qc.invalidateQueries({ queryKey: ['portal-teachers', studentId] })
    },
  })

  if (query.isLoading) return <Loading label="Finding your children…" />
  if (query.error) return <ErrorState error={query.error} />

  const list = teachers.data?.items ?? []
  const chosenTeacher = list.find((t) => t.user_id === teacher)
  const messages = thread.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Messages"
        title="Your child's teachers"
        description="A direct line to the people who teach them. Anything the whole school needs to know belongs in a concern instead."
      />
      <PageBody>
        <Card>
          <CardHeader title="Who you are writing to" />
          <div className="grid gap-5 p-4 sm:grid-cols-2">
            {children.length > 1 && (
              <Field label="Child">
                <Select
                  value={chosen}
                  onChange={(v) => {
                    setChosen(v)
                    setTeacher('')
                  }}
                  placeholder="Choose a child"
                  options={childOptions(children)}
                />
              </Field>
            )}
            <Field label="Teacher">
              <Select
                value={teacher}
                onChange={setTeacher}
                placeholder={list.length ? 'Choose a teacher' : 'No teachers listed yet'}
                options={list.map((t) => ({
                  value: t.user_id,
                  label:
                    (t.class_teacher ? `${t.full_name} — class teacher` : t.full_name) +
                    (t.subject ? ` (${t.subject})` : '') +
                    (t.unread ? ` · ${t.unread} unread` : ''),
                }))}
              />
            </Field>
          </div>
        </Card>

        {studentId === '' ? (
          <EmptyState title="Choose a child" body="Their teachers will appear here." />
        ) : list.length === 0 && !teachers.isLoading ? (
          <EmptyState
            title="No teachers to write to yet"
            body="Once the timetable is set for your child's class, their teachers appear here."
          />
        ) : (
          <Card>
            <CardHeader
              title={chosenTeacher ? chosenTeacher.full_name : 'Conversation'}
              description={
                chosenTeacher?.class_teacher
                  ? 'Class teacher — the person who knows the whole day.'
                  : chosenTeacher?.subject
                    ? `Teaches ${chosenTeacher.subject}.`
                    : undefined
              }
            />
            {thread.isLoading ? (
              <Loading label="Opening the conversation…" />
            ) : messages.length === 0 ? (
              <EmptyState
                title="Nothing said yet"
                body="Write the first message below."
              />
            ) : (
              <ul className="space-y-3 p-4">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className={m.mine ? 'flex justify-end' : 'flex justify-start'}
                  >
                    <div
                      className={
                        'max-w-[36rem] rounded-sm px-3 py-2 text-[14px] ' +
                        (m.mine ? 'bg-primary/10' : 'bg-muted')
                      }
                    >
                      <div className="whitespace-pre-wrap">{m.body}</div>
                      <div className="mt-1 text-[12px] text-muted-foreground">
                        {m.mine ? 'You' : m.sender_name} · {m.sent_at.replace('T', ' ')}
                        {m.mine && !m.read_at && ' · not read yet'}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="border-t p-4">
              <Textarea
                rows={3}
                value={draft}
                onChange={setDraft}
                placeholder="Ravi has been finding the algebra homework hard — could we talk about it?"
              />
              <div className="mt-3 flex items-center gap-3">
                <Button
                  disabled={send.isPending || draft.trim() === '' || teacher === ''}
                  onClick={() => send.mutate()}
                >
                  {send.isPending ? 'Sending…' : 'Send'}
                </Button>
                {chosenTeacher && (
                  <Badge tone="neutral">
                    to {chosenTeacher.full_name}
                  </Badge>
                )}
              </div>
              <FormNotice error={send.error} />
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
