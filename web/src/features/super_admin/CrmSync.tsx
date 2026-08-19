import { useEffect, useState } from 'react'
import { AlertTriangle, Link2, Upload, Users } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Input, Select, Checkbox, Field, FormGrid, Button, FormNotice,
  Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { useToast } from '@/components/Toast'
import {
  crmBase, useConnectorMutation, useCrmConflicts, useCrmConnector,
  useCrmCredentials, useCrmQueue, useCrmRuns, actionLabel, actionTone, whenRead,
  type CrmField, type CrmSyncResult,
} from './connectors-lib'

/* The admissions CRM bridge.
 *
 * Schools run their admissions marketing in Meritto or LeadSquared: that is
 * where the counsellor works, where the call list lives and where the head of
 * admissions reads the funnel. The same leads are in this product as enquiries,
 * because the application, the fee and the child's record all hang off them.
 * Neither side is going to give way, so the job is to keep them the same
 * leads rather than two sets.
 *
 * One failure governs the whole screen. Syncing twice must not create two leads
 * for one child — a duplicate means two counsellors ringing the same parent,
 * which a school notices immediately and blames the software for, correctly.
 * So every lead that has crossed the boundary carries the CRM's own id, the
 * decision to send or skip is taken against that id, and the "already synced"
 * count is shown before anything moves rather than after.
 *
 * There is no live API sync here and the card at the top says so, in words that
 * come from the server. The API tier of both products is a paid add-on with a
 * per-account key, and this installation has neither. What a school can
 * genuinely do today is the CSV route: export here, import in the CRM's own
 * bulk upload, bring the file back the same way — and that is built.
 */

