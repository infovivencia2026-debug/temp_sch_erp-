import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CalendarCheck, BookMarked, Wallet, GraduationCap } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise, cn } from '@/lib/utils'

interface PortalChild {
  student_id: string; admission_no: string; full_name: string
  class_name?: string; section_name?: string; relation?: string
}
interface PortalSummary {
  student_id: string; full_name: string
  attendance_pct: number; present_days: number; total_days: number; absent_days: number
  homework_due: number; next_homework_due?: string; next_homework_title?: string
  outstanding_paise: number; next_exam?: string
  today: TodayPeriod[]
}
interface TodayPeriod {
  period: string; starts_at?: string; ends_at?: string
  subject: string; teacher?: string; room?: string
}
interface AttendanceDay { date: string; status: string }

const DOT: Record<string, string> = {
  present: 'bg-success',
  late: 'bg-warning',
  absent: 'bg-destructive',
  half_day: 'bg-warning/60',
  leave: 'bg-muted-foreground/40',
  holiday: 'bg-border',
}

/** Days between today and a yyyy-mm-dd, in the reader's own words. */
function dueIn(iso: string) {
  const days = Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

/* Anything inside two days is tonight's problem rather than next week's, and
   that is the whole reason the deadline sits next to the count. */
function isUrgent(iso: string) {
  return (
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000 <= 2
  )
}

/**
 * Shared by the student and parent portals. The difference is entirely in the
 * resolved scope: a student's set is one record, a guardian's is their
 * children — so a parent gets a switcher and a student does not.
 */
export default function Portal() {
  const [selected, setSelected] = useState<string | null>(null)
  /* One component serves the dashboard and the attendance register.

     The attendance page is asked one question — how often has this child been
     here — and a timetable underneath it answers a different one. The route
     is what distinguishes them; the component has no other way to know which
     of its two callers it is. */
  const { sectionSlug } = useParams()
  const isAttendance = sectionSlug === 'attendance'

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })

  const activeId = selected ?? children.data?.items[0]?.student_id ?? null

  const summary = useQuery({
    queryKey: ['portal-summary', activeId],
    queryFn: () =>
      api.get<PortalSummary>(`/api/v1/portal/summary${activeId ? `?student_id=${activeId}` : ''}`),
    enabled: !!activeId,
  })

  const attendance = useQuery({
    queryKey: ['portal-attendance', activeId],
    // The child must be named explicitly: the endpoint defaults to the first
    // linked student, so omitting it made the switcher change nothing.
    queryFn: () =>
      api.get<List<AttendanceDay>>(`/api/v1/portal/attendance?student_id=${activeId}`),
    enabled: !!activeId,
  })

  if (children.isLoading) return <Loading />
  if (children.error) return <ErrorState error={children.error} />

  const kids = children.data?.items ?? []
  if (!kids.length) {
    return (
      <>
        <PageHead eyebrow="Portal" title="My day" />
        <PageBody>
          <EmptyState
            title="No student record linked"
            body="Your account is not linked to a student yet. Ask the school office to connect it."
          />
        </PageBody>
      </>
    )
  }

  const s = summary.data
  const days = attendance.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Portal"
        title={s?.full_name ?? 'My day'}
        description="Attendance, homework due, fees and what is coming up."
        actions={
          kids.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {kids.map((c) => (
                <Button
                  key={c.student_id}
                  size="sm"
                  variant={c.student_id === activeId ? 'ink' : 'outline'}
                  onClick={() => setSelected(c.student_id)}
                >
                  {c.full_name.split(' ')[0]}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      />
      <PageBody>
        {summary.isLoading ? (
          <Loading />
        ) : summary.error ? (
          /* `!s` used to fall through to the spinner, so a summary that came
             back 403 or 500 left a parent watching "Loading…" for the rest of
             the session. The failure has a message; show it. */
          <ErrorState error={summary.error} />
        ) : !s ? (
          <EmptyState
            title="Nothing recorded yet"
            body="Attendance, homework and fees appear here once the school starts recording them for this student."
          />
        ) : (
          <>
            <CellGrid cols={isAttendance ? 3 : 4}>
              <Stat
                label="Overall attendance"
                value={`${s.attendance_pct}%`}
                icon={CalendarCheck}
                delta={{ value: `${s.total_days} days marked`, positive: s.attendance_pct >= 75 }}
              />
              <Stat label="Present" value={`${s.present_days} days`} />
              <Stat label="Absent" value={`${s.absent_days} days`} />
              {/* The attendance page is asked one question and should answer
                  that one. Homework, fees and the next exam are the
                  dashboard's business; here they are three numbers a family
                  has to read past to find the one they came for. */}
              {!isAttendance && (
              <>
              <Stat
                label="Homework due"
                value={`${s.homework_due} pending`}
                icon={BookMarked}
                delta={
                  s.homework_due === 0
                    ? { value: 'Nothing outstanding', positive: true }
                    : s.next_homework_due
                      ? { value: `Soonest ${dueIn(s.next_homework_due)}`, positive: !isUrgent(s.next_homework_due) }
                      : undefined
                }
                hint={s.homework_due > 0 ? s.next_homework_title : undefined}
              />
              <Stat
                label="Fees outstanding"
                value={formatPaise(s.outstanding_paise)}
                icon={Wallet}
                hint={s.outstanding_paise ? 'Payable now' : 'All settled'}
              />
              <Stat label="Next exam" value={s.next_exam ?? '—'} icon={GraduationCap} />
              </>
              )}
            </CellGrid>

            {!isAttendance && (
            <Card>
              <CardHeader
                title="Today's classes"
                description={
                  s.today.length
                    ? 'In order, with the teacher taking each one.'
                    : 'Nothing timetabled today.'
                }
              />
              {s.today.length === 0 ? (
                <EmptyState
                  title="No classes today"
                  body="A holiday, a weekend, or the timetable has not been set for this section."
                />
              ) : (
                <ul className="divide-y">
                  {s.today.map((c, i) => (
                    <li key={`${c.period}-${i}`} className="flex flex-wrap items-baseline gap-3 px-4 py-2.5">
                      <span className="w-24 shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground">
                        {c.starts_at ?? '—'}
                        {c.ends_at ? `–${c.ends_at}` : ''}
                      </span>
                      <span className="min-w-[8rem] flex-1 font-medium">{c.subject}</span>
                      <span className="text-[13px] text-muted-foreground">
                        {c.period}
                        {c.teacher ? ` · ${c.teacher}` : ''}
                        {c.room ? ` · ${c.room}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            )}

            {kids.length > 1 && (
              <Card>
                <CardHeader title="Linked children" description="Switch above to change the view" />
                <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
                  {kids.map((c) => (
                    <div key={c.student_id} className="bg-card p-4">
                      <p className="text-[14px] font-medium">{c.full_name}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">
                        {c.class_name ? `${c.class_name}-${c.section_name}` : 'Not enrolled'} ·{' '}
                        <span className="font-mono text-[12px]">{c.admission_no}</span>
                      </p>
                      {c.relation && <Badge>{c.relation}</Badge>}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Attendance history"
                description="Last 120 days, most recent first"
              />
              <div className="p-5">
                {!days.length ? (
                  <p className="py-6 text-center text-[14px] text-muted-foreground">
                    No attendance recorded yet.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {days.map((d) => (
                        <span
                          key={d.date}
                          title={`${d.date} — ${d.status}`}
                          className={cn('h-4 w-4 rounded-sm', DOT[d.status] ?? 'bg-muted')}
                        />
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3 text-[12px] text-muted-foreground">
                      {Object.entries(DOT).map(([k, cls]) => (
                        <span key={k} className="inline-flex items-center gap-1.5">
                          <span className={cn('h-2.5 w-2.5 rounded-sm', cls)} />
                          {k.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
