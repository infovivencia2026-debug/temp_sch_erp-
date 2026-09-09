import { Suspense, useEffect, useMemo, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { industryPath, useNavigate } from '@/lib/nav'
import {
  Download, Eye, MoreHorizontal, Pencil, Plus, Printer, Send, Trash2, Upload, CheckCircle2,
} from 'lucide-react'
import {
  Avatar, Badge, Button, Drawer, Dropdown, Field, Input, Modal, Select, Tabs,
  TableSkeleton, Textarea, useToast,
} from '@/components/ui'
import { DataTable } from '@/components/tables/DataTable'
import { PageHeader } from '@/components/layout/PageHeader'
import { activeModuleMap, activeModules, homePathFor, modulesForRole, type TabDef } from '@/industries'
import { canWrite } from '@/industries/access'
import { makeRows, parseCols, toneFor, type Row } from '@/data/generator'
import { CUSTOM_VIEWS } from '@/pages/custom'
import { useApp } from '@/hooks/useAppState'


export function ModulePage() {
  const { moduleId = '', tabId } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const app = useApp()
  const mod = activeModuleMap()[moduleId]

  /* The sidebar has always been filtered by role, but the routes were not, so
   * typing or keeping a URL reached anything: a student on /students got the
   * full directory, every classmate's CGPA and fee status included. Deciding
   * what a role may open belongs here, at the page, not in the navigation that
   * happens to link to it. */
  const reachable = useMemo(
    () => new Set(modulesForRole(app.role).map((m) => m.id)),
    [app.role, app.industryId],
  )

  /* Reaching a page and being allowed to change it are separate questions. A
   * student opens LMS to find their courses; they are not offered "Create
   * course", Import, Add, bulk approve or delete on it. */
  const mayWrite = canWrite(app.role, moduleId)

  // Rows are generated synchronously in well under a frame, so there is
  // nothing to wait for: rendering immediately is both faster and honest. A
  // skeleton here would only be simulating a network that does not exist.
  const loading = false

  if (mod && !reachable.has(moduleId)) {
    return <Navigate to={industryPath(homePathFor(app.role), app.industryId)} replace />
  }

  if (!mod) {
    return (
      <div className="p-10 text-center">
        <p className="text-sm font-medium">This module is not part of {app.industry.label}</p>
        <div className="mt-3 flex justify-center gap-2">
          <Button onClick={() => nav('/dashboard')}>Back to dashboard</Button>
          <Button variant="primary" onClick={() => nav('/')}>All industries</Button>
        </div>
      </div>
    )
  }

  // Whole-module custom page (dashboard, analytics, settings, portals…).
  // Views arrive as their own chunk, so a skeleton covers the fetch.
  if (mod.custom) {
    const View = CUSTOM_VIEWS[mod.custom]
    if (View) return <Suspense fallback={<ViewFallback />}><View moduleId={mod.id} /></Suspense>
  }

  const activeTab = mod.tabs.find((t) => t.id === tabId) ?? mod.tabs[0]
  if (!activeTab) return null

  return (
    <div className="print-area">
      <PageHeader
        title={mod.label}
        eyebrow={mod.group}
        index={activeModules().findIndex((m) => m.id === mod.id) + 1}
        subtitle={`${app.campus} · ${app.year}`}
        crumbs={[{ label: mod.group }, { label: mod.label }]}
        actions={
          <>
            <Button size="sm" icon={Printer} onClick={() => window.print()}>Print</Button>
            <Button size="sm" icon={Download} onClick={() => toast({ title: 'Export queued', desc: `${mod.label.toLowerCase()}-${activeTab.id}.xlsx`, tone: 'success' })}>Export</Button>
            {mayWrite && mod.primaryAction && <PrimaryAction label={mod.primaryAction} module={mod.label} />}
          </>
        }
      />
      <div className="page-tabs px-6 sm:px-10"><Tabs
        tabs={mod.tabs.map((t) => ({ id: t.id, label: t.label }))}
        value={activeTab.id}
        onChange={(id) => nav(`/${mod.id}/${id}`)}
      /></div>
      <div className="page-body px-6 py-10 sm:px-10">
        <TabBody key={`${app.industryId}-${mod.id}-${activeTab.id}`} moduleId={mod.id} moduleLabel={mod.label} tab={activeTab} loading={loading} industryId={app.industryId} />
      </div>
    </div>
  )
}

/** Holds the page's shape while a lazily-loaded view arrives. */
function ViewFallback() {
  return (
    <div className="px-6 py-10 sm:px-10">
      <TableSkeleton rows={6} cols={5} />
    </div>
  )
}

function PrimaryAction({ label, module }: { label: string; module: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>{label}</Button>
      <RecordForm open={open} onClose={() => setOpen(false)} title={label} module={module} onSave={() => {}} />
    </>
  )
}

function TabBody({ moduleId, moduleLabel, tab, loading, industryId }: {
  moduleId: string; moduleLabel: string; tab: TabDef; loading: boolean; industryId: string
}) {
  const toast = useToast()
  const app = useApp()
  // Same rule as the page header: read is universal, write is granted.
  const mayWrite = canWrite(app.role, moduleId)
  const [drawerRow, setDrawerRow] = useState<Row | null>(null)
  const [editRow, setEditRow] = useState<Row | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  if (tab.custom) {
    const View = CUSTOM_VIEWS[tab.custom]
    // A bespoke tab builds its own toolbar, so the region carries the verdict
    // and the mutating calls to action inside it are withheld.
    if (View) return (
      <div data-readonly={mayWrite ? undefined : 'true'}>
        <Suspense fallback={<TableSkeleton />}><View moduleId={moduleId} /></Suspense>
      </div>
    )
  }

  const columns = useMemo(() => parseCols(tab.cols ?? []), [tab])
  const seeded = useMemo(() => makeRows(`${moduleId}:${tab.id}`, columns, tab.count ?? 24), [moduleId, tab, columns, industryId])
  const [rows, setRows] = useState<Row[]>(seeded)
  useEffect(() => { setRows(seeded) }, [seeded])

  /* Delete first, offer the way back second.
     "Are you sure?" is answered yes by everyone, including the people who are
     not sure, so it stops nothing and costs a click every time. An undo is the
     opposite trade: no cost when you meant it, and a real recovery when you
     did not.
     Positions are captured with the rows. Restoring to the end of the list
     would technically undo the deletion while losing the sort you were reading
     it in — which is not what the reader asked to have back. Reinserting from
     the lowest index up keeps every later index valid as the list grows. */
  const removeRows = (victims: Row[], describe: string) => {
    const ids = new Set(victims.map((v) => v._id))
    const taken = rows
      .map((r, i) => ({ row: r, at: i }))
      .filter((e) => ids.has(e.row._id))

    setRows((r) => r.filter((x) => !ids.has(x._id)))
    toast({
      title: describe,
      desc: 'Removed from the local prototype state.',
      tone: 'error',
      action: {
        label: 'Undo',
        onClick: () => setRows((r) => {
          const next = [...r]
          taken.forEach(({ row, at }) => next.splice(Math.min(at, next.length), 0, row))
          return next
        }),
      },
    })
  }

  const addRow = (values: Record<string, string>) => {
    const fresh: Row = { _id: `new-${Date.now()}` }
    columns.forEach((c, i) => { fresh[c.key] = values[c.key] || (i === 0 ? `NEW-${Math.floor(Math.random() * 9000 + 1000)}` : '—') })
    setRows((r) => [fresh, ...r])
    toast({ title: 'Record created', desc: `Added to ${tab.label}. Stored in local state only.`, tone: 'success' })
  }

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        onRowClick={setDrawerRow}
        selectable={mayWrite}
        toolbar={mayWrite ? (
          <>
            <Button size="sm" icon={Upload} onClick={() => toast({ title: 'Import wizard', desc: 'CSV mapping step is mocked in this prototype.', tone: 'info' })}>Import</Button>
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>Add</Button>
          </>
        ) : undefined}
        bulkActions={!mayWrite ? undefined : (ids, clear) => (
          <>
            <Button size="sm" icon={Send} onClick={() => { toast({ title: `Notification sent to ${ids.length} records`, tone: 'success' }); clear() }}>Notify</Button>
            <Button size="sm" icon={CheckCircle2} onClick={() => { toast({ title: `${ids.length} records approved`, tone: 'success' }); clear() }}>Approve</Button>
            <Button size="sm" variant="danger" icon={Trash2}
              onClick={() => {
                removeRows(rows.filter((x) => ids.includes(x._id)),
                  `${ids.length} record${ids.length === 1 ? '' : 's'} deleted`)
                clear()
              }}>
              Delete
            </Button>
          </>
        )}
        rowActions={(row) => (
          <Dropdown
            align="right"
            trigger={<Button size="sm" variant="ghost"><MoreHorizontal className="h-4 w-4" /></Button>}
            items={[
              { label: 'View details', icon: Eye, onClick: () => setDrawerRow(row) },
              // Reading a record is always allowed; changing it is not.
              ...(mayWrite ? [
                { label: 'Edit record', icon: Pencil, onClick: () => setEditRow(row) },
                { label: 'Send notification', icon: Send, onClick: () => toast({ title: 'Notification sent', desc: String(row[columns[0].key]), tone: 'success' }) },
              ] : []),
              { label: 'Download', icon: Download, onClick: () => toast({ title: 'Download started', desc: `${row[columns[0].key]}.pdf`, tone: 'success' }) },
              ...(mayWrite ? ['sep' as const,
                { label: 'Delete', icon: Trash2, danger: true,
                  onClick: () => removeRows([row], `Deleted “${row[columns[0].key]}”`) },
              ] : []),
            ]}
          />
        )}
      />

      {/* Record detail drawer */}
      <Drawer
        open={!!drawerRow}
        onClose={() => setDrawerRow(null)}
        title={drawerRow ? String(drawerRow[columns[0].key]) : ''}
        subtitle={`${moduleLabel} › ${tab.label}`}
        footer={
          <>
            <Button onClick={() => { setEditRow(drawerRow); setDrawerRow(null) }} icon={Pencil}>Edit</Button>
            <Button variant="primary" icon={CheckCircle2}
              onClick={() => { toast({ title: 'Record approved', desc: 'Status moved to Approved.', tone: 'success' }); setDrawerRow(null) }}>
              Approve
            </Button>
          </>
        }
      >
        {drawerRow && (
          <div className="p-7">
            <DrawerSummary row={drawerRow} columns={columns} />
            <h4 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide muted">All fields</h4>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {columns.map((c) => (
                <div key={c.key}>
                  <dt className="text-[11px] uppercase tracking-wide muted">{c.label}</dt>
                  <dd className="mt-0.5 text-sm">
                    {c.type === 'status' || c.type === 'badge'
                      ? <Badge tone={toneFor(String(drawerRow[c.key]))}>{String(drawerRow[c.key])}</Badge>
                      : String(drawerRow[c.key])}
                  </dd>
                </div>
              ))}
            </dl>
            <h4 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide muted">Activity timeline</h4>
            <ol className="relative space-y-4 border-l pl-4">
              {[
                ['Record created', 'System · 12 Jun 2026'],
                ['Assigned to reviewer', 'Meera Nair · 18 Jun 2026'],
                ['Documents verified', 'Rohan Desai · 02 Jul 2026'],
                ['Status updated', 'Priya Raghavan · 04 Aug 2026'],
              ].map(([t, s]) => (
                <li key={t} className="relative">
                  <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-brand-500 ring-4 ring-[rgb(var(--surface))]" />
                  <p className="text-[13px] font-medium">{t}</p>
                  <p className="text-[11px] muted">{s}</p>
                </li>
              ))}
            </ol>
            <h4 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide muted">Internal notes</h4>
            <Textarea placeholder="Add a note visible to your team…" />
            <Button size="sm" className="mt-2" onClick={() => toast({ title: 'Note saved', tone: 'success' })}>Save note</Button>
          </div>
        )}
      </Drawer>

      <RecordForm
        open={addOpen} onClose={() => setAddOpen(false)}
        title={`Add to ${tab.label}`} module={moduleLabel}
        columns={columns} onSave={addRow}
      />
      <RecordForm
        open={!!editRow} onClose={() => setEditRow(null)}
        title="Edit record" module={moduleLabel} columns={columns} initial={editRow ?? undefined}
        onSave={(values) => {
          setRows((r) => r.map((x) => (x._id === editRow?._id ? { ...x, ...values } : x)))
          toast({ title: 'Changes saved', tone: 'success' })
        }}
      />
    </>
  )
}

