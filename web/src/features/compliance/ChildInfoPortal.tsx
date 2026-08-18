import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Info, KeyRound } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, ConfirmButton,
  Field, FormGrid, FormNotice, Input, Select, Checkbox, Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* Platform configuration for a state Child Info portal.

   This screen is deliberate about what it does not claim. No state Child Info
   portal exposes an API this installation can reach, so there is no live sync
   and nothing here pretends there is: the working connector is a file exchange,
   and the run history is a logbook of what an operator actually did rather than
   a record of scheduled jobs that never ran.

   The credential is write-only. It is sealed with AES-GCM under CREDENTIAL_KEY
   before it is stored and is never sent back, which is why the form shows
   "stored" rather than a masked value it could reveal. */

interface Connector {
  id: string
  state_code: string
  name: string
  provider: string
  endpoint_url?: string
  username?: string
  has_secret: boolean
  schedule?: string
  is_enabled: boolean
  last_sync_at?: string
  last_status?: string
  last_error?: string
  run_count: number
  ready: boolean
  blocker?: string
  updated_at: string
}

interface Run {
  id: string
  connector_id: string
  connector_name: string
  state_code: string
  institution_name?: string
  direction: string
  status: string
  started_at: string
  finished_at?: string
  row_count: number
  message?: string
  started_by?: string
}

interface School {
  id: string
  name: string
}

const EMPTY = {
  id: '',
  state_code: 'TS',
  name: 'Telangana Child Info',
  provider: 'file_exchange',
  endpoint_url: '',
  username: '',
  secret: '',
  schedule: '',
  is_enabled: false,
}

