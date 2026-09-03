import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Checkbox, Textarea, SkeletonTable, ErrorState, FormNotice,
  FormGrid, Field, PrintButton,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'
import { inr, kg, toPaise } from './admin-ops-lib'

/* institution_admin.mid_day_meal.mid_day_meal_register
 *
 * The daily cooked-meal register — the sheet somebody fills in at the kitchen
 * door every afternoon, and the record an inspector asks for by name.
 *
 * It is the source the monthly utilisation return (MDMUtilisation.tsx) has
 * always summarised. Until now nothing wrote it, so that return showed a month
 * of zeroes to every school that opened it. Nothing is duplicated between the
 * two: this screen records days, that one adds them up, and there is exactly
 * one copy of each figure.
 *
 * Closing a day is the act that makes this a record rather than a working
 * sheet. A closed day cannot be edited — it has to be reopened with a reason,
 * and both the reopening and the correction stay visible underneath the day
 * forever. That is the whole reason a register is worth keeping.
 *
 * Foodgrain is kilograms, cooking cost is rupees, and the two never share a
 * column: a form that let 100 g be typed into a money box would file it as a
 * rupee value and this screen would print it back faithfully.
 */

const REGISTER_BASE = '/api/v1/mdm-register'

interface RegisterLine {
  section_id: string
  section_name: string
  class_name: string
  present: number
  meals_served: number
}

interface Amendment {
  action: string
  reason: string
  amended_by?: string
  amended_at: string
  before?: string | null
  after?: string | null
}

interface RegisterDay {
  id: string
  on_date: string
  campus_id?: string
  campus_name?: string
  enrolled: number
  present: number
  meals_served: number
  rice_kg?: number
  cost_paise: number
  menu?: string
  cook_name?: string
  not_served_reason?: string
  status: string
  closed_at?: string
  closed_by?: string
  recorded_by?: string
  line_count: number
  amendment_count: number
  issues: string[]
  lines?: RegisterLine[]
  amendments?: Amendment[]
}

interface MonthResponse {
  month: string
  days: RegisterDay[]
  totals: {
    days_recorded: number
    days_meals_served: number
    meals_served: number
    present: number
    enrolled: number
    rice_kg: number
    cooking_cost_paise: number
  }
}

interface RegisterContext {
  campuses: { id: string; name: string }[]
  sections: { id: string; name: string; class_name: string; campus_id?: string; strength: number }[]
  may_file_institution_wide: boolean
}

