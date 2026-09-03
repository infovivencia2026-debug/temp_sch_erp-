import { useQuery } from '@tanstack/react-query'
import {
  CalendarDays, CheckCircle2, ClipboardCheck, FileText, Megaphone, Repeat,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* What is outstanding on this teacher.

   The faculty Dashboard has two entries and this was the second — catalogued,
   never built, so the most prominent placeholder in the product sat one click
   from where every teacher lands.

   Ordered by when it becomes somebody else's problem, not by category:
   unmarked submissions before missing marks before a notice to acknowledge.
   Colour is spent only on what is genuinely late, because a list where
   everything is red is a list nobody reads. */

interface WorkItem {
  kind: string
  title: string
  detail: string
  count: number
  due?: string
  overdue: boolean
}
interface MyWorkView {
  items: WorkItem[]
  outstanding: number
  sections: number
}

const KIND: Record<string, { label: string; icon: typeof FileText }> = {
  submissions: { label: 'Marking', icon: ClipboardCheck },
  marks: { label: 'Marks', icon: FileText },
  substitution: { label: 'Cover', icon: Repeat },
  leave: { label: 'Leave', icon: CalendarDays },
  announcement: { label: 'Notice', icon: Megaphone },
}

// The order a teacher would sort them into themselves.
const ORDER = ['submissions', 'marks', 'substitution', 'announcement', 'leave']

export default function MyWork() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-work'],
    queryFn: () => api.get<MyWorkView>('/api/v1/teaching/my-work'),
  })

  if (isLoading) return <SkeletonTiles count={4} label="Checking what is outstanding…" />
  if (error) return <ErrorState error={error} />
  const d = data!

  const items = [...d.items].sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  )
  const late = items.filter((i) => i.overdue).length
  const count = (k: string) => items.filter((i) => i.kind === k).reduce((n, i) => n + i.count, 0)

  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="My work"
        description={
          items.length === 0
            ? 'Nothing is waiting on you.'
            : 'Everything outstanding on you, most pressing first.'
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Outstanding"
            value={d.outstanding}
            delta={
              late
                ? { value: `${late} overdue`, positive: false }
                : { value: 'Nothing overdue', positive: true }
            }
          />
          <Stat label="To mark" value={count('submissions')} icon={ClipboardCheck} />
          <Stat label="Marks missing" value={count('marks')} icon={FileText} />
          <Stat label="Cover" value={count('substitution')} icon={Repeat} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Outstanding"
            description={
              d.sections === 0
                ? 'You are not assigned to a section yet, so nothing can be outstanding.'
                : `Across your ${d.sections} section${d.sections === 1 ? '' : 's'}`
            }
          />
          {items.length === 0 ? (
            <EmptyState
              title="Clear"
              body={
                d.sections === 0
                  ? 'Once the office makes you class teacher of a section, or gives you a subject in one, your work appears here.'
                  : 'Every submission is marked, every paper is entered and nothing is waiting on your acknowledgement.'
              }
            />
          ) : (
            /* Capped and scrolled.

               A teacher with four subjects across two sections has a dozen of
               these, and a card that grows to whatever the term produced
               pushes everything below it — the timetable, the cover — off the
               screen entirely. Roughly six rows before it scrolls, so what is
               under the card stays reachable. */
            <ul className="max-h-[26rem] divide-y overflow-y-auto">
              {items.map((it, i) => {
                const K = KIND[it.kind] ?? { label: it.kind, icon: FileText }
                const Icon = K.icon
                return (
                  <li key={i} className="flex items-start gap-3 px-5 py-4">
                    <span
                      className={cn(
                        'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md',
                        it.overdue ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium">{it.title}</p>
                      <p className="mt-0.5 text-[14px] text-muted-foreground">{it.detail}</p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                        <Badge tone={it.overdue ? 'danger' : 'neutral'}>{K.label}</Badge>
                        {it.due && (
                          <span className={it.overdue ? 'text-destructive' : undefined}>
                            {it.overdue ? 'was due ' : 'due '}
                            {formatDate(it.due)}
                          </span>
                        )}
                      </p>
                    </div>
                    {it.count > 1 && (
                      <span className="shrink-0 text-[18px] font-semibold tabular-nums">
                        {it.count}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {items.length === 0 && d.sections > 0 && (
          <p className="flex items-center justify-center gap-2 text-[14px] text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-success" />
            You are up to date.
          </p>
        )}
      </PageBody>
    </>
  )
}
