import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, CellGrid, Checkbox, Dialog, ErrorState, Field, FormNotice, Input, Loading, Stat, Table, Td, Textarea, SEG_BAR, segClass } from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'
import { buzz } from '@/lib/haptics'

/* Known issues and help reports at the desk (worker/src/routes/help/incidents.ts). */

interface Incident { id: string; title: string; workaround: string; routes: string[]; categories: string[]; institution_ids: string[]; status: string; linked: number; created_at: string; created_by_name: string | null; broadcast_id: string | null; resolved_at: string | null }

const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)

export function KnownIssues() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const q = useQuery({ queryKey: ['incidents'], queryFn: () => api.get<{ items: Incident[] }>('/api/v1/admin/platform/incidents') })
  const resolve = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/platform/incidents/${id}/resolve`), onSuccess: () => { buzz('tap'); qc.invalidateQueries({ queryKey: ['incidents'] }) } })
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => setAdding(true)}>Mark a known issue</Button></div>
      {q.error ? <ErrorState error={q.error} /> : !q.data ? <Loading /> : q.data.items.length === 0 ? (
        <Card className="px-4 py-6 text-center text-[14px] text-muted-foreground">No known issues. Mark one when several schools report the same fault.</Card>
      ) : (
        <Card>
          <ul className="divide-y">
            {q.data.items.map((i) => (
              <li key={i.id} className="space-y-1 px-[var(--card-pad)] py-3 text-[14px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto font-semibold">{i.title}</span>
                  <Badge tone={i.status === 'open' ? 'warning' : 'success'}>{i.status === 'open' ? 'Open' : 'Fixed'}</Badge>
                  {i.broadcast_id && <Badge>Banner</Badge>}
                </div>
                <p>{i.workaround}</p>
                <p className="text-[12px] text-muted-foreground">
                  {[...i.routes, ...i.categories].join(', ')} · {i.institution_ids.length ? `${i.institution_ids.length} school(s)` : 'every school'} · {i.linked} request(s) linked · {i.created_by_name} on {formatDate(i.created_at)}
                </p>
                {i.status === 'open' && <Button size="sm" variant="secondary" pending={resolve.isPending} onClick={() => resolve.mutate(i.id)}>Mark fixed</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <FormNotice error={resolve.error} />
      {adding && <IssueForm onClose={() => setAdding(false)} />}
    </div>
  )
}

function IssueForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(''), [workaround, setWorkaround] = useState(''), [routes, setRoutes] = useState(''), [cats, setCats] = useState(''), [schools, setSchools] = useState('')
  const [banner, setBanner] = useState(true)
  const save = useMutation({
    mutationFn: () => api.post<{ linked: number }>('/api/v1/admin/platform/incidents', { title, workaround, routes: list(routes), categories: list(cats), institution_ids: list(schools), banner }),
    onSuccess: () => { buzz('tap'); qc.invalidateQueries({ queryKey: ['incidents'] }); onClose() },
  })
  return (
    <Dialog onClose={onClose} title="Mark a known issue" size="lg" description="Matching requests get the workaround at once, and new ones as they arrive."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!title.trim() || !workaround.trim()} pending={save.isPending} onClick={() => save.mutate()}>Mark it</Button></>}>
      <div className="space-y-4">
        <Field label="What is wrong" required><Input value={title} onChange={setTitle} placeholder="Fee receipts print blank" /></Field>
        <Field label="What to do until it is fixed" required><Textarea value={workaround} onChange={setWorkaround} rows={3} aria-label="Workaround" /></Field>
        <Field label="Screens it affects" hint="Addresses, separated by commas, for example /finance/collections. A screen under one counts too."><Input value={routes} onChange={setRoutes} /></Field>
        <Field label="Request topics it affects" hint="Topic keys, for example fees, sign_in."><Input value={cats} onChange={setCats} /></Field>
        <Field label="Schools" hint="School ids, separated by commas. Leave empty for every school."><Input value={schools} onChange={setSchools} /></Field>
        <Checkbox checked={banner} onChange={setBanner} label="Show a banner in the affected schools" hint="Through Announcements; it goes when you mark it fixed." />
        <FormNotice error={save.error} />
      </div>
    </Dialog>
  )
}

interface Report {
  days: number; schools: { school: string; institution_id: string; requests: number; reached_vendor: number; open: number }[]
  top_categories: { key: string; count: number }[]; top_routes: { key: string; count: number }[]
  first_reply_hours_median: number | null; resolve_hours_median: number | null
  satisfaction: { helpful: number; rated: number; percent: number } | null; deflection: { solved_in_school: number; raised: number; percent: number } | null
  error_spikes: { school: string | null; route: string; release: string; n: number; last_at: string }[]
}

export function HelpReports() {
  const [days, setDays] = useState(30)
  const q = useQuery({ queryKey: ['help-reports', days], queryFn: () => api.get<Report>(`/api/v1/admin/platform/help-reports?days=${days}`) })
  const r = q.data
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className={SEG_BAR} role="tablist" aria-label="Period">
          {[7, 30, 90].map((d) => <button key={d} type="button" role="tab" aria-selected={days === d} className={segClass(days === d)} onClick={() => setDays(d)}>{d} days</button>)}
        </div>
        <a className={cn('ml-auto text-[14px] font-medium text-primary')} href={`/api/v1/admin/platform/help-reports?days=${days}&format=csv`}>Download CSV</a>
      </div>
      {q.error ? <ErrorState error={q.error} /> : !r ? <Loading /> : (
        <>
          <CellGrid cols={4}>
            <Stat label="Requests" value={r.schools.reduce((a, s) => a + s.requests, 0)} detail={`In the last ${r.days} days, every school.`} />
            <Stat label="Answered in the school" value={r.deflection ? `${r.deflection.percent}%` : '-'} detail={r.deflection ? `${r.deflection.solved_in_school} of ${r.deflection.raised} from families and staff never reached XULO support.` : 'No requests from families or staff yet.'} />
            <Stat label="First reply, median" value={r.first_reply_hours_median === null ? '-' : `${r.first_reply_hours_median} h`} detail={r.resolve_hours_median === null ? 'Nothing answered yet.' : `Answered in ${r.resolve_hours_median} h, median.`} />
            <Stat label="It helped" value={r.satisfaction ? `${r.satisfaction.percent}%` : '-'} detail={r.satisfaction ? `${r.satisfaction.helpful} of ${r.satisfaction.rated} who answered.` : 'Nobody has rated an answer yet.'} />
          </CellGrid>
          <Card>
            <CardHeader title="By school" />
            <Table head={['School', 'Requests', 'Reached XULO support', 'Still open']} empty={!r.schools.length} emptyLabel="No schools.">
              {r.schools.map((s) => <tr key={s.institution_id}><Td className="font-medium">{s.school}</Td><Td className="num">{s.requests}</Td><Td className="num">{s.reached_vendor}</Td><Td className="num">{s.open}</Td></tr>)}
            </Table>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader title="Top topics" /><ul className="divide-y text-[14px]">{r.top_categories.map((x) => <li key={x.key} className="flex justify-between px-[var(--card-pad)] py-2"><span>{x.key.replace(/_/g, ' ')}</span><span className="tabular-nums">{x.count}</span></li>)}</ul></Card>
            <Card><CardHeader title="Top screens" /><ul className="divide-y text-[14px]">{r.top_routes.map((x) => <li key={x.key} className="flex justify-between gap-3 px-[var(--card-pad)] py-2"><span className="min-w-0 truncate">{x.key}</span><span className="tabular-nums">{x.count}</span></li>)}</ul></Card>
          </div>
          <Card>
            <CardHeader title="Errors by school, screen and release" />
            <Table head={['School', 'Screen', 'Release', 'Errors', 'Last']} empty={!r.error_spikes.length} emptyLabel="No unexpected errors in this period (they are kept 14 days).">
              {r.error_spikes.map((e, i) => <tr key={i}><Td>{e.school ?? 'No school'}</Td><Td className="max-w-[24ch] truncate">{e.route}</Td><Td>{e.release}</Td><Td className="num">{e.n}</Td><Td>{formatDate(e.last_at)}</Td></tr>)}
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}
