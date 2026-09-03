import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, Filter, Play, Plus, Share2, Table2, Trash2, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Checkbox, Field, FormGrid, FormNotice,
  Input, Select, SkeletonTable, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import { CsvButton } from './shared'

/* institution_admin.analysis.custom_report_builder

   A principal builds a report without waiting for a developer: pick a subject,
   tick columns, add filters, group it, save it, run it, export it, share it.

   Two things about this screen are load-bearing and easy to undo by accident.

   The first is that it sends KEYS, never SQL and never column names of its own
   invention. Everything in the pickers below comes from GET
   /report-builder/schema, which is the server's whitelist rendered; a key the
   server does not know is refused there. If this screen ever starts composing
   a fragment of a query, the whole safety argument goes with it.

   The second is that running a report is always the same request whoever is
   asking — GET /definitions/{id}/run, with no scope, no author and no boundary
   in the query string. The server resolves the CALLER's scope on every run, so
   a head of department opening a report the principal shared gets their
   department. That is why the export is an anchor to that same endpoint with
   ?format=csv rather than ui.tsx's ExportButton, whose targets are unscoped
   whole-table extracts: the file somebody downloads has to contain exactly the
   rows they were shown.

   Export is a click, never a side effect of rendering. A report over a whole
   institution is capped and paginated on the server; this screen shows the cap
   when it bites, because a truncated list read as a complete one is how a
   principal reports the wrong number to a trustee.
*/

// --- the server's whitelist, as this screen sees it --------------------------

interface Dimension { key: string; label: string; kind: string }
interface Measure { key: string; label: string; kind: string }
interface FieldDef {
  key: string
  label: string
  kind: 'text' | 'number' | 'date' | 'uuid' | 'enum'
  ops: string[]
  options?: string[]
}
interface Subject {
  key: string
  name: string
  summary: string
  dimensions: Dimension[]
  measures: Measure[]
  fields: FieldDef[]
}
interface RoleOption { key: string; name: string }
interface Schema {
  subjects: Subject[]
  roles: RoleOption[]
  scope: string
  max_row_limit: number
  page_size: number
}

interface FilterClause {
  field: string
  op: string
  value?: string
  value2?: string
  values?: string[]
}
interface Definition {
  id: string
  name: string
  description?: string
  subject: string
  subject_name: string
  columns: string[]
  filters: FilterClause[]
  group_by: string[]
  sort_column?: string
  sort_dir: string
  row_limit: number
  created_by_me: boolean
  can_edit: boolean
  shared_with: string[]
  updated_at: string
}
interface ResultColumn { key: string; label: string; kind: string }
interface RunResult {
  columns: ResultColumn[]
  rows: (string | null)[][]
  total: number
  limit: number
  offset: number
  has_more: boolean
  row_limit: number
  truncated: boolean
  scope: string
  grouped: boolean
  took_ms: number
}
interface RunRow {
  id: string
  ran_at: string
  ran_by?: string
  row_count: number
  exported: boolean
  scope: string
  took_ms?: number
}

const OP_LABELS: Record<string, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'is after / more than',
  gte: 'is at least',
  lt: 'is before / less than',
  lte: 'is at most',
  contains: 'contains',
  in: 'is one of',
  between: 'is between',
  is_null: 'is blank',
  is_not_null: 'is not blank',
}

/** Operators that take no value at all, so the screen stops asking for one. */
const VALUELESS = new Set(['is_null', 'is_not_null'])

const TABS = [
  ['saved', 'Saved reports', Table2],
  ['build', 'Build a report', Plus],
] as const

