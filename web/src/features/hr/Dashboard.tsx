import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { UserPlus, CalendarCheck, CalendarDays, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* The morning, not the filing cabinet.
 *
 * This screen counted the staff and then printed all of them: a full employee
 * directory, every row, every morning. Nobody arrives at work needing to read
 * the names of twelve colleagues they already know — and at a school with two
 * hundred it pushed everything else below the fold. A directory is something
 * you go and look something up in, which is a different act from opening the
 * dashboard, and it now lives behind Staff records where looking things up is
 * the point.
 *
 * What replaces it is the three things HR does before ten o'clock: find out who
 * is not in, so the missing classes can be covered; see what paperwork is
 * lapsing, before somebody is teaching on an expired certificate; and get at
 * the two or three actions that make up most days.
 */

interface Away {
  name: string
  employee_code: string
  reason: string
  until?: string
}
interface Alert {
  kind: 'danger' | 'warning' | 'neutral'
  text: string
  count: number
  link: string
}
interface HRKPIs {
  headcount: number
  present_today: number
  absent_today: number
  leave_pending: number
  new_joiners_30d: number
  departments: number
  away_today: Away[]
  attention: Alert[]
}

/* The two or three things a day is mostly made of.
 *
 * Deliberately few. A row of nine buttons is a second menu, and a second menu
 * is what somebody scans past — the point of a shortcut is that it is faster
 * to read than the list it shortcuts.
 */
const ACTIONS = [
  { to: '/go/records/staff_records', icon: UserPlus, label: 'Add a staff member' },
  { to: '/go/attendance/staff_register', icon: CalendarCheck, label: 'Mark attendance' },
  { to: '/go/leave/leave', icon: CalendarDays, label: 'Leave & holidays' },
]

export default function HRDashboard() {
  const kpis = useQuery({
    queryKey: ['hr-dashboard'],
    queryFn: () => api.get<HRKPIs>('/api/v1/hr/dashboard'),
  })

  if (kpis.isLoading) return <Loading />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!
  const away = k.away_today ?? []
  const attention = k.attention ?? []

  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="HR overview"
        description="Who is in, what needs doing, and the day's usual jobs."
      />
      <PageBody>
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((a) => (
            <Link
              key={a.to}
              to={a.to}
              className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2.5 text-[14px] font-medium transition-colors hover:bg-muted"
            >
              <a.icon className="h-4 w-4 text-muted-foreground" />
              {a.label}
            </Link>
          ))}
        </div>

        <CellGrid cols={4}>
          <Stat label="Headcount" value={k.headcount} hint={`${k.departments} departments`} />
          <Stat
            label="Present today"
            value={k.present_today}
            delta={{ value: `${k.absent_today} absent`, positive: k.absent_today === 0 }}
          />
          <Stat label="Leave pending" value={k.leave_pending} hint="Awaiting approval" />
          <Stat label="New joiners" value={k.new_joiners_30d} hint="Last 30 days" />
        </CellGrid>

        {attention.length > 0 && (
          <Card>
            <CardHeader
              title="Needs attention"
              description="Paperwork and access that is not finished. Nothing here means nothing is outstanding."
            />
            <div className="divide-y">
              {attention.map((a) => (
                <Link
                  key={a.text}
                  to={a.link}
                  className="flex items-center gap-3 px-1 py-2.5 text-[14px] transition-colors hover:bg-muted/50"
                >
                  <AlertTriangle
                    className={cn(
                      'h-4 w-4 shrink-0',
                      a.kind === 'danger'
                        ? 'text-destructive'
                        : a.kind === 'warning'
                          ? 'text-warning'
                          : 'text-muted-foreground',
                    )}
                  />
                  <span>
                    <span className="font-semibold tabular-nums">{a.count}</span> {a.text}
                  </span>
                </Link>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Away today"
            description={
              away.length
                ? 'Their classes need covering.'
                : 'Everybody is in, or the register has not been marked yet.'
            }
          />
          <Table
            head={['Name', 'Code', 'Why', 'Back']}
            empty={away.length === 0}
            emptyLabel="Nobody is marked away today."
          >
            {away.map((p) => (
              <tr key={p.employee_code + p.reason}>
                <Td className="font-medium">{p.name}</Td>
                <Td className="font-mono text-[12px]">{p.employee_code}</Td>
                <Td>
                  <Badge tone={p.reason === 'marked absent' ? 'warning' : 'neutral'}>
                    {p.reason}
                  </Badge>
                </Td>
                {/* Blank means back tomorrow. Writing "tomorrow" would be a
                    guess about a school that may not open tomorrow. */}
                <Td className="text-muted-foreground">
                  {p.until ? formatDate(p.until) : '—'}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}
