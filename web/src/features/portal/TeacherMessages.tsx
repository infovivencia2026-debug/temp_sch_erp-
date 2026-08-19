import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Field, FormNotice,
  Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useT } from '@/lib/i18n'
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
  const t = useT()
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

  if (query.isLoading) return <Loading label={t('portal.teacher_messages.loading')} />
  if (query.error) return <ErrorState error={query.error} />

  const list = teachers.data?.items ?? []
  const chosenTeacher = list.find((x) => x.user_id === teacher)
  const messages = thread.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow={t('portal.teacher_messages.eyebrow')}
        title={t('portal.teacher_messages.title')}
        description={t('portal.teacher_messages.description')}
      />
      <PageBody>
        <Card>
          <CardHeader title={t('portal.teacher_messages.picker_title')} />
          <div className="grid gap-5 p-4 sm:grid-cols-2">
            {children.length > 1 && (
              <Field label={t('portal.teacher_messages.field_child')}>
                <Select
                  value={chosen}
                  onChange={(v) => {
                    setChosen(v)
                    setTeacher('')
                  }}
                  placeholder={t('portal.teacher_messages.child_placeholder')}
                  options={childOptions(children)}
                />
              </Field>
            )}
            <Field label={t('portal.teacher_messages.field_teacher')}>
              <Select
                value={teacher}
                onChange={setTeacher}
                placeholder={
                  list.length
                    ? t('portal.teacher_messages.teacher_placeholder')
                    : t('portal.teacher_messages.teacher_placeholder_none')
                }
                options={list.map((x) => ({
                  value: x.user_id,
                  label:
                    (x.class_teacher
                      ? t('portal.teacher_messages.option_class_teacher', { name: x.full_name })
                      : x.full_name) +
                    (x.subject ? ` (${x.subject})` : '') +
                    (x.unread ? t('portal.teacher_messages.option_unread', { count: x.unread }) : ''),
                }))}
              />
            </Field>
          </div>
        </Card>

        {studentId === '' ? (
          <EmptyState
            title={t('portal.teacher_messages.empty_child_title')}
            body={t('portal.teacher_messages.empty_child_body')}
          />
        ) : list.length === 0 && !teachers.isLoading ? (
          <EmptyState
            title={t('portal.teacher_messages.empty_teachers_title')}
            body={t('portal.teacher_messages.empty_teachers_body')}
          />
        ) : (
          <Card>
            <CardHeader
              title={chosenTeacher ? chosenTeacher.full_name : t('portal.teacher_messages.thread_title')}
              description={
                chosenTeacher?.class_teacher
                  ? t('portal.teacher_messages.thread_class_teacher')
                  : chosenTeacher?.subject
                    ? t('portal.teacher_messages.thread_teaches', { subject: chosenTeacher.subject })
                    : undefined
              }
            />
            {thread.isLoading ? (
              <Loading label={t('portal.teacher_messages.thread_loading')} />
            ) : messages.length === 0 ? (
              <EmptyState
                title={t('portal.teacher_messages.empty_thread_title')}
                body={t('portal.teacher_messages.empty_thread_body')}
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
                        {m.mine ? t('portal.teacher_messages.sender_you') : m.sender_name} ·{' '}
                        {m.sent_at.replace('T', ' ')}
                        {m.mine && !m.read_at && t('portal.teacher_messages.not_read')}
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
                placeholder={t('portal.teacher_messages.draft_placeholder')}
              />
              <div className="mt-3 flex items-center gap-3">
                <Button
                  disabled={send.isPending || draft.trim() === '' || teacher === ''}
                  onClick={() => send.mutate()}
                >
                  {send.isPending
                    ? t('portal.teacher_messages.sending')
                    : t('portal.teacher_messages.action_send')}
                </Button>
                {chosenTeacher && (
                  <Badge tone="neutral">
                    {t('portal.teacher_messages.badge_to', { name: chosenTeacher.full_name })}
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
