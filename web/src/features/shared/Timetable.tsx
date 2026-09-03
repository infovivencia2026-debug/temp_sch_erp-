import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List, type Section, type Period, type TimetableEntry, type Teacher } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Select, Loading, SkeletonTable, ErrorState } from '@/components/ui'
import { cn } from '@/lib/utils'
import WeekGrid from '@/components/WeekGrid'

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
  const held = session.data?.permissions ?? []
  const isStaff = held.includes('academics.read')

  /* Who may read the whole staff's load.
   *
   * "Faculty workload" lists every colleague, their weekly periods and who is
   * overloaded. That is a management view — the question a head of department
   * or a principal asks before moving a class, and it is answered by naming
   * which of your colleagues is carrying the most.
   *
   * It was offered to anybody who could read academics, which is every
   * teacher in the school. A teacher needs their own week and the week of a
   * class they teach; they have no business with a league table of their
   * colleagues, and being on one is worse. Gated on academics.write, which is
   * what separates the people who move periods from the people who teach
   * them. */
  const mayPlan = held.includes('academics.write')

  const tabs = mayPlan
    ? [
        { id: 'grid', label: 'Grid' },
        { id: 'workload', label: 'Faculty workload' },
      ]
    : [{ id: 'grid', label: isStaff ? 'My week' : 'My week' }]
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
      {tabId === 'grid' || !mayPlan ? <Grid isStaff={isStaff} /> : <Workload />}
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

  /* One grid, shared with the master timetable.

     This drew its own: days down the side, periods across the top, subject
     codes in the cells and breaks dropped entirely — a second way to read a
     thing everybody in the school already reads one way. The principal, the
     head of department, the class teacher and the subject teacher now see the
     same shape, so a teacher checking their own week and a principal checking
     the school are reading one document. */
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
              : 'The whole week for this class, whoever teaches it.'}
          </span>
        </div>
      )}

      <div className="p-4">
        <WeekGrid
          entries={(entries.data?.items ?? []).map((e) => ({
            weekday: e.weekday,
            period_id: e.period_id,
            title: e.subject_name || e.subject_code,
            /* On your own week the teacher is always you, and printing your
               own name in thirty cells tells you nothing. Which class to walk
               into does. On a section's week it is the other way round. */
            detail:
              view.mode === 'me'
                ? `${e.class_name}-${e.section_name}${e.room ? ` · ${e.room}` : ''}`
                : (e.teacher_name ?? 'no teacher') + (e.room ? ` · ${e.room}` : ''),
            unstaffed: view.mode !== 'me' && !e.teacher_name,
          }))}
          periods={periods.data?.items ?? []}
          empty={
            view.mode === 'me'
              ? 'You have no periods on the timetable yet.'
              : 'Nothing timetabled for this class yet.'
          }
        />
      </div>
    </>
  )
}

function Workload() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/timetable/teachers'),
  })
  if (isLoading) return <SkeletonTable columns={4} />
  if (error) return <ErrorState error={error} />
  const rows = data?.items ?? []
  return (
    <Table head={['Code', 'Teacher', 'Weekly periods', 'Load']} empty={!rows.length}>
      {rows.map((t) => {
        // Absent for anybody who does not plan the timetable.
        const load = t.weekly_periods ?? 0
        return (
        <tr key={t.user_id}>
          <Td className="font-mono text-xs">{t.employee_code}</Td>
          <Td className="font-medium">{t.full_name}</Td>
          <Td className="tabular-nums">{t.weekly_periods ?? '—'}</Td>
          <Td>
            {/* 30 periods a week is the usual CBSE ceiling for a full-time
                teacher; over that is worth flagging, not blocking. */}
            <Badge tone={load > 30 ? 'danger' : load > 24 ? 'primary' : 'success'}>
              {load > 30 ? 'Overloaded' : load > 24 ? 'Heavy' : 'Normal'}
            </Badge>
          </Td>
        </tr>
        )
      })}
    </Table>
  )
}
