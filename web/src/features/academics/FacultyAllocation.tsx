import ClassTeachers from './ClassTeachers'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, GraduationCap, UserCheck, UserX } from 'lucide-react'
import { api, type List, type Klass, type Teacher } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Checkbox, FormNotice, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* Who teaches what, and what nobody teaches.

   Two facts a school assumes it knows and cannot produce on request: the
   subject in Class 8 with no teacher against it, and the teacher the timetable
   puts in front of a class that the allocation does not. The second is the
   interesting one — the allocation and the timetable are separate tables and
   drift apart quietly, and this is the only screen where anybody would notice.

   Edited as a grid and saved once. Clearing a cell is a real decision, so an
   empty teacher removes the allocation rather than being ignored. */

interface Slot {
  section_id: string
  section: string
  class_id: string
  class_name: string
  class_subject_id: string
  subject: string
  teacher_user_id?: string
  teacher?: string
  weekly_periods?: number
  timetable_differs: boolean
}

interface AllocationResponse {
  items: Slot[]
  summary: {
    slots: number
    assigned: number
    unassigned: number
    teachers_allocated: number
    timetable_conflicts: number
  }
}

export default function FacultyAllocation() {
  const qc = useQueryClient()
  const [applied, setApplied] = useState('')
  const [classId, setClassId] = useState('')
  const [gapsOnly, setGapsOnly] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const teachers = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/timetable/teachers'),
  })
  const alloc = useQuery({
    queryKey: ['faculty-allocation', classId, gapsOnly],
    queryFn: () => {
      const q = new URLSearchParams()
      if (classId) q.set('class_id', classId)
      if (gapsOnly) q.set('unassigned', '1')
      const qs = q.toString()
      return api.get<AllocationResponse>(
        '/api/v1/academics/admin/faculty-allocation' + (qs ? `?${qs}` : ''),
      )
    },
  })

  const save = useMutation({
    mutationFn: (allocations: { section_id: string; class_subject_id: string; teacher_user_id: string }[]) =>
      api.post('/api/v1/academics/admin/faculty-allocation', { allocations }),
    onSuccess: () => {
      setDraft({})
      qc.invalidateQueries({ queryKey: ['faculty-allocation'] })
    },
  })

  const rows = alloc.data?.items ?? []
  const options = useMemo(
    () =>
      (teachers.data?.items ?? []).map((t) => ({
        value: t.user_id,
        label: `${t.full_name} — ${t.weekly_periods ?? 0} periods`,
      })),
    [teachers.data],
  )

  const apply = useMutation({
    mutationFn: () =>
      api.post<{ periods_reassigned: number; allocations_with_no_period: number }>(
        '/api/v1/academics/admin/faculty-allocation/apply', {},
      ),
    onSuccess: (r) => {
      setApplied(
        `${r.periods_reassigned} periods now name the allocated teacher.` +
          (r.allocations_with_no_period
            ? ` ${r.allocations_with_no_period} allocations have no period to attach to — the timetable was never generated for those subjects.`
            : ''),
      )
      qc.invalidateQueries({ queryKey: ['faculty-allocation'] })
    },
  })

  if (alloc.isLoading) return <Loading label="Working out who teaches what…" />
  if (alloc.error) return <ErrorState error={alloc.error} />

  const s = alloc.data?.summary
  const pending = Object.keys(draft).length

  const cellKey = (r: Slot) => `${r.section_id}:${r.class_subject_id}`
  const current = (r: Slot) => draft[cellKey(r)] ?? r.teacher_user_id ?? ''

  const commit = () =>
    save.mutate(
      Object.entries(draft).map(([key, teacher]) => {
        const [section_id, class_subject_id] = key.split(':')
        return { section_id, class_subject_id, teacher_user_id: teacher }
      }),
    )

  const differs = rows.filter((r) => r.timetable_differs).length
  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Faculty allocation"
        description="Every subject each section takes, who is down to teach it, and the ones nobody is."
        actions={
          pending > 0 ? (
            <Button disabled={save.isPending} onClick={commit}>
              Save {pending} change{pending === 1 ? '' : 's'}
            </Button>
          ) : differs > 0 ? (
            /* The flag existed and nothing could act on it, so a teacher
               allocated a subject but never written into the timetable stayed
               invisible to the substitution board and the clash checker —
               both read periods, not allocations. */
            <Button disabled={apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Updating…' : `Put these ${differs} on the timetable`}
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        {applied && <FormNotice ok={applied} />}
        {apply.error && <FormNotice error={apply.error} />}
        <CellGrid cols={4}>
          <Stat label="Subject slots" value={s?.slots ?? 0} icon={GraduationCap} />
          <Stat label="Allocated" value={s?.assigned ?? 0} icon={UserCheck} />
          <Stat
            label="Nobody allocated"
            value={s?.unassigned ?? 0}
            icon={UserX}
            delta={
              (s?.unassigned ?? 0) > 0
                ? { value: 'These sections have no teacher on record', positive: false }
                : { value: 'Every subject is covered', positive: true }
            }
          />
          <Stat
            label="Timetable disagrees"
            value={s?.timetable_conflicts ?? 0}
            icon={AlertTriangle}
            hint="Somebody else is timetabled for the period"
          />
        </CellGrid>
      {/* Who owns each section, beside who teaches what: the two are decided
          in the same sitting, and setting a class teacher used to be possible
          only from the first-run wizard. */}
      <ClassTeachers />


        <Card>
          <CardHeader
            title="Allocation"
            description="Change a cell and save; clearing one removes the allocation altogether."
            action={
              <div className="flex flex-wrap items-center gap-3">
                <Checkbox checked={gapsOnly} onChange={setGapsOnly} label="Gaps only" />
                <Select
                  value={classId}
                  onChange={setClassId}
                  options={(classes.data?.items ?? []).map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  placeholder="Every class"
                />
              </div>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title={gapsOnly ? 'Nothing unallocated' : 'No sections yet'}
              body={
                gapsOnly
                  ? 'Every subject in every section has a teacher against it.'
                  : 'Set up classes, sections and subjects first; allocation follows from them.'
              }
            />
          ) : (
            <Table head={['Class', 'Section', 'Subject', 'Periods', 'Teacher', 'Notes']}>
              {rows.map((r) => (
                <tr key={cellKey(r)}>
                  <Td className="font-medium">{r.class_name}</Td>
                  <Td>{r.section}</Td>
                  <Td>{r.subject}</Td>
                  <Td className="tabular-nums">{r.weekly_periods || '—'}</Td>
                  <Td>
                    <Select
                      value={current(r)}
                      onChange={(v) => setDraft((d) => ({ ...d, [cellKey(r)]: v }))}
                      options={options}
                      placeholder="Nobody"
                    />
                  </Td>
                  <Td>
                    {r.timetable_differs && (
                      <Badge tone="warning">timetable names somebody else</Badge>
                    )}
                    {!r.teacher_user_id && !r.timetable_differs && (
                      <Badge tone="danger">unallocated</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <div className="px-5 pb-5">
            <FormNotice
              error={save.error}
              ok={save.isSuccess && pending === 0 ? 'Allocation saved.' : undefined}
            />
          </div>
        </Card>
      </PageBody>
    </>
  )
}
