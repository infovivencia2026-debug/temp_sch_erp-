import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List, type Section, type Period, type TimetableEntry, type Teacher } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Select, Loading, ErrorState } from '@/components/ui'
import { cn, WEEKDAYS } from '@/lib/utils'

/* One screen, two audiences.

   A member of staff plans the week: they pick a section and can look at how
   the teaching load falls across the faculty. A student or a parent has no
   section to pick — they have theirs — and no business reading a staff
   workload report. Showing them both meant a picker that 403'd on load and a
   tab that answered 403 when opened.

   The endpoint now returns only the caller's own sections, so the difference
   here is entirely about what to offer, not what to hide. */
export default function Timetable() {
  const [tabId, setTab] = useState('grid')
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  const isStaff = session.data?.permissions.includes('academics.read') ?? false

  const tabs = isStaff
    ? [
        { id: 'grid', label: 'Grid' },
        { id: 'workload', label: 'Faculty workload' },
      ]
    : [{ id: 'grid', label: 'My week' }]
  return (
    <Card>
      <CardHeader title="Timetable" />
      <div className={cn('flex gap-1 border-b px-3 pt-2', tabs.length === 1 && 'hidden')}>
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
      {tabId === 'grid' || !isStaff ? <Grid isStaff={isStaff} /> : <Workload />}
    </Card>
  )
}

/* Whose week is on screen.

   'me' is a teacher's own teaching week — the periods they stand in front of
   a class for. It is the default for staff and it is the thing "My timetable"
   was named after, and could not show: the screen opened on a section picker
   and an empty grid, so a teacher had to choose one of their own classes
   before seeing anything, and then saw that class's week rather than theirs.

   A class teacher wants the other one too — the whole week of the section
   they are responsible for, including the periods somebody else teaches — so
   picking a section is still offered, it is simply no longer compulsory. */
type View = { mode: 'me' } | { mode: 'section'; sectionId: string }

function Grid({ isStaff }: { isStaff: boolean }) {
  const [view, setView] = useState<View>(isStaff ? { mode: 'me' } : { mode: 'section', sectionId: '' })
  const sectionId = view.mode === 'section' ? view.sectionId : ''

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
    enabled: isStaff,
  })
  const periods = useQuery({
    queryKey: ['periods'],
    queryFn: () => api.get<List<Period>>('/api/v1/timetable/periods'),
  })
  const query =
    view.mode === 'me' ? '?teacher_id=me' : sectionId ? `?section_id=${sectionId}` : ''
  const entries = useQuery({
    queryKey: ['timetable', view.mode, sectionId],
    queryFn: () => api.get<List<TimetableEntry>>(`/api/v1/timetable/entries${query}`),
  })

  if (periods.isLoading || entries.isLoading) return <Loading />
  if (entries.error) return <ErrorState error={entries.error} />

  const ps = (periods.data?.items ?? []).filter((p) => !p.is_break)
  // weekday is ISO-8601 from the DB (1 = Monday), so index into WEEKDAYS with
  // weekday-1 rather than treating 0 as Sunday.
  const byCell = new Map<string, TimetableEntry>()
  for (const e of entries.data?.items ?? []) byCell.set(`${e.weekday}:${e.period_id}`, e)

  return (
    <>
      {isStaff && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <Select
            value={view.mode === 'me' ? '__me__' : sectionId}
            onChange={(v) =>
              setView(v === '__me__' ? { mode: 'me' } : { mode: 'section', sectionId: v })
            }
            options={[
              { value: '__me__', label: 'My own teaching week' },
              ...(sections.data?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.class_name}-${s.name}`,
              })),
            ]}
          />
          <span className="text-xs text-muted-foreground">
            {view.mode === 'me'
              ? 'Every period you teach, across all your classes.'
              : 'The whole week for this section, whoever teaches it.'}
          </span>
        </div>
      )}

      <div className="overflow-x-auto p-4">
        <table className="w-full min-w-[640px] border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th className="w-24" />
              {ps.map((p) => (
                <th key={p.id} className="rounded bg-muted px-2 py-1.5 text-xs font-medium">
                  <div>{p.name}</div>
                  <div className="font-normal text-muted-foreground">{p.starts_at}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6].map((wd) => (
              <tr key={wd}>
                <th className="rounded bg-muted px-2 py-1.5 text-xs font-medium">{WEEKDAYS[wd - 1]}</th>
                {ps.map((p) => {
                  const e = byCell.get(`${wd}:${p.id}`)
                  return (
                    <td key={p.id} className="rounded border p-1.5 align-top">
                      {e ? (
                        <>
                          <div className="text-xs font-medium">{e.subject_code}</div>
                          {/* On your own week the teacher is always you, and
                              printing your own name in thirty cells tells you
                              nothing. Which room to walk into does. */}
                          <div className="truncate text-[12px] text-muted-foreground">
                            {view.mode === 'me'
                              ? `${e.class_name}-${e.section_name}${e.room ? ` · ${e.room}` : ''}`
                              : (e.teacher_name ?? 'Unassigned')}
                          </div>
                        </>
                      ) : (
                        <span className="text-[12px] text-muted-foreground">—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Workload() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/timetable/teachers'),
  })
  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  const rows = data?.items ?? []
  return (
    <Table head={['Code', 'Teacher', 'Weekly periods', 'Load']} empty={!rows.length}>
      {rows.map((t) => (
        <tr key={t.user_id}>
          <Td className="font-mono text-xs">{t.employee_code}</Td>
          <Td className="font-medium">{t.full_name}</Td>
          <Td className="tabular-nums">{t.weekly_periods}</Td>
          <Td>
            {/* 30 periods a week is the usual CBSE ceiling for a full-time
                teacher; over that is worth flagging, not blocking. */}
            <Badge tone={t.weekly_periods > 30 ? 'danger' : t.weekly_periods > 24 ? 'primary' : 'success'}>
              {t.weekly_periods > 30 ? 'Overloaded' : t.weekly_periods > 24 ? 'Heavy' : 'Normal'}
            </Badge>
          </Td>
        </tr>
      ))}
    </Table>
  )
}
