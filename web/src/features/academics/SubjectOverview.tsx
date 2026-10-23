import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import WeekGrid from '@/components/WeekGrid'
import SubjectChat from './SubjectChat'
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
  homework_30d: number; present_30d: number | null; marked_30d: number; leave_30d: number
}
interface Plan { id: string; week_of: string; objectives: string | null; activities: string | null; homework: string | null; teacher: string | null; class: string }
type Parts = Record<'performance' | 'classes' | 'timetable' | 'notices' | 'meetings' | 'approvals' | 'homework', boolean>
interface Slot { weekday: number; period_id: string; teacher_user_id: string | null; period: string; sequence: number; starts_at: string; ends_at: string; class: string; teacher: string | null; room: string | null }
interface Notice { id: string; title: string; body: string; kind: string; publish_at: string; by_name: string }
interface Meeting { id: string; title: string; agenda: string | null; meets_at: string; place: string | null; minutes: string | null; by_name: string | null; replies: { name: string; reply: 'yes' | 'no'; note: string | null }[] }
interface Section {
  section_id: string; class_subject_id: string; label: string; level: number; teacher_user_id: string | null; teacher: string | null; students: number
  avg: number | null; pass: number | null; papers: number; units_total: number; units_due: number; units_done: number
}
interface Heads {
  subjects: { id: string; name: string; code: string; head_user_id: string | null; head_name: string | null }[]
  staff: { id: string; name: string; code: string | null }[]
}
interface Data {
  subjects: { id: string; name: string }[]
  subject: { id: string; name: string } | null
  teachers: Teacher[]; timetable: Slot[]; notices: Notice[]; meetings: Meeting[]
  sections: Section[]; can_assign: boolean; staff: { id: string; name: string }[]
  parts: Parts; pending_plans: Plan[]; removed: { id: string; name: string }[]
}

const TABS = ['All subjects', 'Teachers', 'Classes', 'Approvals', 'Timetable', 'Notices', 'Meetings', 'Chat', 'Subject heads'] as const
/* Which school setting turns each tab off for a head. The principal always sees them all. */
const TAB_PART: Partial<Record<(typeof TABS)[number], keyof Parts>> = {
  Teachers: 'performance', Classes: 'classes', Approvals: 'approvals', Timetable: 'timetable', Notices: 'notices', Meetings: 'meetings',
}
const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
const pct = (v: number | null) => (v === null ? '—' : `${v}%`)

export default function SubjectOverview() {
  const [subject, setSubject] = useState('')
  const [tab, setTab] = useState<(typeof TABS)[number] | null>(null)
  const q = useQuery({
    queryKey: ['subject-overview', subject],
    queryFn: () => api.get<Data>(`/api/v1/teaching/my-subjects${subject ? `?subject=${subject}` : ''}`),
  })
  const d = q.data
  // Only the office can set heads; for a HOD this call is refused and the tab stays hidden.
  const heads = useQuery({ queryKey: ['subject-heads'], queryFn: () => api.get<Heads>('/api/v1/academics/subject-heads'), retry: false })
  const office = !!heads.data
  const tabs = TABS.filter((t) => ((t !== 'Subject heads' && t !== 'All subjects') || office) && (office || !TAB_PART[t] || d?.parts[TAB_PART[t]!] !== false))
  // The principal opens on every subject at once; a head on their own subject's teachers.
  const shown = tab && tabs.includes(tab) ? tab : office ? 'All subjects' : tabs.includes('Teachers') ? 'Teachers' : tabs[0]
  // These two tabs are about every subject, so the page names no single subject and hides the picker.
  const schoolWide = shown === 'All subjects' || shown === 'Subject heads'

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title={schoolWide ? (shown === 'Subject heads' ? 'Subject heads' : 'All subjects') : d?.subject ? `${d.subject.name} overview` : 'Subject overview'}
        actions={!schoolWide && d && d.subjects.length > 1 ? (
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
                <button key={t} type="button" role="tab" aria-selected={shown === t} className={tabClass(shown === t)} onClick={() => setTab(t)}>
                  {t}{t === 'Teachers' ? ` (${d.teachers.length})` : t === 'Meetings' ? ` (${d.meetings.length})` : t === 'Approvals' && d.pending_plans.length ? ` (${d.pending_plans.length})` : ''}
                </button>
              ))}
            </div>
            <div className="mt-4">
              {shown === 'All subjects' && <AllHeads onOpen={(id) => { setSubject(id); setTab('Teachers') }} />}
              {shown === 'Teachers' && <Teachers rows={d.teachers} subjectId={d.subject.id} office={office} removed={d.removed} staff={d.staff} slots={d.timetable} sections={d.sections} />}
              {shown === 'Approvals' && <Approvals rows={d.pending_plans} />}
              {shown === 'Classes' && <Classes rows={d.sections} canAssign={d.can_assign} staff={d.staff} />}
              {shown === 'Timetable' && <Timetable rows={d.timetable} teachers={d.teachers} />}
              {shown === 'Chat' && <SubjectChat subjectId={d.subject.id} />}
              {shown === 'Notices' && <Notices rows={d.notices} />}
              {shown === 'Subject heads' && heads.data && <><HeadsSetup data={heads.data} /><div className="mt-4"><PartsSetup /></div></>}
              {shown === 'Meetings' && <Meetings subjectId={d.subject.id} rows={d.meetings} teachers={d.teachers.length} />}
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}

