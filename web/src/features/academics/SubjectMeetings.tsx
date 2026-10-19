import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import SubjectChat from './SubjectChat'
import { PageHead, PageBody, Card, CardHeader, TAB_BAR, tabClass, Badge, Button, Input, Select, Textarea, Field, FormGrid, FormNotice, ErrorState, EmptyState, SkeletonTiles } from '@/components/ui'

/* The teacher's side of a subject head's meetings (owner, 2026-10-19):
   when, where and what about, and an answer -- attending, or can't come
   with the reason. Answers can be changed until the meeting. */

interface Meeting {
  id: string; title: string; agenda: string | null; meets_at: string; place: string | null; minutes: string | null
  subject: string; by_name: string | null; reply: 'yes' | 'no' | null; note: string | null
}

const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

export default function SubjectMeetings() {
  const q = useQuery({ queryKey: ['subject-meetings'], queryFn: () => api.get<{ items: Meeting[] }>('/api/v1/teaching/subject-meetings') })
  const [tab, setTab] = useState<'Meetings' | 'Group chat'>('Meetings')
  return (
    <>
      <PageHead eyebrow="Academics" title="Subject meetings" />
      <PageBody>
        <div className={TAB_BAR} role="tablist">
          {(['Meetings', 'Group chat'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tabClass(tab === t)} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div className="mt-4">
        {tab === 'Group chat' ? <SubjectChat /> : <>
        <Schedule />
        {q.isLoading ? <SkeletonTiles /> : q.error ? <ErrorState error={q.error} /> : !q.data?.items.length ? (
          <div className="mt-4"><EmptyState title="No meetings" body="Meetings your subject head calls will appear here." /></div>
        ) : (
          <div className="mt-4 space-y-3">{q.data.items.map((m) => <MeetingCard key={m.id} m={m} />)}</div>
        )}
        </>}
        </div>
      </PageBody>
    </>
  )
}

function MeetingCard({ m }: { m: Meeting }) {
  const qc = useQueryClient()
  const [note, setNote] = useState(m.note ?? '')
  const [asking, setAsking] = useState(false)
  const past = new Date(m.meets_at).getTime() < Date.now()
  const send = useMutation({
    mutationFn: (reply: 'yes' | 'no') => api.post(`/api/v1/teaching/subject-meetings/${m.id}/reply`, { reply, note }),
    onSuccess: () => { setAsking(false); qc.invalidateQueries({ queryKey: ['subject-meetings'] }) },
  })
  return (
    <Card>
      <div className="space-y-2 p-[var(--card-pad)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{m.title}</span>
          <Badge>{m.subject}</Badge>
          {m.reply === 'yes' && <Badge tone="success">You're attending</Badge>}
          {m.reply === 'no' && <Badge tone="danger">You can't come</Badge>}
        </div>
        <div className="text-[14px] text-muted-foreground">
          {when(m.meets_at)}{m.place ? ` · ${m.place}` : ''}{m.by_name ? ` · called by ${m.by_name}` : ''}
        </div>
        {m.agenda && <div className="whitespace-pre-line text-[14px]">{m.agenda}</div>}
        {m.minutes && <div className="rounded-md bg-muted p-3 text-[14px]"><span className="font-medium">Minutes: </span><span className="whitespace-pre-line">{m.minutes}</span></div>}
        {!past && (
          <div className="space-y-2 pt-1">
            {asking && <Input value={note} onChange={setNote} placeholder="Why you can't come" autoFocus />}
            <FormNotice error={send.error} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={send.isPending} onClick={() => send.mutate('yes')}>Attending</Button>
              {asking
                ? <Button size="sm" variant="secondary" disabled={send.isPending || !note.trim()} onClick={() => send.mutate('no')}>Send: can't come</Button>
                : <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>Can't come</Button>}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

/* A subject head calls a meeting from here too (owner, 2026-10-19: "let the
   hod add meeting"). Shown only to someone who heads a subject; it goes to
   every teacher of that subject. */
function Schedule() {
  const qc = useQueryClient()
  const heads = useQuery({
    queryKey: ['subject-overview', ''],
    queryFn: () => api.get<{ subjects: { id: string; name: string }[] }>('/api/v1/teaching/my-subjects'),
  })
  const [f, setF] = useState({ subject_id: '', title: '', meets_at: '', place: '', agenda: '' })
  const [done, setDone] = useState('')
  const create = useMutation({
    mutationFn: () => api.post<{ sent: number }>('/api/v1/teaching/my-subjects/meetings', { ...f, subject_id: f.subject_id || subjects[0]?.id, meets_at: new Date(f.meets_at).toISOString() }),
    onSuccess: (r) => {
      setDone(`Meeting scheduled and sent to ${r.sent} teacher${r.sent === 1 ? '' : 's'}.`)
      setF({ subject_id: f.subject_id, title: '', meets_at: '', place: '', agenda: '' })
      qc.invalidateQueries({ queryKey: ['subject-meetings'] }); qc.invalidateQueries({ queryKey: ['subject-overview'] })
    },
  })
  const subjects = heads.data?.subjects ?? []
  if (!subjects.length) return null
  return (
    <Card>
      <CardHeader title="Schedule a meeting" />
      <div className="space-y-3 p-[var(--card-pad)]">
        <FormGrid>
          {subjects.length > 1 && (
            <Field label="Subject"><Select value={f.subject_id || subjects[0].id} onChange={(v) => setF({ ...f, subject_id: v })} options={subjects.map((x) => ({ value: x.id, label: x.name }))} /></Field>
          )}
          <Field label="Title"><Input value={f.title} onChange={(v) => setF({ ...f, title: v })} placeholder="e.g. SA-1 paper review" /></Field>
          <Field label="Date and time"><Input type="datetime-local" value={f.meets_at} onChange={(v) => setF({ ...f, meets_at: v })} /></Field>
          <Field label="Place"><Input value={f.place} onChange={(v) => setF({ ...f, place: v })} placeholder="e.g. Staff room" /></Field>
        </FormGrid>
        <Field label="Agenda"><Textarea value={f.agenda} onChange={(v) => setF({ ...f, agenda: v })} placeholder="What will be discussed" /></Field>
        <FormNotice error={create.error} ok={done} />
        <Button disabled={create.isPending || !f.title.trim() || !f.meets_at} onClick={() => { setDone(''); create.mutate() }}>
          {create.isPending ? 'Sending…' : 'Schedule and send to the subject teachers'}
        </Button>
      </div>
    </Card>
  )
}
