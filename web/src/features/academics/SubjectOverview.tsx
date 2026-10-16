import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Textarea, ErrorState, EmptyState, SkeletonTiles, TAB_BAR, tabClass,
} from '@/components/ui'

/* A subject head's view of their subject (owner, 2026-10-16): every teacher
   of it from Grade 1 up, how their classes are doing, the subject's timetable
   across all classes, the notices those teachers posted, and the meetings
   the head calls -- each one sent to all of those teachers. */

interface ClassRow { label: string; periods: number; avg: number | null }
interface Teacher {
  id: string; name: string; phone: string | null; classes: ClassRow[]; periods_week: number; avg: number | null
  plans_30d: number; plans_submitted: number; plans_delivered: number
}
interface Slot { weekday: number; period: string; sequence: number; starts_at: string; ends_at: string; class: string; teacher: string | null; room: string | null }
interface Notice { id: string; title: string; body: string; kind: string; publish_at: string; by_name: string }
interface Meeting { id: string; title: string; agenda: string | null; meets_at: string; place: string | null; minutes: string | null; by_name: string | null }
interface Heads {
  subjects: { id: string; name: string; code: string; head_user_id: string | null; head_name: string | null }[]
  staff: { id: string; name: string; code: string | null }[]
}
interface Data {
  subjects: { id: string; name: string }[]
  subject: { id: string; name: string } | null
  teachers: Teacher[]; timetable: Slot[]; notices: Notice[]; meetings: Meeting[]
}

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const TABS = ['Teachers', 'Timetable', 'Notices', 'Meetings', 'Subject heads'] as const
const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
const pct = (v: number | null) => (v === null ? '—' : `${v}%`)

export default function SubjectOverview() {
  const [subject, setSubject] = useState('')
  const [tab, setTab] = useState<(typeof TABS)[number]>('Teachers')
  const q = useQuery({
    queryKey: ['subject-overview', subject],
    queryFn: () => api.get<Data>(`/api/v1/teaching/my-subjects${subject ? `?subject=${subject}` : ''}`),
  })
  const d = q.data
  // Only the office can set heads; for a HOD this call is refused and the tab stays hidden.
  const heads = useQuery({ queryKey: ['subject-heads'], queryFn: () => api.get<Heads>('/api/v1/academics/subject-heads'), retry: false })
  const tabs = TABS.filter((t) => t !== 'Subject heads' || heads.data)

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title={d?.subject ? `${d.subject.name} overview` : 'Subject overview'}
        actions={d && d.subjects.length > 1 ? (
          <div className="w-56">
            <Select value={d.subject?.id ?? ''} onChange={setSubject} options={d.subjects.map((s) => ({ value: s.id, label: s.name }))} />
          </div>
        ) : undefined}
      />
      <PageBody>
        {q.isLoading ? <SkeletonTiles /> : q.error ? <ErrorState error={q.error} /> : !d?.subject && heads.data ? (
          <HeadsSetup data={heads.data} />
        ) : !d?.subject ? (
          <EmptyState title="No subject yet" body="The office makes you the head of a subject in Academics → Subject heads." />
        ) : (
          <>
            <div className={TAB_BAR} role="tablist">
              {tabs.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={tabClass(tab === t)} onClick={() => setTab(t)}>
                  {t}{t === 'Teachers' ? ` (${d.teachers.length})` : t === 'Meetings' ? ` (${d.meetings.length})` : ''}
                </button>
              ))}
            </div>
            <div className="mt-4">
              {tab === 'Teachers' && <Teachers rows={d.teachers} />}
              {tab === 'Timetable' && <Timetable rows={d.timetable} />}
              {tab === 'Notices' && <Notices rows={d.notices} />}
              {tab === 'Subject heads' && heads.data && <HeadsSetup data={heads.data} />}
              {tab === 'Meetings' && <Meetings subjectId={d.subject.id} rows={d.meetings} teachers={d.teachers.length} />}
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}

