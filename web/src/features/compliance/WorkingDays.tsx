import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, SkeletonTable,
  ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

/* Working days and instructional hours against the statutory minimum.

   Computed from the calendar and the timetable that already exist, never typed.
   The number that matters is the shortfall, and it matters early — a school
   told in April that it is thirty hours short has learned something it can no
   longer act on. Hence the year-to-date toggle: one figure is a projection, the
   other is what has already happened. */

interface ClassRow {
  class_id?: string
  class_label: string
  class_level?: number
  stage_code?: string
  stage_label?: string
  working_days: number
  instructional_minutes: number
  required_days: number
  required_minutes: number
  shortfall_days: number
  shortfall_minutes: number
  has_timetable: boolean
}

interface Result {
  academic_year_id: string
  academic_year: string
  period_from: string
  period_to: string
  to_date: boolean
  calendar_days: number
  working_days: number
  declared_working_days?: number
  required_working_days: number
  adjustment_days: number
  adjustment_minutes: number
  classes_short: number
  classes: ClassRow[]
  notes: string[]
}

interface Norm {
  id: string
  stage_code: string
  label: string
  min_level: number
  max_level: number
  min_days: number
  min_hours: number
  authority?: string
  note?: string
}

interface Adjustment {
  id: string
  class_id?: string
  class_label?: string
  on_date: string
  days_delta: number
  minutes_delta: number
  reason: string
  created_by?: string
  created_at: string
}

interface Return {
  id: string
  title: string
  period_from: string
  period_to: string
  status: string
  working_days: number
  classes_short: number
  filed_at?: string
  filed_by?: string
  lines: ClassRow[]
}

const hours = (minutes: number) =>
  `${(minutes / 60).toLocaleString('en-IN', { maximumFractionDigits: 1 })} h`

