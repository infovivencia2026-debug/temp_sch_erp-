import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Building2, TriangleAlert, Users, UserCog } from 'lucide-react'
import { api, type List, type Klass } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Input, Select, SkeletonTable, ErrorState, EmptyState, useSort,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* Which children a department is responsible for.

   A school department holds staff, not children — the only edge that exists is
   an employee's department. The roll is therefore reached the way a head of
   department would reach it in conversation: their teachers, the sections
   those teachers take, and the children enrolled in them. A department column
   on the student record would have been a second, wrong answer the moment a
   teacher moved department. */

interface DeptStudent {
  student_id: string
  admission_no: string
  full_name: string
  class_name: string
  section: string
  roll_no?: number
  department: string
  advisor?: string
  attendance_percent?: number
  marks_percent?: number
  backlogs: number
}

interface Department {
  id: string
  name: string
  head?: string
  staff: number
  students: number
  sections: number
}

export default function DepartmentStudents() {
  const [deptID, setDeptID] = useState('')
  const [classId, setClassId] = useState('')
  const [q, setQ] = useState('')

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const roll = useQuery({
    queryKey: ['department-students', deptID, classId, q],
    queryFn: () => {
      const p = new URLSearchParams()
      if (deptID) p.set('department_id', deptID)
      if (classId) p.set('class_id', classId)
      if (q.trim()) p.set('q', q.trim())
      const qs = p.toString()
      return api.get<{
        items: DeptStudent[]
        departments: Department[]
        summary: { departments: number; students: number; with_backlogs: number }
      }>('/api/v1/academics/admin/department-students' + (qs ? `?${qs}` : ''))
    },
  })

  const rows = roll.data?.items ?? []
  const sort = useSort<DeptStudent>(
    rows,
    (r, k) => (r as unknown as Record<string, string | number>)[k],
    { key: 'full_name' },
  )

  if (roll.isLoading) return <SkeletonTable columns={5} label="Working out who each department teaches…" />
  if (roll.error) return <ErrorState error={roll.error} />

  const depts = roll.data?.departments ?? []
  const s = roll.data?.summary
  const staff = depts.reduce((n, d) => n + d.staff, 0)

  return (
    <>
      <PageHead
        eyebrow="Students"
        title="Department students"
        description="The children each department reaches through its own teachers, with attendance, marks and backlogs alongside."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Departments" value={s?.departments ?? 0} icon={Building2} />
          <Stat label="Students reached" value={s?.students ?? 0} icon={Users} />
          <Stat label="Teaching staff" value={staff} icon={UserCog} />
          <Stat
            label="With backlogs"
            value={s?.with_backlogs ?? 0}
            icon={TriangleAlert}
            hint="At least one paper below the pass mark"
          />
        </CellGrid>

        {depts.length > 0 && (
          <Card>
            <CardHeader
              title="Departments"
              description="Reach is counted through allocation, so a department with no subjects allocated shows none."
            />
            <Table head={['Department', 'Head', 'Staff', 'Sections', 'Students']}>
              {depts.map((d) => (
                <tr key={d.id}>
                  <Td className="font-medium">{d.name}</Td>
                  <Td className="text-muted-foreground">{d.head ?? 'Not named'}</Td>
                  <Td className="tabular-nums">{d.staff}</Td>
                  <Td className="tabular-nums">{d.sections}</Td>
                  <Td className="tabular-nums">{d.students}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="The roll"
            description="Absences are excluded from the marks figure rather than scored nought — a child who was ill has not failed."
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={q}
                  onChange={setQ}
                  placeholder="Name or admission number"
                  className="w-56"
                />
                <Select
                  value={classId}
                  onChange={setClassId}
                  options={(classes.data?.items ?? []).map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  placeholder="Every class"
                />
                <Select
                  value={deptID}
                  onChange={setDeptID}
                  options={depts.map((d) => ({ value: d.id, label: d.name }))}
                  placeholder="Every department"
                />
              </div>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No students reached"
              body="A department reaches children through the subjects its teachers are allocated. Allocate one and the roll fills."
            />
          ) : (
            <Table
              head={[
                { label: 'Student', key: 'full_name' },
                { label: 'Admission', key: 'admission_no' },
                { label: 'Class', key: 'class_name' },
                { label: 'Department', key: 'department' },
                { label: 'Class teacher', key: 'advisor' },
                { label: 'Attendance', key: 'attendance_percent' },
                { label: 'Marks', key: 'marks_percent' },
                { label: 'Backlogs', key: 'backlogs' },
              ]}
              sort={sort}
            >
              {sort.sorted.map((r) => (
                <tr key={`${r.department}-${r.student_id}`}>
                  <Td className="font-medium">{r.full_name}</Td>
                  <Td className="text-muted-foreground">{r.admission_no}</Td>
                  <Td>
                    {r.class_name}-{r.section}
                    {r.roll_no != null && (
                      <span className="text-muted-foreground"> · {r.roll_no}</span>
                    )}
                  </Td>
                  <Td>{r.department}</Td>
                  <Td className="text-muted-foreground">{r.advisor ?? '—'}</Td>
                  <Td>
                    {r.attendance_percent == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          'tabular-nums',
                          r.attendance_percent < 75 && 'text-destructive',
                        )}
                      >
                        {r.attendance_percent}%
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {r.marks_percent == null ? '—' : `${r.marks_percent}%`}
                  </Td>
                  <Td>
                    {r.backlogs > 0 ? (
                      <Badge tone="danger">{r.backlogs}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
