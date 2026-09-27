import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Checkbox, SkeletonTable, ErrorState,
} from '@/components/ui'

/* Targeted announcements (seller/announcements.ts): all schools, a group, a
   plan, or chosen schools; admins, staff and/or parents; a window; and how
   many of the schools reached have opened it. */

type Kind = 'all' | 'group' | 'plan' | 'schools'
type Audience = 'admins' | 'staff' | 'parents'
interface Announcement {
  id: string; severity: string; title: string; body: string; starts_at: string; ends_at: string | null
  status: 'live' | 'scheduled' | 'ended' | 'retired'; target: { kind: Kind; ids: string[] }; audiences: Audience[]
  reach_schools: number; seen_schools: number; seen_users: number; dismissed_users: number; read_rate: number
}
interface School { id: string; name: string; plan: string; group_id: string | null }
interface Reads { id: string; name: string; seen_users: number; dismissed_users: number; last_seen: string | null }
interface Form { severity: string; title: string; body: string; starts_at: string; ends_at: string; kind: Kind; ids: string[]; audiences: Audience[] }

const KEY = ['seller-announcements']
const BLANK: Form = { severity: 'info', title: '', body: '', starts_at: '', ends_at: '', kind: 'all', ids: [], audiences: ['admins', 'staff', 'parents'] }
const TONE = { live: 'success', scheduled: 'info', ended: 'neutral', retired: 'neutral' } as const
const local = (iso: string | null) => (iso ? iso.slice(0, 16) : '')