export default function WorkingDays() {
  const qc = useQueryClient()
  /* Two different permissions on one screen, so they are read separately
     rather than collapsed into one flag: adjustments and norms are
     academics.write, filing the return is institution.write
     (statutory.go:118-125). A teacher-facing academics role may record a
     closure without being able to file the school's statutory return. */
  const can = useCan()
  const mayAdjust = can('academics.write')
  const mayFileReturn = can('institution.write')
  const [toDate, setToDate] = useState(true)
  const [adj, setAdj] = useState({ on_date: '', days: '', minutes: '', reason: '' })
  const [title, setTitle] = useState('')

  const compute = useQuery({
    queryKey: ['working-days', toDate],
    queryFn: () =>
      api.get<Result>(`/api/v1/statutory/working-days${toDate ? '?to_date=1' : ''}`),
  })
  const norms = useQuery({
    queryKey: ['working-days-norms'],
    queryFn: () => api.get<List<Norm>>('/api/v1/statutory/working-days/norms'),
  })
  const adjustments = useQuery({
    queryKey: ['working-days-adjustments'],
    queryFn: () => api.get<List<Adjustment>>('/api/v1/statutory/working-days/adjustments'),
  })
  const returns = useQuery({
    queryKey: ['working-days-returns'],
    queryFn: () => api.get<List<Return>>('/api/v1/statutory/working-days/returns'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['working-days'] })
    qc.invalidateQueries({ queryKey: ['working-days-adjustments'] })
    qc.invalidateQueries({ queryKey: ['working-days-returns'] })
  }

  const addAdjustment = useMutation({
    mutationFn: () =>
      api.post('/api/v1/statutory/working-days/adjustments', {
        on_date: adj.on_date,
        days_delta: Number(adj.days || 0),
        minutes_delta: Number(adj.minutes || 0),
        reason: adj.reason,
      }),
    onSuccess: () => {
      setAdj({ on_date: '', days: '', minutes: '', reason: '' })
      refresh()
    },
  })

  const removeAdjustment = useMutation({
    mutationFn: (id: string) =>
      api.del(`/api/v1/statutory/working-days/adjustments/${id}`),
    onSuccess: refresh,
  })

  const fileReturn = useMutation({
    mutationFn: () =>
      api.post('/api/v1/statutory/working-days/returns', { title: title || undefined }),
    onSuccess: () => {
      setTitle('')
      refresh()
    },
  })

  const r = compute.data

  return (
    <>
      <PageHead
        eyebrow="Statutory returns"
        title="Working days & instructional hours"
        description="Counted from the academic calendar and the timetable, against the RTE minimum for each stage. The point is to see a shortfall while there is still term left to fix it."
        width="wide"
        actions={
          <Button variant="secondary" onClick={() => setToDate((v) => !v)}>
            {toDate ? 'Show the whole year' : 'Show year to date'}
          </Button>
        }
      />
      <PageBody width="wide">
        {compute.isLoading ? (
          <SkeletonTable columns={9} label="Counting the calendar…" />
        ) : compute.error ? (
          <ErrorState error={compute.error} />
        ) : r ? (
          <>
            <CellGrid cols={4}>
              <Stat
                label={toDate ? 'Working days so far' : 'Working days this year'}
                value={r.working_days}
                hint={`${r.period_from} to ${r.period_to}`}
              />
              <Stat
                label="Classes short"
                value={r.classes_short}
                delta={{
                  value: r.classes_short ? 'Below the minimum' : 'All classes meet it',
                  positive: r.classes_short === 0,
                }}
              />
              <Stat label="Minimum required" value={r.required_working_days} />
              <Stat
                label="Manual adjustment"
                value={`${r.adjustment_days > 0 ? '+' : ''}${r.adjustment_days} d`}
                hint={r.adjustment_minutes ? `${r.adjustment_minutes} min` : undefined}
              />
            </CellGrid>

            {r.to_date && (
              <Card>
                <div className="px-5 py-3 text-[13px] text-muted-foreground">
                  Year to date, cut at today. This is what has actually happened; switch to the
                  whole year for the projection you will eventually file.
                </div>
              </Card>
            )}

            {r.notes.map((n) => (
              <Card key={n}>
                <div className="flex items-start gap-2 px-5 py-3 text-[13px]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <span>{n}</span>
                </div>
              </Card>
            ))}

            <Card>
              <CardHeader
                title="By class"
                description={`${r.academic_year} · ${r.calendar_days} calendar days in the window`}
              />
              <Table
                head={[
                  'Class', 'Stage', 'Working days', 'Required', 'Short by',
                  'Instructional hours', 'Required', 'Short by',
                ]}
                empty={!r.classes.length}
                emptyLabel="No classes are set up for this year."
              >
                {r.classes.map((c) => (
                  <tr key={c.class_id ?? c.class_label}>
                    <Td className="font-medium">{c.class_label}</Td>
                    <Td>{c.stage_label ?? '—'}</Td>
                    <Td className="tabular-nums">{c.working_days}</Td>
                    <Td className="tabular-nums text-muted-foreground">{c.required_days}</Td>
                    <Td className="tabular-nums">
                      {c.shortfall_days > 0 ? (
                        <Badge tone="danger">{c.shortfall_days} d</Badge>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      {c.has_timetable ? hours(c.instructional_minutes) : (
                        <span className="text-muted-foreground">no timetable</span>
                      )}
                    </Td>
                    <Td className="tabular-nums text-muted-foreground">
                      {c.required_minutes ? hours(c.required_minutes) : '—'}
                    </Td>
                    <Td className="tabular-nums">
                      {c.shortfall_minutes > 0 ? (
                        <Badge tone="danger">{hours(c.shortfall_minutes)}</Badge>
                      ) : (
                        '—'
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card>
              <CardHeader
                title="Adjustments"
                description="Half days, unscheduled closures, a Saturday worked to make it back. Every one carries a reason, because the return has to be able to explain the difference between the calendar and what it reports."
              />
              <div className="space-y-3 px-5 pb-5 pt-1">
                <FormGrid>
                  <Field label="Date" required>
                    <Input
                      type="date"
                      value={adj.on_date}
                      onChange={(v) => setAdj({ ...adj, on_date: v })}
                    />
                  </Field>
                  <Field label="Days" hint="-0.5 for a half day, +1 for a day worked back">
                    <Input value={adj.days} onChange={(v) => setAdj({ ...adj, days: v })} placeholder="0" />
                  </Field>
                  <Field label="Minutes" hint="Instructional minutes gained or lost">
                    <Input
                      value={adj.minutes}
                      onChange={(v) => setAdj({ ...adj, minutes: v })}
                      placeholder="0"
                    />
                  </Field>
                  <Field label="Reason" required wide>
                    <Input
                      value={adj.reason}
                      onChange={(v) => setAdj({ ...adj, reason: v })}
                      placeholder="Bandh — school closed at noon"
                    />
                  </Field>
                </FormGrid>
                <Button
                  disabled={
                    !mayAdjust || addAdjustment.isPending || !adj.on_date || !adj.reason.trim()
                  }
                  onClick={() => addAdjustment.mutate()}
                >
                  Record the adjustment
                </Button>
                <FormNotice error={addAdjustment.error} />
              </div>
              {/* A failed request is not "no adjustments — the figures above are
                  the calendar as planned", which is a statement about the
                  school's year. */}
              {adjustments.error && <ErrorState error={adjustments.error} />}
              <Table
                head={['Date', 'Class', 'Days', 'Minutes', 'Reason', 'Recorded by', '']}
                empty={!adjustments.data?.items.length && !adjustments.error}
                emptyLabel="No adjustments — the figures above are the calendar as planned."
              >
                {(adjustments.data?.items ?? []).map((a) => (
                  <tr key={a.id}>
                    <Td>{formatDate(a.on_date)}</Td>
                    <Td>{a.class_label ?? 'Whole school'}</Td>
                    <Td className="tabular-nums">{a.days_delta || '—'}</Td>
                    <Td className="tabular-nums">{a.minutes_delta || '—'}</Td>
                    <Td className="max-w-md text-[13px]">{a.reason}</Td>
                    <Td>{a.created_by ?? '—'}</Td>
                    <Td>
                      {mayAdjust && <ConfirmButton
                        size="sm"
                        variant="ghost"
                        tone="danger"
                        confirmLabel="Remove"
                        question="Remove this adjustment? The figures go back to what the calendar says."
                        onConfirm={() => removeAdjustment.mutate(a.id)}
                      >
                        Remove
                      </ConfirmButton>}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card>
              <CardHeader
                title="The statutory minimum"
                description="RTE Act figures for classes I–VIII; the secondary bands are the common state norm and are editable, because states amend them and a stricter board norm is the one you will be inspected on."
              />
              {norms.error && <ErrorState error={norms.error} />}
              <Table
                head={['Stage', 'Classes', 'Minimum days', 'Minimum hours', 'Authority']}
                empty={!norms.data?.items.length && !norms.error}
                emptyLabel="No norms on file."
              >
                {(norms.data?.items ?? []).map((n) => (
                  <tr key={n.id}>
                    <Td className="font-medium">{n.label}</Td>
                    <Td className="tabular-nums">
                      {n.min_level}–{n.max_level}
                    </Td>
                    <Td className="tabular-nums">{n.min_days}</Td>
                    <Td className="tabular-nums">{n.min_hours}</Td>
                    <Td className="text-[13px] text-muted-foreground">{n.authority ?? '—'}</Td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card>
              <CardHeader
                title="File the return"
                description="Freezes today's figures line by line. A filed return is never recomputed — the shortfall as filed is a fact about the filing."
              />
              <div className="space-y-3 px-5 pb-5">
                <FormGrid>
                  <Field label="Title" hint="Defaults to the academic year" wide>
                    <Input value={title} onChange={setTitle} placeholder="Optional" />
                  </Field>
                </FormGrid>
                <Button
                  disabled={!mayFileReturn || fileReturn.isPending}
                  onClick={() => fileReturn.mutate()}
                >
                  {fileReturn.isPending ? 'Filing…' : 'File the return'}
                </Button>
                <FormNotice error={fileReturn.error} />
              </div>
              {returns.error && <ErrorState error={returns.error} />}
              <Table
                head={['Title', 'Period', 'Working days', 'Classes short', 'Filed', 'By']}
                empty={!returns.data?.items.length && !returns.error}
                emptyLabel="Nothing filed yet."
              >
                {(returns.data?.items ?? []).map((t) => (
                  <tr key={t.id}>
                    <Td className="font-medium">{t.title}</Td>
                    <Td>
                      {formatDate(t.period_from)} – {formatDate(t.period_to)}
                    </Td>
                    <Td className="tabular-nums">{t.working_days}</Td>
                    <Td className="tabular-nums">{t.classes_short || '—'}</Td>
                    <Td>{t.filed_at ? formatDate(t.filed_at) : '—'}</Td>
                    <Td>{t.filed_by ?? '—'}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        ) : null}
      </PageBody>
    </>
  )
}
