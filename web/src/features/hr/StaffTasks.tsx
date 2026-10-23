import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Input, Textarea, Button, Select, Field, FormGrid,
  Loading, ErrorState, FormNotice, Badge, TAB_BAR, tabClass,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate, cn } from '@/lib/utils'

/* Office work handed to a member of staff.

   Two doors, one screen. HR's door (hr.tasks.staff_tasks) shows every task,
   the per-person report and who reports to whom. A teacher's door
   (faculty.my_profile.my_tasks) shows their own and their team's. The route
   says which; the server narrows regardless of what the screen asks. */

interface Task {
  id: string; title: string; detail?: string; due_on?: string; priority: string; status: string
  done_note?: string; done_at?: string; created_at: string
  employee_id: string; assigned_to: string; employee_code: string; assigned_by?: string; overdue: boolean
}
interface Staff { id: string; full_name: string; employee_code: string }

const STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' }
const PRIORITY: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High' }

export default function StaffTasks() {
  const selfService = useLocation().pathname.includes('/my_profile/')
  const hr = useCan()('hr.employees.read') && !selfService
  const [tab, setTab] = useState<'tasks' | 'report' | 'managers'>('tasks')
  return (
    <>
      <PageHead eyebrow={selfService ? 'My work' : 'People'} title={selfService ? 'My tasks' : 'Staff tasks'} />
      <PageBody>
        {hr && (
          <div className={cn(TAB_BAR, 'mb-4')}>
            {([['tasks', 'Tasks'], ['report', 'Report'], ['managers', 'Reporting managers']] as const).map(([k, label]) => (
              <button key={k} type="button" className={tabClass(tab === k)} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
        )}
        {(!hr || tab === 'tasks') && <Tasks hr={hr} />}
        {hr && tab === 'report' && <Report />}
        {hr && tab === 'managers' && <ReportingManagers />}
      </PageBody>
    </>
  )
}

function Tasks({ hr }: { hr: boolean }) {
  const qc = useQueryClient()
  const [scope, setScope] = useState<'mine' | 'team' | 'all'>(hr ? 'all' : 'mine')
  const [status, setStatus] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: '', detail: '', assigned_to: '', due_on: '', priority: 'normal' })
  const [notes, setNotes] = useState<Record<string, string>>({})

  const q = useQuery({
    queryKey: ['staff-tasks', scope, status],
    queryFn: () => api.get<{ items: Task[]; summary: { open: number; overdue: number; done: number } }>(
      `/api/v1/hr/tasks?for=${scope}${status ? `&status=${status}` : ''}`),
  })
  /* HR may hand a task to anyone on the roll; a manager only to their own
     people, which the server enforces. The list offered is the roll either
     way; a wrong pick is refused with the reason. */
  const staff = useQuery({
    queryKey: ['work-pattern-staff'],
    queryFn: () => api.get<{ items: Staff[] }>('/api/v1/setup/work-patterns/staff'),
    enabled: adding,
  })
  const add = useMutation({
    mutationFn: () => api.post('/api/v1/hr/tasks', { ...form, detail: form.detail || undefined, due_on: form.due_on || undefined }),
    onSuccess: () => {
      setForm({ title: '', detail: '', assigned_to: '', due_on: '', priority: 'normal' })
      setAdding(false)
      qc.invalidateQueries({ queryKey: ['staff-tasks'] })
    },
  })
  const move = useMutation({
    mutationFn: (v: { id: string; status: string }) => api.post(`/api/v1/hr/tasks/${v.id}/status`, { status: v.status, note: notes[v.id] || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff-tasks'] }),
  })

  const items = q.data?.items ?? []
  const s = q.data?.summary ?? { open: 0, overdue: 0, done: 0 }
  return (
    <div className="space-y-4">
      <CellGrid cols={3}>
        <Stat label="Open" value={s.open} onClick={() => setStatus(status === 'open' ? '' : 'open')} active={status === 'open'} />
        <Stat label="Overdue" value={s.overdue} />
        <Stat label="Done" value={s.done} onClick={() => setStatus(status === 'done' ? '' : 'done')} active={status === 'done'} />
      </CellGrid>
      <Card>
        <CardHeader
          title="Hand somebody a job"
          action={<Button variant={adding ? 'secondary' : 'primary'} onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'New task'}</Button>}
        />
        {adding && (
          <div className="px-5 pb-5">
            <FormGrid>
              <Field label="What" required>
                <Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="Count the chairs in every classroom" />
              </Field>
              <Field label="Who" required>
                <Select value={form.assigned_to} onChange={(v) => setForm({ ...form, assigned_to: v })} placeholder="Choose"
                  options={(staff.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name || e.employee_code }))} />
              </Field>
              <Field label="By when">
                <Input type="date" value={form.due_on} onChange={(v) => setForm({ ...form, due_on: v })} />
              </Field>
              <Field label="Priority">
                <Select value={form.priority} onChange={(v) => setForm({ ...form, priority: v })}
                  options={Object.entries(PRIORITY).map(([value, label]) => ({ value, label }))} />
              </Field>
            </FormGrid>
            <Field label="Detail">
              <Textarea value={form.detail} onChange={(v) => setForm({ ...form, detail: v })} placeholder="Anything they need to know to do it" />
            </Field>
            <FormNotice error={add.error} />
            <Button className="mt-3" disabled={!form.title.trim() || !form.assigned_to || add.isPending} onClick={() => add.mutate()}>
              {add.isPending ? 'Sending…' : 'Hand it over'}
            </Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Tasks"
          action={
            <div className="flex flex-wrap gap-2">
              <Select value={scope} onChange={(v) => setScope(v as 'mine' | 'team' | 'all')}
                options={[{ value: 'mine', label: 'Mine' }, { value: 'team', label: 'My team' }, ...(hr ? [{ value: 'all', label: 'Everyone' }] : [])]} />
              <Select value={status} onChange={setStatus}
                options={[{ value: '', label: 'Any status' }, ...Object.entries(STATUS).map(([value, label]) => ({ value, label }))]} />
            </div>
          }
        />
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
          <Table head={['Task', 'Who', 'Due', 'Priority', 'Status', '']} empty={!items.length} emptyLabel="No tasks here.">
            {items.map((t) => {
              const live = t.status === 'open' || t.status === 'in_progress'
              return (
                <tr key={t.id}>
                  <Td className="font-medium">
                    {t.title}
                    {t.detail && <span className="block max-w-[40ch] truncate text-[12px] font-normal text-muted-foreground" title={t.detail}>{t.detail}</span>}
                    {t.assigned_by && <span className="block text-[11.5px] font-normal text-muted-foreground">from {t.assigned_by}</span>}
                  </Td>
                  <Td>{t.assigned_to}<span className="block font-mono text-[11.5px] text-muted-foreground">{t.employee_code}</span></Td>
                  <Td className={cn('text-muted-foreground', t.overdue && 'text-destructive')}>{t.due_on ? formatDate(t.due_on) : '-'}{t.overdue && <span className="block text-[11.5px]">overdue</span>}</Td>
                  <Td>{t.priority === 'high' ? <Badge tone="warning">High</Badge> : <span className="text-muted-foreground">{PRIORITY[t.priority] ?? t.priority}</span>}</Td>
                  <Td>
                    {STATUS[t.status] ?? t.status}
                    {t.done_note && <span className="block max-w-[28ch] text-[11.5px] text-muted-foreground">“{t.done_note}”</span>}
                    {t.done_at && <span className="block text-[11.5px] text-muted-foreground">{formatDate(t.done_at)}</span>}
                  </Td>
                  <Td>
                    {live && (
                      <span className="flex flex-wrap items-center gap-2">
                        <Input className="w-40" value={notes[t.id] ?? ''} onChange={(v) => setNotes({ ...notes, [t.id]: v })} placeholder="Note" />
                        {t.status === 'open' && <Button size="sm" variant="secondary" disabled={move.isPending} onClick={() => move.mutate({ id: t.id, status: 'in_progress' })}>Start</Button>}
                        <Button size="sm" disabled={move.isPending} onClick={() => move.mutate({ id: t.id, status: 'done' })}>Done</Button>
                        {(hr || scope === 'team') && <Button size="sm" variant="ghost" tone="danger" disabled={move.isPending} onClick={() => move.mutate({ id: t.id, status: 'cancelled' })}>Cancel</Button>}
                      </span>
                    )}
                  </Td>
                </tr>
              )
            })}
          </Table>
        )}
        <div className="px-5 pb-4"><FormNotice error={move.error} /></div>
      </Card>
    </div>
  )
}

