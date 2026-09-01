import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Select, Reload, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* The year plan, drawn as the timeline it is.

   The school keeps this as a spreadsheet with a month column, which means a
   chapter running three periods over makes every month below it wrong. Here no
   month is stored: the chapters carry an order and a period cost, the calendar
   carries the teaching days, and the placement is poured fresh on every read.

   So this screen has nothing to save. Editing a chapter — its order, its
   periods — happens on the syllabus screen, and the timeline re-flows. */

interface Spend {
  month: string
  periods: number
}

interface Unit {
  id: string
  sequence: number
  title: string
  planned_periods: number
  starts_in?: string
  ends_in?: string
  split?: Spend[]
  delivered: boolean
  delivered_on?: string
  overflows?: boolean
}

interface Month {
  month: string
  label: string
  working_days: number
  exam_days: number
  teaching_days: number
}

interface YearPlanResponse {
  from: string
  to: string
  months: Month[]
  units: Unit[]
  summary: {
    teaching_days: number
    planned_periods: number
    spare_periods: number
    units: number
    units_delivered: number
  }
}

interface SubjectOption {
  id: string
  class_name?: string
  subject_name?: string
}

export default function YearPlan() {
  const [subject, setSubject] = useState('')

  // The subjects this school runs, so the plan can be picked rather than typed.
  const subjects = useQuery({
    queryKey: ['year-plan-subjects'],
    queryFn: () => api.get<SubjectOption[]>('/api/v1/academics/class-subjects'),
  })

  const plan = useQuery({
    queryKey: ['year-plan', subject],
    queryFn: () =>
      api.get<YearPlanResponse>(`/api/v1/academics/admin/year-plan?class_subject_id=${subject}`),
    enabled: !!subject,
  })

  const options = (subjects.data ?? []).map((s) => ({
    value: s.id,
    label: [s.class_name, s.subject_name].filter(Boolean).join(' · ') || s.id,
  }))

  const d = plan.data
  const short = (d?.summary.spare_periods ?? 0) < 0

  return (
    <Card>
      <CardHeader
        title="Year plan"
        description="Chapters poured into the teaching days the calendar leaves. Change a chapter’s periods or its order and the rest of the year re-flows — no month is stored."
        action={
          <div className="flex items-center gap-2">
            <Select
              value={subject}
              onChange={setSubject}
              options={options}
              placeholder="Pick a class and subject"
            />
            <Reload
              onClick={() => plan.refetch()}
              busy={plan.isFetching}
              label="Re-read the plan"
            />
          </div>
        }
      />

      {!subject && (
        <EmptyState
          title="Pick a class and subject"
          body="A year plan is a plan for one subject in one class — the chapters it teaches and the days it has to teach them in."
        />
      )}
      {subject && plan.isLoading && <Loading label="Pouring the year…" />}
      {plan.error && <ErrorState error={plan.error} />}

      {d && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[13px]">
            <Badge tone="neutral">{d.summary.teaching_days} teaching days</Badge>
            <Badge tone="neutral">{d.summary.planned_periods} periods planned</Badge>
            {short ? (
              <Badge tone="danger">
                {Math.abs(d.summary.spare_periods)} periods short
              </Badge>
            ) : (
              <Badge tone="success">{d.summary.spare_periods} periods spare</Badge>
            )}
            <span className="text-muted-foreground">
              {d.summary.units_delivered} of {d.summary.units} chapters taught
            </span>
          </div>

          {short && (
            <p className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[13px] dark:bg-amber-950/20">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                The syllabus is longer than the year. The chapters marked below run past
                February — shown rather than quietly trimmed, because which chapter gives is
                the school’s decision, not this screen’s.
              </span>
            </p>
          )}

          {/* The ruler. Working days minus exam days is what is left to teach in,
              and it is the only figure the plan below spends. */}
          <div className="overflow-x-auto px-4 pb-4">
            <div className="flex min-w-max gap-1">
              {d.months.map((m) => (
                <div
                  key={m.month}
                  className="min-w-[74px] rounded-md border border-border/60 px-2 py-1.5 text-center"
                >
                  <div className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                    {m.label}
                  </div>
                  <div className="text-[17px] font-semibold tabular-nums">{m.teaching_days}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {m.working_days} open
                    {m.exam_days > 0 && ` · ${m.exam_days} exam`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {d.units.length === 0 ? (
            <EmptyState
              title="No chapters for this subject yet"
              body="Add the chapter list on the syllabus screen, or import the year plan workbook, and the timeline draws itself."
            />
          ) : (
            <Table head={['#', 'Chapter', 'Periods', 'Runs', 'Status']}>
              {d.units.map((u) => (
                <tr key={u.id}>
                  <Td className="tabular-nums text-muted-foreground">{u.sequence}</Td>
                  <Td className="font-medium">{u.title}</Td>
                  <Td className="tabular-nums">{u.planned_periods}</Td>
                  <Td className="whitespace-nowrap">
                    {u.overflows ? (
                      <span className="text-muted-foreground">past the year</span>
                    ) : (
                      <>
                        {monthLabel(d.months, u.starts_in)}
                        {u.ends_in !== u.starts_in && ` – ${monthLabel(d.months, u.ends_in)}`}
                        {(u.split?.length ?? 0) > 1 && (
                          <span className="block text-[12px] text-muted-foreground">
                            {u.split!.map((s) => `${monthLabel(d.months, s.month)} ${s.periods}P`).join(' · ')}
                          </span>
                        )}
                      </>
                    )}
                  </Td>
                  <Td>
                    {u.overflows ? (
                      <Badge tone="danger">Does not fit</Badge>
                    ) : u.delivered ? (
                      <Badge tone="success">Taught</Badge>
                    ) : (
                      <Badge tone="neutral">Not yet</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Card>
  )
}

function monthLabel(months: Month[], key?: string) {
  if (!key) return '—'
  return months.find((m) => m.month === key)?.label ?? key
}
