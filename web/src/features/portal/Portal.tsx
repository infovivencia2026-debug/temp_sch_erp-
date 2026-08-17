import { useState } from 'react'
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
  attendance_pct: number; present_days: number; total_days: number
  homework_due: number; outstanding_paise: number; next_exam?: string
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

/**
 * Shared by the student and parent portals. The difference is entirely in the
 * resolved scope: a student's set is one record, a guardian's is their
 * children — so a parent gets a switcher and a student does not.
 */
export default function Portal() {
  const [selected, setSelected] = useState<string | null>(null)

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
        {summary.isLoading || !s ? (
          <Loading />
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat
                label="Attendance"
                value={`${s.attendance_pct}%`}
                icon={CalendarCheck}
                delta={{
                  value: `${s.present_days}/${s.total_days} days`,
                  positive: s.attendance_pct >= 75,
                }}
              />
              <Stat label="Homework due" value={s.homework_due} icon={BookMarked} />
              <Stat
                label="Fees outstanding"
                value={formatPaise(s.outstanding_paise)}
                icon={Wallet}
                hint={s.outstanding_paise ? 'Payable now' : 'All settled'}
              />
              <Stat label="Next exam" value={s.next_exam ?? '—'} icon={GraduationCap} />
            </CellGrid>

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
