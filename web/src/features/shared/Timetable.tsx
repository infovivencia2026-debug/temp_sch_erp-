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

function Grid({ isStaff }: { isStaff: boolean }) {
  const [sectionId, setSectionId] = useState('')

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
    enabled: isStaff,
  })
  const periods = useQuery({
    queryKey: ['periods'],
    queryFn: () => api.get<List<Period>>('/api/v1/timetable/periods'),
  })
  const entries = useQuery({
    queryKey: ['timetable', sectionId],
    queryFn: () =>
      api.get<List<TimetableEntry>>(
        `/api/v1/timetable/entries${sectionId ? `?section_id=${sectionId}` : ''}`,
      ),
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
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Select
            value={sectionId}
            onChange={setSectionId}
            placeholder="All sections"
            options={(sections.data?.items ?? []).map((s) => ({
              value: s.id, label: `${s.class_name}-${s.name}`,
            }))}
          />
          {!sectionId && (
            <span className="text-xs text-muted-foreground">
              Pick a section — the grid collapses overlapping entries otherwise.
            </span>
          )}
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
                          <div className="truncate text-[12px] text-muted-foreground">
                            {e.teacher_name ?? 'Unassigned'}
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
