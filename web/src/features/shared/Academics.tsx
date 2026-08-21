import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type List, type Section, type Klass, type Subject, type AcademicYear } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Loading, ErrorState } from '@/components/ui'
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
  const [tab, setTab] = useState<string | null>(null)
  const tabId = tab ?? TAB_FOR[featureSlug ?? ''] ?? 'sections'
  const tabs = [
    { id: 'sections', label: 'Sections' },
    { id: 'classes', label: 'Classes' },
    { id: 'subjects', label: 'Subjects' },
    { id: 'years', label: 'Academic years' },
  ]

  return (
    <Card>
      <CardHeader title="Academics" description="Reference data the rest of the system hangs off" />
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
  )
}

function Sections() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  const rows = data?.items ?? []
  return (
    <Table head={['Section', 'Class teacher', 'Room', 'Enrolled', 'Capacity', 'Utilisation']} empty={!rows.length}>
      {rows.map((s) => {
        const pct = s.capacity ? Math.round((s.enrolled / s.capacity) * 100) : 0
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
          </tr>
        )
      })}
    </Table>
  )
}

function Classes() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  const rows = data?.items ?? []
  return (
    <Table head={['Class', 'Level', 'Stream']} empty={!rows.length}>
      {rows.map((c) => (
        <tr key={c.id}>
          <Td className="font-medium">{c.name}</Td>
          <Td className="tabular-nums">{c.level}</Td>
          <Td>{c.stream ?? '—'}</Td>
        </tr>
      ))}
    </Table>
  )
}

function Subjects() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<List<Subject>>('/api/v1/academics/subjects'),
  })
  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  const rows = data?.items ?? []
  return (
    <Table head={['Code', 'Subject', 'Type']} empty={!rows.length}>
      {rows.map((s) => (
        <tr key={s.id}>
          <Td className="font-mono text-xs">{s.code}</Td>
          <Td className="font-medium">{s.name}</Td>
          <Td>
            <Badge tone={s.is_scholastic ? 'primary' : 'neutral'}>
              {s.is_scholastic ? 'Scholastic' : 'Co-scholastic'}
            </Badge>
          </Td>
        </tr>
      ))}
    </Table>
  )
}

function Years() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['years'],
    queryFn: () => api.get<List<AcademicYear>>('/api/v1/academics/years'),
  })
  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  const rows = data?.items ?? []
  return (
    <Table head={['Year', 'Starts', 'Ends', '']} empty={!rows.length}>
      {rows.map((y) => (
        <tr key={y.id}>
          <Td className="font-medium">{y.name}</Td>
          <Td>{formatDate(y.starts_on)}</Td>
          <Td>{formatDate(y.ends_on)}</Td>
          <Td>{y.is_current && <Badge tone="success">Current</Badge>}</Td>
        </tr>
      ))}
    </Table>
  )
}