export default function CrmSync() {
  /* platform.tenants.write throughout (connectors.go). institution_admin holds
     every other key in this product and deliberately not this one, so a school
     administrator who somehow reaches this screen must not be shown its Save
     buttons — the backend refuses them either way. */
  const can = useCan()
  const mayConfigure = can('platform.tenants.write')
  const toast = useToast()

  const conn = useCrmConnector()
  const queue = useCrmQueue()
  const runs = useCrmRuns()
  const conflicts = useCrmConflicts()
  const creds = useCrmCredentials()

  const [provider, setProvider] = useState('')
  const [direction, setDirection] = useState('push')
  const [policy, setPolicy] = useState('flag')
  const [enabled, setEnabled] = useState(false)
  const [fields, setFields] = useState<CrmField[]>([])
  const [lastRun, setLastRun] = useState<CrmSyncResult | null>(null)

  // Seeded from the server once, then left to the operator. Keyed on the
  // fetched value rather than a defaultValue, so a save made in another tab is
  // reflected instead of being overwritten by a stale form.
  const loaded = conn.data
  useEffect(() => {
    if (!loaded) return
    setProvider(loaded.settings.provider ?? '')
    setDirection(loaded.settings.direction)
    setPolicy(loaded.settings.conflict_policy)
    setEnabled(loaded.settings.is_enabled)
    setFields(loaded.fields)
  }, [loaded])

  const saveSettings = useConnectorMutation(
    () =>
      api.put(crmBase, {
        provider,
        direction,
        conflict_policy: policy,
        transport: 'csv',
        is_enabled: enabled,
      }),
    () => toast.ok('The CRM connector was saved.'),
  )

  const saveMappings = useConnectorMutation(
    () =>
      api.put(`${crmBase}/mappings`, {
        mappings: fields
          .filter((f) => f.crm_field.trim() !== '')
          .map((f) => ({
            local_field: f.local_field,
            crm_field: f.crm_field,
            direction: f.direction,
            is_required: f.is_required,
          })),
      }),
    () => toast.ok('The field mapping was saved.'),
  )

  const exportLeads = useConnectorMutation(
    () => api.post<CrmSyncResult>(`${crmBase}/export`, {}),
    (res) => {
      setLastRun(res)
      toast.ok('The export was recorded. Download the file below.')
    },
  )

  const importLeads = useConnectorMutation(
    (csv: string) => api.post<CrmSyncResult>(`${crmBase}/import`, { csv }),
    (res) => {
      setLastRun(res)
      toast.ok(`${res.considered} rows were read from the file.`)
    },
  )

  const resolve = useConnectorMutation(
    (args: { id: string; keep: string }) =>
      api.post(`${crmBase}/conflicts/${args.id}/resolve`, { keep: args.keep }),
    () => toast.ok('The conflict was settled.'),
  )

  if (conn.isLoading) return <Loading label="Reading the connector…" />
  // Never an empty state for a failed query: "no leads" and "we could not ask"
  // are different facts and only one of them is the school's problem.
  if (conn.error) return <ErrorState error={conn.error} />

  const c = conn.data!
  const counts = queue.data?.counts ?? {}
  const systemName =
    c.systems.find((s) => s.key === c.settings.provider)?.name ?? 'No CRM chosen'

  const setField = (i: number, patch: Partial<CrmField>) =>
    setFields((prev) => prev.map((f, n) => (n === i ? { ...f, ...patch } : f)))

  return (
    <>
      <PageHead
        eyebrow="Platform Setup"
        title="Meritto / LeadSquared sync"
        description="Keep this school's enquiries and the CRM's leads as one set rather than two. Every lead that crosses carries the CRM's own id, so syncing twice updates one lead instead of creating a second."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Enquiries here" value={c.enquiries} icon={Users} />
          <Stat
            label="Linked to the CRM"
            value={c.linked_leads}
            icon={Link2}
            hint="Carrying the CRM's own id, so a second sync skips them"
          />
          <Stat
            label="Fields mapped"
            value={`${c.mapped_fields} of ${c.total_fields}`}
            delta={
              c.mapped_fields
                ? { value: 'Ready to export', positive: true }
                : { value: 'Nothing is mapped yet', positive: false }
            }
          />
          <Stat
            label="Waiting on a decision"
            value={c.conflicts}
            icon={AlertTriangle}
            hint={c.conflicts ? 'Changed here and in the CRM' : 'No lead is in dispute'}
          />
        </CellGrid>

        {/* Taken from the server, not decided here — whether a live sync exists
            is a fact about the deployment, and a screen that hardcoded it would
            go on promising after somebody changed the backend. */}
        <Card>
          <CardHeader
            title="There is no live API sync"
            description={c.live_sync_note}
            action={<Badge tone="warning">CSV exchange only</Badge>}
          />
        </Card>

        <Card>
          <CardHeader
            title="The CRM, and which way leads travel"
            description="A school whose counsellors live in the CRM pulls status back and pushes nothing else. One using this product as the system of record pushes out. Both is the arrangement that needs a conflict rule."
          />
          <div className="space-y-4 p-5">
            <FormGrid>
              <Field label="CRM" required hint="Which product this school's admissions team uses.">
                <Select
                  value={provider}
                  onChange={setProvider}
                  placeholder="Not chosen yet"
                  options={c.systems.map((s) => ({ value: s.key, label: s.name }))}
                />
              </Field>
              <Field label="Direction">
                <Select
                  value={direction}
                  onChange={setDirection}
                  options={[
                    { value: 'push', label: 'Push our enquiries out' },
                    { value: 'pull', label: 'Pull their status back' },
                    { value: 'both', label: 'Both ways' },
                  ]}
                />
              </Field>
              <Field
                label="When both sides changed"
                hint="There is no correct answer here, only a decided one. Flagging is the honest default: it applies neither and asks."
              >
                <Select
                  value={policy}
                  onChange={setPolicy}
                  options={[
                    { value: 'flag', label: 'Flag it for a person' },
                    { value: 'ours', label: "Keep this school's record" },
                    { value: 'theirs', label: "Keep the CRM's record" },
                    { value: 'newest', label: 'Keep whichever changed last' },
                  ]}
                />
              </Field>
              <Field label="Connector">
                <Checkbox
                  checked={enabled}
                  onChange={setEnabled}
                  label="Switched on"
                  hint="Choose the CRM before switching this on; an export with no destination is a file nobody can use."
                />
              </Field>
            </FormGrid>
            <FormNotice error={saveSettings.error} />
            <Button
              onClick={() => saveSettings.mutate(undefined as never)}
              disabled={!mayConfigure || saveSettings.isPending}
            >
              Save the connector
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Which field is which"
            description="Nothing is guessed. LeadSquared calls a custom field mx_Class_Sought in one account and mx_ClassApplied in the next, and a mapping filled in automatically would write plausible data into the wrong field in a real CRM — which nobody notices until a counsellor rings the wrong number."
            action={<Badge tone={c.mapped_fields ? 'success' : 'warning'}>{systemName}</Badge>}
          />
          {/* A Table goes as a sibling of the padded body, never inside it: a
              padded card body and the table's own row padding double-inset
              every cell. */}
          <Table head={['Field here', 'Field in the CRM', 'Direction', 'Required']}>
            {fields.map((f, i) => (
              <tr key={f.local_field}>
                <Td>{f.label}</Td>
                <Td>
                  <Input
                    value={f.crm_field}
                    onChange={(v) => setField(i, { crm_field: v })}
                    placeholder="Leave blank to leave unmapped"
                    srLabel={`Field in the CRM for ${f.label}`}
                  />
                </Td>
                <Td>
                  <Select
                    value={f.direction || 'both'}
                    onChange={(v) => setField(i, { direction: v })}
                    options={[
                      { value: 'both', label: 'Both ways' },
                      { value: 'push', label: 'Push only' },
                      { value: 'pull', label: 'Pull only' },
                    ]}
                  />
                </Td>
                <Td>
                  <Checkbox
                    checked={f.is_required}
                    onChange={(v) => setField(i, { is_required: v })}
                    label=""
                    srLabel={`${f.label} is required`}
                  />
                </Td>
              </tr>
            ))}
          </Table>
          <div className="space-y-3 px-5 pb-5 pt-1">
            <FormNotice error={saveMappings.error} />
            <Button
              onClick={() => saveMappings.mutate(undefined as never)}
              disabled={!mayConfigure || saveMappings.isPending}
            >
              Save the mapping
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="What a push would send"
            description="Decided by the same rules the export uses, so the counts below are what will actually happen. The number that matters is 'already synced': those leads are linked and unchanged, and sending them again is exactly how a school ends up with duplicates."
            action={
              <Badge tone={counts.skipped ? 'info' : 'neutral'}>
                {counts.skipped ?? 0} already synced
              </Badge>
            }
          />
          {queue.error ? (
            <div className="p-5">
              <ErrorState error={queue.error} />
            </div>
          ) : (
            <Table
              head={['Child', 'Phone', 'Status here', 'CRM id', 'What would happen']}
              empty={!queue.isLoading && (queue.data?.items.length ?? 0) === 0}
              emptyLabel="No enquiries to send."
            >
              {(queue.data?.items ?? []).slice(0, 50).map((q) => (
                <tr key={q.enquiry_id}>
                  <Td>{q.student_name}</Td>
                  <Td>{q.phone}</Td>
                  <Td>{q.status}</Td>
                  <Td>{q.external_id || '—'}</Td>
                  <Td>
                    <Badge tone={actionTone(q.action)}>{actionLabel(q.action)}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <div className="space-y-3 px-5 pb-5 pt-1">
            <FormNotice error={exportLeads.error} />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => exportLeads.mutate(undefined as never)}
                disabled={!mayConfigure || exportLeads.isPending}
              >
                Record an export and build the file
              </Button>
              {lastRun?.download_url && (
                <a
                  href={lastRun.download_url}
                  className="text-[14px] font-medium text-primary underline underline-offset-2"
                >
                  Download the CSV
                </a>
              )}
            </div>
            {lastRun?.note && (
              <p className="text-[13px] text-muted-foreground">{lastRun.note}</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Bring the CRM's export back"
            description="Matched on the CRM's own id, so the same file applied twice changes nothing the second time. Rows the school has no enquiry for are listed and left alone rather than invented: a CRM export carries leads for other campuses and other years."
          />
          <div className="space-y-3 p-5">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed py-10 text-center transition-colors hover:bg-accent/40">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-[14px] font-medium">Choose the CRM's export</span>
              <span className="text-[13px] text-muted-foreground">
                CSV, keeping the external_id column this screen exported
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                disabled={!mayConfigure}
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) importLeads.mutate(await f.text())
                }}
              />
            </label>
            <FormNotice error={importLeads.error} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Leads that changed on both sides"
            description="Nothing here resolves itself and nothing ages out. A sync that quietly settles its own conflicts is how a counsellor's call notes disappear."
          />
          {conflicts.error ? (
            <div className="p-5">
              <ErrorState error={conflicts.error} />
            </div>
          ) : (
            <Table
              head={['Child', 'Status here', 'Status in the CRM', 'Since', 'Keep']}
              empty={!conflicts.isLoading && (conflicts.data?.items.length ?? 0) === 0}
              emptyLabel="No lead is in dispute."
            >
              {(conflicts.data?.items ?? []).map((k) => (
                <tr key={k.id}>
                  <Td>{k.student_name}</Td>
                  <Td>{k.our_status}</Td>
                  <Td>{k.their_status ?? '—'}</Td>
                  <Td>{whenRead(k.conflict_at)}</Td>
                  <Td>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!mayConfigure || resolve.isPending}
                        onClick={() => resolve.mutate({ id: k.id, keep: 'ours' })}
                      >
                        Ours
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!mayConfigure || resolve.isPending}
                        onClick={() => resolve.mutate({ id: k.id, keep: 'theirs' })}
                      >
                        Theirs
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Syncs that have run"
            description="Recorded whether or not anything moved: 'the run found nothing' and 'no run happened' are different facts, and only the first exonerates the connector."
          />
          {runs.error ? (
            <div className="p-5">
              <ErrorState error={runs.error} />
            </div>
          ) : (
            <Table
              head={['When', 'Direction', 'Considered', 'New', 'Changed', 'Already synced', 'Held back']}
              empty={!runs.isLoading && (runs.data?.items.length ?? 0) === 0}
              emptyLabel="No sync has run yet."
            >
              {(runs.data?.items ?? []).map((run) => (
                <tr key={run.id}>
                  <Td>{whenRead(run.started_at)}</Td>
                  <Td>{run.direction === 'push' ? 'Out to the CRM' : 'Back from the CRM'}</Td>
                  <Td>{run.considered}</Td>
                  <Td>{run.created_count}</Td>
                  <Td>{run.updated_count}</Td>
                  <Td>{run.skipped_count}</Td>
                  <Td>
                    {run.conflict_count + run.failed_count > 0 ? (
                      <Badge tone={run.failed_count ? 'danger' : 'warning'}>
                        {run.conflict_count + run.failed_count}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="The CRM's API key"
            description="Recorded for the day an account exists. Stored encrypted, never shown again, and out of reach of the school's own administrator — a key that can read and write every lead in the admissions pipeline is the vendor's to hold."
            action={<Badge tone="warning">Not used today</Badge>}
          />
          {creds.error ? (
            <div className="p-5">
              <ErrorState error={creds.error} />
            </div>
          ) : (
            <>
              <Table
                head={['CRM', 'Endpoint', 'Key stored', 'Scope', 'Updated']}
                empty={!creds.isLoading && (creds.data?.items.length ?? 0) === 0}
                emptyLabel="No CRM credential has been recorded."
              >
                {(creds.data?.items ?? []).map((k) => (
                  <tr key={k.provider}>
                    <Td>{k.provider}</Td>
                    <Td>{k.base_url || '—'}</Td>
                    <Td>
                      <Badge tone={k.has_credentials ? 'success' : 'neutral'}>
                        {k.has_credentials ? 'Stored' : 'None'}
                      </Badge>
                    </Td>
                    <Td>{k.is_installation_default ? 'Every campus' : 'This school'}</Td>
                    <Td>{whenRead(k.updated_at)}</Td>
                  </tr>
                ))}
              </Table>
              <div className="px-5 pb-5 pt-1">
                <CrmCredentialForm mayConfigure={mayConfigure} />
              </div>
            </>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/* The key form, its own component so the write-only field has its own state.
 *
 * The secret is sent only when it was typed. An absent field leaves the stored
 * key alone and an empty one clears it, which is the distinction that stops a
 * screen wiping a credential it was never shown on an unrelated save. */
function CrmCredentialForm({ mayConfigure }: { mayConfigure: boolean }) {
  const toast = useToast()
  const [provider, setProvider] = useState('meritto')
  const [baseURL, setBaseURL] = useState('')
  const [secret, setSecret] = useState('')

  const save = useConnectorMutation(
    () =>
      api.put(`${crmBase}/credentials`, {
        provider,
        base_url: baseURL,
        ...(secret === '' ? {} : { secret }),
      }),
    () => {
      setSecret('')
      toast.ok('The credential was stored. It cannot be read back.')
    },
  )

  return (
    <div className="space-y-4">
      <FormGrid>
        <Field label="CRM">
          <Select
            value={provider}
            onChange={setProvider}
            options={[
              { value: 'meritto', label: 'Meritto' },
              { value: 'leadsquared', label: 'LeadSquared' },
            ]}
          />
        </Field>
        <Field
          label="API endpoint"
          hint="LeadSquared's differs by data centre; a key issued for one returns 401 against another, which reads as a bad key."
        >
          <Input value={baseURL} onChange={setBaseURL} placeholder="https://api-in21.leadsquared.com" />
        </Field>
        <Field label="API key" hint="Write-only. Leave blank to keep whatever is stored." wide>
          <Input value={secret} onChange={setSecret} type="password" placeholder="••••••••" />
        </Field>
      </FormGrid>
      <FormNotice error={save.error} />
      <Button
        onClick={() => save.mutate(undefined as never)}
        disabled={!mayConfigure || save.isPending}
      >
        Store the credential
      </Button>
    </div>
  )
}
