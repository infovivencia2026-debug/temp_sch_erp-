import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, MessageCircle, Users } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { commsQueryKeys } from './comms-keys'

/* parent.messages.private_counselor_chat_channel

   Confidentiality is the whole feature, so it is worth being exact about what
   is and is not delivered.

   Who can read a thread is an explicit list of people — the participants panel
   below — and nothing else. A class teacher, a head of department and the
   principal are not in it by virtue of being those things, and no permission
   grant opens one: the server checks for a live participant row and refuses
   everybody else identically, whether they are staff or a stranger. Adding
   somebody requires the counsellor, a written reason, and leaves a record the
   family can see on this screen.

   What is NOT delivered is end-to-end encryption, whatever the catalogue's
   summary says. Messages are stored as text the server can read. Doing
   otherwise needs per-family keys this product has no way to hold or recover,
   and a family locked out of their own counselling history by a forgotten
   password is worse than the risk it removes. The line says so plainly rather
   than letting the padlock imply more than it means. */

interface Thread {
  id: string
  student_id: string
  student: string
  subject: string
  status: string
  urgency: string
  my_role: string
  opened_by: string
  created_at: string
  last_message_at?: string
  unread: number
  participants: number
}

interface Message {
  id: string
  sender: string
  sender_id: string
  mine: boolean
  body: string
  created_at: string
}

interface Participant {
  user_id: string
  full_name: string
  role_in_thread: string
  added_by?: string
  added_reason?: string
  added_at: string
  removed_at?: string
}

interface Contact {
  user_id: string
  full_name: string
  role?: string
}

const URGENCY_TONE: Record<string, 'neutral' | 'info' | 'danger'> = {
  routine: 'neutral',
  normal: 'info',
  urgent: 'danger',
}

