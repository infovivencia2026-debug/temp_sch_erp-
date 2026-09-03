import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea, SkeletonTable,
  ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

/* The state roster against ours, and what was decided about the gap.

   The diff is the easy part. The reason this screen is worth opening twice is
   that a difference already settled does not come back: the resolutions list at
   the bottom is the durable half, and the count of suppressed rows is how a
   head knows it is working. */

interface Import {
  id: string
  source_label?: string
  file_name?: string
  row_count: number
  portal_only_count: number
  school_only_count: number
  mismatch_count: number
  suppressed_count: number
  open_count: number
  imported_by?: string
  imported_at: string
  note?: string
}

interface Diff {
  id: string
  import_id: string
  kind: string
  match_key: string
  field?: string
  portal_value?: string
  school_value?: string
  student_id?: string
  child_info_id?: string
  display_name?: string
  admission_no?: string
  status: string
  resolution_action?: string
  resolution_note?: string
}

interface Resolution {
  id: string
  kind: string
  match_key: string
  field?: string
  portal_value?: string
  school_value?: string
  action: string
  note?: string
  resolved_by?: string
  resolved_at: string
}

interface ImportResult {
  import_id?: string
  dry_run: boolean
  rows: number
  portal_only_count: number
  school_only_count: number
  mismatch_count: number
  suppressed_count: number
  open_count: number
  sample: Diff[]
}

const KIND_LABEL: Record<string, string> = {
  portal_only: 'In the portal, not here',
  school_only: 'Enrolled here, not in the portal',
  field_mismatch: 'Both, but they disagree',
}

const KIND_TONE: Record<string, 'warning' | 'danger' | 'info'> = {
  portal_only: 'warning',
  school_only: 'danger',
  field_mismatch: 'info',
}

const ACTIONS = [
  { value: 'fix_local', label: 'Our record is wrong — fix it here' },
  { value: 'mark_for_portal', label: 'The portal is wrong — file a change' },
  { value: 'accept', label: 'Both are right — accept the difference' },
]

// Fields the reconciliation may write back. Class and guardian names change on
// the screens that know what else has to move with them.
const WRITABLE = new Set(['date_of_birth', 'gender', 'aadhaar_last4', 'apaar_id'])

