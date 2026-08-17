import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Check, Clock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Loading, ErrorState,
} from '@/components/ui'

interface TodayClass {
  entry_id: string; section_id: string; section_name: string; class_name: string
  subject_name: string; period_name: string; starts_at: string; ends_at: string
  room?: string; attendance_marked: boolean
}
interface MyClass {
  section_id: string; section_name: string; class_name: string
  room?: string; enrolled: number; marked_today: boolean
}

export default function TodaysClasses() {
  const navigate = useNavigate()
  const today = useQuery({
    queryKey: ['teaching-today'],
    queryFn: () => api.get<List<TodayClass>>('/api/v1/teaching/today'),
  })
  const classes = useQuery({
    queryKey: ['teaching-classes'],
    queryFn: () => api.get<List<MyClass>>('/api/v1/teaching/classes'),
  })

  if (today.isLoading) return <Loading />
  if (today.error) return <ErrorState error={today.error} />

  const rows = today.data?.items ?? []
  const now = new Date().toTimeString().slice(0, 5)
  // The next class is the first whose end time has not passed.
  const nextIdx = rows.findIndex((c) => c.ends_at > now)
  const marked = rows.filter((c) => c.attendance_marked).length
  const students = (classes.data?.items ?? []).reduce((a, c) => a + c.enrolled, 0)

  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="Today's classes"
        description="Your schedule for today, with one-click attendance for each period."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Classes today" value={rows.length} />
          <Stat label="Attendance marked" value={`${marked}/${rows.length}`} />
          <Stat label="My sections" value={classes.data?.items.length ?? 0} />
          <Stat label="Students taught" value={students} />
        </CellGrid>

        <Card>
          <CardHeader title="Schedule" description={rows.length ? undefined : 'Nothing timetabled for today'} />
          <Table
            head={['Period', 'Time', 'Class', 'Subject', 'Room', 'Attendance', '']}
            empty={!rows.length}
            emptyLabel="No classes timetabled for you today."
          >
            {rows.map((c, i) => (
              <tr key={c.entry_id} className={i === nextIdx ? 'bg-primary/5' : undefined}>
                <Td className="font-medium">
                  {c.period_name}
                  {i === nextIdx && (
                    <Badge tone="primary">
                      <Clock className="mr-1 h-3 w-3" /> next
                    </Badge>
                  )}
                </Td>
                <Td className="text-muted-foreground">{c.starts_at}–{c.ends_at}</Td>
                <Td>{c.class_name}-{c.section_name}</Td>
                <Td className="font-medium">{c.subject_name}</Td>
                <Td className="text-muted-foreground">{c.room ?? '—'}</Td>
                <Td>
                  {c.attendance_marked ? (
                    <Badge tone="success"><Check className="mr-1 h-3 w-3" /> marked</Badge>
                  ) : (
                    <Badge tone="warning">pending</Badge>
                  )}
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant={c.attendance_marked ? 'outline' : 'ink'}
                    onClick={() => navigate('/faculty/teaching_workspace/take_attendance')}
                  >
                    {c.attendance_marked ? 'Review' : 'Take attendance'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title="My classes" description="Sections you teach or are class teacher of" />
          <Table
            head={['Class', 'Room', 'Students', 'Today']}
            empty={!classes.data?.items.length}
            emptyLabel="You are not assigned to any section yet."
          >
            {(classes.data?.items ?? []).map((c) => (
              <tr key={c.section_id}>
                <Td className="font-medium">{c.class_name}-{c.section_name}</Td>
                <Td className="text-muted-foreground">{c.room ?? '—'}</Td>
                <Td>{c.enrolled}</Td>
                <Td>
                  <Badge tone={c.marked_today ? 'success' : 'neutral'}>
                    {c.marked_today ? 'marked' : 'not marked'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}