export default function ReportBuilder() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('saved')
  const [editing, setEditing] = useState<Definition | null>(null)

  const schema = useQuery({
    queryKey: ['report-builder', 'schema'],
    queryFn: () => api.get<Schema>('/api/v1/report-builder/schema'),
  })
  const defs = useQuery({
    queryKey: ['report-builder', 'definitions'],
    queryFn: () => api.get<List<Definition>>('/api/v1/report-builder/definitions'),
  })

  if (schema.isLoading || defs.isLoading) return <SkeletonTiles count={4} label="Opening the builder…" />
  /* A failed query is an error, never an empty state. "No reports yet" over a
     500 sends a principal off to rebuild something that already exists. */
  if (schema.error) return <ErrorState error={schema.error} />
  if (defs.error) return <ErrorState error={defs.error} />

  const s = schema.data!
  const reports = defs.data?.items ?? []
  const mine = reports.filter((r) => r.created_by_me)
  const shared = reports.filter((r) => !r.created_by_me)

  const openEditor = (d: Definition | null) => {
    setEditing(d)
    setTab('build')
  }

  return (
    <>
      <PageHead
        eyebrow="Analysis"
        title="Custom report builder"
        description="Choose a subject, pick the columns, filter and group it. Saved reports run against whatever you are allowed to see — share one and the reader gets their own rows, not yours."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Saved reports" value={reports.length} icon={BarChart3} />
          <Stat label="Built by you" value={mine.length} />
          <Stat label="Shared with you" value={shared.length} icon={Share2} />
          <Stat
            label="Your reach"
            value={s.scope === 'institution' ? 'Whole school' : 'Your department'}
            hint="Every report you run is bounded by this."
          />
        </CellGrid>

        <div className="flex gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-[14px] transition-colors ' +
                (tab === k
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {tab === 'saved' ? (
          <SavedReports reports={reports} schema={s} onEdit={openEditor} />
        ) : (
          /* key resets every piece of editor state when the report being
             edited changes. Without it, switching from one saved report to
             another leaves the previous report's columns ticked and saves them
             over the new one — the shape of bug that has shipped here nine
             times. */
          <ReportEditor
            key={editing?.id ?? 'new'}
            schema={s}
            editing={editing}
            onDone={(d) => {
              setEditing(d)
              setTab('saved')
            }}
          />
        )}
      </PageBody>
    </>
  )
}

// --- saved reports -----------------------------------------------------------

function SavedReports({
  reports,
  schema,
  onEdit,
}: {
  reports: Definition[]
  schema: Schema
  onEdit: (d: Definition | null) => void
}) {
  const qc = useQueryClient()
  const [running, setRunning] = useState<Definition | null>(null)
  const [sharing, setSharing] = useState<Definition | null>(null)

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/report-builder/definitions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-builder', 'definitions'] }),
  })

  return (
    <div className="space-y-7">
      <Card>
        <CardHeader
          title="Saved reports"
          description="Yours, and the ones shared with a role you hold."
          action={
            <Button size="sm" onClick={() => onEdit(null)}>
              <Plus className="h-3.5 w-3.5" />
              New report
            </Button>
          }
        />
        <Table
          head={['Report', 'Subject', 'Shows', 'Shared with', 'Updated', '']}
          empty={reports.length === 0}
          emptyLabel="No reports yet. Build one and it appears here."
        >
          {reports.map((d) => (
            <tr key={d.id}>
              <Td>
                <span className="font-medium">{d.name}</span>
                {d.description && (
                  <span className="block text-[13px] text-muted-foreground">{d.description}</span>
                )}
              </Td>
              <Td>{d.subject_name || d.subject}</Td>
              <Td>
                <span className="text-[13px] text-muted-foreground">
                  {d.columns.length} column{d.columns.length === 1 ? '' : 's'}
                  {d.group_by.length > 0 && `, grouped by ${d.group_by.join(', ')}`}
                  {d.filters.length > 0 &&
                    `, ${d.filters.length} filter${d.filters.length === 1 ? '' : 's'}`}
                </span>
              </Td>
              <Td>
                {d.shared_with.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {d.shared_with.map((r) => (
                      <Badge key={r} tone="info" solid>
                        {r}
                      </Badge>
                    ))}
                  </span>
                )}
              </Td>
              <Td>{d.updated_at.replace('T', ' ')}</Td>
              <Td className="text-right">
                <span className="inline-flex flex-wrap justify-end gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => setRunning(d)}>
                    <Play className="h-3.5 w-3.5" />
                    Run
                  </Button>
                  {d.can_edit && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setSharing(d)}>
                        <Share2 className="h-3.5 w-3.5" />
                        Share
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onEdit(d)}>
                        Edit
                      </Button>
                      <ConfirmButton
                        confirmLabel="Delete"
                        question="Delete this report for everyone it is shared with?"
                        tone="danger"
                        onConfirm={() => remove.mutate(d.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </ConfirmButton>
                    </>
                  )}
                </span>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {remove.error && (
        <div className="p-5">
          <FormNotice error={remove.error} />
        </div>
      )}

      {sharing && (
        <ShareCard key={sharing.id} report={sharing} schema={schema} onClose={() => setSharing(null)} />
      )}

      {running && <RunPanel key={running.id} report={running} onClose={() => setRunning(null)} />}
    </div>
  )
}

