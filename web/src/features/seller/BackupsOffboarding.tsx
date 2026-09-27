import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Input, Field, FormGrid, FormNotice,
  ErrorState, SkeletonTable,
} from '@/components/ui'
import { TypedConfirm, bytes, stamp } from './BackupsShared'

interface LifecycleView {
  institution_id: string
  school: string
  slug: string
  status: string
  state: string
  read_only_days: number
  leaving_at: string | null
  export_id: string | null
  read_only_until: string | null
  archived_at: string | null
  delete_requested_at: string | null
  deleted_at: string | null
}
interface ExportRow {
  id: string
  purpose: string
  status: string
  size_bytes: number
  tables: number
  row_count: number
  files: number
  error: string | null
  requested_by_name: string | null
  created_at: string
  expires_at: string | null
  download_url: string | null
}
interface Detail extends LifecycleView {
  events: { id: string; step: string; detail: string | null; actor_name: string | null; at: string }[]
  exports: ExportRow[]
  live: boolean
}

const STATE_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  active: 'success', leaving: 'info', read_only: 'warning', archived: 'neutral', delete_pending: 'danger', deleted: 'danger',
}

/**
 * A school leaving the platform, one logged step at a time:
 * leaving (export queued) → read-only (writes refused, the app says why) →
 * archived (nobody signs in, the database is kept) → deleted, only after a
 * second confirmation. Any step before deletion can be cancelled.
 */