export default function ChildInfoReconciliation() {
  const qc = useQueryClient()
  /* Reading the differences is admin.reports.read; importing an extract and
     settling a difference are students.write (statutory.go:111-113). */
  const can = useCan()
  const mayResolve = can('students.write')
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [note, setNote] = useState('')
  const [kind, setKind] = useState('')
  const [decision, setDecision] = useState<Record<string, { action: string; note: string }>>({})

  const imports = useQuery({
    queryKey: ['child-info-imports'],
    queryFn: () => api.get<List<Import>>('/api/v1/statutory/child-info/imports'),
  })
  const diffs = useQuery({
    queryKey: ['child-info-differences', kind],
    queryFn: () =>
      api.get<List<Diff>>(
        `/api/v1/statutory/child-info/differences${kind ? `?kind=${kind}` : ''}`,
      ),
  })
  const resolutions = useQuery({
    queryKey: ['child-info-resolutions'],
    queryFn: () => api.get<List<Resolution>>('/api/v1/statutory/child-info/resolutions'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['child-info-imports'] })
    qc.invalidateQueries({ queryKey: ['child-info-differences'] })
    qc.invalidateQueries({ queryKey: ['child-info-resolutions'] })
  }

  const run = useMutation({
    mutationFn: (commit: boolean) =>
      api.post<ImportResult>('/api/v1/statutory/child-info/import', {
        csv,
        file_name: fileName || undefined,
        note: note || undefined,
        dry_run: !commit,
      }),
    onSuccess: (_r, commit) => {
      if (commit) {
        setCsv('')
        setFileName('')
        setNote('')
        refresh()
      }
    },
  })

  const resolve = useMutation({
    mutationFn: ({ id, action, note: n, apply }: {
      id: string; action: string; note: string; apply: boolean
    }) =>
      api.post(`/api/v1/statutory/child-info/differences/${id}/resolve`, {
        action,
        note: n,
        apply_locally: apply,
      }),
    onSuccess: refresh,
  })

  const forget = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/statutory/child-info/resolutions/${id}`),
    onSuccess: refresh,
  })

  const onFile = (f: File) => {
    setFileName(f.name)
    const reader = new FileReader()
    reader.onload = () => setCsv(String(reader.result ?? ''))
    reader.readAsText(f)
  }

  const latest = imports.data?.items[0]
  const rows = diffs.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Statutory returns"
        title="Child Info reconciliation"
        description="Import the portal extract and see the three ways the state's roster and ours disagree. A difference you have already decided about does not come back next month."
        width="wide"
      />
      <PageBody width="wide">
        {latest && (
          <CellGrid cols={4}>
            <Stat label="In the portal, not here" value={latest.portal_only_count} />
            <Stat
              label="Enrolled here, not in the portal"
              value={latest.school_only_count}
              delta={{
                value: latest.school_only_count ? 'Unlisted is unfunded' : 'None',
                positive: latest.school_only_count === 0,
              }}
            />
            <Stat label="Fields that disagree" value={latest.mismatch_count} />
            <Stat
              label="Already settled"
              value={latest.suppressed_count}
              hint="Not shown again — decided on an earlier run"
            />
          </CellGrid>
        )}

        <Card>
          <CardHeader
            title="Import the portal extract"
            description="Checked before anything is stored. The columns are matched by their headings, so the portal's own export works without rearranging it."
          />
          <div className="space-y-3 px-5 pb-5 pt-1">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed py-10 text-center transition-colors hover:bg-accent/40">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-[14px] font-medium">
                {fileName || "Click to choose the portal's extract"}
              </span>
              <span className="text-[13px] text-muted-foreground">
                CSV. Checked and reconciled before anything is stored
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onFile(f)
                }}
              />
            </label>
            <FormGrid>
              <Field label="Note" hint="What this extract is, and when you pulled it" wide>
                <Textarea value={note} onChange={setNote} rows={2} />
              </Field>
            </FormGrid>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!mayResolve || !csv || run.isPending} onClick={() => run.mutate(false)}>
                {run.isPending ? 'Reconciling…' : 'Check the file'}
              </Button>
              <Button
                variant="secondary"
                disabled={!mayResolve || !csv || run.isPending || !run.data}
                onClick={() => run.mutate(true)}
              >
                Import {run.data ? `${run.data.rows} row(s)` : ''}
              </Button>
            </div>
            {run.data && (
              <div className="rounded-md border px-3 py-2 text-[13px]">
                {run.data.rows} row(s) read · {run.data.portal_only_count} only in the portal ·{' '}
                {run.data.school_only_count} only here · {run.data.mismatch_count} disagree ·{' '}
                <strong>{run.data.suppressed_count}</strong> already settled and hidden
                {run.data.dry_run ? ' · nothing stored yet' : ''}
              </div>
            )}
            <FormNotice error={run.error} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Differences to decide"
            description={
              latest
                ? `From the import of ${formatDate(latest.imported_at)} · ${rows.length} open`
                : 'Import an extract to begin.'
            }
            action={
              <Select
                value={kind}
                onChange={setKind}
                options={[
                  { value: '', label: 'Every kind' },
                  { value: 'portal_only', label: KIND_LABEL.portal_only },
                  { value: 'school_only', label: KIND_LABEL.school_only },
                  { value: 'field_mismatch', label: KIND_LABEL.field_mismatch },
                ]}
              />
            }
          />
          {diffs.isLoading ? (
            <SkeletonTable columns={7} />
          ) : diffs.error ? (
            <ErrorState error={diffs.error} />
          ) : !rows.length ? (
            <EmptyState
              title="Nothing outstanding"
              body="Either the two rosters agree, or everything that differs has already been decided about."
            />
          ) : (
            <Table
              head={['Child', 'Admission no.', 'Difference', 'Field', 'Portal says', 'We say', 'Decision']}
            >
              {rows.map((d) => {
                const chosen = decision[d.id] ?? { action: '', note: '' }
                return (
                  <tr key={d.id}>
                    <Td className="font-medium">{d.display_name ?? '—'}</Td>
                    <Td className="font-mono text-[12px]">{d.admission_no ?? '—'}</Td>
                    <Td>
                      <Badge tone={KIND_TONE[d.kind] ?? 'neutral'}>
                        {KIND_LABEL[d.kind] ?? d.kind}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-[12px]">{d.field ?? '—'}</Td>
                    <Td>{d.portal_value ?? '—'}</Td>
                    <Td>{d.school_value ?? '—'}</Td>
                    <Td>
                      <div className="flex flex-col gap-1.5">
                        <Select
                          value={chosen.action}
                          onChange={(v) =>
                            setDecision({ ...decision, [d.id]: { ...chosen, action: v } })
                          }
                          options={ACTIONS}
                          placeholder="Decide…"
                        />
                        {chosen.action && (
                          <>
                            <Input
                              value={chosen.note}
                              onChange={(v) =>
                                setDecision({ ...decision, [d.id]: { ...chosen, note: v } })
                              }
                              placeholder="Note (optional)"
                            />
                            <Button
                              size="sm"
                              disabled={!mayResolve || resolve.isPending}
                              onClick={() =>
                                resolve.mutate({
                                  id: d.id,
                                  action: chosen.action,
                                  note: chosen.note,
                                  // Only write back where the school actually
                                  // holds the field; the rest are recorded as a
                                  // decision and changed on their own screen.
                                  apply:
                                    chosen.action === 'fix_local' &&
                                    !!d.field &&
                                    WRITABLE.has(d.field),
                                })
                              }
                            >
                              Save decision
                            </Button>
                          </>
                        )}
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
          <FormNotice error={resolve.error} />
        </Card>

        <Card>
          <CardHeader
            title="Settled differences"
            description="These are why the next reconciliation is short. Forget one and it comes straight back on the next run."
          />
          {resolutions.error && <ErrorState error={resolutions.error} />}
          {!resolutions.error && (
          <Table
            head={['Child key', 'Difference', 'Field', 'Portal said', 'We said', 'Decision', 'By', '']}
            empty={!resolutions.data?.items.length}
            emptyLabel="Nothing has been settled yet."
          >
            {(resolutions.data?.items ?? []).map((res) => (
              <tr key={res.id}>
                <Td className="font-mono text-[12px]">{res.match_key}</Td>
                <Td>{KIND_LABEL[res.kind] ?? res.kind}</Td>
                <Td className="font-mono text-[12px]">{res.field ?? '—'}</Td>
                <Td>{res.portal_value ?? '—'}</Td>
                <Td>{res.school_value ?? '—'}</Td>
                <Td>
                  <Badge tone="neutral">{res.action.replace(/_/g, ' ')}</Badge>
                  {res.note ? (
                    <div className="text-[12px] text-muted-foreground">{res.note}</div>
                  ) : null}
                </Td>
                <Td>{res.resolved_by ?? '—'}</Td>
                <Td>
                  {mayResolve && (
                    <Button size="sm" variant="ghost" onClick={() => forget.mutate(res.id)}>
                      Raise again
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Earlier imports" />
          {/* "No extract has been imported yet" is a claim about the school's
              history, and it was what a failed request said. */}
          {imports.error && <ErrorState error={imports.error} />}
          {!imports.error && (
          <Table
            head={['When', 'File', 'Rows', 'Portal only', 'School only', 'Disagree', 'Hidden', 'Open', 'By']}
            empty={!imports.data?.items.length}
            emptyLabel="No extract has been imported yet."
          >
            {(imports.data?.items ?? []).map((i) => (
              <tr key={i.id}>
                <Td>{formatDate(i.imported_at)}</Td>
                <Td>{i.file_name ?? '—'}</Td>
                <Td className="tabular-nums">{i.row_count}</Td>
                <Td className="tabular-nums">{i.portal_only_count}</Td>
                <Td className="tabular-nums">{i.school_only_count}</Td>
                <Td className="tabular-nums">{i.mismatch_count}</Td>
                <Td className="tabular-nums">{i.suppressed_count}</Td>
                <Td className="tabular-nums">{i.open_count}</Td>
                <Td>{i.imported_by ?? '—'}</Td>
              </tr>
            ))}
          </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
