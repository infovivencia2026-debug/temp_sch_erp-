import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useSession } from '@/lib/session'
import { PageHead, PageBody, Card, CardHeader, Field, Select, EmptyState } from '@/components/ui'
import { ChatThread, type Attachment } from '@/components/Chat'
import { ChatScreen, PersonAvatar } from '@/components/ChatScreen'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
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
  /** The staff photograph, where the school holds one. */
  photo?: string
  unread: number
}

interface Message {
  id: string
  body: string
  sent_at: string
  sender_name: string
  mine: boolean
  read_at?: string
  attachments?: Attachment[]
}

export default function TeacherMessages() {
  const t = useT()
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen, query } = useChildren()
  const [teacher, setTeacher] = useState('')
  const me = useSession().user?.id

  /* A tap on the bell lands HERE, in the conversation it was about.

     The notification's link names the child and the teacher who wrote
     (?student_id=…&teacher_user_id=…); without reading them this screen
     opened on its default teacher and the parent had to find the sender
     themselves — which is the search the notification existed to save.
     Applied once, on arrival; the pickers take over from there. */
  const [params] = useSearchParams()
  useEffect(() => {
    const s = params.get('student_id')
    const t = params.get('teacher_user_id')
    if (s) setChosen(s)
    if (t) setTeacher(t)
    // Only on first render for this URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('student_id'), params.get('teacher_user_id')])

  const teachers = useQuery({
    queryKey: ['portal-teachers', studentId],
    queryFn: () =>
      api.get<List<Teacher>>(`/api/v1/portal/messages/teachers?student_id=${studentId}`),
    enabled: studentId !== '',
  })

  const thread = useQuery({
    queryKey: ['portal-thread', studentId, teacher],
    queryFn: () =>
      api.get<List<Message>>(
        `/api/v1/portal/messages?student_id=${studentId}&teacher_user_id=${teacher}`,
      ),
    enabled: studentId !== '' && teacher !== '',
  })

  const send = useMutation({
    mutationFn: (m: { body: string; attachments: Attachment[] }) =>
      api.post('/api/v1/portal/messages', {
        student_id: studentId,
        teacher_user_id: teacher,
        body: m.body,
        attachments: m.attachments,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portal-thread', studentId, teacher] })
      qc.invalidateQueries({ queryKey: ['portal-teachers', studentId] })
    },
  })

  if (query.isLoading) return <ScreenSkeleton label={t('portal.teacher_messages.loading')} />
  if (query.error && !query.data) return <ScreenError error={query.error} />

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
      <Freshness query={query} />
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
            {/* The teachers as a list to tap, the way a phone lists chats:
                the class teacher first, then everyone timetabled to the
                child's section, with an unread count. Tapping one opens the
                conversation on its own screen; Back returns here. */}
            <CardHeader title={t('portal.teacher_messages.field_teacher')} />
            <ul className="divide-y">
              {list.map((x) => (
                <li key={x.user_id}>
                  <button
                    type="button"
                    onClick={() => setTeacher(x.user_id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60"
                  >
                    {/* The face first. A parent knows the maths sir by sight
                        long before they know his name, and a column of six
                        names tells them nothing about which is which. */}
                    <PersonAvatar name={x.full_name} photoId={x.photo} size={44} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium">
                        {x.class_teacher
                          ? t('portal.teacher_messages.option_class_teacher', { name: x.full_name })
                          : x.full_name}
                      </span>
                      <span className="block truncate text-[12.5px] text-muted-foreground">
                        {x.class_teacher
                          ? t('portal.teacher_messages.thread_class_teacher')
                          : x.subject
                            ? t('portal.teacher_messages.thread_teaches', { subject: x.subject })
                            : ''}
                      </span>
                    </span>
                    {x.unread > 0 && (
                      <span className="grid h-6 min-w-6 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[12px] font-semibold text-primary-foreground">
                        {x.unread}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <ChatScreen
          open={teacher !== ''}
          title={chosenTeacher?.full_name ?? t('portal.teacher_messages.thread_title')}
          photoId={chosenTeacher?.photo}
          subtitle={
            chosenTeacher?.class_teacher
              ? t('portal.teacher_messages.thread_class_teacher')
              : chosenTeacher?.subject
                ? t('portal.teacher_messages.thread_teaches', { subject: chosenTeacher.subject })
                : undefined
          }
          onBack={() => setTeacher('')}
        >
          <ChatThread
            live={studentId && teacher && me
              ? { scope: 'parent', student: studentId, parent: me, teacher }
              : undefined}
            messages={messages.map((m) => ({
              id: m.id,
              body: m.body,
              at: m.sent_at,
              mine: m.mine,
              read_at: m.read_at,
              sender: m.sender_name,
              attachments: m.attachments,
            }))}
            loading={thread.isLoading}
            empty={t('portal.teacher_messages.empty_thread_body')}
            canSend={teacher !== ''}
            onSend={(m) => send.mutate(m)}
            sending={send.isPending}
            /* A parent can take back what they have just written, for the
               same fifteen minutes the server allows anybody. Held-message
               Delete is absent on the teacher's messages, which is right:
               it is the teacher's to withdraw, not theirs. */
            onUnsend={async (id) => {
              await api.del(`/api/v1/chat/messages/${id}?channel=parent`)
              qc.invalidateQueries({ queryKey: ['portal-thread'] })
            }}
            error={send.error}
            placeholder={t('portal.teacher_messages.draft_placeholder')}
            height="min-h-0"
          />
        </ChatScreen>
      </PageBody>
    </>
  )
}
