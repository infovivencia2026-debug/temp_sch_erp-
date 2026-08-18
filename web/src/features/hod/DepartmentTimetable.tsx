import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarRange, Gauge, TriangleAlert, UserCheck } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Table, Td,
  Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { WEEKDAYS, cn } from '@/lib/utils'

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

  if (q.isLoading) return <Loading label="Reading the department's week…" />
  if (q.error) return <ErrorState error={q.error} />

  const d = q.data!
  const s = d.summary
  const periods = d.periods.filter((p) => !p.is_break)
  const shown = teacher ? d.teachers.filter((t) => t.user_id === teacher) : d.teachers

  // One lookup for the whole grid: teacher, weekday, period.
  const cells = new Map(
    d.entries.map((e) => [`${e.teacher_id}:${e.weekday}:${e.period_id}`, e]),
  )

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
            <Select
              value={teacher}
              onChange={setTeacher}
              placeholder="Everyone"
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
                  <Td className="text-[13px] text-muted-foreground">{r.teacher_name ?? '—'}</Td>
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
            description="Against each teacher's own cap. Under-loaded is not an accusation — it is who has room when cover is needed."
          />
          <Table head={['Teacher', 'Department', 'Periods', 'Cap', 'Free slots', 'Load']}>
            {d.teachers.map((t) => (
              <tr key={t.user_id}>
                <Td>
                  <div className="font-medium">{t.full_name}</div>
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
            />
            <div className="overflow-x-auto p-4">
              <table className="w-full min-w-[720px] border-separate border-spacing-1 text-[13px]">
                <thead>
                  <tr>
                    <th className="w-24" />
                    {periods.map((p) => (
                      <th key={p.id} className="rounded bg-muted px-2 py-1.5 text-[12px] font-medium">
                        <div>{p.name}</div>
                        <div className="font-normal text-muted-foreground">{p.starts_at}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.weekdays.map((wd) => (
                    <tr key={wd}>
                      <th className="rounded bg-muted px-2 py-1.5 text-[12px] font-medium">
                        {WEEKDAYS[wd - 1]}
                      </th>
                      {periods.map((p) => {
                        const e = cells.get(`${t.user_id}:${wd}:${p.id}`)
                        return (
                          <td
                            key={p.id}
                            className={cn(
                              'rounded border px-2 py-1.5 align-top',
                              !e && 'border-dashed bg-muted/30',
                            )}
                          >
                            {e ? (
                              <>
                                <div className="font-medium">
                                  {e.class_name}-{e.section_name}
                                </div>
                                <div className="text-[12px] text-muted-foreground">
                                  {e.subject_name}
                                </div>
                              </>
                            ) : (
                              <span className="text-[12px] text-muted-foreground">free</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </PageBody>
    </>
  )
}
