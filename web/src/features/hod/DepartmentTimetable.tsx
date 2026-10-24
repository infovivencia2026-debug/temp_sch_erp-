import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useQuery } from '@tanstack/react-query'
import { CalendarRange, Download, Gauge, TriangleAlert, UserCheck } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Table, Td,
  Select, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import WeekGrid from '@/components/WeekGrid'

/* The head of department's week, in one place.

   Four questions a HOD currently answers with a printed grid and a pen: who is
   teaching what and when, where the free periods are, who is carrying too much
   or too little, and which of the department's subject requirements the live
   timetable does not actually meet.

   The last one is the reason this is not just a filtered copy of the timetable
   screen. A grid looks complete whatever is in it; "Class 8B Maths: 6 wanted,
   4 scheduled" is the row that changes what somebody does on Monday.

   Scope is the server's decision, not this screen's. A HOD gets their own
   departments and a principal gets every one, and asking for a department you
   do not head returns 403 rather than an empty grid — which is the difference
   between access control and a hidden button. */

interface DeptEntry {
  teacher_id: string
  teacher_name: string
  weekday: number
  period_id: string
  section_name: string
  class_name: string
  subject_name: string
  room?: string
}

interface DeptTeacher {
  user_id: string
  full_name: string
  employee_code: string
  department: string
  periods: number
  max_periods_per_week: number
  max_periods_per_day: number
  free_slots: number
  load: 'over' | 'under' | 'ok'
}

interface DeptRequirement {
  section_name: string
  class_name: string
  subject_name: string
  teacher_name?: string
  periods_required: number
  periods_scheduled: number
}

interface DeptResponse {
  academic_year_id: string
  departments: { id: string; name: string }[]
  department_id?: string
  weekdays: number[]
  periods: { id: string; name: string; sequence: number; starts_at: string; is_break: boolean }[]
  teachers: DeptTeacher[]
  entries: DeptEntry[]
  requirements: DeptRequirement[]
  summary: {
    teachers: number
    periods_assigned: number
    free_slots: number
    teaching_slots_a_week: number
    over_loaded: number
    under_loaded: number
    unmet_requirements: number
  }
}

const LOAD_TONE = { over: 'danger', under: 'warning', ok: 'success' } as const

