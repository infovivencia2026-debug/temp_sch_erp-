import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState, EmptyState, PrintButton,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import { CsvButton } from './shared'

/**
 * Today — the principal's landing page for the day in front of them.
 *
 * Deliberately not a second executive KPI dashboard. That screen answers "how
 * is the school doing" over a chosen range; this one answers "what will still
 * be broken at four o'clock if I do not deal with it", so every panel is
 * either today's fact or today's decision and nothing on it is a running
 * total.
 *
 * The cover picture leads because it is the only thing here that decays: a
 * class with no teacher at 08:00 cannot be fixed at 16:00.
 */

interface StaffAbsence {
  user_id: string; full_name: string; department?: string; status: string
  periods_today: number; periods_covered: number; periods_uncovered: number
}
interface Gap {
  period: string; starts_at: string; class_name: string
  section_name: string; subject: string; reason: string
}
interface Money {
  due_today_paise: number; collected_today_paise: number; receipts_today: number
  overdue_as_of_today_paise: number; overdue_students: number
  cheques_awaiting_clearance_paise: number
}
interface DiaryItem { at?: string; title: string; with?: string; kind?: string }
interface Decision { key: string; label: string; count: number; href: string }

interface TodayView {
  date: string; weekday: string; scope: string
  staff_absent: StaffAbsence[]
  uncovered_periods: Gap[]
  money?: Money
  visitors_expected: DiaryItem[]
  events: DiaryItem[]
  decisions: Decision[]
}

const URL = '/api/v1/rollups/today'

export default function Today() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['rollup-today'],
    queryFn: () => api.get<TodayView>(URL),
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const uncovered = data.uncovered_periods.length
  const away = data.staff_absent.length
  const decisions = data.decisions.reduce((a, d) => a + d.count, 0)

  return (
    <>
      <PageHead
        eyebrow="Home"
        title="Today"
        description={`${data.weekday}, ${data.date} — what needs dealing with before the day ends.`}
        actions={
          <div className="flex gap-2">
            <CsvButton href={URL} label="Export day list" />
            <PrintButton />
          </div>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Staff away" value={away} hint="Absent or on leave today" period="Today" />
          <Stat
            label="Periods without a teacher"
            value={uncovered}
            hint="Unstaffed or uncovered"
            period="Today"
          />
          <Stat
            label="Collected today"
            value={data.money ? formatPaise(data.money.collected_today_paise) : '—'}
            hint={data.money ? `${data.money.receipts_today} receipts` : 'Needs finance access'}
            period="Today"
          />
          <Stat label="Decisions waiting" value={decisions} hint="Queues only you can clear" />
        </CellGrid>

        {/* The one panel that cannot wait: a class sitting with nobody in front of it. */}
        <Card>
          <CardHeader
            title="Periods with no teacher"
            description="Either nobody is timetabled, or the teacher is away and no cover was arranged."
          />
          {uncovered === 0 ? (
            <EmptyState title="Every period today is staffed." />
          ) : (
            <Table head={['Period', 'From', 'Class', 'Subject', 'Reason']}>
              {data.uncovered_periods.map((g, i) => (
                <tr key={`${g.period}-${g.class_name}-${g.section_name}-${i}`}>
                  <Td className="font-medium">{g.period}</Td>
                  <Td className="font-mono text-[12px]">{g.starts_at}</Td>
                  <Td>{`${g.class_name}-${g.section_name}`}</Td>
                  <Td className="text-muted-foreground">{g.subject}</Td>
                  <Td>
                    <Badge tone={g.reason.startsWith('No teacher') ? 'danger' : 'warning'}>
                      {g.reason}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Staff away today"
            description="With how much of each person's day is already covered."
          />
          {away === 0 ? (
            <EmptyState title="Everyone is in today." />
          ) : (
            <Table head={['Name', 'Department', 'Status', 'Periods today', 'Covered', 'Cover']}>
              {data.staff_absent.map((s) => (
                <tr key={s.user_id}>
                  <Td className="font-medium">{s.full_name}</Td>
                  <Td className="text-muted-foreground">{s.department ?? '—'}</Td>
                  <Td>
                    <Badge tone={s.status === 'leave' ? 'info' : 'warning'}>{s.status}</Badge>
                  </Td>
                  <Td>{s.periods_today}</Td>
                  <Td>{s.periods_covered}</Td>
                  <Td>
                    <Badge
                      tone={
                        s.periods_today === 0 ? 'neutral'
                        : s.periods_uncovered === 0 ? 'success'
                        : 'danger'
                      }
                    >
                      {s.periods_today === 0 ? 'No classes'
                        : s.periods_uncovered === 0 ? 'Fully covered'
                        : `${s.periods_uncovered} uncovered`}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {/* Money is omitted server-side for anyone without finance rights, so
            the absence of this card is an authorisation outcome, not a layout
            choice. */}
        {data.money && (
          <Card>
            <CardHeader
              title="Money today"
              description="Today's collection against what fell due today, and what is already overdue."
            />
            <CellGrid cols={4}>
              <Stat label="Fell due today" value={formatPaise(data.money.due_today_paise)} period="Today" />
              <Stat
                label="Collected today"
                value={formatPaise(data.money.collected_today_paise)}
                hint="Write-offs excluded"
                period="Today"
              />
              <Stat
                label="Overdue"
                value={formatPaise(data.money.overdue_as_of_today_paise)}
                hint={`${data.money.overdue_students} students`}
                period="As of now"
              />
              <Stat
                label="Cheques not cleared"
                value={formatPaise(data.money.cheques_awaiting_clearance_paise)}
                hint="Taken, not yet banked"
                period="As of now"
              />
            </CellGrid>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Expected in today" description="Appointments still booked." />
            {data.visitors_expected.length === 0 ? (
              <EmptyState title="No appointments booked for today." />
            ) : (
              <Table head={['Time', 'Visitor', 'Seeing', 'Purpose']}>
                {data.visitors_expected.map((v, i) => (
                  <tr key={`${v.at}-${v.title}-${i}`}>
                    <Td className="font-mono text-[12px]">{v.at || '—'}</Td>
                    <Td className="font-medium">{v.title}</Td>
                    <Td className="text-muted-foreground">{v.with || '—'}</Td>
                    <Td className="text-muted-foreground">{v.kind || '—'}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="On today" description="Published events, holidays and exam days." />
            {data.events.length === 0 ? (
              <EmptyState title="An ordinary teaching day." />
            ) : (
              <Table head={['Time', 'What', 'Where', 'Kind']}>
                {data.events.map((e, i) => (
                  <tr key={`${e.title}-${i}`}>
                    <Td className="font-mono text-[12px]">{e.at || '—'}</Td>
                    <Td className="font-medium">{e.title}</Td>
                    <Td className="text-muted-foreground">{e.with || '—'}</Td>
                    <Td>
                      <Badge tone="info">{e.kind || 'event'}</Badge>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Waiting on a decision"
            description="Only the queues you hold the right to clear are listed."
          />
          {data.decisions.length === 0 ? (
            <EmptyState title="Nothing is waiting on you." />
          ) : (
            <Table head={['Count', 'What', '']}>
              {data.decisions.map((d) => (
                <tr key={d.key}>
                  <Td className="font-medium">{d.count}</Td>
                  <Td>{d.label}</Td>
                  <Td className="text-muted-foreground">{d.href}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
