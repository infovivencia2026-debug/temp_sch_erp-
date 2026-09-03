import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Pencil } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Section, type Klass, type Subject, type AcademicYear } from '@/lib/api'
import {
  PageHead, PageBody, Card, Table, Td, Badge, Button, Input, Reload, SkeletonTable, ErrorState,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'
import { formatDate, cn } from '@/lib/utils'

/* The academics reference tables are reached from several roles, so the tab is
   local state seeded from the feature slug rather than a route segment. */
const TAB_FOR: Record<string, string> = {
  academic_structure: 'sections',
  // The principal's "Class Setup" — grades first, because that is the level
  // the entry is named after and sections hang beneath it.
  class_setup: 'classes',
  sections: 'sections',
  classes: 'classes',
  subjects: 'subjects',
  years: 'years',
}

export default function Academics() {
  const { featureSlug } = useParams()
  const nav = useRouteFeature()
  const [tab, setTab] = useState<string | null>(null)
  const tabId = tab ?? TAB_FOR[featureSlug ?? ''] ?? 'sections'
  const tabs = [
    { id: 'sections', label: 'Sections' },
    { id: 'classes', label: 'Classes' },
    { id: 'subjects', label: 'Subjects' },
    { id: 'years', label: 'Academic years' },
  ]

  /* The page band every other screen has, and this one did not.

     Reached from five catalogue entries across four roles — Class Setup,
     Academic structure, Sections, Subjects, Academic years — so the heading
     is whatever the person actually clicked rather than one name that is
     right on one route and wrong on the other four. Without it the screen
     opened straight onto a card with no breadcrumb, no title and nothing
     saying where in the product you had landed. */
  return (
    <>
      <PageHead
        eyebrow={nav.section?.name}
        title={nav.feature?.name ?? 'Academics'}
        description="Reference data the rest of the system hangs off: sections, classes, subjects and the academic year."
      />
      <PageBody>
        <Card>
          <div className="flex gap-1 border-b px-3 pt-2">
            {tabs.map((t: { id: string; label: string }) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'rounded-t-md px-3 py-1.5 text-sm',
                  t.id === tabId ? 'border-b-2 border-primary font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tabId === 'sections' && <Sections />}
          {tabId === 'classes' && <Classes />}
          {tabId === 'subjects' && <Subjects />}
          {tabId === 'years' && <Years />}
        </Card>
      </PageBody>
    </>
  )
}

function Sections() {
  const q = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const [editing, setEditing] = useState<string | null>(null)
  if (q.isLoading) return <SkeletonTable columns={7} />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <>
      <RefreshBar q={q} label="Re-read the sections" />
      <Table
        head={['Section', 'Class teacher', 'Room', 'Enrolled', 'Capacity', 'Utilisation', '']}
        empty={!rows.length}
      >
        {rows.map((s) => {
          const pct = s.capacity ? Math.round((s.enrolled / s.capacity) * 100) : 0
          if (editing === s.id) {
            return (
              <EditRow
                key={s.id}
                cols={7}
                path={`/api/v1/setup/sections/${s.id}`}
                invalidate="sections"
                onClose={() => setEditing(null)}
                deletable={s.enrolled === 0}
                fields={[
                  { key: 'name', label: `${s.class_name} section`, value: s.name },
                  { key: 'room', label: 'Room', value: s.room ?? '' },
                  { key: 'capacity', label: 'Capacity', value: String(s.capacity), numeric: true },
                ]}
              />
            )
          }
          return (
            <tr key={s.id}>
              <Td className="font-medium">{s.class_name}-{s.name}</Td>
              <Td>{s.class_teacher ?? '—'}</Td>
              <Td>{s.room ?? '—'}</Td>
              <Td className="tabular-nums">{s.enrolled}</Td>
              <Td className="tabular-nums">{s.capacity}</Td>
              <Td>
                <Badge tone={pct >= 100 ? 'danger' : pct >= 85 ? 'primary' : 'success'}>{pct}%</Badge>
              </Td>
              <Td><EditButton onClick={() => setEditing(s.id)} /></Td>
            </tr>
          )
        })}
      </Table>
    </>
  )
}

function Classes() {
  const q = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const [editing, setEditing] = useState<string | null>(null)
  if (q.isLoading) return <SkeletonTable columns={4} />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <>
      <RefreshBar q={q} label="Re-read the classes" />
      <Table head={['Class', 'Level', 'Stream', '']} empty={!rows.length}>
        {rows.map((c) =>
          editing === c.id ? (
            <EditRow
              key={c.id}
              cols={4}
              path={`/api/v1/setup/classes/${c.id}`}
              invalidate="classes"
              onClose={() => setEditing(null)}
              deletable
              fields={[
                { key: 'name', label: 'Name', value: c.name },
                { key: 'level', label: 'Level', value: String(c.level), numeric: true },
                { key: 'stream', label: 'Stream', value: c.stream ?? '' },
              ]}
            />
          ) : (
            <tr key={c.id}>
              <Td className="font-medium">{c.name}</Td>
              <Td className="tabular-nums">{c.level}</Td>
              <Td>{c.stream ?? '—'}</Td>
              <Td><EditButton onClick={() => setEditing(c.id)} /></Td>
            </tr>
          ),
        )}
      </Table>
    </>
  )
}

function Subjects() {
  const q = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<List<Subject>>('/api/v1/academics/subjects'),
  })
  const [editing, setEditing] = useState<string | null>(null)
  if (q.isLoading) return <SkeletonTable columns={4} />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <>
      <RefreshBar q={q} label="Re-read the subjects" />
      <Table head={['Code', 'Subject', 'Type', '']} empty={!rows.length}>
        {rows.map((s) =>
          editing === s.id ? (
            <EditRow
              key={s.id}
              cols={4}
              path={`/api/v1/setup/subjects/${s.id}`}
              invalidate="subjects"
              onClose={() => setEditing(null)}
              deletable
              fields={[
                { key: 'code', label: 'Code', value: s.code },
                { key: 'name', label: 'Name', value: s.name },
              ]}
            />
          ) : (
            <tr key={s.id}>
              <Td className="font-mono text-xs">{s.code}</Td>
              <Td className="font-medium">{s.name}</Td>
              <Td>
                <Badge tone={s.is_scholastic ? 'primary' : 'neutral'}>
                  {s.is_scholastic ? 'Scholastic' : 'Co-scholastic'}
                </Badge>
              </Td>
              <Td><EditButton onClick={() => setEditing(s.id)} /></Td>
            </tr>
          ),
        )}
      </Table>
    </>
  )
}

