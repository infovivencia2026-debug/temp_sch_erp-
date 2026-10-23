import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Select, Input, Textarea, Field, FormNotice,
  ErrorState, EmptyState, SkeletonTiles, TAB_BAR, tabClass,
} from '@/components/ui'

/* Parent concerns at the front desk (owner, 2026-10-20): filter by class,
   section or student; send a concern to that class's class teacher or a
   subject teacher; see what the teacher resolved; tell the parent. */

interface Row {
  id: string; subject: string; body: string; created_at: string; status: string; resolution: string | null
  student: string | null; class_name: string | null; section_name: string | null; parent: string | null
  sent_to: string | null; assigned_to: string | null; teacher_note: string | null
}
interface Opts { sections: { id: string; name: string; class_id: string; class_name: string }[]; students: { id: string; name: string }[] }

const STATES = [
  { key: 'open', label: 'Open' }, { key: 'teacher_resolved', label: 'Resolved by teacher' },
  { key: 'resolved', label: 'Told the parent' }, { key: 'all', label: 'All' },
] as const
const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

export default function ParentConcerns() {
  const [state, setState] = useState<(typeof STATES)[number]['key']>('open')
  const [cls, setCls] = useState(''), [sec, setSec] = useState(''), [stu, setStu] = useState(''), [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('id'))
  const opts = useQuery({ queryKey: ['parent-concerns-opts'], queryFn: () => api.get<Opts>('/api/v1/comms/parent-concerns-desk/options') })
  const list = useQuery({
    queryKey: ['parent-concerns-desk', state, cls, sec, stu, q],
    queryFn: () => api.get<{ items: Row[] }>(`/api/v1/comms/parent-concerns-desk?state=${state}&class_id=${cls}&section_id=${sec}&student_id=${stu}&q=${encodeURIComponent(q.trim())}`),
  })
  const classes = [...new Map((opts.data?.sections ?? []).map((s) => [s.class_id, s.class_name])).entries()]
  const rows = list.data?.items ?? []
  const picked = rows.find((r) => r.id === open)
  return (
    <>
      <PageHead eyebrow="Communication" title="Parent concerns" />
      <PageBody>
        <div className={TAB_BAR} role="tablist">
          {STATES.map((s) => <button key={s.key} type="button" role="tab" aria-selected={state === s.key} className={tabClass(state === s.key)} onClick={() => setState(s.key)}>{s.label}</button>)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <div className="w-44"><Select value={cls} onChange={(v) => { setCls(v); setSec('') }} options={[{ value: '', label: 'All classes' }, ...classes.map(([id, name]) => ({ value: id, label: name }))]} /></div>
          <div className="w-44"><Select value={sec} onChange={setSec} options={[{ value: '', label: 'All sections' }, ...(opts.data?.sections ?? []).filter((s) => !cls || s.class_id === cls).map((s) => ({ value: s.id, label: `${s.class_name} ${s.name}` }))]} /></div>
          <div className="w-56"><Select value={stu} onChange={setStu} options={[{ value: '', label: 'All students' }, ...(opts.data?.students ?? []).map((s) => ({ value: s.id, label: s.name }))]} /></div>
          <div className="w-56"><Input value={q} onChange={setQ} placeholder="Search" /></div>
        </div>
        <div className="mt-4 space-y-4">
          {picked && <CaseCard row={picked} onClose={() => setOpen(null)} />}
          {list.isLoading ? <SkeletonTiles /> : list.error ? <ErrorState error={list.error} /> : !rows.length ? (
            <EmptyState title="Nothing here" body="Concerns parents send to the front desk appear here." />
          ) : (
            <Card>
              <Table head={['When', 'Student', 'Class', 'Concern', 'Sent to', 'Status']}>
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-accent/40" onClick={() => setOpen(r.id)}>
                    <Td className="whitespace-nowrap">{when(r.created_at)}</Td>
                    <Td>{r.student ?? '—'}{r.parent && <div className="text-[12.5px] text-muted-foreground">{r.parent}</div>}</Td>
                    <Td className="whitespace-nowrap">{r.class_name ? `${r.class_name} ${r.section_name ?? ''}` : '—'}</Td>
                    <Td><div className="font-medium">{r.subject}</div><div className="line-clamp-1 text-muted-foreground">{r.body}</div></Td>
                    <Td>{r.sent_to ?? '—'}</Td>
                    <Td>{['resolved', 'closed'].includes(r.status) ? <Badge tone="success">Told the parent</Badge> : r.teacher_note ? <Badge tone="warning">Resolved by teacher</Badge> : r.assigned_to ? <Badge>With teacher</Badge> : <Badge tone="danger">New</Badge>}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </div>
      </PageBody>
    </>
  )
}

function CaseCard({ row, onClose }: { row: Row; onClose: () => void }) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['parent-concerns-desk'] })
  const teachers = useQuery({
    queryKey: ['parent-concern-teachers', row.id],
    queryFn: () => api.get<{ items: { user_id: string; full_name: string; role: string }[] }>(`/api/v1/comms/parent-concerns-desk/${row.id}/teachers`),
  })
  const [to, setTo] = useState(''), [note, setNote] = useState('')
  const [msg, setMsg] = useState(row.teacher_note ?? '')
  const send = useMutation({ mutationFn: () => api.post(`/api/v1/comms/parent-concerns-desk/${row.id}/send`, { user_id: to, note }), onSuccess: () => { setNote(''); done() } })
  const tell = useMutation({ mutationFn: () => api.post(`/api/v1/comms/parent-concerns-desk/${row.id}/tell-parent`, { message: msg }), onSuccess: () => { done(); onClose() } })
  const settled = ['resolved', 'closed'].includes(row.status)
  return (
    <Card>
      <CardHeader title={row.subject} action={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>} />
      <div className="space-y-4 p-[var(--card-pad)] text-[14px]">
        <div className="text-muted-foreground">{row.student ?? 'No student'}{row.class_name ? ` · ${row.class_name} ${row.section_name ?? ''}` : ''}{row.parent ? ` · from ${row.parent}` : ''} · {when(row.created_at)}</div>
        <div className="whitespace-pre-wrap">{row.body}</div>
        {row.teacher_note && <div className="rounded-md bg-muted p-3"><span className="font-medium">{row.sent_to ?? 'Teacher'} resolved it: </span>{row.teacher_note}</div>}
        {settled ? (
          <div className="rounded-md bg-muted p-3"><span className="font-medium">Told the parent: </span>{row.resolution}</div>
        ) : (
          <>
            <Field label="Send to a teacher of this class">
              <div className="flex flex-wrap gap-2">
                <div className="w-72"><Select value={to} onChange={setTo} placeholder={teachers.data && !teachers.data.items.length ? 'No teachers found for this class' : 'Class teacher or subject teacher'}
                  options={(teachers.data?.items ?? []).map((t) => ({ value: t.user_id, label: `${t.full_name} · ${t.role}` }))} /></div>
              </div>
            </Field>
            <Field label="Note for the teacher"><Input value={note} onChange={setNote} placeholder="Optional" /></Field>
            <Button disabled={!to || send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : 'Send to teacher'}</Button>
            <FormNotice error={send.error} ok={send.isSuccess ? 'Sent.' : undefined} />
            <div className="space-y-2 border-t pt-4">
              <Field label="Tell the parent"><Textarea value={msg} onChange={setMsg} placeholder="What was done" /></Field>
              <Button disabled={!msg.trim() || tell.isPending} onClick={() => tell.mutate()}>{tell.isPending ? 'Sending…' : 'Send to parent: resolved'}</Button>
              <FormNotice error={tell.error} />
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