export default function CounselorChannel() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [opening, setOpening] = useState({
    counselor_id: '', student_id: '', subject: '', urgency: 'normal', message: '',
  })
  const [addition, setAddition] = useState({ user_id: '', role_in_thread: 'observer', reason: '' })

  const threads = useQuery({
    queryKey: commsQueryKeys.counselorThreads(),
    queryFn: () => api.get<List<Thread>>('/api/v1/comms/counselor/threads'),
  })
  const contacts = useQuery({
    queryKey: commsQueryKeys.counselorContacts(),
    queryFn: () => api.get<List<Contact>>('/api/v1/comms/counselor/contacts'),
  })
  const messages = useQuery({
    queryKey: commsQueryKeys.counselorMessages(selected),
    queryFn: () => api.get<List<Message>>(`/api/v1/comms/counselor/threads/${selected}/messages`),
    enabled: !!selected,
  })
  const participants = useQuery({
    queryKey: commsQueryKeys.counselorParticipants(selected),
    queryFn: () =>
      api.get<List<Participant>>(`/api/v1/comms/counselor/threads/${selected}/participants`),
    enabled: !!selected,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: commsQueryKeys.counselorRoot() })

  const open = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/comms/counselor/threads', {
        counselor_id: opening.counselor_id,
        student_id: opening.student_id || undefined,
        subject: opening.subject,
        urgency: opening.urgency,
        message: opening.message || undefined,
      }),
    onSuccess: (r) => {
      setOpening({ counselor_id: '', student_id: '', subject: '', urgency: 'normal', message: '' })
      setSelected(r.id)
      refresh()
    },
  })
  const send = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/comms/counselor/threads/${selected}/messages`, { body: draft }),
    onSuccess: () => {
      setDraft('')
      refresh()
    },
  })
  const addPerson = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/comms/counselor/threads/${selected}/participants`, addition),
    onSuccess: () => {
      setAddition({ user_id: '', role_in_thread: 'observer', reason: '' })
      refresh()
    },
  })
  const close = useMutation({
    mutationFn: () => api.post(`/api/v1/comms/counselor/threads/${selected}/close`, {}),
    onSuccess: refresh,
  })

  const rows = threads.data?.items ?? []
  const current = rows.find((t) => t.id === selected)
  const live = participants.data?.items.filter((p) => !p.removed_at) ?? []
  const past = participants.data?.items.filter((p) => p.removed_at) ?? []

  return (
    <>
      <PageHead
        eyebrow="Messages"
        title="Counsellor"
        description="A conversation with the school counsellor about your child, readable only by the people listed on it."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="What private means here"
            description="Worth reading once."
          />
          <div className="space-y-2 p-5 text-[14px] leading-relaxed text-muted-foreground">
            <p>
              <Lock className="mr-1.5 inline h-4 w-4" />
              Only the people named on a conversation can open it. Teachers, heads of
              department and the principal are not among them unless the counsellor adds them,
              which they can only do with a written reason that you will see on this screen.
            </p>
            <p>
              Messages are stored on the school&apos;s system and the school&apos;s technical
              staff could in principle read the database. This is not end-to-end encrypted, and
              you should treat it as a confidential conversation with the counsellor rather than
              a sealed one.
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="Start a conversation" />
          <div className="space-y-4 p-5">
            <FormGrid>
              <Field label="Counsellor" required>
                <Select
                  value={opening.counselor_id}
                  onChange={(v) => setOpening({ ...opening, counselor_id: v })}
                  placeholder={contacts.isLoading ? 'Loading…' : 'Choose a counsellor'}
                  options={(contacts.data?.items ?? []).map((c) => ({
                    value: c.user_id,
                    label: c.role ? `${c.full_name} — ${c.role}` : c.full_name,
                  }))}
                />
              </Field>
              <Field
                label="Child"
                hint="Only needed if you have more than one child at the school."
              >
                <Input
                  value={opening.student_id}
                  onChange={(v) => setOpening({ ...opening, student_id: v })}
                  placeholder="Leave blank for your only child"
                />
              </Field>
              <Field label="Subject" required>
                <Input
                  value={opening.subject}
                  onChange={(v) => setOpening({ ...opening, subject: v })}
                  placeholder="Something happening at home"
                />
              </Field>
              <Field label="Urgency">
                <Select
                  value={opening.urgency}
                  onChange={(v) => setOpening({ ...opening, urgency: v })}
                  options={[
                    { value: 'routine', label: 'Routine' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'urgent', label: 'Urgent' },
                  ]}
                />
              </Field>
              <Field label="First message" wide>
                <Textarea
                  value={opening.message}
                  onChange={(v) => setOpening({ ...opening, message: v })}
                  rows={3}
                />
              </Field>
            </FormGrid>
            <Button
              disabled={!opening.counselor_id || !opening.subject.trim() || open.isPending}
              onClick={() => open.mutate()}
            >
              Start
            </Button>
            <FormNotice error={open.error} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Conversations" />
          {threads.isLoading ? (
            <Loading />
          ) : threads.error ? (
            <ErrorState error={threads.error} />
          ) : (
            <Table
              head={['Subject', 'Child', 'Urgency', 'People', 'Last message', 'Unread', '']}
              empty={rows.length === 0}
              emptyLabel="Nothing yet."
            >
              {rows.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <span className="font-medium">{t.subject}</span>
                    {t.status === 'closed' && (
                      <span className="ml-2">
                        <Badge tone="neutral" solid>
                          closed
                        </Badge>
                      </span>
                    )}
                  </Td>
                  <Td>{t.student}</Td>
                  <Td>
                    <Badge tone={URGENCY_TONE[t.urgency] ?? 'neutral'}>{t.urgency}</Badge>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      {t.participants}
                    </span>
                  </Td>
                  <Td>{t.last_message_at ? formatDate(t.last_message_at) : '—'}</Td>
                  <Td>{t.unread > 0 ? <Badge tone="info">{t.unread}</Badge> : '—'}</Td>
                  <Td>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(t.id)}>
                      Open
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {selected && current && (
          <Card>
            <CardHeader
              title={current.subject}
              description={`About ${current.student} · you are the ${current.my_role}`}
              action={
                <div className="flex gap-2">
                  {current.status === 'open' && current.my_role !== 'observer' && (
                    <Button size="sm" variant="secondary" onClick={() => close.mutate()}>
                      Close conversation
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                </div>
              }
            />
            <div className="space-y-5 p-5">
              {messages.isLoading ? (
                <Loading />
              ) : (messages.data?.items.length ?? 0) === 0 ? (
                <EmptyState title="Nothing said yet." />
              ) : (
                <ul className="space-y-3">
                  {messages.data?.items.map((m) => (
                    <li
                      key={m.id}
                      className={m.mine ? 'rounded-md bg-muted px-3 py-2' : 'px-3 py-2'}
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                        <MessageCircle className="h-3.5 w-3.5" />
                        <span>{m.mine ? 'You' : m.sender}</span>
                        <span>{formatDate(m.created_at)}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-[14px]">{m.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              {current.status === 'open' && current.my_role !== 'observer' && (
                <div className="space-y-3 border-t pt-4">
                  <Field label="Reply">
                    <Textarea value={draft} onChange={setDraft} rows={3} />
                  </Field>
                  <Button
                    disabled={!draft.trim() || send.isPending}
                    onClick={() => send.mutate()}
                  >
                    Send
                  </Button>
                  <FormNotice error={send.error} />
                </div>
              )}

              <div className="border-t pt-4">
                <h4 className="mb-3 text-[14px] font-semibold">
                  Who can read this conversation
                </h4>
                <ul className="space-y-2 text-[14px]">
                  {live.map((p) => (
                    <li key={p.user_id}>
                      <span className="font-medium">{p.full_name}</span>{' '}
                      <Badge tone="neutral" solid>
                        {p.role_in_thread}
                      </Badge>
                      {p.added_reason && (
                        <span className="block text-[13px] text-muted-foreground">
                          Added by {p.added_by ?? 'unknown'} on {formatDate(p.added_at)} —{' '}
                          {p.added_reason}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {past.length > 0 && (
                  <p className="mt-3 text-[13px] text-muted-foreground">
                    No longer in the conversation:{' '}
                    {past.map((p) => `${p.full_name} (until ${formatDate(p.removed_at)})`).join(', ')}
                    . They read what was written before then.
                  </p>
                )}

                {current.my_role === 'counselor' && current.status === 'open' && (
                  <div className="mt-4 space-y-3">
                    <FormGrid>
                      <Field label="Add a member of staff" hint="Their user id">
                        <Input
                          value={addition.user_id}
                          onChange={(v) => setAddition({ ...addition, user_id: v })}
                        />
                      </Field>
                      <Field label="As">
                        <Select
                          value={addition.role_in_thread}
                          onChange={(v) => setAddition({ ...addition, role_in_thread: v })}
                          options={[
                            { value: 'observer', label: 'Observer (may read, not write)' },
                            { value: 'counselor', label: 'Counsellor (may read and write)' },
                          ]}
                        />
                      </Field>
                      <Field
                        label="Reason"
                        wide
                        required
                        hint="The family sees this. It is the record of why their conversation was widened."
                      >
                        <Input
                          value={addition.reason}
                          onChange={(v) => setAddition({ ...addition, reason: v })}
                        />
                      </Field>
                    </FormGrid>
                    <Button
                      size="sm"
                      disabled={
                        !addition.user_id.trim() || !addition.reason.trim() || addPerson.isPending
                      }
                      onClick={() => addPerson.mutate()}
                    >
                      Add
                    </Button>
                    <FormNotice error={addPerson.error} />
                  </div>
                )}
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