export default function ChildInfoPortal() {
  const qc = useQueryClient()
  const [form, setForm] = useState({ ...EMPTY })
  const [school, setSchool] = useState('')
  const [logging, setLogging] = useState<string | null>(null)
  const [logEntry, setLogEntry] = useState({ direction: 'export', rows: '', message: '' })

  const connectors = useQuery({
    queryKey: ['child-info-connectors'],
    queryFn: () => api.get<List<Connector>>('/api/v1/statutory/portal/connectors'),
  })
  const runs = useQuery({
    queryKey: ['child-info-runs'],
    queryFn: () => api.get<List<Run>>('/api/v1/statutory/portal/runs'),
  })
  const schools = useQuery({
    queryKey: ['institutions'],
    queryFn: () => api.get<List<School>>('/api/v1/admin/institutions'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['child-info-connectors'] })
    qc.invalidateQueries({ queryKey: ['child-info-runs'] })
  }

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/statutory/portal/connectors', {
        id: form.id || undefined,
        state_code: form.state_code,
        name: form.name,
        provider: form.provider,
        endpoint_url: form.endpoint_url,
        username: form.username,
        // Omitted entirely when blank, which the server reads as "keep what is
        // stored" rather than "erase it".
        secret: form.secret ? form.secret : undefined,
        schedule: form.schedule,
        is_enabled: form.is_enabled,
      }),
    onSuccess: () => {
      setForm({ ...EMPTY })
      refresh()
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/statutory/portal/connectors/${id}`),
    onSuccess: refresh,
  })

  const record = useMutation({
    mutationFn: (connectorID: string) =>
      api.post(`/api/v1/statutory/portal/connectors/${connectorID}/runs`, {
        institution_id: school || undefined,
        direction: logEntry.direction,
        status: 'ok',
        row_count: Number(logEntry.rows || 0),
        message: logEntry.message || undefined,
      }),
    onSuccess: () => {
      setLogEntry({ direction: 'export', rows: '', message: '' })
      setLogging(null)
      refresh()
    },
  })

  const edit = (c: Connector) =>
    setForm({
      id: c.id,
      state_code: c.state_code,
      name: c.name,
      provider: c.provider,
      endpoint_url: c.endpoint_url ?? '',
      username: c.username ?? '',
      secret: '',
      schedule: c.schedule ?? '',
      is_enabled: c.is_enabled,
    })

  return (
    <>
      <PageHead
        eyebrow="Statutory & boards"
        title="Child Info portal sync"
        description="Platform configuration for a state Child Info portal: the endpoint, the credentials and the record of what has been exchanged."
        width="wide"
      />
      <PageBody width="wide">
        <Card>
          <div className="flex items-start gap-3 px-5 py-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-[13px]">
              <div className="font-medium">There is no live portal API, and this does not pretend otherwise.</div>
              <div className="text-muted-foreground">
                No state Child Info portal publishes an interface this installation can call. What
                works today is the file exchange: export a school's roster below, upload it on the
                portal by hand, download the portal's extract, and import it under the school's own
                Child Info Reconciliation screen. Live sync would need state portal credentials and
                a published endpoint; a connector can be recorded now so it is ready the day those
                arrive, and until then it reports itself as not runnable rather than silently doing
                nothing.
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Export a school's roster"
            description="The file you upload on the portal. Its columns match what the reconciliation reads back, so a round trip needs no mapping step."
          />
          <div className="flex flex-wrap items-end gap-3 px-5 pb-5">
            <div className="min-w-64">
              <Field label="School" required>
                <Select
                  value={school}
                  onChange={setSchool}
                  options={(schools.data?.items ?? []).map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                  placeholder="Choose a school"
                />
              </Field>
            </div>
            {school ? (
              <a
                href={`/api/v1/statutory/portal/export?institution_id=${school}`}
                download
              >
                <Button variant="secondary">
                  <Download className="h-4 w-4" /> Export roster
                </Button>
              </a>
            ) : (
              <Button variant="secondary" disabled>
                <Download className="h-4 w-4" /> Export roster
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={form.id ? 'Edit connector' : 'Add a connector'}
            description="One row per state portal. These are platform rows: no school can read them, and the credential is encrypted before it is stored and never returned."
          />
          <div className="space-y-3 px-5 pb-5">
            <FormGrid>
              <Field label="State code" required>
                <Input
                  value={form.state_code}
                  onChange={(v) => setForm({ ...form, state_code: v })}
                  placeholder="TS"
                />
              </Field>
              <Field label="Name" required>
                <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              </Field>
              <Field label="Connector type">
                <Select
                  value={form.provider}
                  onChange={(v) => setForm({ ...form, provider: v })}
                  options={[
                    { value: 'file_exchange', label: 'File exchange (works today)' },
                    { value: 'api', label: 'Portal API (needs state credentials)' },
                  ]}
                />
              </Field>
              <Field label="Schedule" hint="Free text — there is no scheduler behind this">
                <Input
                  value={form.schedule}
                  onChange={(v) => setForm({ ...form, schedule: v })}
                  placeholder="Monthly, before the 10th"
                />
              </Field>
              <Field label="Endpoint" wide>
                <Input
                  value={form.endpoint_url}
                  onChange={(v) => setForm({ ...form, endpoint_url: v })}
                  placeholder="https://childinfo.telangana.gov.in"
                />
              </Field>
              <Field label="Username">
                <Input value={form.username} onChange={(v) => setForm({ ...form, username: v })} />
              </Field>
              <Field
                label="Password or API key"
                hint={form.id ? 'Leave blank to keep what is stored' : 'Encrypted before storage; never shown again'}
              >
                <Input
                  type="password"
                  value={form.secret}
                  onChange={(v) => setForm({ ...form, secret: v })}
                />
              </Field>
            </FormGrid>
            <Checkbox
              checked={form.is_enabled}
              onChange={(v) => setForm({ ...form, is_enabled: v })}
              label="Enabled"
              hint="An enabled file-exchange connector is one an operator is expected to run."
            />
            <div className="flex gap-2">
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {form.id ? 'Save connector' : 'Add connector'}
              </Button>
              {form.id && (
                <Button variant="ghost" onClick={() => setForm({ ...EMPTY })}>
                  Cancel
                </Button>
              )}
            </div>
            <FormNotice error={save.error} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Connectors" />
          {connectors.isLoading ? (
            <Loading />
          ) : connectors.error ? (
            <ErrorState error={connectors.error} />
          ) : (
            <Table
              head={['State', 'Name', 'Type', 'Credentials', 'Runnable', 'Last exchange', 'Runs', '']}
              empty={!connectors.data?.items.length}
              emptyLabel="No portal connector has been configured."
            >
              {(connectors.data?.items ?? []).map((c) => (
                <tr key={c.id}>
                  <Td className="font-mono text-[12px]">{c.state_code}</Td>
                  <Td className="font-medium">{c.name}</Td>
                  <Td>{c.provider.replace(/_/g, ' ')}</Td>
                  <Td>
                    {c.has_secret ? (
                      <span className="flex items-center gap-1 text-[13px]">
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" /> stored
                      </span>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </Td>
                  <Td className="max-w-sm">
                    {c.ready ? (
                      <Badge tone="success">yes</Badge>
                    ) : (
                      <>
                        <Badge tone="warning">no</Badge>
                        <div className="text-[12px] text-muted-foreground">{c.blocker}</div>
                      </>
                    )}
                  </Td>
                  <Td>
                    {c.last_sync_at ? (
                      <>
                        {formatDate(c.last_sync_at)}
                        {c.last_status === 'failed' ? (
                          <div className="text-[12px] text-destructive">{c.last_error}</div>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="tabular-nums">{c.run_count}</Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => edit(c)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setLogging(c.id)}>
                        Log an exchange
                      </Button>
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        tone="danger"
                        confirmLabel="Delete"
                        question="Delete this connector and its exchange history?"
                        onConfirm={() => remove.mutate(c.id)}
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                    {logging === c.id && (
                      <div className="mt-2 space-y-1.5 rounded-md border p-2">
                        <Select
                          value={logEntry.direction}
                          onChange={(v) => setLogEntry({ ...logEntry, direction: v })}
                          options={[
                            { value: 'export', label: 'Exported to the portal' },
                            { value: 'import', label: 'Imported from the portal' },
                          ]}
                        />
                        <Input
                          value={logEntry.rows}
                          onChange={(v) => setLogEntry({ ...logEntry, rows: v })}
                          placeholder="Rows exchanged"
                        />
                        <Input
                          value={logEntry.message}
                          onChange={(v) => setLogEntry({ ...logEntry, message: v })}
                          placeholder="Note"
                        />
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            disabled={record.isPending}
                            onClick={() => record.mutate(c.id)}
                          >
                            Record
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setLogging(null)}>
                            Cancel
                          </Button>
                        </div>
                        <div className="text-[12px] text-muted-foreground">
                          {school
                            ? 'Recorded against the school chosen above.'
                            : 'Choose a school above to record this against one.'}
                        </div>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <FormNotice error={record.error} />
        </Card>

        <Card>
          <CardHeader
            title="Exchange history"
            description="What an operator did and when. A logbook, not a scheduler — nothing here ran on its own."
          />
          <Table
            head={['When', 'Connector', 'School', 'Direction', 'Rows', 'Status', 'By', 'Note']}
            empty={!runs.data?.items.length}
            emptyLabel="Nothing has been exchanged yet."
          >
            {(runs.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <Td>{formatDate(r.started_at)}</Td>
                <Td>{r.connector_name}</Td>
                <Td>{r.institution_name ?? '—'}</Td>
                <Td>{r.direction}</Td>
                <Td className="tabular-nums">{r.row_count}</Td>
                <Td>
                  <Badge tone={r.status === 'ok' ? 'success' : 'danger'}>{r.status}</Badge>
                </Td>
                <Td>{r.started_by ?? '—'}</Td>
                <Td className="max-w-sm text-[13px]">{r.message ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}
