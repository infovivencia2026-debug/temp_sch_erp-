import { useQuery } from '@tanstack/react-query'
import { Flame, BookCheck, CalendarCheck } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { usePhone } from '@/lib/viewport'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

/* Days in a row.

   Two counts, both from records that already exist: the days the app was
   opened, and homework handed in by its due date. Opening this screen is what
   writes today's day, so the number on it is never a day behind.

   A streak that has not been opened today is still alive until midnight — the
   screen says "keep it going" rather than showing a zero at breakfast. */

export interface StreakBadge {
  key: string
  title: string
  detail: string
  group: string
  earned: boolean
  on?: string
}

interface Streak {
  today: string
  open_streak: number
  open_longest: number
  opened_today: boolean
  days_this_month: number
  homework_streak: number
  homework_on_time: number
  homework_due: number
  homework_pending: number
  recent: { day: string; opened: boolean }[]
  badges: StreakBadge[]
}

function DayGrid({ days }: { days: Streak['recent'] }) {
  return (
    <div className="grid grid-cols-7 gap-1.5" aria-label="The last five weeks">
      {days.map((d) => (
        <span
          key={d.day}
          title={d.day}
          className={
            'aspect-square rounded-sm ' + (d.opened ? 'bg-primary' : 'bg-muted')
          }
        />
      ))}
    </div>
  )
}

export default function Streak() {
  const phone = usePhone()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)
  const q = useQuery({
    queryKey: ['streak', studentId],
    queryFn: () => api.get<Streak>(`/api/v1/portal/learning/streak${studentQuery(studentId)}`),
    enabled: ready,
  })

  if (q.isLoading && ready) return <SkeletonTiles count={3} label="Counting the days…" />
  if (q.error) return <ErrorState error={q.error} />
  const s = q.data
  const earned = s?.badges.filter((b) => b.earned) ?? []
  const next = s?.badges.find((b) => !b.earned)

  return (
    <>
      <PageHead eyebrow="Learning" title="Streak" />
      <PageBody width={phone ? 'form' : 'operational'}>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />
        {!ready || !s ? (
          <EmptyState title="Choose a child" body="Each child keeps their own streak." />
        ) : phone ? (
          <>
            <Card className="p-5 text-center">
              <Flame className="mx-auto h-8 w-8 text-primary" />
              <p className="mt-2 text-[40px] font-semibold leading-none">{s.open_streak}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {s.open_streak === 1 ? 'day in a row' : 'days in a row'}
                {s.open_streak > 0 && !s.opened_today ? ' · keep it going today' : ''}
              </p>
              <p className="mt-3 text-[13px] text-muted-foreground">
                Best {s.open_longest} · {s.days_this_month} days this month
              </p>
            </Card>
            <Card className="p-5">
              <DayGrid days={s.recent} />
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-3">
                <BookCheck className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-[15px] font-semibold">{s.homework_streak} on time in a row</p>
                  <p className="text-[13px] text-muted-foreground">
                    {s.homework_on_time} of {s.homework_due} handed in by the due date
                    {s.homework_pending > 0 ? ` · ${s.homework_pending} due soon` : ''}
                  </p>
                </div>
              </div>
            </Card>
            <Card>
              <CardHeader title="Badges" action={<Badge tone="primary">{earned.length}</Badge>} />
              {earned.length === 0 ? (
                <EmptyState
                  title="No badge yet"
                  body={next ? `First one: ${next.title}.` : undefined}
                />
              ) : (
                <ul className="divide-y">
                  {s.badges.map((b) => (
                    <li key={b.key} className={'flex items-center gap-3 px-5 py-3 ' + (b.earned ? '' : 'opacity-50')}>
                      <span className="text-[14px] font-medium">{b.title}</span>
                      <span className="ml-auto text-[12.5px] text-muted-foreground">
                        {b.earned ? 'Earned' : 'Not yet'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat label="Days in a row" value={s.open_streak} icon={Flame}
                hint={s.open_streak > 0 && !s.opened_today ? 'Open the app today to keep it' : `Best ${s.open_longest}`} />
              <Stat label="This month" value={s.days_this_month} icon={CalendarCheck} hint="Days the app was opened" />
              <Stat label="Homework on time" value={s.homework_streak} icon={BookCheck} hint="In a row, by the due date" />
              <Stat label="On time overall" value={`${s.homework_on_time} / ${s.homework_due}`}
                hint={s.homework_pending > 0 ? `${s.homework_pending} due soon` : 'Nothing due'} />
            </CellGrid>
            <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Card>
                <CardHeader title="Last five weeks" />
                <div className="p-5"><DayGrid days={s.recent} /></div>
              </Card>
              <Card>
                <CardHeader title="Badges" action={<Badge tone="primary">{earned.length} earned</Badge>} />
                <Table head={['Badge', 'For', 'Status']}>
                  {s.badges.map((b) => (
                    <tr key={b.key} className={b.earned ? '' : 'text-muted-foreground'}>
                      <Td className="font-medium">{b.title}</Td>
                      <Td>{b.detail}</Td>
                      <Td>{b.earned ? <Badge tone="success">Earned</Badge> : 'Not yet'}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}
