import { useQuery } from '@tanstack/react-query'
import { BookOpen, GraduationCap, FolderOpen, ClipboardList } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Course {
  class_subject_id: string
  subject: string
  code: string
  is_scholastic: boolean
  is_elective: boolean
  max_marks: number
  teacher?: string
  weekly_periods: number
  resources: number
  next_exam_on?: string
  homework_pending: number
}
interface CourseList {
  student_id: string
  class_name: string
  section_name: string
  items: Course[]
}

/* What the child is actually taught.

   Assembled from the class the child is enrolled in rather than from a list
   somebody maintains per pupil: a subject added to Grade 6 appears here the
   same day, and a child who changes section gets the right teacher without
   anyone remembering to update them.

   The three counts on each row are the questions a timetable does not answer —
   how much of the week this takes, whether there is anything to read, and
   whether anything is owed. */
export default function Courses() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const courses = useQuery({
    queryKey: ['learning-courses', studentId],
    queryFn: () => api.get<CourseList>(`/api/v1/portal/learning/courses${studentQuery(studentId)}`),
    enabled: ready,
  })

  if (courses.isLoading && ready) return <Loading label="Looking up your subjects…" />
  if (courses.error) return <ErrorState error={courses.error} />

  const rows = courses.data?.items ?? []
  const scholastic = rows.filter((r) => r.is_scholastic)
  const periods = rows.reduce((n, r) => n + r.weekly_periods, 0)
  const resources = rows.reduce((n, r) => n + r.resources, 0)
  const pending = rows.reduce((n, r) => n + r.homework_pending, 0)

  return (
    <>
      <PageHead
        eyebrow="Learning"
        title="Courses and subjects"
        description={
          courses.data
            ? `Everything ${courses.data.class_name}-${courses.data.section_name} is taught this year, and who takes it.`
            : 'Everything your class is taught this year, and who takes it.'
        }
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState
            title="Choose a child"
            body="Each child follows their own class, so the subject list is theirs."
          />
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat label="Subjects" value={rows.length} icon={BookOpen}
                hint={`${scholastic.length} scholastic`} />
              <Stat label="Periods a week" value={periods} icon={GraduationCap}
                hint="Counted from the timetable" />
              <Stat label="Resources posted" value={resources} icon={FolderOpen} />
              <Stat
                label="Homework outstanding"
                value={pending}
                icon={ClipboardList}
                delta={
                  pending === 0
                    ? { value: 'Nothing owed', positive: true }
                    : { value: 'Still to hand in', positive: false }
                }
              />
            </CellGrid>

            <Card>
              <CardHeader
                title="This year's subjects"
                description="Scholastic subjects first, then everything else."
              />
              <Table
                head={[
                  'Subject', 'Code', 'Taken by',
                  { label: 'Periods', align: 'right' },
                  { label: 'Resources', align: 'right' },
                  { label: 'Homework', align: 'right' },
                  'Next paper',
                ]}
                empty={rows.length === 0}
                emptyLabel="No subjects have been set up for your class yet."
              >
                {rows.map((c) => (
                  <tr key={c.class_subject_id}>
                    <Td>
                      <span className="font-medium">{c.subject}</span>
                      {c.is_elective && <Badge tone="info">Elective</Badge>}
                      {!c.is_scholastic && <Badge>Co-scholastic</Badge>}
                    </Td>
                    <Td className="font-mono text-[13px] text-muted-foreground">{c.code}</Td>
                    <Td>{c.teacher ?? <span className="text-muted-foreground">Not assigned</span>}</Td>
                    <Td className="text-right tabular-nums">{c.weekly_periods}</Td>
                    <Td className="text-right tabular-nums">{c.resources}</Td>
                    <Td className="text-right tabular-nums">
                      {c.homework_pending > 0 ? (
                        <Badge tone="warning">{c.homework_pending}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td>
                      {c.next_exam_on ? (
                        formatDate(c.next_exam_on)
                      ) : (
                        <span className="text-muted-foreground">None scheduled</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
