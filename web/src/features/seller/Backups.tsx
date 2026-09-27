import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button, Input, Field,
  FormGrid, FormNotice, ErrorState, SkeletonTable, TAB_BAR, tabClass,
} from '@/components/ui'
import InstanceHealth from './InstanceHealth'
import BackupsOffboarding from './BackupsOffboarding'
import { TypedConfirm, bytes, stamp } from './BackupsShared'

interface FleetRow {
  institution_id: string
  school: string
  slug: string
  status: string
  last_good_at: string | null
  last_size_bytes: number | null
  kept: number
  failed_7d: number
  lifecycle: string
  stale: boolean
}
interface Fleet {
  items: FleetRow[]
  control: { last_good_at: string | null; kept: number; stale: boolean }
  retention: { daily: number; monthly: number }
  restore_live: boolean
}
interface BackupRow {
  id: string
  kind: string
  backup_date: string
  status: string
  tables: number
  row_count: number
  size_bytes: number
  sha256: string | null
  error: string | null
  started_at: string
  finished_at: string | null
  download_url: string | null
}
interface RestoreRow {
  id: string
  target_timestamp: string | null
  target_bookmark: string | null
  pre_bookmark: string | null
  result_bookmark: string | null
  undoes_restore_id: string | null
  status: string
  error: string | null
  reason: string | null
  actor_name: string | null
  created_at: string
}
interface RestoreResult { id: string; status: string; dry_run?: { would_call: { method: string; url: string }[]; note: string } }

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  succeeded: 'success', failed: 'danger', running: 'info', pruned: 'neutral', replaced: 'neutral', dry_run: 'warning',
}

/**
 * Usage & Health → Instance health, with the backups beside it: the
 * nightly dumps of every school, restore to a point in time, and the
 * off-boarding of a school that is leaving.
 */
export default function BackupsScreen() {
  const [tab, setTab] = useState<'health' | 'backups' | 'offboarding'>('health')
  return (
    <>
      <div className="px-5 pt-5 sm:px-7">
        <div className={TAB_BAR} role="tablist">
          <button role="tab" aria-selected={tab === 'health'} className={tabClass(tab === 'health')} onClick={() => setTab('health')}>Health</button>
          <button role="tab" aria-selected={tab === 'backups'} className={tabClass(tab === 'backups')} onClick={() => setTab('backups')}>Backups & restore</button>
          <button role="tab" aria-selected={tab === 'offboarding'} className={tabClass(tab === 'offboarding')} onClick={() => setTab('offboarding')}>Off-boarding</button>
        </div>
      </div>
      {tab === 'health' && <InstanceHealth />}
      {tab === 'backups' && <BackupsFleet />}
      {tab === 'offboarding' && <BackupsOffboarding />}
    </>
  )
}

