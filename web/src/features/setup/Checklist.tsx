import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Circle, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, CellGrid, Stat, SkeletonTiles, ErrorState } from '@/components/ui'
import { cn } from '@/lib/utils'

interface Step {
  key: string; label: string; done: boolean
  count: number; detail: string; blocking: boolean
}
interface Status {
  steps: Step[]; completed: number; total: number
  blocking_remaining: number; ready: boolean
}

/**
 * The first screen a new school should see.
 *
 * An empty ERP is indistinguishable from a broken one — every dashboard reads
 * zero and nothing explains why. This turns that into a list of what to do
 * next, in the order the data depends on itself.
 */
export default function Checklist() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<Status>('/api/v1/setup/status'),
    refetchInterval: 30_000,
  })

  if (isLoading) return <SkeletonTiles count={3} />
  if (error) return <ErrorState error={error} />
  const d = data!

  const required = d.steps.filter((s) => s.blocking)
  const optional = d.steps.filter((s) => !s.blocking)

  return (
    <>
      <PageHead
        eyebrow="Getting started"
        title={d.ready ? 'Your school is set up' : 'Finish setting up your school'}
        description={
          d.ready
            ? 'Everything required is in place. The optional steps below unlock fees, grading and exams.'
            : 'Each step depends on the one before it. Work down the list.'
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Steps complete" value={`${d.completed}/${d.total}`} />
          <Stat
            label="Still required"
            value={d.blocking_remaining}
            delta={{ value: d.ready ? 'Ready to operate' : 'Blocking', positive: d.ready }}
          />
          <Stat label="Optional remaining" value={optional.filter((s) => !s.done).length} />
        </CellGrid>

        <Card>
          <CardHeader title="Required" description="The school cannot operate without these" />
          <ol className="divide-y">
            {required.map((s, i) => (
              <StepRow key={s.key} step={s} index={i + 1} />
            ))}
          </ol>
        </Card>

        <Card>
          <CardHeader title="Recommended" description="Unlock fees, grading and examinations" />
          <ol className="divide-y">
            {optional.map((s, i) => (
              <StepRow key={s.key} step={s} index={required.length + i + 1} />
            ))}
          </ol>
        </Card>
      </PageBody>
    </>
  )
}

function StepRow({ step, index }: { step: Step; index: number }) {
  return (
    <li className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 shrink-0">
        {step.done ? (
          <CheckCircle2 className="h-[18px] w-[18px] text-success" />
        ) : step.blocking ? (
          <AlertCircle className="h-[18px] w-[18px] text-warning" />
        ) : (
          <Circle className="h-[18px] w-[18px] text-muted-foreground/50" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-[14px] font-medium', step.done && 'text-muted-foreground line-through')}>
          {index}. {step.label}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{step.detail}</p>
      </div>
      {step.count > 0 && (
        <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{step.count}</span>
      )}
    </li>
  )
}