function Report() {
  interface Row { employee_id: string; full_name: string; employee_code: string; department?: string; open: number; overdue: number; done: number; next_due?: string }
  const q = useQuery({ queryKey: ['staff-tasks', 'report'], queryFn: () => api.get<{ items: Row[] }>('/api/v1/hr/tasks/report') })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <Card>
      <CardHeader title="Who has what" description="Most overdue first." />
      <Table head={['Person', 'Department', { label: 'Open', align: 'right' }, { label: 'Overdue', align: 'right' }, { label: 'Done', align: 'right' }, 'Next due']} empty={!rows.length} emptyLabel="No tasks have been handed out yet.">
        {rows.map((r) => (
          <tr key={r.employee_id}>
            <Td className="font-medium">{r.full_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.employee_code}</span></Td>
            <Td className="text-muted-foreground">{r.department ?? '-'}</Td>
            <Td className="text-right tabular-nums">{r.open}</Td>
            <Td className={cn('text-right tabular-nums', Number(r.overdue) > 0 && 'font-medium text-destructive')}>{r.overdue}</Td>
            <Td className="text-right tabular-nums">{r.done}</Td>
            <Td className="text-muted-foreground">{r.next_due ? formatDate(r.next_due) : '-'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function ReportingManagers() {
  interface Row { id: string; full_name: string; employee_code: string; department?: string; designation?: string; reports_to?: string; manager_name?: string; manager_code?: string; reports: number }
  const qc = useQueryClient()
  const [find, setFind] = useState('')
  const q = useQuery({ queryKey: ['reporting-managers'], queryFn: () => api.get<{ items: Row[] }>('/api/v1/hr/reporting-managers') })
  const set = useMutation({
    mutationFn: (v: { id: string; reports_to: string }) => api.put(`/api/v1/hr/employees/${v.id}/reporting-manager`, { reports_to: v.reports_to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reporting-managers'] }),
  })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const all = q.data?.items ?? []
  const needle = find.trim().toLowerCase()
  const rows = all.filter((r) => !needle || r.full_name.toLowerCase().includes(needle) || (r.department ?? '').toLowerCase().includes(needle))
  const options = [{ value: '', label: 'Nobody' }, ...all.map((e) => ({ value: e.id, label: `${e.full_name} (${e.employee_code})` }))]
  return (
    <Card>
      <CardHeader title="Who answers to whom" description="A leave request goes to the reporting manager first, then to HR." action={<Input className="w-56" value={find} onChange={setFind} placeholder="Find a person or department" />} />
      <Table head={['Person', 'Department', 'Reports to', { label: 'Team', align: 'right' }]} empty={!rows.length} emptyLabel="Nobody on the roll.">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{r.full_name}<span className="block text-[11.5px] font-normal text-muted-foreground">{r.employee_code}{r.designation ? ` · ${r.designation}` : ''}</span></Td>
            <Td className="text-muted-foreground">{r.department ?? '-'}</Td>
            <Td>
              <Select value={r.reports_to ?? ''} onChange={(v) => set.mutate({ id: r.id, reports_to: v })} options={options.filter((o) => o.value !== r.id)} />
            </Td>
            <Td className="text-right tabular-nums">{r.reports}</Td>
          </tr>
        ))}
      </Table>
      <div className="px-5 pb-4"><FormNotice error={set.error} /></div>
    </Card>
  )
}