/** Generic create/edit form derived from the tab's column spec, with required-field validation. */
export function RecordForm({ open, onClose, title, module, columns = [], initial, onSave }: {
  open: boolean; onClose: () => void; title: string; module: string
  columns?: ReturnType<typeof parseCols>; initial?: Row
  onSave: (values: Record<string, string>) => void
}) {
  const fields = columns.length ? columns.slice(0, 8) : parseCols(['id:Reference', 'person:Name', 'date:Date', 'text:Notes@—'])
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    const init: Record<string, string> = {}
    fields.forEach((f) => { init[f.key] = initial ? String(initial[f.key] ?? '') : '' })
    setValues(init); setErrors({})
  }, [open])

  const submit = () => {
    const errs: Record<string, string> = {}
    fields.slice(0, 3).forEach((f) => { if (!values[f.key]?.trim()) errs[f.key] = `${f.label} is required` })
    setErrors(errs)
    if (Object.keys(errs).length) return
    onSave(values)
    onClose()
  }

  return (
    <Modal
      open={open} onClose={onClose} title={title} subtitle={`${module} · prototype form — data stays in your browser`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save record</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f, i) => (
          <Field key={f.key} label={f.label} required={i < 3} error={errors[f.key]}>
            {f.options && f.options.length > 1 ? (
              <Select options={['', ...f.options]} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <Input
                type={f.type.startsWith('date') ? 'date' : f.type === 'int' || f.type === 'money' ? 'number' : 'text'}
                value={values[f.key] ?? ''}
                placeholder={`Enter ${f.label.toLowerCase()}`}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  )
}


/** A drawer that opens with a flat list of twenty fields makes the reader do
 *  the triage. Lead with identity, money and status; the rest can wait. */
function DrawerSummary({ row, columns }: { row: Row; columns: ReturnType<typeof parseCols> }) {
  const person = columns.find((c) => c.type === 'person')
  const ref = columns.find((c) => c.type === 'id' || c.type === 'code')
  const status = columns.find((c) => c.type === 'status')
  const amount = columns.find((c) => c.type === 'money' || c.type === 'moneysm')
  const when = columns.find((c) => c.type.startsWith('date'))
  const pct = columns.find((c) => c.type === 'pct')

  const facts = [amount, pct, when].filter(Boolean).slice(0, 3) as typeof columns

  return (
    <div className="rounded-xl hairline p-4">
      <div className="flex flex-wrap items-center gap-3">
        {person && <Avatar name={String(row[person.key])} size={40} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">
            {person ? String(row[person.key]) : String(row[columns[0].key])}
          </p>
          {ref && <p className="truncate text-[12px] muted">{String(row[ref.key])}</p>}
        </div>
        {status && <Badge tone={toneFor(String(row[status.key]))} dot>{String(row[status.key])}</Badge>}
      </div>
      {facts.length > 0 && (
        <dl className="mt-4 grid gap-3 border-t pt-3 sm:grid-cols-3">
          {facts.map((c) => (
            <div key={c.key}>
              <dt className="text-[10px] uppercase tracking-wide muted">{c.label}</dt>
              <dd className="text-[15px] font-semibold tabular-nums">{String(row[c.key])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
