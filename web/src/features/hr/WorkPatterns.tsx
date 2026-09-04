import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan } from '@/lib/session'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Input, Field, FormGrid,
  FormNotice, Select, SkeletonTable, ErrorState, EmptyState, ConfirmButton,
} from '@/components/ui'
import { WEEKDAYS } from '@/lib/utils'

/* THE HOURS THIS SCHOOL KEEPS, AND WHAT A DAY LOST COSTS.

   The readers have recorded check_in and check_out since the beginning and
   compared them to nothing: nobody could be late, a half day meant nothing,
   and payroll divided the month by the calendar because it had no other rule
   to divide it by.

   One set of hours would not have been enough either. Teaching staff, the
   office and the drivers do not start together - the bus leaves before the
   gate opens and the office closes after the last child has gone. So the
   school names its own sets, says what each one costs, and assigns them. */

interface Pattern {
  id: string
  name: string
  starts_at: string
  ends_at: string
  grace_minutes: number
  full_day_minutes: number
  half_day_minutes: number
  working_days: number[]
  lop_basis: 'none' | 'fixed' | 'salary'
  lop_per_day_paise?: number | null
  salary_divisor: number
  lates_for_half_day: number
  is_default: boolean
  departments: string
  people: number
}
interface Dept { id: string; name: string }

const BLANK = {
  name: '', starts_at: '08:45', ends_at: '15:45', grace_minutes: '10',
  full_day_minutes: '420', half_day_minutes: '210', working_days: [1, 2, 3, 4, 5, 6],
  lop_basis: 'none', lop_rupees: '', salary_divisor: '30', lates_for_half_day: '0',
  is_default: false, department_ids: [] as string[],
}
type Draft = typeof BLANK

/* Money is entered in rupees and stored in paise, as everywhere else here. A
   school typing 500 means five hundred rupees and would be startled to find it
   had set five. */
const toPaise = (r: string) => Math.round(Number(r) * 100)
const toRupees = (p?: number | null) => (p == null ? '' : String(p / 100))