// --- sharing -----------------------------------------------------------------

function ShareCard({
  report,
  schema,
  onClose,
}: {
  report: Definition
  schema: Schema
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [role, setRole] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['report-builder', 'definitions'] })

  const share = useMutation({
    mutationFn: (roleKey: string) =>
      api.post(`/api/v1/report-builder/definitions/${report.id}/shares`, { role_key: roleKey }),
    onSuccess: () => {
      setRole('')
      refresh()
    },
  })
  const unshare = useMutation({
    mutationFn: (roleKey: string) =>
      api.del(
        `/api/v1/report-builder/definitions/${report.id}/shares/${encodeURIComponent(roleKey)}`,
      ),
    onSuccess: refresh,
  })

  const available = schema.roles.filter((r) => !report.shared_with.includes(r.key))

  return (
    <Card>
      <CardHeader
        title={`Share “${report.name}”`}
        description="A role you share with can run this report. They see their own rows — sharing hands over the question, never your answer to it."
        action={
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Close
          </Button>
        }
      />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Field label="Role">
              <Select
                value={role}
                onChange={setRole}
                options={available.map((r) => ({ value: r.key, label: r.name }))}
                placeholder={available.length ? 'Choose a role…' : 'Shared with every role'}
              />
            </Field>
          </div>
          <Button disabled={!role || share.isPending} onClick={() => share.mutate(role)}>
            Share
          </Button>
        </div>

        {report.shared_with.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {report.shared_with.map((r) => (
              <span
                key={r}
                className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[13px]"
              >
                {schema.roles.find((x) => x.key === r)?.name ?? r}
                <button
                  type="button"
                  aria-label={`Stop sharing with ${r}`}
                  onClick={() => unshare.mutate(r)}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <FormNotice error={share.error || unshare.error} />
      </div>
    </Card>
  )
}

// --- running -----------------------------------------------------------------

function RunPanel({ report, onClose }: { report: Definition; onClose: () => void }) {
  const [offset, setOffset] = useState(0)
  const base = `/api/v1/report-builder/definitions/${report.id}/run`

  const run = useQuery({
    queryKey: ['report-builder', 'run', report.id, offset],
    queryFn: () => api.get<RunResult>(`${base}?offset=${offset}`),
  })
  const runs = useQuery({
    queryKey: ['report-builder', 'runs', report.id],
    queryFn: () => api.get<List<RunRow>>(`${base.replace('/run', '/runs')}`),
  })

  return (
    <div className="space-y-7">
      <Card>
        <CardHeader
          title={report.name}
          description={
            run.data
              ? `${run.data.total.toLocaleString('en-IN')} row${run.data.total === 1 ? '' : 's'} within your ${
                  run.data.scope === 'institution' ? 'school' : 'department'
                }, in ${run.data.took_ms} ms.`
              : undefined
          }
          action={
            <>
              {/* Explicit. The export never fires on render, and it goes to the
                  same scoped endpoint the table above is reading, so the file
                  contains exactly the rows shown. */}
              <CsvButton href={base} label="Export CSV" />
              <Button size="sm" variant="ghost" onClick={onClose}>
                <X className="h-3.5 w-3.5" />
                Close
              </Button>
            </>
          }
        />
        {run.isLoading ? (
          <div className="p-5">
            <SkeletonTable columns={5} label="Running…" />
          </div>
        ) : run.error ? (
          <div className="p-5">
            <ErrorState error={run.error} />
          </div>
        ) : (
          <ReportTable result={run.data!} />
        )}
      </Card>

      {run.data && (run.data.has_more || run.data.offset > 0) && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-muted-foreground">
            Rows {run.data.offset + 1}–{run.data.offset + run.data.rows.length} of{' '}
            {run.data.total.toLocaleString('en-IN')}
          </p>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={run.data.offset === 0}
              onClick={() => setOffset(Math.max(0, offset - run.data!.limit))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!run.data.has_more}
              onClick={() => setOffset(offset + run.data!.limit)}
            >
              Next
            </Button>
          </span>
        </div>
      )}

      <Card>
        <CardHeader
          title="Recent runs"
          description="Who ran this, how much it returned, and whether it left the building."
        />
        {runs.error ? (
          <div className="p-5">
            <ErrorState error={runs.error} />
          </div>
        ) : (
          <Table
            head={['When', 'By', { label: 'Rows', align: 'right' }, 'Boundary', 'Exported']}
            empty={(runs.data?.items ?? []).length === 0}
            emptyLabel="Not run yet."
          >
            {(runs.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <Td>{r.ran_at.replace('T', ' ')}</Td>
                <Td>{r.ran_by ?? '—'}</Td>
                <Td className="text-right tabular-nums">{r.row_count.toLocaleString('en-IN')}</Td>
                <Td>{r.scope === 'institution' ? 'Whole school' : 'Department'}</Td>
                <Td>
                  {r.exported ? (
                    <Badge tone="warning">Downloaded</Badge>
                  ) : (
                    <span className="text-muted-foreground">On screen</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

/** The result grid. Columns are decided at run time, so this is generic. */
function ReportTable({ result }: { result: RunResult }) {
  return (
    <>
      {result.truncated && (
        <p className="border-b bg-warning/5 px-5 py-2.5 text-[13px] text-warning">
          This report matches {result.total.toLocaleString('en-IN')} rows and is capped at{' '}
          {result.row_limit.toLocaleString('en-IN')}. Narrow it with a filter, or raise the cap when
          you edit it — a shortened list read as a complete one is worse than no list.
        </p>
      )}
      <Table
        head={result.columns.map((c) => ({
          label: c.label,
          align: c.kind === 'money' || c.kind === 'number' ? ('right' as const) : undefined,
        }))}
        empty={result.rows.length === 0}
        emptyLabel="Nothing matched. The filters may be narrower than you meant, or your reach may not cover these rows."
      >
        {result.rows.map((row, i) => (
          /* A plain <tr> per row, produced by this map rather than by a
             component: Table's labelCells walks the elements it is handed, and
             a component element hides its cells from that walk, which silently
             strips every mobile label. */
          <tr key={i}>
            {result.columns.map((c, j) => (
              <Td
                key={c.key}
                className={c.kind === 'money' || c.kind === 'number' ? 'text-right tabular-nums' : ''}
              >
                {renderCell(row[j], c.kind)}
              </Td>
            ))}
          </tr>
        ))}
      </Table>
    </>
  )
}

/* Every cell arrives as a string or null. Null is a blank the school can act
   on — an em dash, not a zero — because "0" in a fee column and "never
   recorded" are very different facts. */
function renderCell(v: string | null | undefined, kind: string) {
  if (v === null || v === undefined || v === '') return <span className="text-muted-foreground">—</span>
  if (kind === 'money') {
    const n = Number(v)
    return Number.isFinite(n) ? formatPaise(n) : v
  }
  if (kind === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n.toLocaleString('en-IN') : v
  }
  return v
}

// --- the editor --------------------------------------------------------------

function ReportEditor({
  schema,
  editing,
  onDone,
}: {
  schema: Schema
  editing: Definition | null
  onDone: (d: Definition | null) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [subjectKey, setSubjectKey] = useState(editing?.subject ?? schema.subjects[0]?.key ?? '')
  const [columns, setColumns] = useState<string[]>(editing?.columns ?? [])
  const [groupBy, setGroupBy] = useState<string[]>(editing?.group_by ?? [])
  const [filters, setFilters] = useState<FilterClause[]>(editing?.filters ?? [])
  const [sortColumn, setSortColumn] = useState(editing?.sort_column ?? '')
  const [sortDir, setSortDir] = useState(editing?.sort_dir ?? 'asc')
  /* Held as a string, not a number. An emptied box must mean "use the default",
     which is what the server does with an absent value — coercing '' to 0 here
     would save a report that returns nothing and looks broken. */
  const [rowLimit, setRowLimit] = useState(editing ? String(editing.row_limit) : '')
  const [preview, setPreview] = useState<RunResult | null>(null)

  const subject = schema.subjects.find((s) => s.key === subjectKey)

  // Changing subject invalidates every key chosen under the old one.
  const changeSubject = (key: string) => {
    setSubjectKey(key)
    setColumns([])
    setGroupBy([])
    setFilters([])
    setSortColumn('')
    setPreview(null)
  }

  const grouped = groupBy.length > 0
  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key])

  const body = () => ({
    id: editing?.id,
    name,
    description,
    subject: subjectKey,
    columns,
    filters,
    group_by: groupBy,
    sort_column: sortColumn,
    sort_dir: sortDir,
    // Omitted when blank so the server applies its own default.
    ...(rowLimit.trim() === '' ? {} : { row_limit: Number(rowLimit) }),
  })

  const tryIt = useMutation({
    mutationFn: () => api.post<RunResult>('/api/v1/report-builder/preview', body()),
    onSuccess: setPreview,
  })
  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/v1/report-builder/definitions', body()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['report-builder', 'definitions'] })
      onDone(null)
    },
  })

  if (!subject) return <ErrorState error={new Error('That subject is no longer available.')} />

  return (
    <div className="space-y-7">
      <Card>
        <CardHeader
          title={editing ? `Edit “${editing.name}”` : 'Build a report'}
          description="Pick what the report is about, then what it should show."
          action={
            editing && (
              <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            )
          }
        />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Name" required>
              <Input value={name} onChange={setName} placeholder="Fee defaulters, Class 9" />
            </Field>
            <Field label="Subject" required hint={subject.summary}>
              <Select
                value={subjectKey}
                onChange={changeSubject}
                options={schema.subjects.map((s) => ({ value: s.key, label: s.name }))}
              />
            </Field>
            <Field label="Description" wide hint="What question does this answer? The next person will thank you.">
              <Input
                value={description}
                onChange={setDescription}
                placeholder="Unpaid invoices past their due date, by class"
              />
            </Field>
          </FormGrid>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Columns"
          description={
            grouped
              ? 'Grouped: show the columns you grouped by, plus any totals.'
              : 'One row per record. Add a grouping below to count and total instead.'
          }
        />
        <div className="space-y-5 p-5">
          <div>
            <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Details</p>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {subject.dimensions.map((d) => (
                <Checkbox
                  key={d.key}
                  label={d.label}
                  checked={columns.includes(d.key)}
                  onChange={() => toggle(columns, setColumns, d.key)}
                  hint={grouped && !groupBy.includes(d.key) ? 'Group by this to show it' : undefined}
                />
              ))}
            </div>
          </div>

          {subject.measures.length > 0 && (
            <div>
              <p className="mb-2 text-[13px] font-medium text-secondary-foreground">
                Totals{!grouped && ' — available once the report is grouped'}
              </p>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {subject.measures.map((m) => (
                  <Checkbox
                    key={m.key}
                    label={m.label}
                    checked={columns.includes(m.key)}
                    onChange={() => toggle(columns, setColumns, m.key)}
                  />
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Group by</p>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {subject.dimensions.map((d) => (
                <Checkbox
                  key={d.key}
                  label={d.label}
                  checked={groupBy.includes(d.key)}
                  onChange={() => toggle(groupBy, setGroupBy, d.key)}
                />
              ))}
            </div>
          </div>

          <FormGrid>
            <Field label="Sort by" hint="One of the columns you are showing.">
              <Select
                value={sortColumn}
                onChange={setSortColumn}
                options={columns.map((k) => ({
                  value: k,
                  label:
                    subject.dimensions.find((d) => d.key === k)?.label ??
                    subject.measures.find((m) => m.key === k)?.label ??
                    k,
                }))}
                placeholder="Server order"
              />
            </Field>
            <Field label="Direction">
              <Select
                value={sortDir}
                onChange={setSortDir}
                options={[
                  { value: 'asc', label: 'Ascending' },
                  { value: 'desc', label: 'Descending' },
                ]}
              />
            </Field>
            <Field
              label="Row cap"
              hint={`Blank uses the default. At most ${schema.max_row_limit.toLocaleString('en-IN')} — a report over a whole school is slow past that.`}
            >
              <Input value={rowLimit} onChange={setRowLimit} type="number" placeholder="500" />
            </Field>
          </FormGrid>
        </div>
      </Card>

      <FilterCard subject={subject} filters={filters} onChange={setFilters} />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={columns.length === 0 || tryIt.isPending}
          onClick={() => tryIt.mutate()}
        >
          <Play className="h-3.5 w-3.5" />
          {tryIt.isPending ? 'Running…' : 'Try it'}
        </Button>
        <Button disabled={!name.trim() || columns.length === 0 || save.isPending} onClick={() => save.mutate()}>
          {editing ? 'Save changes' : 'Save report'}
        </Button>
        <span className="text-[13px] text-muted-foreground">
          Trying it runs against your own reach — {schema.scope === 'institution' ? 'the whole school' : 'your department'}.
        </span>
      </div>

      <FormNotice error={tryIt.error || save.error} />

      {preview && (
        <Card>
          <CardHeader
            title="Preview"
            description={`${preview.total.toLocaleString('en-IN')} row${preview.total === 1 ? '' : 's'} matched. Save the report to export or share it.`}
          />
          <ReportTable result={preview} />
        </Card>
      )}
    </div>
  )
}

// --- filters -----------------------------------------------------------------

function FilterCard({
  subject,
  filters,
  onChange,
}: {
  subject: Subject
  filters: FilterClause[]
  onChange: (f: FilterClause[]) => void
}) {
  const add = () => {
    const f = subject.fields[0]
    if (!f) return
    onChange([...filters, { field: f.key, op: f.ops[0] }])
  }
  const update = (i: number, patch: Partial<FilterClause>) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const remove = (i: number) => onChange(filters.filter((_, j) => j !== i))

  return (
    <Card>
      <CardHeader
        title="Filters"
        description="Every filter narrows the report. They combine with and."
        action={
          <Button size="sm" variant="secondary" onClick={add}>
            <Filter className="h-3.5 w-3.5" />
            Add a filter
          </Button>
        }
      />
      <div className="space-y-3 p-5">
        {filters.length === 0 ? (
          <EmptyState
            title="No filters"
            body="The report covers everything you are allowed to see. Add a filter to narrow it."
          />
        ) : (
          filters.map((f, i) => {
            const field = subject.fields.find((x) => x.key === f.field)
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                <div className="min-w-[150px] flex-1">
                  <Select
                    value={f.field}
                    onChange={(v) => {
                      const nf = subject.fields.find((x) => x.key === v)
                      // The old operator may be illegal on the new field, so
                      // the whole clause resets rather than being half-valid.
                      update(i, { field: v, op: nf?.ops[0] ?? 'eq', value: '', value2: '', values: [] })
                    }}
                    options={subject.fields.map((x) => ({ value: x.key, label: x.label }))}
                  />
                </div>
                <div className="min-w-[130px]">
                  <Select
                    value={f.op}
                    onChange={(v) => update(i, { op: v, value: '', value2: '', values: [] })}
                    options={(field?.ops ?? []).map((o) => ({ value: o, label: OP_LABELS[o] ?? o }))}
                  />
                </div>
                <FilterValue field={field} clause={f} onChange={(p) => update(i, p)} />
                <button
                  type="button"
                  aria-label="Remove this filter"
                  onClick={() => remove(i)}
                  className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}

/** The value side of one filter, which depends on the field and the operator. */
function FilterValue({
  field,
  clause,
  onChange,
}: {
  field?: FieldDef
  clause: FilterClause
  onChange: (patch: Partial<FilterClause>) => void
}) {
  if (!field) return null
  if (VALUELESS.has(clause.op)) {
    return <span className="text-[13px] text-muted-foreground">no value needed</span>
  }

  const inputType = field.kind === 'date' ? 'date' : field.kind === 'number' ? 'number' : 'text'

  if (clause.op === 'in') {
    if (field.options) {
      return (
        <span className="flex flex-wrap gap-2">
          {field.options.map((o) => (
            <Checkbox
              key={o}
              label={o}
              checked={(clause.values ?? []).includes(o)}
              onChange={() =>
                onChange({
                  values: (clause.values ?? []).includes(o)
                    ? (clause.values ?? []).filter((v) => v !== o)
                    : [...(clause.values ?? []), o],
                })
              }
            />
          ))}
        </span>
      )
    }
    return (
      <div className="min-w-[200px] flex-1">
        <Input
          value={(clause.values ?? []).join(', ')}
          onChange={(v) =>
            onChange({ values: v.split(',').map((x) => x.trim()).filter(Boolean) })
          }
          placeholder="one, two, three"
          srLabel={`${field.label}: values, comma separated`}
        />
      </div>
    )
  }

  if (clause.op === 'between') {
    return (
      <span className="flex flex-1 flex-wrap items-center gap-2">
        <span className="min-w-[130px] flex-1">
          <Input
            value={clause.value ?? ''}
            onChange={(v) => onChange({ value: v })}
            type={inputType}
            srLabel={`${field.label}: from`}
          />
        </span>
        <span className="text-[13px] text-muted-foreground">and</span>
        <span className="min-w-[130px] flex-1">
          <Input
            value={clause.value2 ?? ''}
            onChange={(v) => onChange({ value2: v })}
            type={inputType}
            srLabel={`${field.label}: to`}
          />
        </span>
      </span>
    )
  }

  if (field.options) {
    return (
      <div className="min-w-[150px] flex-1">
        <Select
          value={clause.value ?? ''}
          onChange={(v) => onChange({ value: v })}
          options={field.options.map((o) => ({ value: o, label: o }))}
          placeholder="Choose…"
        />
      </div>
    )
  }

  return (
    <div className="min-w-[150px] flex-1">
      <Input
        value={clause.value ?? ''}
        onChange={(v) => onChange({ value: v })}
        type={inputType}
        placeholder={field.kind === 'uuid' ? 'id' : ''}
        srLabel={`${field.label}: value`}
      />
    </div>
  )
}
