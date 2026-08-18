import { useQuery } from '@tanstack/react-query'
import { Target, ClipboardList } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Field,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

/* How the support plan is actually going.

   The plan itself — the concern, the accommodations, the exam concession — has
   been in the schema since support plans were added and no family screen ever
   showed it, so a parent who agreed a plan in a meeting had no copy of what was
   agreed. That is the top half of this page.

   The bottom half is the part that answers "is it working". Each goal has a
   number it started at and one it is aiming for, and the bar is the newest
   dated observation between them. Goals whose target is lower than the
   baseline — fewer prompts, fewer absences — fill up as the number falls,
   because the fraction is taken against the distance travelled rather than
   against the raw value.

   A goal with no measurements shows no bar at all. A bar drawn at zero for a
   goal nobody has measured reads as a child who has made no progress, which is
   a different and much crueller statement. */

interface Update {
  on_date: string
  value?: number
  note?: string
}

interface Goal {
  id: string
  title: string
  domain: string
  baseline_value?: number
  target_value?: number
  latest_value?: number
  latest_on?: string
  unit?: string
  higher_is_better: boolean
  starts_on: string
  target_on?: string
  status: string
  progress_percent?: number
  updates: Update[]
}

interface Plan {
  id?: string
  concern?: string
  accommodations?: string
  exam_concession?: string
  external_support?: string
  review_on?: string
  status?: string
}

const TONE: Record<string, 'primary' | 'success' | 'warning' | 'neutral'> = {
  active: 'primary',
  met: 'success',
  paused: 'warning',
  withdrawn: 'neutral',
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${Math.max(2, percent)}%` }}
      />
    </div>
  )
}

export default function IEPGoals() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const query = useQuery({
    queryKey: ['portal-iep', studentId],
    queryFn: () =>
      api.get<{
        student_name: string
        plan: Plan
        goals: Goal[]
        has_plan: boolean
      }>(`/api/v1/portal/academics/iep${studentId ? `?student_id=${studentId}` : ''}`),
  })

  if (query.isLoading) return <Loading label="Looking up the support plan…" />
  if (query.error) return <ErrorState error={query.error} />

  const plan = query.data?.plan
  const goals = query.data?.goals ?? []
  const measured = goals.filter((g) => g.progress_percent != null)

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Support plan & goals"
        description="What the school agreed to do, and how far each goal has come."
      />
      <PageBody>
        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label="Child">
                <Select value={chosen} onChange={setChosen} options={childOptions(children)} />
              </Field>
            </div>
          </Card>
        )}

        {!query.data?.has_plan ? (
          <Card>
            <EmptyState
              title="No support plan"
              body="Your child does not have a support plan on file. If you believe they should, speak to the class teacher."
            />
          </Card>
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Goals" value={goals.length} icon={Target} />
              <Stat label="Met" value={goals.filter((g) => g.status === 'met').length} />
              <Stat
                label="Average progress"
                value={
                  measured.length
                    ? `${Math.round(measured.reduce((n, g) => n + (g.progress_percent ?? 0), 0) / measured.length)}%`
                    : '—'
                }
                hint={measured.length ? undefined : 'Nothing measured yet'}
              />
            </CellGrid>

            <Card>
              <CardHeader
                title="The plan"
                description={
                  plan?.review_on ? `Next review ${formatDate(plan.review_on)}.` : 'No review date set.'
                }
                action={plan?.status ? <Badge tone={TONE[plan.status] ?? 'neutral'}>{plan.status.replace('_', ' ')}</Badge> : undefined}
              />
              <dl className="divide-y">
                {[
                  ['What we are working on', plan?.concern],
                  ['In the classroom', plan?.accommodations],
                  ['In examinations', plan?.exam_concession],
                  ['Outside the school', plan?.external_support],
                ]
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k as string} className="px-5 py-3">
                      <dt className="text-[13px] text-muted-foreground">{k}</dt>
                      <dd className="mt-1 whitespace-pre-line text-[14px]">{v}</dd>
                    </div>
                  ))}
              </dl>
            </Card>

            <Card>
              <CardHeader
                title="Goals"
                description="Each bar is the most recent measurement between where your child started and where the plan is aiming."
              />
              {goals.length === 0 ? (
                <EmptyState
                  title="No goals yet"
                  body="The plan is in place but no measurable goals have been written against it."
                />
              ) : (
                <ul className="divide-y">
                  {goals.map((g) => (
                    <li key={g.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium">{g.title}</p>
                          <p className="text-[13px] text-muted-foreground">
                            {g.domain.replace(/_/g, ' ')}
                            {g.target_on && ` · aiming for ${formatDate(g.target_on)}`}
                          </p>
                        </div>
                        <Badge tone={TONE[g.status] ?? 'neutral'}>{g.status}</Badge>
                      </div>

                      {g.progress_percent != null ? (
                        <>
                          <div className="mt-3 flex items-baseline justify-between gap-3 text-[13px]">
                            <span className="text-muted-foreground">
                              Started at {g.baseline_value}
                              {g.unit ? ` ${g.unit}` : ''}
                            </span>
                            <span className="font-medium">
                              Now {g.latest_value}
                              {g.latest_on && (
                                <span className="text-muted-foreground"> ({formatDate(g.latest_on)})</span>
                              )}
                            </span>
                            <span className="text-muted-foreground">
                              Target {g.target_value}
                            </span>
                          </div>
                          <ProgressBar percent={g.progress_percent} />
                          <p className="mt-1 text-[12px] text-muted-foreground">
                            {g.progress_percent}% of the way
                            {!g.higher_is_better && ' — for this goal a lower number is better'}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-[13px] text-muted-foreground">
                          {g.updates.length
                            ? 'Recorded in words rather than numbers — see the notes below.'
                            : 'Not measured yet.'}
                        </p>
                      )}

                      {g.updates.length > 0 && (
                        <ul className="mt-3 space-y-1 border-l pl-4">
                          {g.updates.slice(0, 5).map((u, i) => (
                            <li key={`${u.on_date}-${i}`} className="text-[13px]">
                              <span className="text-muted-foreground">{formatDate(u.on_date)}</span>
                              {u.value != null && <span className="ml-2 font-medium">{u.value}</span>}
                              {u.note && <span className="ml-2">{u.note}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
              <ClipboardList className="mt-0.5 h-4 w-4 shrink-0" />
              Some goals may be recorded but not shared here — a school may withhold a
              goal written from a clinical referral. Ask the class teacher if something
              you expected is missing.
            </p>
          </>
        )}
      </PageBody>
    </>
  )
}