function BackupsFleet() {
  const qc = useQueryClient()
  const fleet = useQuery({ queryKey: ['seller', 'backups', 'fleet'], queryFn: () => api.get<Fleet>('/api/v1/seller/backups/fleet') })
  const [selected, setSelected] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: (body: { institution_id?: string; scope?: string }) => api.post('/api/v1/seller/backups/run', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['seller', 'backups'] }),
  })

  if (fleet.isLoading) return <SkeletonTable columns={6} />
  if (fleet.error) return <ErrorState error={fleet.error} />
  const d = fleet.data!
  const stale = d.items.filter((r) => r.stale)
  const school = d.items.find((r) => r.institution_id === selected) ?? null

  return (
    <>
      <PageHead eyebrow="Usage & Health" title="Backups" description="Nightly SQL dumps of every school and of the platform database, kept 30 days daily and 12 months monthly." />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Schools" value={d.items.length} />
          <Stat label="No backup in 36 hours" value={stale.length} />
          <Stat label="Platform database" value={d.control.stale ? 'Stale' : 'Current'} hint={`Last ${stamp(d.control.last_good_at)}, ${d.control.kept} kept`} />
          <Stat label="Restores" value={d.restore_live ? 'Live' : 'Dry run'} hint={d.restore_live ? 'Calls the Cloudflare API' : 'CF_API_TOKEN, CF_ACCOUNT_ID and D1_ADMIN_LIVE not set'} />
        </CellGrid>
        <Card>
          <CardHeader
            title="Every school"
            action={<Button size="sm" variant="secondary" pending={run.isPending} onClick={() => run.mutate({ scope: 'control' })}>Back up platform database now</Button>}
          />
          <Table head={['School', 'Last good backup', 'Size', 'Kept', 'Failed (7 days)', '']} empty={d.items.length === 0}>
            {d.items.map((r) => (
              <tr key={r.institution_id}>
                <Td className="font-medium">
                  {r.school}
                  {r.lifecycle !== 'active' && <Badge tone="warning" className="ml-1.5">{r.lifecycle.replace('_', ' ')}</Badge>}
                </Td>
                <Td className="whitespace-nowrap">
                  <Badge tone={r.stale ? 'danger' : 'success'}>{r.stale ? 'stale' : 'ok'}</Badge>{' '}
                  <span className="text-muted-foreground">{stamp(r.last_good_at)}</span>
                </Td>
                <Td className="num">{bytes(r.last_size_bytes)}</Td>
                <Td className="num">{r.kept}</Td>
                <Td className="num">{r.failed_7d}</Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(selected === r.institution_id ? null : r.institution_id)}>
                    {selected === r.institution_id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
          {run.error ? <div className="border-t px-5 py-3"><FormNotice error={run.error} /></div> : null}
          {run.isSuccess && <div className="border-t px-5 py-3"><FormNotice ok="Backup queued. It appears here when it finishes." /></div>}
        </Card>
        {school && <SchoolBackups key={school.institution_id} school={school} onRun={() => run.mutate({ institution_id: school.institution_id })} running={run.isPending} />}
      </PageBody>
    </>
  )
}

function SchoolBackups({ school, onRun, running }: { school: FleetRow; onRun: () => void; running: boolean }) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ['seller', 'backups', school.institution_id],
    queryFn: () => api.get<{ items: BackupRow[] }>(`/api/v1/seller/backups?institution_id=${school.institution_id}`),
  })
  const restores = useQuery({
    queryKey: ['seller', 'backups', 'restores', school.institution_id],
    queryFn: () => api.get<{ items: RestoreRow[]; live: boolean }>(`/api/v1/seller/tenants/${school.institution_id}/restores`),
  })
  const [when, setWhen] = useState('')
  const [bookmark, setBookmark] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState<null | { kind: 'restore' } | { kind: 'undo'; id: string }>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const restore = useMutation({
    mutationFn: (typed: string) => confirming?.kind === 'undo'
      ? api.post<RestoreResult>(`/api/v1/seller/restores/${confirming.id}/undo`, { confirm_name: typed })
      : api.post<RestoreResult>(`/api/v1/seller/tenants/${school.institution_id}/restore`, {
        confirm_name: typed, reason,
        ...(bookmark ? { bookmark } : { timestamp: new Date(when).toISOString() }),
      }),
    onSuccess: (r) => {
      setResult(r); setConfirming(null)
      qc.invalidateQueries({ queryKey: ['seller', 'backups', 'restores', school.institution_id] })
    },
  })
  const items = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader title={`${school.school}: backups`} action={<Button size="sm" pending={running} onClick={onRun}>Back up now</Button>} />
        <Table head={['Date', 'Kind', 'Status', 'Tables', 'Rows', 'Size', '']} empty={items.length === 0} loading={list.isLoading}
          emptyLabel="No backup has been taken of this school yet.">
          {items.map((b) => (
            <tr key={b.id}>
              <Td className="num whitespace-nowrap">{b.backup_date}</Td>
              <Td>{b.kind}</Td>
              <Td><Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{b.status}</Badge>{b.error && <span className="ml-1.5 text-[12px] text-destructive">{b.error}</span>}</Td>
              <Td className="num">{b.tables}</Td>
              <Td className="num">{b.row_count.toLocaleString()}</Td>
              <Td className="num">{bytes(b.size_bytes)}</Td>
              <Td>{b.download_url && <a className="text-primary underline-offset-2 hover:underline" href={b.download_url}>Download</a>}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardHeader title="Restore to a point in time" action={<Badge tone={restores.data?.live ? 'danger' : 'warning'}>{restores.data?.live ? 'live' : 'dry run'}</Badge>} />
        <div className="grid gap-4 px-5 py-4">
          <p className="text-[13px] text-muted-foreground">
            Rewinds this school's live database with D1 Time Travel (up to 30 days back). Everything written after that moment is
            replaced. Where the database stands just before is recorded, so the restore can be undone below.
          </p>
          <FormGrid>
            <Field label="Restore to (your local time)"><Input type="datetime-local" value={when} onChange={setWhen} /></Field>
            <Field label="Or a bookmark" hint="Overrides the time when given"><Input value={bookmark} onChange={setBookmark} /></Field>
            <Field label="Reason" wide><Input value={reason} onChange={setReason} placeholder="What went wrong, and who asked" /></Field>
          </FormGrid>
          {confirming ? (
            <TypedConfirm
              name={school.school}
              label={confirming.kind === 'undo' ? 'Undo the restore' : 'Restore now'}
              question={confirming.kind === 'undo'
                ? `Put ${school.school} back where it was before that restore?`
                : `Rewind ${school.school} to ${bookmark ? 'bookmark ' + bookmark : new Date(when).toString()}? Every change since then is lost.`}
              pending={restore.isPending}
              error={restore.error}
              onConfirm={(typed) => restore.mutate(typed)}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <div><Button tone="danger" disabled={!when && !bookmark} onClick={() => { setResult(null); setConfirming({ kind: 'restore' }) }}>Restore…</Button></div>
          )}
          {result?.dry_run && (
            <div className="rounded-md border bg-muted/40 p-3 text-[12px]">
              <div className="mb-1 font-medium">Dry run: nothing was restored. Would call:</div>
              {result.dry_run.would_call.map((c, i) => <div key={i} className="font-mono break-all">{c.method} {c.url}</div>)}
              <div className="mt-1 text-muted-foreground">{result.dry_run.note}</div>
            </div>
          )}
        </div>
        <Table head={['When', 'By', 'To', 'Status', 'Before (bookmark)', '']} empty={(restores.data?.items ?? []).length === 0}
          emptyLabel="No restore has been run on this school.">
          {(restores.data?.items ?? []).map((r) => (
            <tr key={r.id}>
              <Td className="num whitespace-nowrap">{stamp(r.created_at)}</Td>
              <Td>{r.actor_name ?? '-'}</Td>
              <Td className="font-mono text-[12px]">{r.undoes_restore_id ? 'undo' : r.target_timestamp ?? r.target_bookmark}</Td>
              <Td><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.replace('_', ' ')}</Badge></Td>
              <Td className="font-mono text-[12px] break-all">{r.pre_bookmark ?? '-'}</Td>
              <Td>
                {r.status === 'succeeded' && r.pre_bookmark && (
                  <Button size="sm" variant="ghost" onClick={() => { setResult(null); setConfirming({ kind: 'undo', id: r.id }) }}>Undo</Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}
