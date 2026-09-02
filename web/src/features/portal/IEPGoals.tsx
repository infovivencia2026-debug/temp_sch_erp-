import { useQuery } from '@tanstack/react-query'
import { Target, ClipboardList } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Field,
  Loading, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useChildren, childOptions, readyFor } from './use-children'

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
  const t = useT()
  const { children, studentId, chosen, setChosen } = useChildren()
  /* A support plan is one child's, and the endpoint resolves it with
     whichChild (portal_school_life.go:1164), which answers for the eldest when
     no student_id is sent. So a guardian of three used to open this screen and
     read a concern, a set of accommodations and an exam concession belonging to
     a child the page never named, while the picker above still said "Choose a
     child…". Nothing is fetched until the question has an answer. */
  const ready = readyFor(children, studentId)
  const query = useQuery({
    queryKey: ['portal-iep', studentId],
    queryFn: () =>
      api.get<{
        student_name: string
        plan: Plan
        goals: Goal[]
        has_plan: boolean
      }>(`/api/v1/portal/academics/iep${studentId ? `?student_id=${studentId}` : ''}`),
    enabled: ready,
  })

  if (query.isLoading) return <Loading label={t('portal.iep_goals.loading')} />
  if (query.error) return <ScreenError error={query.error} />

  const plan = query.data?.plan
  const goals = query.data?.goals ?? []
  const measured = goals.filter((g) => g.progress_percent != null)

  return (
    <>
      <PageHead
        eyebrow={t('portal.iep_goals.eyebrow')}
        title={t('portal.iep_goals.title')}
        description={t('portal.iep_goals.description')}
      />
      <PageBody>
        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label={t('portal.iep_goals.field_child')}>
                <Select value={chosen} onChange={setChosen} options={childOptions(children)} />
              </Field>
            </div>
          </Card>
        )}

        {!ready ? (
          <Card>
            <EmptyState
              title={t('portal.iep_goals.choose_child_title')}
              body={t('portal.iep_goals.choose_child_body')}
            />
          </Card>
        ) : !query.data?.has_plan ? (
          <Card>
            <EmptyState
              title={t('portal.iep_goals.no_plan_title')}
              body={t('portal.iep_goals.no_plan_body')}
            />
          </Card>
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label={t('portal.iep_goals.stat_goals')} value={goals.length} icon={Target} />
              <Stat label={t('portal.iep_goals.stat_met')} value={goals.filter((g) => g.status === 'met').length} />
              <Stat
                label={t('portal.iep_goals.stat_average_progress')}
                value={
                  measured.length
                    ? `${Math.round(measured.reduce((n, g) => n + (g.progress_percent ?? 0), 0) / measured.length)}%`
                    : '—'
                }
                hint={measured.length ? undefined : t('portal.iep_goals.stat_average_hint')}
              />
            </CellGrid>

            <Card>
              <CardHeader
                title={t('portal.iep_goals.plan_title')}
                description={
                  plan?.review_on
                    ? t('portal.iep_goals.plan_next_review', { date: formatDate(plan.review_on) })
                    : t('portal.iep_goals.plan_no_review')
                }
                action={plan?.status ? <Badge tone={TONE[plan.status] ?? 'neutral'}>{plan.status.replace('_', ' ')}</Badge> : undefined}
              />
              <dl className="divide-y">
                {[
                  [t('portal.iep_goals.plan_concern'), plan?.concern],
                  [t('portal.iep_goals.plan_accommodations'), plan?.accommodations],
                  [t('portal.iep_goals.plan_exam_concession'), plan?.exam_concession],
                  [t('portal.iep_goals.plan_external_support'), plan?.external_support],
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
                title={t('portal.iep_goals.goals_title')}
                description={t('portal.iep_goals.goals_description')}
              />
              {goals.length === 0 ? (
                <EmptyState
                  title={t('portal.iep_goals.no_goals_title')}
                  body={t('portal.iep_goals.no_goals_body')}
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
                            {g.target_on &&
                              t('portal.iep_goals.aiming_for', { date: formatDate(g.target_on) })}
                          </p>
                        </div>
                        <Badge tone={TONE[g.status] ?? 'neutral'}>{g.status}</Badge>
                      </div>

                      {g.progress_percent != null ? (
                        <>
                          <div className="mt-3 flex items-baseline justify-between gap-3 text-[13px]">
                            <span className="text-muted-foreground">
                              {t('portal.iep_goals.started_at', {
                                value: `${g.baseline_value ?? ''}${g.unit ? ` ${g.unit}` : ''}`,
                              })}
                            </span>
                            <span className="font-medium">
                              {t('portal.iep_goals.now', { value: g.latest_value ?? '' })}
                              {g.latest_on && (
                                <span className="text-muted-foreground"> ({formatDate(g.latest_on)})</span>
                              )}
                            </span>
                            <span className="text-muted-foreground">
                              {t('portal.iep_goals.target', { value: g.target_value ?? '' })}
                            </span>
                          </div>
                          <ProgressBar percent={g.progress_percent} />
                          <p className="mt-1 text-[12px] text-muted-foreground">
                            {t('portal.iep_goals.progress_of_the_way', {
                              percent: g.progress_percent,
                            })}
                            {!g.higher_is_better && t('portal.iep_goals.lower_is_better')}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-[13px] text-muted-foreground">
                          {g.updates.length
                            ? t('portal.iep_goals.recorded_in_words')
                            : t('portal.iep_goals.not_measured')}
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
              {t('portal.iep_goals.footnote')}
            </p>
          </>
        )}
      </PageBody>
    </>
  )
}