function Teachers({ rows }: { rows: Teacher[] }) {
  return (
    <Card>
      <Table head={['Teacher', 'Classes (avg marks)', { label: 'Periods / week', align: 'right' }, { label: 'Avg marks', align: 'right' }, { label: 'Lesson plans (30 days)', align: 'right' }]}
        empty={!rows.length} emptyLabel="Nobody teaches this subject yet. Set subject teachers or the timetable.">
        {rows.map((t) => (
          <tr key={t.id}>
            <Td className="font-medium">{t.name}{t.phone && <div className="text-[12.5px] font-normal text-muted-foreground">{t.phone}</div>}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {t.classes.map((k) => <Badge key={k.label}>{k.label} · {pct(k.avg)}</Badge>)}
              </div>
            </Td>
            <Td className="num">{t.periods_week}</Td>
            <Td className="num">{t.avg === null ? '—' : <Badge tone={t.avg >= 75 ? 'success' : t.avg >= 50 ? 'warning' : 'danger'}>{pct(t.avg)}</Badge>}</Td>
            <Td className="num">{t.plans_30d ? `${t.plans_submitted}/${t.plans_30d} sent · ${t.plans_delivered} done` : '—'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function Timetable({ rows }: { rows: Slot[] }) {
  return (
    <Card>
      <Table head={['Day', 'Period', 'Time', 'Class', 'Teacher', 'Room']} empty={!rows.length} emptyLabel="This subject has no periods on the timetable.">
        {rows.map((s, i) => (
          <tr key={i}>
            <Td className="font-medium">{DAYS[s.weekday] ?? s.weekday}</Td>
            <Td>{s.period}</Td>
            <Td className="whitespace-nowrap">{s.starts_at.slice(0, 5)}–{s.ends_at.slice(0, 5)}</Td>
            <Td>{s.class}</Td>
            <Td>{s.teacher ?? '—'}</Td>
            <Td>{s.room ?? '—'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function Notices({ rows }: { rows: Notice[] }) {
  return (
    <Card>
      <Table head={['When', 'By', 'Notice']} empty={!rows.length} emptyLabel="No notices from these teachers in the last 60 days.">
        {rows.map((n) => (
          <tr key={n.id}>
            <Td className="whitespace-nowrap">{when(n.publish_at)}</Td>
            <Td>{n.by_name}</Td>
            <Td><div className="font-medium">{n.title}</div><div className="line-clamp-2 text-muted-foreground">{n.body}</div></Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function Meetings({ subjectId, rows, teachers }: { subjectId: string; rows: Meeting[]; teachers: number }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ title: '', meets_at: '', place: '', agenda: '' })
  const [done, setDone] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [minutes, setMinutes] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['subject-overview'] })
  const create = useMutation({
    mutationFn: () => api.post<{ sent: number }>('/api/v1/teaching/my-subjects/meetings', { subject_id: subjectId, ...f, meets_at: f.meets_at ? new Date(f.meets_at).toISOString() : '' }),
    onSuccess: (r) => { setDone(`Meeting scheduled and sent to ${r.sent} teacher${r.sent === 1 ? '' : 's'}.`); setF({ title: '', meets_at: '', place: '', agenda: '' }); refresh() },
  })
  const save = useMutation({
    mutationFn: (id: string) => api.patch(`/api/v1/teaching/my-subjects/meetings/${id}`, { minutes }),
    onSuccess: () => { setOpen(null); refresh() },
  })
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/v1/teaching/my-subjects/meetings/${id}`), onSuccess: refresh })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Schedule a meeting" />
        <div className="space-y-3 p-[var(--card-pad)]">
          <FormGrid>
            <Field label="Title"><Input value={f.title} onChange={(v) => setF({ ...f, title: v })} placeholder="e.g. SA-1 paper review" /></Field>
            <Field label="Date and time"><Input type="datetime-local" value={f.meets_at} onChange={(v) => setF({ ...f, meets_at: v })} /></Field>
            <Field label="Place"><Input value={f.place} onChange={(v) => setF({ ...f, place: v })} placeholder="e.g. Staff room" /></Field>
          </FormGrid>
          <Field label="Agenda"><Textarea value={f.agenda} onChange={(v) => setF({ ...f, agenda: v })} placeholder="What will be discussed" /></Field>
          <FormNotice error={create.error} ok={done} />
          <Button disabled={create.isPending || !f.title.trim() || !f.meets_at} onClick={() => { setDone(''); create.mutate() }}>
            {create.isPending ? 'Sending…' : `Schedule and send to ${teachers} teacher${teachers === 1 ? '' : 's'}`}
          </Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="Meetings" />
        <Table head={['When', 'Meeting', 'Minutes', '']} empty={!rows.length} emptyLabel="No meetings yet.">
          {rows.map((m) => (
            <tr key={m.id}>
              <Td className="whitespace-nowrap">{when(m.meets_at)}{m.place && <div className="text-muted-foreground">{m.place}</div>}</Td>
              <Td><div className="font-medium">{m.title}</div>{m.agenda && <div className="whitespace-pre-line text-muted-foreground">{m.agenda}</div>}</Td>
              <Td>
                {open === m.id ? (
                  <div className="space-y-2">
                    <Textarea value={minutes} onChange={setMinutes} placeholder="What was agreed" />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(m.id)}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="whitespace-pre-line">{m.minutes || <span className="text-muted-foreground">—</span>}</div>
                )}
              </Td>
              <Td className="whitespace-nowrap">
                {open !== m.id && <Button size="sm" variant="ghost" onClick={() => { setOpen(m.id); setMinutes(m.minutes ?? '') }}>Minutes</Button>}
                <ConfirmButton size="sm" variant="ghost" tone="danger" question="Delete this meeting?" confirmLabel="Delete" onConfirm={() => remove.mutate(m.id)}>Delete</ConfirmButton>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}

function HeadsSetup({ data }: { data: Heads }) {
  const qc = useQueryClient()
  const set = useMutation({
    mutationFn: (v: { subject_id: string; head_user_id: string | null }) => api.put('/api/v1/academics/subject-heads', v),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['subject-heads'] }); qc.invalidateQueries({ queryKey: ['subject-overview'] }) },
  })
  const staff = [{ value: '', label: 'No head' }, ...data.staff.map((p) => ({ value: p.id, label: p.code ? `${p.name} (${p.code})` : p.name }))]
  return (
    <Card>
      <CardHeader title="Who heads each subject" />
      <FormNotice error={set.error} />
      <Table head={['Subject', 'Head']} empty={!data.subjects.length} emptyLabel="No subjects yet.">
        {data.subjects.map((s) => (
          <tr key={s.id}>
            <Td className="font-medium">{s.name} <span className="text-muted-foreground">{s.code}</span></Td>
            <Td className="w-80">
              <Select value={s.head_user_id ?? ''} onChange={(v) => set.mutate({ subject_id: s.id, head_user_id: v || null })} options={staff} placeholder="No head" />
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