export function Announcements() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<List<Announcement> & { schools: School[] }>('/api/v1/seller/announcements') })
  const groups = useQuery({ queryKey: ['seller-school-groups'], queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/seller/school-groups') })
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [readsOf, setReadsOf] = useState<string | null>(null)
  const reads = useQuery({
    queryKey: [...KEY, 'reads', readsOf],
    enabled: !!readsOf,
    queryFn: () => api.get<List<Reads>>(`/api/v1/seller/announcements/${readsOf}/reads`),
  })
  const done = () => { setForm(null); setEditing(null); qc.invalidateQueries({ queryKey: KEY }) }
  const save = useMutation({
    mutationFn: () => {
      const f = form!
      const body = {
        severity: f.severity, title: f.title, body: f.body,
        starts_at: f.starts_at ? new Date(f.starts_at).toISOString() : '', ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : '',
        target: { kind: f.kind, ids: f.ids }, audiences: f.audiences,
      }
      return editing ? api.put(`/api/v1/seller/announcements/${editing}`, body) : api.post('/api/v1/seller/announcements', body)
    },
    onSuccess: done,
  })
  const retire = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/seller/announcements/${id}/retire`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })

  const schools = q.data?.schools ?? []
  const plans = [...new Set(schools.map((s) => s.plan).filter(Boolean))]
  const choices: { value: string; label: string }[] =
    form?.kind === 'group' ? (groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))
    : form?.kind === 'plan' ? plans.map((p) => ({ value: p, label: p }))
    : form?.kind === 'schools' ? schools.map((s) => ({ value: s.id, label: s.name })) : []
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return (
    <Card>
      <CardHeader
        title="Announcements"
        description="Targeted by school, group or plan and by audience, with who has read them"
        action={!form && <Button onClick={() => { setEditing(null); setForm(BLANK) }}>New announcement</Button>}
      />
      {form && (
        <div className="space-y-4 border-b px-5 py-5">
          {save.isError && <FormNotice error={save.error} />}
          <FormGrid>
            <Field label="Severity" required>
              <Select value={form.severity} onChange={(v) => setForm({ ...form, severity: v })}
                options={[{ value: 'info', label: 'Info' }, { value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Critical' }]} />
            </Field>
            <Field label="Title" required>
              <Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
            </Field>
            <Field label="From" hint="Blank shows it now.">
              <Input type="datetime-local" value={form.starts_at} onChange={(v) => setForm({ ...form, starts_at: v })} />
            </Field>
            <Field label="Until" hint="Blank keeps it up until retired.">
              <Input type="datetime-local" value={form.ends_at} onChange={(v) => setForm({ ...form, ends_at: v })} />
            </Field>
            <Field label="Send to" required>
              <Select value={form.kind} onChange={(v) => setForm({ ...form, kind: v as Kind, ids: [] })}
                options={[{ value: 'all', label: 'Every school' }, { value: 'group', label: 'A school group' },
                  { value: 'plan', label: 'A plan tier' }, { value: 'schools', label: 'Chosen schools' }]} />
            </Field>
            <Field label="Audience" required>
              <div className="flex flex-wrap gap-4">
                {(['admins', 'staff', 'parents'] as Audience[]).map((a) => (
                  <Checkbox key={a} label={a === 'admins' ? 'School admins' : a === 'staff' ? 'All staff' : 'Parents'}
                    checked={form.audiences.includes(a)} onChange={() => setForm({ ...form, audiences: toggle(form.audiences, a) })} />
                ))}
              </div>
            </Field>
            {form.kind !== 'all' && (
              <Field label="Which" wide>
                <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-2 overflow-y-auto">
                  {choices.map((o) => (
                    <Checkbox key={o.value} label={o.label} checked={form.ids.includes(o.value)}
                      onChange={() => setForm({ ...form, ids: toggle(form.ids, o.value) })} />
                  ))}
                </div>
              </Field>
            )}
            <Field label="Detail" wide>
              <Textarea value={form.body} onChange={(v) => setForm({ ...form, body: v })} rows={3} />
            </Field>
          </FormGrid>
          <div className="flex gap-2">
            <Button onClick={() => save.mutate()} disabled={!form.title.trim() || save.isPending}>
              {editing ? 'Save' : 'Publish'}
            </Button>
            <Button variant="secondary" onClick={() => { setForm(null); setEditing(null) }}>Cancel</Button>
          </div>
        </div>
      )}
      {q.isLoading ? <SkeletonTable columns={6} /> : q.error ? <ErrorState error={q.error} /> : (
        <Table head={['', 'Announcement', 'To', 'Window', 'Read', '']} empty={(q.data?.items ?? []).length === 0}
          emptyLabel="No announcement yet.">
          {(q.data?.items ?? []).map((a) => (
            <tr key={a.id}>
              <Td><Badge tone={TONE[a.status]}>{a.status}</Badge> <Badge tone={a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warning' : 'info'}>{a.severity}</Badge></Td>
              <Td>{a.title}</Td>
              <Td>{a.target.kind === 'all' ? 'Every school' : `${a.target.kind}: ${a.target.ids.length}`} · {a.audiences.join(', ')}</Td>
              <Td>{local(a.starts_at).replace('T', ' ')}{a.ends_at ? ' – ' + local(a.ends_at).replace('T', ' ') : ''}</Td>
              <Td>
                <button type="button" className="underline" onClick={() => setReadsOf(readsOf === a.id ? null : a.id)}>
                  {a.seen_schools}/{a.reach_schools} schools ({a.read_rate}%)
                </button>
                <div className="text-[12px] text-muted-foreground">{a.seen_users} seen · {a.dismissed_users} dismissed</div>
              </Td>
              <Td>
                {a.status !== 'retired' && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => {
                      setEditing(a.id)
                      setForm({ severity: a.severity, title: a.title, body: a.body, starts_at: local(a.starts_at), ends_at: local(a.ends_at),
                        kind: a.target.kind, ids: a.target.ids, audiences: a.audiences })
                    }}>Edit</Button>
                    <ConfirmButton confirmLabel="Retire" question="Take this announcement down everywhere?" onConfirm={() => retire.mutate(a.id)}>
                      Retire
                    </ConfirmButton>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {readsOf && (
        <div className="border-t px-5 py-4">
          <Table head={['School', 'Seen by', 'Dismissed by', 'Last seen']} empty={(reads.data?.items ?? []).length === 0} loading={reads.isLoading}>
            {(reads.data?.items ?? []).map((s) => (
              <tr key={s.id}><Td>{s.name}</Td><Td>{s.seen_users}</Td><Td>{s.dismissed_users}</Td><Td>{s.last_seen ? local(s.last_seen).replace('T', ' ') : '—'}</Td></tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  )
}