export default function BackupsOffboarding() {
  const list = useQuery({ queryKey: ['seller', 'lifecycle'], queryFn: () => api.get<{ items: LifecycleView[] }>('/api/v1/seller/lifecycle') })
  const [selected, setSelected] = useState<string | null>(null)
  if (list.isLoading) return <SkeletonTable columns={4} />
  if (list.error) return <ErrorState error={list.error} />
  const items = list.data?.items ?? []
  return (
    <>
      <PageHead eyebrow="Schools" title="Off-boarding" description="Exports, the read-only period, archiving and deletion of a school that is leaving." />
      <PageBody>
        <Card>
          <CardHeader title="Schools" />
          <Table head={['School', 'State', 'Read-only until', '']} empty={items.length === 0}>
            {items.map((s) => (
              <tr key={s.institution_id}>
                <Td className="font-medium">{s.school}</Td>
                <Td><Badge tone={STATE_TONE[s.state] ?? 'neutral'}>{s.state.replace('_', ' ')}</Badge></Td>
                <Td className="num">{s.read_only_until?.slice(0, 10) ?? '-'}</Td>
                <Td>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(selected === s.institution_id ? null : s.institution_id)}>
                    {selected === s.institution_id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        {selected && <SchoolLifecycle key={selected} id={selected} />}
      </PageBody>
    </>
  )
}

function SchoolLifecycle({ id }: { id: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['seller', 'lifecycle', id], queryFn: () => api.get<Detail>(`/api/v1/seller/tenants/${id}/lifecycle`) })
  const [days, setDays] = useState('30')
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState<null | 'archive' | 'delete-request' | 'delete-confirm'>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['seller', 'lifecycle'] })
    qc.invalidateQueries({ queryKey: ['seller', 'backups'] })
  }
  const step = useMutation({
    mutationFn: ({ s, body }: { s: string; body: Record<string, unknown> }) => api.post(`/api/v1/seller/tenants/${id}/lifecycle/${s}`, body),
    onSuccess: () => { setConfirm(null); refresh() },
  })
  const exportNow = useMutation({ mutationFn: () => api.post(`/api/v1/seller/tenants/${id}/exports`), onSuccess: refresh })

  if (q.isLoading) return <SkeletonTable columns={4} />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data!
  const offExport = d.exports.find((e) => e.id === d.export_id)
  const readOnlyOver = !d.read_only_until || d.read_only_until < new Date().toISOString()

  return (
    <>
      <Card>
        <CardHeader title={`${d.school}: ${d.state.replace('_', ' ')}`} action={!d.live ? <Badge tone="warning">database deletion is a dry run</Badge> : undefined} />
        <div className="grid gap-4 px-5 py-4">
          {d.state === 'active' && (
            <>
              <FormGrid>
                <Field label="Read-only period (days)"><Input type="number" value={days} onChange={setDays} /></Field>
                <Field label="Note" wide><Input value={note} onChange={setNote} placeholder="Contract end date, who asked" /></Field>
              </FormGrid>
              <div><Button pending={step.isPending} onClick={() => step.mutate({ s: 'leaving', body: { read_only_days: Number(days), note } })}>Mark as leaving and export</Button></div>
            </>
          )}
          {d.state === 'leaving' && (
            <div className="grid gap-2">
              <p className="text-[14px]">Export: {offExport ? <Badge tone={offExport.status === 'ready' ? 'success' : 'info'}>{offExport.status}</Badge> : '-'}</p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={offExport?.status !== 'ready'} pending={step.isPending} onClick={() => step.mutate({ s: 'read-only', body: { read_only_days: d.read_only_days } })}>
                  Start the {d.read_only_days}-day read-only period
                </Button>
                <Button variant="ghost" onClick={() => q.refetch()}>Refresh</Button>
              </div>
            </div>
          )}
          {d.state === 'read_only' && (confirm === 'archive' ? (
            <TypedConfirm name={d.school} label="Archive" pending={step.isPending} error={step.error}
              question={`Archive ${d.school}? Every session ends, nobody can sign in, and it drops out of every schedule. The database is kept.`}
              onConfirm={(n) => step.mutate({ s: 'archive', body: { confirm_name: n, force: !readOnlyOver } })} onCancel={() => setConfirm(null)} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px]">Read-only until {d.read_only_until?.slice(0, 10)}.</span>
              <Button tone="danger" onClick={() => setConfirm('archive')}>{readOnlyOver ? 'Archive' : 'Archive early'}</Button>
            </div>
          ))}
          {d.state === 'archived' && (confirm === 'delete-request' ? (
            <TypedConfirm name={d.school} label="Ask to delete" pending={step.isPending} error={step.error}
              question={`Start deleting ${d.school}? A second confirmation is needed before anything is removed.`}
              onConfirm={(n) => step.mutate({ s: 'delete-request', body: { confirm_name: n } })} onCancel={() => setConfirm(null)} />
          ) : (
            <div><Button tone="danger" onClick={() => setConfirm('delete-request')}>Delete…</Button></div>
          ))}
          {d.state === 'delete_pending' && (confirm === 'delete-confirm' ? (
            <TypedConfirm name={d.school} phrase={`DELETE ${d.slug}`} label="Delete the database" pending={step.isPending} error={step.error}
              question={`Permanently delete the database of ${d.school}? Only the backups remain.`}
              onConfirm={(n, p) => step.mutate({ s: 'delete-confirm', body: { confirm_name: n, confirm_phrase: p } })} onCancel={() => setConfirm(null)} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px]">Deletion requested {stamp(d.delete_requested_at)}.</span>
              <Button tone="danger" onClick={() => setConfirm('delete-confirm')}>Confirm deletion…</Button>
            </div>
          ))}
          {['leaving', 'read_only', 'archived', 'delete_pending'].includes(d.state) && !confirm && (
            <div><Button variant="ghost" pending={step.isPending} onClick={() => step.mutate({ s: 'cancel', body: {} })}>Cancel off-boarding (back to active)</Button></div>
          )}
          {step.error && !confirm ? <FormNotice error={step.error} /> : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Exports" action={<Button size="sm" variant="secondary" pending={exportNow.isPending} onClick={() => exportNow.mutate()}>Export now</Button>} />
        <Table head={['Asked', 'By', 'Status', 'Tables', 'Rows', 'Files', 'Size', 'Expires', '']} empty={d.exports.length === 0} emptyLabel="No export yet.">
          {d.exports.map((e) => (
            <tr key={e.id}>
              <Td className="num whitespace-nowrap">{stamp(e.created_at)}</Td>
              <Td>{e.requested_by_name ?? '-'}</Td>
              <Td><Badge tone={e.status === 'ready' ? 'success' : e.status === 'failed' ? 'danger' : 'neutral'}>{e.status}</Badge></Td>
              <Td className="num">{e.tables}</Td>
              <Td className="num">{e.row_count.toLocaleString()}</Td>
              <Td className="num">{e.files}</Td>
              <Td className="num">{bytes(e.size_bytes)}</Td>
              <Td className="num">{e.expires_at?.slice(0, 10) ?? '-'}</Td>
              <Td>{e.download_url && <a className="text-primary hover:underline" href={e.download_url}>Download</a>}</Td>
            </tr>
          ))}
        </Table>
        {exportNow.error ? <div className="border-t px-5 py-3"><FormNotice error={exportNow.error} /></div> : null}
      </Card>

      <Card>
        <CardHeader title="Steps taken" />
        <Table head={['When', 'Step', 'By', 'Detail']} empty={d.events.length === 0} emptyLabel="Nothing yet.">
          {d.events.map((e) => (
            <tr key={e.id}>
              <Td className="num whitespace-nowrap">{stamp(e.at)}</Td>
              <Td className="font-mono text-[12px]">{e.step}</Td>
              <Td>{e.actor_name ?? '-'}</Td>
              <Td className="font-mono text-[12px] break-all text-muted-foreground">{e.detail ?? ''}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}