export default function WorkPatterns() {
  const qc = useQueryClient()
  const canWrite = useCan()('hr.employees.write')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [note, setNote] = useState<{ error?: unknown; ok?: string }>({})

  const q = useQuery({
    queryKey: ['work-patterns'],
    queryFn: () => api.get<Pattern[]>('/api/v1/setup/work-patterns'),
  })
  const depts = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get<Dept[]>('/api/v1/setup/departments'),
  })

  const done = (ok: string) => {
    setNote({ ok })
    setDraft(null)
    qc.invalidateQueries({ queryKey: ['work-patterns'] })
  }

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.post('/api/v1/setup/work-patterns', {
        name: d.name.trim(),
        starts_at: d.starts_at,
        ends_at: d.ends_at,
        grace_minutes: Number(d.grace_minutes),
        full_day_minutes: Number(d.full_day_minutes),
        half_day_minutes: Number(d.half_day_minutes),
        working_days: d.working_days,
        lop_basis: d.lop_basis,
        // Sent only where the school picked the rule that uses it, so a stale
        // number left in the box never becomes a policy nobody chose.
        lop_per_day_paise: d.lop_basis === 'fixed' ? toPaise(d.lop_rupees) : null,
        salary_divisor: Number(d.salary_divisor),
        lates_for_half_day: Number(d.lates_for_half_day),
        is_default: d.is_default,
        department_ids: d.department_ids,
      }),
    onSuccess: () => done('Saved. The month is read against these hours from now on.'),
    onError: (error) => setNote({ error }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/setup/work-patterns/${id}`),
    onSuccess: () => done('Removed.'),
    onError: (error) => setNote({ error }),
  })

  const edit = (p: Pattern) => {
    setNote({})
    setDraft({
      name: p.name, starts_at: p.starts_at, ends_at: p.ends_at,
      grace_minutes: String(p.grace_minutes),
      full_day_minutes: String(p.full_day_minutes),
      half_day_minutes: String(p.half_day_minutes),
      working_days: p.working_days,
      lop_basis: p.lop_basis,
      lop_rupees: toRupees(p.lop_per_day_paise),
      salary_divisor: String(p.salary_divisor),
      lates_for_half_day: String(p.lates_for_half_day),
      is_default: p.is_default,
      department_ids: [],
    })
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const toggleDay = (iso: number) =>
    set({
      working_days: draft!.working_days.includes(iso)
        ? draft!.working_days.filter((n) => n !== iso)
        : [...draft!.working_days, iso].sort(),
    })

  // How the rule reads back in a sentence, so somebody scanning the list sees
  // the policy rather than three columns they must assemble themselves.
  const rule = (p: Pattern) =>
    p.lop_basis === 'none' ? 'No deduction'
      : p.lop_basis === 'fixed' ? `Rs ${toRupees(p.lop_per_day_paise)} a day`
        : p.salary_divisor > 0 ? `Pay divided by ${p.salary_divisor}`
          : 'Pay divided by days expected'

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title="Working hours and loss of pay"
        actions={canWrite && !draft
          ? <Button onClick={() => { setNote({}); setDraft({ ...BLANK }) }}>Add hours</Button>
          : undefined}
      />
      <PageBody>
        {draft && (
          <Card>
            <CardHeader title={draft.name ? draft.name : 'New hours'} />
            <div className="p-5">
              <FormGrid>
                <Field label="Name" required hint="Teaching, Office, Transport">
                  <Input value={draft.name} onChange={(v) => set({ name: v })} />
                </Field>
                <Field label="Day starts" required>
                  <Input type="time" value={draft.starts_at} onChange={(v) => set({ starts_at: v })} />
                </Field>
                <Field label="Day ends" required>
                  <Input type="time" value={draft.ends_at} onChange={(v) => set({ ends_at: v })} />
                </Field>
                <Field label="Grace, minutes" hint="Late only after this">
                  <Input type="number" value={draft.grace_minutes} onChange={(v) => set({ grace_minutes: v })} />
                </Field>
                <Field label="A full day, minutes" hint="Time actually on the premises">
                  <Input type="number" value={draft.full_day_minutes} onChange={(v) => set({ full_day_minutes: v })} />
                </Field>
                <Field label="A half day, minutes">
                  <Input type="number" value={draft.half_day_minutes} onChange={(v) => set({ half_day_minutes: v })} />
                </Field>
              </FormGrid>

              <div className="mt-5">
                <div className="text-sm font-medium">Days worked</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {WEEKDAYS.map((d, i) => {
                    const on = draft.working_days.includes(i + 1)
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleDay(i + 1)}
                        className={`rounded-md border px-3 py-1.5 text-sm ${on
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-slate-300 text-slate-500'}`}
                      >
                        {d}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Days off are never counted against anybody. School holidays come out on top of these.
                </p>
              </div>

              <div className="mt-6 border-t pt-5">
                <div className="text-sm font-medium">When a day is lost</div>
                <FormGrid>
                  <Field label="How pay is cut">
                    <Select
                      value={draft.lop_basis}
                      onChange={(v) => set({ lop_basis: v })}
                      options={[
                        { value: 'none', label: 'Not at all - absence is recorded only' },
                        { value: 'fixed', label: 'A fixed amount for each day' },
                        { value: 'salary', label: "A share of the person's own monthly pay" },
                      ]}
                    />
                  </Field>
                  {draft.lop_basis === 'fixed' && (
                    <Field label="Rupees per day lost" required>
                      <Input type="number" value={draft.lop_rupees} onChange={(v) => set({ lop_rupees: v })} />
                    </Field>
                  )}
                  {draft.lop_basis === 'salary' && (
                    <Field
                      label="Divide the month by"
                      hint="30 is what most contracts say. 0 uses the days actually expected."
                    >
                      <Input type="number" value={draft.salary_divisor} onChange={(v) => set({ salary_divisor: v })} />
                    </Field>
                  )}
                  <Field label="Lates that make a half day" hint="0 to never deduct for lateness">
                    <Input
                      type="number"
                      value={draft.lates_for_half_day}
                      onChange={(v) => set({ lates_for_half_day: v })}
                    />
                  </Field>
                </FormGrid>

                {depts.data && depts.data.length > 0 && (
                  <div className="mt-5">
                    <div className="text-sm font-medium">Departments on these hours</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {depts.data.map((d) => {
                        const on = draft.department_ids.includes(d.id)
                        return (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() =>
                              set({
                                department_ids: on
                                  ? draft.department_ids.filter((x) => x !== d.id)
                                  : [...draft.department_ids, d.id],
                              })}
                            className={`rounded-md border px-3 py-1.5 text-sm ${on
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-slate-300 text-slate-500'}`}
                          >
                            {d.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <label className="mt-5 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.is_default}
                    onChange={(e) => set({ is_default: e.target.checked })}
                  />
                  The school&rsquo;s default - anybody not on another set keeps these hours
                </label>
              </div>

              <div className="mt-5 flex items-center gap-3">
                <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>Save</Button>
                <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <FormNotice error={note.error} />
              </div>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title="Hours the school keeps" />
          {!draft && <div className="px-5"><FormNotice error={note.error} ok={note.ok} /></div>}
          {q.isLoading ? (
            <SkeletonTable rows={3} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : q.data!.length === 0 ? (
            <EmptyState
              title="No hours set"
              body="Until a set of hours exists, the readers record punches that are compared to nothing."
            />
          ) : (
            <Table head={['Name', 'Hours', 'Days', 'When a day is lost', 'On these hours', '']}>
              {q.data!.map((p) => (
                <tr key={p.id}>
                  <Td className="font-medium">
                    {p.name} {p.is_default && <Badge tone="neutral">Default</Badge>}
                  </Td>
                  <Td className="tabular-nums">{p.starts_at}&ndash;{p.ends_at}</Td>
                  <Td>{p.working_days.map((d) => WEEKDAYS[d - 1]).join(' ')}</Td>
                  <Td>{rule(p)}</Td>
                  <Td className="text-slate-500">
                    {[p.departments, p.people ? `${p.people} named` : ''].filter(Boolean).join(' / ') || '-'}
                  </Td>
                  <Td>
                    {canWrite && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => edit(p)}>Edit</Button>
                        <ConfirmButton
                          confirmLabel="Delete"
                          question="Anyone still on these hours falls back to the school's default."
                          tone="danger"
                          onConfirm={() => remove.mutate(p.id)}
                        >
                          Delete
                        </ConfirmButton>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>

    </>
  )
}