function thisMonth(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function MDMRegister() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('institution.write')

  const [month, setMonth] = useState(thisMonth())
  const [campus, setCampus] = useState('')
  const [editing, setEditing] = useState<RegisterDay | 'new' | null>(null)
  const [openDay, setOpenDay] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const days = useQuery({
    queryKey: ['mdm-register', 'days', month, campus],
    queryFn: () =>
      api.get<MonthResponse>(
        `${REGISTER_BASE}/days?month=${month}${campus ? `&campus_id=${campus}` : ''}`,
      ),
  })

  const context = useQuery({
    queryKey: ['mdm-register', 'context'],
    queryFn: () => api.get<RegisterContext>(`${REGISTER_BASE}/context`),
  })

  const detail = useQuery({
    queryKey: ['mdm-register', 'day', openDay],
    queryFn: () => api.get<RegisterDay>(`${REGISTER_BASE}/days/${openDay}`),
    enabled: !!openDay,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mdm-register'] })

  const close = useMutation({
    mutationFn: (id: string) => api.post(`${REGISTER_BASE}/days/${id}/close`, {}),
    onSuccess: () => {
      setNote('Day closed. It is now the figure this school has filed.')
      invalidate()
    },
  })

  const reopen = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      api.post(`${REGISTER_BASE}/days/${v.id}/reopen`, { reason: v.reason }),
    onSuccess: () => {
      setNote('Reopened. The reason is on the record, and so will be the correction.')
      invalidate()
    },
  })

  const d = days.data
  const flagged = d?.days.filter((x) => x.issues.length > 0) ?? []

  return (
    <>
      <PageHead
        eyebrow="Mid-day meal"
        title="Mid-day meal register"
        description="The daily record: children present, meals served, foodgrain and cooking cost, who cooked, and why the kitchen did not on the days it did not. This is what the monthly utilisation return is built from."
      />
      <PageBody>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-muted-foreground">Month</span>
            <Input value={month} onChange={setMonth} type="month" />
          </label>
          {(context.data?.campuses.length ?? 0) > 1 && (
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Campus</span>
              <Select
                value={campus}
                onChange={setCampus}
                placeholder="Every campus you cover"
                options={(context.data?.campuses ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
            </label>
          )}
          <PrintButton label="Print the register" />
          {mayWrite && (
            <Button size="sm" onClick={() => { setEditing('new'); setNote('') }}>
              Record a day
            </Button>
          )}
        </div>

        <FormNotice error={close.error ?? reopen.error} ok={note} />

        {editing && mayWrite && (
          <DayForm
            /* Keyed by the day being edited. Without this the form keeps the
               previous day's figures in state when a different row is opened,
               and yesterday's headcount is filed under today's date — a bug
               this codebase has shipped nine times in other forms. */
            key={editing === 'new' ? 'new' : editing.id}
            day={editing === 'new' ? null : editing}
            context={context.data}
            defaultCampus={campus}
            onDone={(m) => { setEditing(null); setNote(m); invalidate() }}
            onCancel={() => setEditing(null)}
          />
        )}

        {days.isLoading ? (
          <SkeletonTable columns={2} />
        ) : days.error ? (
          /* A failed query is never drawn as an empty register. "Nothing
             recorded this month" and "we could not read the register" are
             different sentences and only one of them means go and cook. */
          <ErrorState error={days.error} />
        ) : d ? (
          <>
            <CellGrid cols={4}>
              <Stat
                label="Meals served"
                value={d.totals.meals_served.toLocaleString('en-IN')}
                hint={`over ${d.totals.days_meals_served} serving day${d.totals.days_meals_served === 1 ? '' : 's'}`}
              />
              <Stat label="Days recorded" value={d.totals.days_recorded} />
              <Stat label="Foodgrain consumed" value={kg(d.totals.rice_kg)} />
              <Stat label="Cooking cost" value={inr(d.totals.cooking_cost_paise)} />
            </CellGrid>

            {flagged.length > 0 && (
              <Card>
                <CardHeader
                  title={`${flagged.length} day${flagged.length === 1 ? '' : 's'} the block office would question`}
                  description="The same arithmetic the monthly return runs, applied the day it is entered rather than six weeks later in a letter."
                />
                <Table head={['Date', 'What does not add up']}>
                  {flagged.map((x) => (
                    <tr key={x.id}>
                      <Td className="tabular-nums font-medium">{x.on_date}</Td>
                      <Td>
                        {x.issues.map((i) => (
                          <span key={i} className="block text-[13px] text-destructive">{i}</span>
                        ))}
                      </Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}

            <Card>
              <CardHeader
                title="The register"
                description="A closed day is the figure this school has filed. Correcting one means reopening it with a reason, and both versions stay on the record."
              />
              <Table
                head={['Date', 'On roll', 'Present', 'Meals', 'Foodgrain', 'Cost', 'Cook', 'Status', '']}
                empty={!d.days.length}
                emptyLabel="Nothing recorded for this month yet."
              >
                {d.days.map((x) => (
                  <tr key={x.id}>
                    <Td className="tabular-nums font-medium">{x.on_date}</Td>
                    <Td className="tabular-nums text-muted-foreground">{x.enrolled}</Td>
                    <Td className="tabular-nums text-muted-foreground">{x.present}</Td>
                    <Td className={cn('tabular-nums', x.issues.length > 0 && 'font-medium text-destructive')}>
                      {x.meals_served}
                    </Td>
                    <Td className="tabular-nums">{x.rice_kg != null ? kg(x.rice_kg) : '—'}</Td>
                    <Td className="tabular-nums">{inr(x.cost_paise)}</Td>
                    <Td className="text-muted-foreground">{x.cook_name ?? '—'}</Td>
                    <Td>
                      <Badge tone={x.status === 'closed' ? 'success' : 'warning'}>
                        {x.status === 'closed' ? 'closed' : 'open'}
                      </Badge>
                      {x.amendment_count > 0 && (
                        <span className="ml-2 text-[12px] text-muted-foreground">
                          amended {x.amendment_count}×
                        </span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="ghost"
                          onClick={() => setOpenDay(openDay === x.id ? null : x.id)}>
                          {openDay === x.id ? 'Hide' : 'Detail'}
                        </Button>
                        {mayWrite && x.status === 'open' && (
                          <>
                            <Button size="sm" variant="secondary"
                              onClick={() => { setEditing(x); setNote('') }}>
                              Edit
                            </Button>
                            <Button size="sm" disabled={close.isPending}
                              onClick={() => close.mutate(x.id)}>
                              Close
                            </Button>
                          </>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>

            {openDay && (
              detail.isLoading ? <SkeletonTable columns={4} /> :
              detail.error ? <ErrorState error={detail.error} /> :
              detail.data ? (
                <DayDetail
                  key={detail.data.id}
                  day={detail.data}
                  mayWrite={mayWrite}
                  pending={reopen.isPending}
                  onReopen={(reason) => reopen.mutate({ id: detail.data!.id, reason })}
                />
              ) : null
            )}
          </>
        ) : null}
      </PageBody>
    </>
  )
}

/* One closed or open day, in full: the section breakdown if the school keeps
   one, and every correction ever made to it. */
function DayDetail({ day, mayWrite, pending, onReopen }: {
  day: RegisterDay
  mayWrite: boolean
  pending: boolean
  onReopen: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Card>
      <CardHeader
        title={`${day.on_date}${day.campus_name ? ` — ${day.campus_name}` : ''}`}
        description={day.status === 'closed'
          ? `Closed${day.closed_by ? ` by ${day.closed_by}` : ''}. This is what the school has filed for this day.`
          : 'Still open. Nothing is filed until it is closed.'}
      />

      <div className="space-y-1 p-5 text-[13px]">
        {day.cook_name && <p><span className="text-muted-foreground">Cook on duty: </span>{day.cook_name}</p>}
        {day.menu && <p><span className="text-muted-foreground">Menu: </span>{day.menu}</p>}
        {day.not_served_reason && (
          <p><span className="text-muted-foreground">No meal served because: </span>{day.not_served_reason}</p>
        )}
        {day.recorded_by && <p className="text-muted-foreground">Recorded by {day.recorded_by}</p>}
      </div>

      {(day.lines?.length ?? 0) > 0 && (
        <Table head={['Class', 'Section', 'Present', 'Meals']}>
          {(day.lines ?? []).map((l) => (
            <tr key={l.section_id}>
              <Td>{l.class_name}</Td>
              <Td>{l.section_name}</Td>
              <Td className="tabular-nums">{l.present}</Td>
              <Td className="tabular-nums">{l.meals_served}</Td>
            </tr>
          ))}
        </Table>
      )}

      {(day.amendments?.length ?? 0) > 0 && (
        <Table head={['When', 'What', 'Who', 'Why']}>
          {(day.amendments ?? []).map((a, i) => (
            <tr key={`${a.amended_at}-${i}`}>
              <Td className="tabular-nums">{a.amended_at.slice(0, 16).replace('T', ' ')}</Td>
              <Td>{a.action === 'reopen' ? 'reopened' : 'figures corrected'}</Td>
              <Td className="text-muted-foreground">{a.amended_by ?? '—'}</Td>
              <Td>{a.reason}</Td>
            </tr>
          ))}
        </Table>
      )}

      {mayWrite && day.status === 'closed' && (
        <div className="space-y-3 p-5">
          <label className="flex max-w-lg flex-col gap-1.5 text-[13px]">
            <span className="text-muted-foreground">
              Reopening a closed day needs a reason, and the reason stays on the record
            </span>
            <Textarea value={reason} onChange={setReason} rows={2} />
          </label>
          <Button variant="secondary" disabled={pending || !reason.trim()}
            onClick={() => onReopen(reason.trim())}>
            {pending ? 'Reopening…' : 'Reopen for correction'}
          </Button>
        </div>
      )}
    </Card>
  )
}

/* The entry form.
 *
 * Every numeric box is held as a string and sent only when it holds a number.
 * An emptied box is a third state — neither the stored figure nor a value —
 * and turning it into 0 would file a day claiming meals were cooked with no
 * rice, which is precisely the row an inspection stops on. The MDM balances
 * form was fixed for exactly this, and the fix is repeated here rather than
 * rediscovered.
 */
function DayForm({ day, context, defaultCampus, onDone, onCancel }: {
  day: RegisterDay | null
  context?: RegisterContext
  defaultCampus: string
  onDone: (msg: string) => void
  onCancel: () => void
}) {
  const [onDate, setOnDate] = useState(day?.on_date ?? today())
  const [campus, setCampus] = useState(day?.campus_id ?? defaultCampus)
  const [enrolled, setEnrolled] = useState(day ? String(day.enrolled) : '')
  const [present, setPresent] = useState(day ? String(day.present) : '')
  const [meals, setMeals] = useState(day ? String(day.meals_served) : '')
  const [rice, setRice] = useState(day?.rice_kg != null ? String(day.rice_kg) : '')
  const [cost, setCost] = useState(day ? String(day.cost_paise / 100) : '')
  const [cook, setCook] = useState(day?.cook_name ?? '')
  const [menu, setMenu] = useState(day?.menu ?? '')
  const [notServed, setNotServed] = useState(day?.not_served_reason ?? '')
  const [reason, setReason] = useState('')
  const [byClass, setByClass] = useState((day?.line_count ?? 0) > 0)
  const [lines, setLines] = useState<Record<string, { present: string; meals: string }>>(() => {
    const seed: Record<string, { present: string; meals: string }> = {}
    for (const l of day?.lines ?? []) {
      seed[l.section_id] = { present: String(l.present), meals: String(l.meals_served) }
    }
    return seed
  })

  const amending = (day?.amendment_count ?? 0) > 0
  const num = (v: string): number | undefined => {
    const t = v.trim()
    if (t === '') return undefined
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }

  // What the section lines add up to. Shown in place of the two header boxes
  // while the breakdown is on, so the clerk sees the figure the server will
  // store rather than one they might have typed differently.
  const lineTotals = Object.values(lines).reduce(
    (acc, v) => ({
      present: acc.present + (num(v.present) ?? 0),
      meals: acc.meals + (num(v.meals) ?? 0),
    }),
    { present: 0, meals: 0 },
  )

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        on_date: onDate,
        campus_id: campus || undefined,
        enrolled: num(enrolled),
        present: num(present),
        meals_served: num(meals),
        rice_kg: num(rice),
        cost_paise: cost.trim() === '' ? undefined : toPaise(cost),
        cook_name: cook,
        menu,
        not_served_reason: notServed,
      }
      if (amending) body.reason = reason.trim()
      if (byClass) {
        body.lines = Object.entries(lines)
          .filter(([, v]) => v.present.trim() !== '' || v.meals.trim() !== '')
          .map(([section_id, v]) => ({
            section_id,
            present: num(v.present),
            meals_served: num(v.meals),
          }))
      }
      return api.post(`${REGISTER_BASE}/days`, body)
    },
    onSuccess: () => onDone(day ? 'Day updated.' : 'Day recorded.'),
  })

  // A new day needs all three counts typed. An existing one keeps whatever is
  // not retyped, so a blank box there means "leave it alone" rather than nought.
  const countsGiven = day != null
    || (num(enrolled) !== undefined && num(present) !== undefined && num(meals) !== undefined)
  const sections = (context?.sections ?? []).filter(
    (s) => !campus || !s.campus_id || s.campus_id === campus,
  )

  return (
    <Card>
      <CardHeader
        title={day ? `Correcting ${day.on_date}` : 'Record a day'}
        description={amending
          ? 'This day has already been corrected once. Say why it is being changed again — the reason is kept with both versions.'
          : 'Meals served, children present, what was cooked and who cooked it.'}
      />
      <div className="p-5">
        <FormGrid>
          <Field label="Date">
            <Input value={onDate} onChange={setOnDate} type="date" />
          </Field>
          {(context?.campuses.length ?? 0) > 1 && (
            <Field label="Campus">
              <Select
                value={campus}
                onChange={setCampus}
                placeholder={context?.may_file_institution_wide ? 'The whole school' : undefined}
                options={(context?.campuses ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
            </Field>
          )}
          <Field label="Children on roll">
            <Input value={enrolled} onChange={setEnrolled} type="number" />
          </Field>
          {/* When the day is broken down by class the two totals are the
              server's, computed from the lines. Showing them as text rather
              than as a disabled box is the honest form: they are not a field
              somebody may type into and have ignored. */}
          <Field label="Children present" hint={byClass ? 'Added up from the classes below' : undefined}>
            {byClass ? (
              <p className="text-[14px] tabular-nums">{lineTotals.present}</p>
            ) : (
              <Input value={present} onChange={setPresent} type="number" />
            )}
          </Field>
          <Field label="Meals served" hint={byClass ? 'Added up from the classes below' : undefined}>
            {byClass ? (
              <p className="text-[14px] tabular-nums">{lineTotals.meals}</p>
            ) : (
              <Input value={meals} onChange={setMeals} type="number" />
            )}
          </Field>
          <Field label="Foodgrain consumed (kg)">
            <Input value={rice} onChange={setRice} type="number" />
          </Field>
          <Field label="Cooking cost (₹)">
            <Input value={cost} onChange={setCost} type="number" />
          </Field>
          <Field label="Cook on duty">
            <Input value={cook} onChange={setCook} placeholder="Name of the cook-cum-helper" />
          </Field>
          <Field label="Menu">
            <Input value={menu} onChange={setMenu} placeholder="Rice, dal, vegetable curry, egg" />
          </Field>
          <Field
            label="If no meal was served, why"
            hint="A zero-meal day cannot be closed without this"
          >
            <Input value={notServed} onChange={setNotServed} placeholder="Holiday, no supply, no cook" />
          </Field>
          {amending && (
            <Field label="Why this day is being corrected">
              <Textarea value={reason} onChange={setReason} rows={2} />
            </Field>
          )}
        </FormGrid>

        <div className="mt-4">
          <Checkbox
            checked={byClass}
            onChange={setByClass}
            label="Break the day down by class"
            hint="Optional. The block office asks a large school for the primary and upper-primary split; a small one counts once at the kitchen door."
          />
        </div>
      </div>

      {byClass && (
        <Table
          head={['Class', 'Section', 'On roll', 'Present', 'Meals']}
          empty={!sections.length}
          emptyLabel="No sections on this campus in the current year."
        >
          {sections.map((s) => (
            <tr key={s.id}>
              <Td>{s.class_name}</Td>
              <Td>{s.name}</Td>
              <Td className="tabular-nums text-muted-foreground">{s.strength}</Td>
              <Td>
                <Input
                  className="w-20"
                  type="number"
                  srLabel={`Children present in ${s.class_name} ${s.name}`}
                  value={lines[s.id]?.present ?? ''}
                  onChange={(v) =>
                    setLines((p) => ({ ...p, [s.id]: { present: v, meals: p[s.id]?.meals ?? '' } }))}
                />
              </Td>
              <Td>
                <Input
                  className="w-20"
                  type="number"
                  srLabel={`Meals served in ${s.class_name} ${s.name}`}
                  value={lines[s.id]?.meals ?? ''}
                  onChange={(v) =>
                    setLines((p) => ({ ...p, [s.id]: { present: p[s.id]?.present ?? '', meals: v } }))}
                />
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <div className="space-y-3 p-5">
        <FormNotice error={save.error} />
        <div className="flex gap-2">
          <Button
            disabled={save.isPending || !countsGiven || (amending && !reason.trim())}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : day ? 'Save the correction' : 'Record the day'}
          </Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
        {!countsGiven && (
          <p className="text-[13px] text-muted-foreground">
            A new day needs the roll, the headcount and the meals served. An empty box is not nought.
          </p>
        )}
      </div>
    </Card>
  )
}