function Teachers({ rows, subjectId, office, removed, staff, slots, sections }: { rows: Teacher[]; subjectId: string; office: boolean; removed: { id: string; name: string }[]; staff: { id: string; name: string }[]; slots: Slot[]; sections: Section[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const picked = rows.find((r) => r.id === open)
  const qc = useQueryClient()
  const member = useMutation({
    mutationFn: (v: { user_id: string; mode: 'add' | 'remove' | null }) => api.put('/api/v1/academics/subject-heads/members', { subject_id: subjectId, ...v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subject-overview'] }),
  })
  const [add, setAdd] = useState('')
  return (
    <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-72"><Select value={open ?? ''} onChange={(v) => setOpen(v || null)} options={[{ value: '', label: 'All teachers' }, ...rows.map((r) => ({ value: r.id, label: r.name }))]} /></div>
      {picked && <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Back to all teachers</Button>}
    </div>
    {picked ? <TeacherView t={picked} slots={slots.filter((x) => x.teacher_user_id === picked.id)} sections={sections.filter((x) => x.teacher_user_id === picked.id)} /> : (
    <Card>
      <Table head={['Teacher', 'Classes (avg marks)', { label: 'Periods / week', align: 'right' }, { label: 'Avg marks', align: 'right' }, { label: 'Lesson plans (30 days)', align: 'right' }, { label: 'Homework (30 days)', align: 'right' }, { label: 'Present (30 days)', align: 'right' }, ...(office ? [''] : [])]}
        empty={!rows.length} emptyLabel="Nobody teaches this subject yet. Set subject teachers or the timetable.">
        {rows.map((t) => (
          <tr key={t.id} className="cursor-pointer hover:bg-accent/40" onClick={() => setOpen(t.id)} title="Open this teacher's overview">
            <Td className="font-medium">{t.name}{t.phone && <div className="text-[12.5px] font-normal text-muted-foreground">{t.phone}</div>}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {t.classes.map((k) => <Badge key={k.label}>{k.label} · {pct(k.avg)}</Badge>)}
              </div>
            </Td>
            <Td className="num">{t.periods_week}</Td>
            <Td className="num">{t.avg === null ? '—' : <Badge tone={t.avg >= 75 ? 'success' : t.avg >= 50 ? 'warning' : 'danger'}>{pct(t.avg)}</Badge>}</Td>
            <Td className="num">{t.plans_30d ? `${t.plans_submitted}/${t.plans_30d} sent · ${t.plans_delivered} done` : '—'}</Td>
            <Td className="num">{t.homework_30d}</Td>
            <Td className="num">{t.marked_30d ? `${t.present_30d}/${t.marked_30d}` : '—'}{t.leave_30d ? <div className="text-[12.5px] text-muted-foreground">{t.leave_30d} leave</div> : null}</Td>
            {office && <Td><span onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" disabled={member.isPending} onClick={() => member.mutate({ user_id: t.id, mode: 'remove' })}>Remove</Button></span></Td>}
          </tr>
        ))}
      </Table>
    </Card>
    )}
    {office && (
      <Card>
        <CardHeader title="Teachers under this head" />
        <div className="space-y-3 p-[var(--card-pad)] text-[14px]">
          <div className="text-muted-foreground">Everyone teaching the subject is under the head by default. Remove a teacher above, or add someone here.</div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72"><Select value={add} onChange={setAdd} options={staff.filter((p) => !rows.some((r) => r.id === p.id)).map((p) => ({ value: p.id, label: p.name }))} placeholder="Add a teacher" /></div>
            <Button size="sm" disabled={!add || member.isPending} onClick={() => { member.mutate({ user_id: add, mode: 'add' }); setAdd('') }}>Add</Button>
          </div>
          {removed.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Removed:</span>
              {removed.map((p) => <Button key={p.id} size="sm" variant="secondary" onClick={() => member.mutate({ user_id: p.id, mode: null })}>{p.name} · put back</Button>)}
            </div>
          )}
          <FormNotice error={member.error} />
        </div>
      </Card>
    )}
    </div>
  )
}

/* One teacher's week in this subject, as the staff-room grid (owner,
   2026-10-19: "select one person and show their timetable and classes per
   week, like our theme"). */
function Timetable({ rows, teachers }: { rows: Slot[]; teachers: Teacher[] }) {
  const withSlots = teachers.filter((t) => rows.some((r) => r.teacher_user_id === t.id))
  const [who, setWho] = useState(withSlots[0]?.id ?? '')
  const mine = rows.filter((r) => r.teacher_user_id === who)
  return (
    <div className="space-y-4">
      <div className="w-72"><Select value={who} onChange={setWho} options={withSlots.map((t) => ({ value: t.id, label: t.name }))} placeholder="Pick a teacher" /></div>
      {who ? <TeacherWeek slots={mine} /> : <EmptyState title="No periods" body="This subject has no periods on the timetable." />}
    </div>
  )
}

function TeacherWeek({ slots }: { slots: Slot[] }) {
  const periods = [...new Map(slots.map((s) => [s.period_id, { id: s.period_id, name: s.period, starts_at: s.starts_at, ends_at: s.ends_at, seq: s.sequence }])).values()]
    .sort((a, b) => a.seq - b.seq)
  const perClass = new Map<string, number>()
  for (const s of slots) perClass.set(s.class, (perClass.get(s.class) ?? 0) + 1)
  return (
    <Card>
      <CardHeader title={`${slots.length} periods a week`} />
      <div className="flex flex-wrap gap-1.5 px-[var(--card-pad)] pt-3">
        {[...perClass.entries()].map(([k, n]) => <Badge key={k}>{k} · {n}/week</Badge>)}
      </div>
      <div className="p-[var(--card-pad)]">
        <WeekGrid periods={periods} entries={slots.map((s) => ({ weekday: s.weekday, period_id: s.period_id, title: s.class, detail: s.room }))} empty="No periods for this teacher." />
      </div>
    </Card>
  )
}

/* Everything about one teacher of the subject on one page. */
function TeacherView({ t, slots, sections }: { t: Teacher; slots: Slot[]; sections: Section[] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t.name} />
        <div className="grid grid-cols-2 gap-3 p-[var(--card-pad)] text-[14px] sm:grid-cols-3 lg:grid-cols-6">
          {([
            ['Phone', t.phone ?? '—'], ['Periods a week', String(t.periods_week)], ['Average marks', pct(t.avg)],
            ['Lesson plans (30 days)', t.plans_30d ? `${t.plans_submitted}/${t.plans_30d} sent, ${t.plans_delivered} done` : '—'],
            ['Homework (30 days)', String(t.homework_30d)],
            ['Present (30 days)', t.marked_30d ? `${t.present_30d}/${t.marked_30d}${t.leave_30d ? ` · ${t.leave_30d} leave` : ''}` : '—'],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} className="rounded-lg border p-3">
              <div className="text-[12.5px] text-muted-foreground">{k}</div>
              <div className="mt-1 font-semibold">{v}</div>
            </div>
          ))}
        </div>
      </Card>
      <Classes rows={sections} canAssign={false} staff={[]} />
      <TeacherWeek slots={slots} />
    </div>
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
        <Table head={['When', 'Meeting', 'Replies', 'Minutes', '']} empty={!rows.length} emptyLabel="No meetings yet.">
          {rows.map((m) => (
            <tr key={m.id}>
              <Td className="whitespace-nowrap">{when(m.meets_at)}{m.place && <div className="text-muted-foreground">{m.place}</div>}</Td>
              <Td><div className="font-medium">{m.title}</div>{m.agenda && <div className="whitespace-pre-line text-muted-foreground">{m.agenda}</div>}</Td>
              <Td>
                <div className="whitespace-nowrap">
                  <Badge tone="success">{m.replies.filter((r) => r.reply === 'yes').length} attending</Badge>{' '}
                  <Badge tone="danger">{m.replies.filter((r) => r.reply === 'no').length} can't come</Badge>
                </div>
                {m.replies.map((r) => (
                  <div key={r.name} className="text-[12.5px] text-muted-foreground">
                    {r.name}: {r.reply === 'yes' ? 'attending' : `can't come${r.note ? ` (${r.note})` : ''}`}
                  </div>
                ))}
                {teachers > m.replies.length && <div className="text-[12.5px] text-muted-foreground">{teachers - m.replies.length} not answered</div>}
              </Td>
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

/* Every class of the subject side by side: marks, pass rate and syllabus
   covered, so the class that is behind stands out. The principal sets the
   subject teacher of each class here too. */
function Classes({ rows, canAssign, staff }: { rows: Section[]; canAssign: boolean; staff: { id: string; name: string }[] }) {
  const qc = useQueryClient()
  const assign = useMutation({
    mutationFn: (v: { section_id: string; class_subject_id: string; teacher_user_id: string }) =>
      api.post('/api/v1/academics/admin/faculty-allocation', { allocations: [v] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subject-overview'] }),
  })
  const marked = rows.filter((r) => r.avg !== null)
  const mean = marked.length ? marked.reduce((n, r) => n + (r.avg ?? 0), 0) / marked.length : null
  const behind = (r: Section) => {
    const why: string[] = []
    if (mean !== null && r.avg !== null && r.avg < mean - 5) why.push(`marks ${Math.round(mean - r.avg)}% below the subject average`)
    if (r.units_due > r.units_done) why.push(`${r.units_due - r.units_done} chapter${r.units_due - r.units_done === 1 ? '' : 's'} behind plan`)
    return why
  }
  const opts = [{ value: '', label: 'No teacher' }, ...staff.map((p) => ({ value: p.id, label: p.name }))]
  return (
    <Card>
      <CardHeader title={mean === null ? 'Classes' : `Classes · subject average ${Math.round(mean * 10) / 10}%`} />
      <FormNotice error={assign.error} />
      <Table head={['Class', 'Subject teacher', { label: 'Students', align: 'right' }, { label: 'Avg marks', align: 'right' }, { label: 'Pass %', align: 'right' }, 'Syllabus covered', 'Status']}
        empty={!rows.length} emptyLabel="No class has this subject this year.">
        {rows.map((r) => {
          const why = behind(r)
          const pc = r.units_total ? Math.round((r.units_done / r.units_total) * 100) : null
          return (
            <tr key={r.section_id + r.class_subject_id}>
              <Td className="whitespace-nowrap font-medium">{r.label}</Td>
              <Td className="min-w-[13rem]">
                {canAssign ? (
                  <Select value={r.teacher_user_id ?? ''} options={opts} placeholder="No teacher"
                    onChange={(v) => assign.mutate({ section_id: r.section_id, class_subject_id: r.class_subject_id, teacher_user_id: v })} />
                ) : (r.teacher ?? <span className="text-muted-foreground">—</span>)}
              </Td>
              <Td className="num">{r.students}</Td>
              <Td className="num">{pct(r.avg)}</Td>
              <Td className="num">{pct(r.pass)}</Td>
              <Td className="min-w-[10rem]">
                {r.units_total ? (
                  <>
                    <div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${pc}%` }} /></div>
                    <div className="mt-1 text-[12.5px] text-muted-foreground">{r.units_done}/{r.units_total} chapters{r.units_due ? ` · ${r.units_due} due by today` : ''}</div>
                  </>
                ) : <span className="text-muted-foreground">No syllabus set</span>}
              </Td>
              <Td>
                {why.length ? <Badge tone="danger">Behind</Badge> : r.avg === null && !r.units_total ? <span className="text-muted-foreground">—</span> : <Badge tone="success">On track</Badge>}
                {why.map((w) => <div key={w} className="text-[12.5px] text-muted-foreground">{w}</div>)}
              </Td>
            </tr>
          )
        })}
      </Table>
    </Card>
  )
}

/* Lesson plans of the subject waiting on the head: approve, or send back with a reason. */
function Approvals({ rows }: { rows: Plan[] }) {
  const qc = useQueryClient()
  const [why, setWhy] = useState<Record<string, string>>({})
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'returned' }) =>
      api.post(`/api/v1/teaching/my-subjects/lesson-plans/${v.id}/decide`, { decision: v.decision, remarks: why[v.id] ?? '' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subject-overview'] }),
  })
  return (
    <Card>
      <CardHeader title="Lesson plans waiting" />
      <FormNotice error={decide.error} />
      <Table head={['Week of', 'Class', 'Teacher', 'Plan', '']} empty={!rows.length} emptyLabel="Nothing waiting.">
        {rows.map((p) => (
          <tr key={p.id}>
            <Td className="whitespace-nowrap">{p.week_of}</Td>
            <Td className="whitespace-nowrap">{p.class}</Td>
            <Td>{p.teacher ?? '—'}</Td>
            <Td>
              {p.objectives && <div><span className="font-medium">Objectives: </span>{p.objectives}</div>}
              {p.activities && <div className="text-muted-foreground">{p.activities}</div>}
            </Td>
            <Td className="min-w-[14rem] space-y-2">
              <Input value={why[p.id] ?? ''} onChange={(v) => setWhy({ ...why, [p.id]: v })} placeholder="Remarks (needed to send back)" />
              <div className="flex gap-2">
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: 'approved' })}>Approve</Button>
                <Button size="sm" variant="secondary" disabled={decide.isPending || !(why[p.id] ?? '').trim()} onClick={() => decide.mutate({ id: p.id, decision: 'returned' })}>Send back</Button>
              </div>
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

/* What this school gives a subject head. Every part on until turned off. */
const PART_LABELS: [keyof Parts, string][] = [
  ['performance', 'Teacher performance'], ['classes', 'Classes: marks and syllabus'], ['approvals', 'Approve lesson plans'],
  ['homework', 'Set homework for every class of the subject'], ['timetable', 'Subject timetable'], ['notices', 'Teachers\' notices'], ['meetings', 'Meetings with the teachers'],
]
function PartsSetup() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['subject-head-parts'], queryFn: () => api.get<{ parts: Parts }>('/api/v1/academics/subject-heads/settings') })
  const save = useMutation({
    mutationFn: (parts: Parts) => api.put('/api/v1/academics/subject-heads/settings', { parts }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['subject-head-parts'] }); qc.invalidateQueries({ queryKey: ['subject-overview'] }) },
  })
  const parts = q.data?.parts
  return (
    <Card>
      <CardHeader title="What a subject head gets at this school" />
      <div className="space-y-2 p-[var(--card-pad)] text-[14px]">
        {!parts ? <SkeletonTiles /> : PART_LABELS.map(([k, label]) => (
          <label key={k} className="flex min-h-10 cursor-pointer items-center gap-3">
            <input type="checkbox" checked={parts[k]} disabled={save.isPending} onChange={(e) => save.mutate({ ...parts, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}

interface HeadRow { id: string; name: string; head: string | null; teachers: number; avg: number | null; units: number; due: number; done: number; plans_waiting: number; meetings: number }
/* Every subject head at once, for the principal. */
function AllHeads({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['subject-heads-summary'], queryFn: () => api.get<{ items: HeadRow[] }>('/api/v1/academics/subject-heads/summary') })
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <Card>
      <Table loading={q.isLoading} head={['Subject', 'Head', { label: 'Teachers', align: 'right' }, { label: 'Avg marks', align: 'right' }, 'Syllabus', { label: 'Plans waiting', align: 'right' }, { label: 'Meetings (90 days)', align: 'right' }, '']}
        empty={!rows.length} emptyLabel="No subjects yet.">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{r.name}</Td>
            <Td>{r.head ?? <span className="text-muted-foreground">No head</span>}</Td>
            <Td className="num">{r.teachers}</Td>
            <Td className="num">{r.avg === null ? '—' : <Badge tone={r.avg >= 75 ? 'success' : r.avg >= 50 ? 'warning' : 'danger'}>{r.avg}%</Badge>}</Td>
            <Td>{r.units ? <>{r.done}/{r.units} chapters{r.due > r.done ? <Badge tone="danger"> {r.due - r.done} behind</Badge> : null}</> : <span className="text-muted-foreground">No syllabus</span>}</Td>
            <Td className="num">{r.plans_waiting}</Td>
            <Td className="num">{r.meetings}</Td>
            <Td><Button size="sm" variant="ghost" onClick={() => onOpen(r.id)}>Open</Button></Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