export default function DepartmentTimetable() {
  const [dept, setDept] = useState('')
  const [teacher, setTeacher] = useState('')

  const q = useQuery({
    queryKey: ['department-timetable', dept],
    queryFn: () =>
      api.get<DeptResponse>(
        `/api/v1/department-timetable/${dept ? `?department_id=${dept}` : ''}`,
      ),
  })

  /* Every bell schedule's periods (Yajur runs several): an entry on another
     schedule's Period3 belongs on this grid's Period3 row, matched by name. */
  const allPeriods = useQuery({
    queryKey: ['periods', 'all'],
    queryFn: () => api.call('GET /timetable/periods', { query: { all: '1' } }),
  })

  if (q.isLoading && !q.data) return <SkeletonTable columns={6} label="Reading the department's week…" />
  if (q.error) return <ErrorState error={q.error} />

  const d = q.data!
  const s = d.summary
  const rowByName = new Map(d.periods.filter((p) => !p.is_break).map((p) => [p.name.trim().toLowerCase(), p.id]))
  const nameOf = new Map((allPeriods.data?.items ?? []).map((p) => [p.id, p.name.trim().toLowerCase()]))
  const weekly = (uid: string) => {
    const m = new Map<string, { key: string; cls: string; subject: string; n: number }>()
    for (const e of d.entries) {
      if (e.teacher_id !== uid) continue
      const key = `${e.class_name}-${e.section_name}|${e.subject_name}`
      const w = m.get(key) ?? { key, cls: `${e.class_name}-${e.section_name}`, subject: e.subject_name, n: 0 }
      w.n++
      m.set(key, w)
    }
    return [...m.values()].sort((a, b) => a.cls.localeCompare(b.cls) || a.subject.localeCompare(b.subject))
  }
  /* EXPORT (Yajur, 2026-10-24): each period on its own row, day, period,
     time, class and section, subject and room, for one teacher or all of them. */
  const exportWeek = (people: { user_id: string; full_name: string; employee_code?: string }[]) => {
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    const order = new Map(d.periods.map((p, i) => [p.id, i]))
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const lines = [['Teacher', 'Code', 'Day', 'Period', 'Starts', 'Class', 'Section', 'Subject', 'Room'].join(',')]
    for (const t of people) {
      const rows = d.entries.filter((e) => e.teacher_id === t.user_id)
        .map((e) => ({ e, p: d.periods.find((x) => x.id === rowOf(e.period_id)) }))
        .sort((a, b) => a.e.weekday - b.e.weekday || (order.get(a.p?.id ?? '') ?? 0) - (order.get(b.p?.id ?? '') ?? 0))
      for (const { e, p } of rows) {
        lines.push([t.full_name, t.employee_code ?? '', DAYS[e.weekday - 1] ?? String(e.weekday), p?.name ?? '',
          p ? p.starts_at.slice(0, 5) : '', e.class_name, e.section_name, e.subject_name, e.room ?? ''].map(cell).join(','))
      }
    }
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = people.length === 1 ? `timetable-${people[0].full_name.replace(/\s+/g, '-')}.csv` : 'department-timetable.csv'
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const rowOf = (periodID: string) => (d.periods.some((p) => p.id === periodID) ? periodID : rowByName.get(nameOf.get(periodID) ?? '') ?? periodID)
  /* ONE TEACHER'S WEEK AT A TIME (Yajur, 2026-10-24: every teacher's grid one
     under another read as endless scrolling). Pick a name in the Load table
     or the picker; only that week is drawn. */
  const shown = teacher ? d.teachers.filter((t) => t.user_id === teacher) : []

  return (
    <>
      <PageHead
        eyebrow="Department"
        title="Department timetable"
        description="Who is teaching what and when, where the free periods sit, and which subject requirements the published week does not meet."
        width="wide"
        actions={
          <>
            {d.departments.length > 1 && (
              <Select
                value={dept}
                onChange={(v) => {
                  setDept(v)
                  setTeacher('')
                }}
                placeholder="All my departments"
                options={d.departments.map((x) => ({ value: x.id, label: x.name }))}
              />
            )}
            <Button variant="secondary" onClick={() => exportWeek(d.teachers)}><Download className="h-4 w-4" /> Export all</Button>
            <Select
              value={teacher}
              onChange={setTeacher}
              placeholder="Choose a teacher"
              options={d.teachers.map((t) => ({ value: t.user_id, label: t.full_name }))}
            />
          </>
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Teachers" value={s.teachers} icon={UserCheck} />
          <Stat
            label="Periods assigned"
            value={s.periods_assigned}
            icon={CalendarRange}
            hint={`${s.teaching_slots_a_week} slots in the week`}
          />
          <Stat
            label="Over their load"
            value={s.over_loaded}
            icon={Gauge}
            hint={`${s.under_loaded} are well under theirs`}
          />
          <Stat
            label="Requirements unmet"
            value={s.unmet_requirements}
            icon={TriangleAlert}
            hint="Subjects short of their weekly periods"
          />
        </CellGrid>

        {/* The unmet requirements come first. A grid always looks finished. */}
        <Card>
          <CardHeader
            title="Requirements the week does not meet"
            description="Periods a subject was allocated, against periods it actually has in the published timetable."
          />
          {d.requirements.length === 0 ? (
            <EmptyState
              title="Every requirement is met"
              body="Each subject this department teaches has exactly the periods it was allocated."
            />
          ) : (
            <Table head={['Class', 'Subject', 'Teacher', 'Wanted', 'Scheduled', 'Short by']}>
              {d.requirements.map((r, i) => (
                <tr key={i}>
                  <Td>
                    {r.class_name}-{r.section_name}
                  </Td>
                  <Td className="font-medium">{r.subject_name}</Td>
                  <Td className="text-[13px] text-muted-foreground">{r.teacher_name ?? '-'}</Td>
                  <Td className="tabular-nums">{r.periods_required}</Td>
                  <Td className="tabular-nums">{r.periods_scheduled}</Td>
                  <Td>
                    <Badge tone={r.periods_scheduled < r.periods_required ? 'danger' : 'warning'}>
                      {r.periods_required - r.periods_scheduled > 0
                        ? `${r.periods_required - r.periods_scheduled} short`
                        : `${r.periods_scheduled - r.periods_required} over`}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Load"
            description="Against each teacher's own cap. Tap a name to see that teacher's week."
          />
          <Table head={['Teacher', 'Department', 'Periods', 'Cap', 'Free slots', 'Load']}>
            {d.teachers.map((t) => (
              <tr key={t.user_id} className={cn(teacher === t.user_id && 'bg-primary/[0.07]')}>
                <Td>
                  <button type="button" onClick={() => setTeacher(teacher === t.user_id ? '' : t.user_id)}
                    className="text-left font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t.full_name}
                  </button>
                  <div className="text-[12px] text-muted-foreground">{t.employee_code}</div>
                </Td>
                <Td className="text-[13px] text-muted-foreground">{t.department}</Td>
                <Td className="tabular-nums">{t.periods}</Td>
                <Td className="tabular-nums text-muted-foreground">{t.max_periods_per_week}</Td>
                <Td className="tabular-nums">{t.free_slots}</Td>
                <Td>
                  <Badge tone={LOAD_TONE[t.load]}>
                    {t.load === 'over' ? 'over cap' : t.load === 'under' ? 'has room' : 'balanced'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {shown.map((t) => (
          <Card key={t.user_id}>
            <CardHeader
              title={t.full_name}
              description={`${t.periods} periods a week, ${t.free_slots} slots free, cap ${t.max_periods_per_week}.`}
              action={<Button size="sm" variant="secondary" onClick={() => exportWeek([t])}><Download className="h-4 w-4" /> Export</Button>}
            />
            {/* What they teach in a week: each class and subject with its periods (Yajur, 2026-10-24). */}
            <Table head={['Class', 'Subject', 'Periods a week']}>
              {weekly(t.user_id).map((w) => (
                <tr key={w.key}>
                  <Td>{w.cls}</Td>
                  <Td className="font-medium">{w.subject}</Td>
                  <Td className="tabular-nums">{w.n}</Td>
                </tr>
              ))}
              <tr>
                <Td className="font-semibold">Total</Td>
                <Td className="text-muted-foreground">{weekly(t.user_id).length} {weekly(t.user_id).length === 1 ? 'class' : 'classes'}</Td>
                <Td className="font-semibold tabular-nums">{weekly(t.user_id).reduce((n, w) => n + w.n, 0)}</Td>
              </tr>
            </Table>
            <div className="p-4">
              <WeekGrid
                weekdays={d.weekdays}
                periods={d.periods}
                entries={d.entries.filter((e) => e.teacher_id === t.user_id).map((e) => ({
                  weekday: e.weekday,
                  period_id: rowOf(e.period_id),
                  title: `${e.class_name}-${e.section_name}`,
                  detail: e.subject_name,
                  room: e.room,
                }))}
                empty="No periods are timetabled for this teacher yet."
              />
            </div>
          </Card>
        ))}
      </PageBody>
    </>
  )
}
