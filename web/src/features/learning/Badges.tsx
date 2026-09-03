import { useQuery } from '@tanstack/react-query'
import { Award, Medal, Star, Flame } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { usePhone } from '@/lib/viewport'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'
import type { StreakBadge } from './Streak'

/* Every badge the child holds, in one place.

   None is minted here. A behaviour badge is the positive conduct note a
   teacher wrote and chose to show the child; an academic or activity badge is
   an achievement the office recorded or a commendation from a teacher; a
   streak badge is a milestone the child reached on their own. What the
   showcase adds is the shelf, not the trophies. */

interface Showcase {
  earned: number
  badges: StreakBadge[]
}

const GROUPS: { key: string; label: string; icon: typeof Award }[] = [
  { key: 'academic', label: 'Academic', icon: Star },
  { key: 'behaviour', label: 'Behaviour', icon: Award },
  { key: 'activities', label: 'Activities', icon: Medal },
  { key: 'streaks', label: 'Streaks', icon: Flame },
]

export default function Badges() {
  const phone = usePhone()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)
  const q = useQuery({
    queryKey: ['badges', studentId],
    queryFn: () => api.get<Showcase>(`/api/v1/portal/learning/badges${studentQuery(studentId)}`),
    enabled: ready,
  })

  if (q.isLoading && ready) return <SkeletonTiles count={4} label="Fetching the badges…" />
  if (q.error) return <ErrorState error={q.error} />
  const all = q.data?.badges ?? []
  const byGroup = (g: string) => all.filter((b) => b.group === g)
  const count = (g: string) => byGroup(g).filter((b) => b.earned).length

  return (
    <>
      <PageHead eyebrow="Learning" title="Badges" />
      <PageBody width={phone ? 'form' : 'operational'}>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />
        {!ready || !q.data ? (
          <EmptyState title="Choose a child" body="Badges belong to one child each." />
        ) : q.data.earned === 0 ? (
          <EmptyState
            title="No badge yet"
            body="Badges come from teachers, from achievements the school records, and from streaks."
          />
        ) : phone ? (
          GROUPS.map((g) => {
            const items = byGroup(g.key).filter((b) => b.earned)
            if (items.length === 0) return null
            return (
              <Card key={g.key}>
                <CardHeader title={g.label} action={<Badge tone="primary">{items.length}</Badge>} />
                <ul className="divide-y">
                  {items.map((b) => (
                    <li key={b.key} className="flex items-start gap-3 px-5 py-3">
                      <g.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">{b.title}</p>
                        {b.detail && <p className="text-[13px] text-muted-foreground">{b.detail}</p>}
                        {b.on && <p className="text-[12.5px] text-muted-foreground">{formatDate(b.on)}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )
          })
        ) : (
          <>
            <CellGrid cols={4}>
              {GROUPS.map((g) => (
                <Stat key={g.key} label={g.label} value={count(g.key)} icon={g.icon} />
              ))}
            </CellGrid>
            <Card>
              <CardHeader title="All badges" action={<Badge tone="primary">{q.data.earned} earned</Badge>} />
              <Table head={['Badge', 'Kind', 'For', 'When']}>
                {all.filter((b) => b.earned).map((b) => (
                  <tr key={b.key}>
                    <Td className="font-medium">{b.title}</Td>
                    <Td>{GROUPS.find((g) => g.key === b.group)?.label ?? b.group}</Td>
                    <Td>{b.detail}</Td>
                    <Td>{b.on ? formatDate(b.on) : '—'}</Td>
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