function Years() {
  const q = useQuery({
    queryKey: ['years'],
    queryFn: () => api.get<List<AcademicYear>>('/api/v1/academics/years'),
  })
  const [editing, setEditing] = useState<string | null>(null)
  if (q.isLoading) return <SkeletonTable columns={5} />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <>
      <RefreshBar q={q} label="Re-read the years" />
      <Table head={['Year', 'Starts', 'Ends', '', '']} empty={!rows.length}>
        {rows.map((y) =>
          editing === y.id ? (
            <EditRow
              key={y.id}
              cols={5}
              path={`/api/v1/setup/academic-years/${y.id}`}
              invalidate="years"
              onClose={() => setEditing(null)}
              fields={[
                { key: 'name', label: 'Name', value: y.name },
                { key: 'starts_on', label: 'Starts', value: y.starts_on, date: true },
                { key: 'ends_on', label: 'Ends', value: y.ends_on, date: true },
              ]}
            />
          ) : (
            <tr key={y.id}>
              <Td className="font-medium">{y.name}</Td>
              <Td>{formatDate(y.starts_on)}</Td>
              <Td>{formatDate(y.ends_on)}</Td>
              <Td>{y.is_current && <Badge tone="success">Current</Badge>}</Td>
              <Td><EditButton onClick={() => setEditing(y.id)} /></Td>
            </tr>
          ),
        )}
      </Table>
    </>
  )
}

/* One editor for four reference tables.

   Sections, classes, subjects and years are all the same shape of edit: a
   handful of short fields, a save, and sometimes a delete the server may
   refuse. Writing that four times would give four places for the refusal to be
   swallowed, which is the failure that matters here — the whole point of the
   delete guards is that the reason reaches the person pressing the button.

   PATCH rather than PUT, so a row with thirty columns is not blanked by a form
   that edits three. */
interface EditField {
  key: string
  label: string
  value: string
  numeric?: boolean
  date?: boolean
}

function EditRow({
  cols,
  path,
  invalidate,
  fields,
  deletable,
  onClose,
}: {
  cols: number
  path: string
  invalidate: string
  fields: EditField[]
  deletable?: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [v, setV] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.value])),
  )
  const [failed, setFailed] = useState('')

  const done = () => {
    qc.invalidateQueries({ queryKey: [invalidate] })
    onClose()
  }
  const blame = (e: unknown) =>
    setFailed(e instanceof Error ? e.message : 'That did not save.')

  const save = useMutation({
    mutationFn: () =>
      api.patch(
        path,
        Object.fromEntries(
          fields.map((f) => [f.key, f.numeric ? Number(v[f.key]) || 0 : v[f.key].trim()]),
        ),
      ),
    onSuccess: done,
    onError: blame,
  })
  const remove = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: done,
    onError: blame,
  })

  return (
    <tr>
      <Td colSpan={cols}>
        <div className="flex flex-wrap items-end gap-2">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground">{f.label}</span>
              <span className={f.date ? 'w-40' : f.numeric ? 'w-20' : 'w-36'}>
                <Input
                  type={f.date ? 'date' : 'text'}
                  value={v[f.key]}
                  onChange={(nv) => setV({ ...v, [f.key]: nv })}
                />
              </span>
            </label>
          ))}
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          {deletable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {/* The server refuses a delete that would take a register, a set of
            marks or money collected with it, and says which. Printing it here
            is the only reason those guards are worth having. */}
        {failed && <p className="mt-2 text-[12.5px] text-danger">{failed}</p>}
      </Td>
    </tr>
  )
}

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} title="Edit this row">
      <Pencil className="h-3.5 w-3.5" />
    </Button>
  )
}

function RefreshBar({
  q,
  label,
}: {
  q: { refetch: () => unknown; isFetching: boolean }
  label: string
}) {
  return (
    <div className="flex justify-end px-1 pb-2">
      <Reload onClick={() => q.refetch()} busy={q.isFetching} label={label} />
    </div>
  )
}
