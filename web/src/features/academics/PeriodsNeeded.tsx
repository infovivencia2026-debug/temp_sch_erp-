import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, Table, Td, Input, Badge, Loading, ErrorState, FormNotice } from '@/components/ui'

/* HOW MANY PERIODS A WEEK EACH SUBJECT WANTS, ON THE SCREEN THAT NEEDS IT.

   The master timetable cannot run until something says what to place, and it
   said so — then sent the person to Academics → Class Setup, or to a CSV with a
   periods_per_week column. Both are real routes and both are somewhere else: a
   school with eighteen sections was told the one thing standing between it and
   a timetable, and then asked to leave the page to do it.

   So the requirement is edited here, in front of the button that consumes it.
   Type 6 against Maths, and the stage card above turns from "first, say how
   many periods" into "make a timetable" without a navigation.

   ONE ROW PER CLASS, NOT PER SECTION. `class_subjects` hangs off the CLASS, so
   Grade 1 A and Grade 1 B share one Maths requirement and always have — the
   optimizer's own input query joins it that way. Drawing it per section would
   show the same number four times and imply four places to change it, three of
   which would silently overwrite the others. The TIMETABLE is per section: the
   solver places these periods separately for every section of the class, which
   is why a class of four sections needs four teachers' worth of room and gets
   four different grids out. */

interface Requirement {
  class_subject_id: string
  subject_name: string
  subject_code: string
  periods_per_week: number
  prefers_morning: boolean
  teacher_name?: string
}

interface OptSection {
  id: string
  name: string
  class_name: string
  level: number
  requirements: Requirement[]
}

interface Inputs {
  sections: OptSection[]
  summary: {
    teaching_slots_a_week: number
    subjects_without_requirement: number
  }
}

/** One class, with the subjects it teaches and how many sections sit under it. */
interface ClassRow {
  className: string
  level: number
  sections: number
  subjects: Requirement[]
}

export default function PeriodsNeeded({ mayWrite }: { mayWrite: boolean }) {
  const qc = useQueryClient()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, true>>({})

  const inputs = useQuery({
    queryKey: ['timetable-inputs'],
    queryFn: () => api.get<Inputs>('/api/v1/timetable-optimizer/inputs'),
  })

  const save = useMutation({
    mutationFn: (v: { id: string; periods: number; morning: boolean }) =>
      api.put('/api/v1/timetable-optimizer/requirements', {
        class_subject_id: v.id,
        periods_per_week: v.periods,
        prefers_morning: v.morning,
      }),
    onSuccess: (_r, v) => {
      setSaved((old) => ({ ...old, [v.id]: true }))
      /* The stage card above counts required periods. Without this the person
         types six against Maths, nothing on the page changes, and they type it
         again somewhere else. */
      qc.invalidateQueries({ queryKey: ['master-timetable'] })
      qc.invalidateQueries({ queryKey: ['timetable-inputs'] })
    },
  })

  /* Collapse the sections back into their classes.

     The endpoint returns one entry per (section, class subject) because that
     is what the solver consumes. The same class_subject_id therefore arrives
     once per section, carrying the same number every time. */
  const classes = useMemo<ClassRow[]>(() => {
    const by = new Map<string, ClassRow>()
    for (const sec of inputs.data?.sections ?? []) {
      let row = by.get(sec.class_name)
      if (!row) {
        row = { className: sec.class_name, level: sec.level, sections: 0, subjects: [] }
        by.set(sec.class_name, row)
      }
      row.sections += 1
      for (const rq of sec.requirements) {
        if (!row.subjects.some((x) => x.class_subject_id === rq.class_subject_id)) {
          row.subjects.push(rq)
        }
      }
    }
    return [...by.values()].sort((a, b) => a.level - b.level || a.className.localeCompare(b.className))
  }, [inputs.data])

  const slots = inputs.data?.summary.teaching_slots_a_week ?? 0

  function valueFor(rq: Requirement): string {
    return edits[rq.class_subject_id] ?? String(rq.periods_per_week || '')
  }

  function commit(rq: Requirement) {
    const raw = edits[rq.class_subject_id]
    if (raw === undefined) return
    const n = Number(raw)
    // An empty box means nought, which is a real answer: this class does not
    // teach this subject this year. A word in the box is not an answer.
    if (!Number.isFinite(n) || n < 0 || n > 60) return
    if (n === rq.periods_per_week) return
    save.mutate({ id: rq.class_subject_id, periods: n, morning: rq.prefers_morning })
  }

  if (inputs.isLoading) return <Loading label="Reading the subjects…" />
  if (inputs.error) return <ErrorState error={inputs.error} />

  if (classes.length === 0) {
    return (
      <Card>
        <CardHeader
          title="No subjects to give periods to"
          description="Add subjects to your classes under Academics → Class Setup, or upload the class-subjects sheet. They appear here once a class teaches something."
        />
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Periods a week"
        description={
          `Say how many periods a week each subject wants. Set once per class — every ` +
          `section of that class gets its own timetable built from these same numbers. ` +
          (slots ? `The school week has ${slots} teaching periods.` : '')
        }
      />
      <FormNotice error={save.error} />

      <div className="flex flex-col divide-y">
        {classes.map((c) => {
          const total = c.subjects.reduce((n, rq) => {
            const v = edits[rq.class_subject_id]
            const own = v !== undefined && Number.isFinite(Number(v)) ? Number(v) : rq.periods_per_week
            return n + (own || 0)
          }, 0)
          const over = slots > 0 && total > slots

          return (
            <div key={c.className} className="px-5 py-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[14px] font-medium">
                  {c.className}
                  <span className="ml-2 text-[12.5px] font-normal text-muted-foreground">
                    {c.sections === 1 ? '1 section' : `${c.sections} sections`}
                  </span>
                </div>
                {/* The one number that decides whether this can be solved: a
                    class asking for more periods than the week holds cannot be
                    placed however good the solver is, and finding that out
                    from a failed run is slower than reading it here. */}
                <div className={over ? 'text-[13px] text-destructive' : 'text-[13px] text-muted-foreground'}>
                  <span className="tabular-nums font-medium">{total}</span>
                  {slots > 0 && <> of {slots} periods a week{over && ' — more than the week holds'}</>}
                </div>
              </div>

              <Table head={['Subject', 'Periods a week', 'Teacher', '']}>
                {c.subjects.map((rq) => (
                  <tr key={rq.class_subject_id}>
                    <Td className="text-[13.5px]">{rq.subject_name}</Td>
                    <Td>
                      {mayWrite ? (
                        <Input
                          type="number"
                          className="w-24"
                          srLabel={`Periods a week for ${rq.subject_name} in ${c.className}`}
                          value={valueFor(rq)}
                          onChange={(v) => {
                            setEdits((old) => ({ ...old, [rq.class_subject_id]: v }))
                            setSaved((old) => {
                              if (!old[rq.class_subject_id]) return old
                              const next = { ...old }
                              delete next[rq.class_subject_id]
                              return next
                            })
                          }}
                          onBlur={() => commit(rq)}
                        />
                      ) : (
                        <span className="tabular-nums text-[13.5px]">
                          {rq.periods_per_week || '—'}
                        </span>
                      )}
                    </Td>
                    <Td className="text-[13px] text-muted-foreground">
                      {rq.teacher_name ?? 'nobody yet'}
                    </Td>
                    <Td>
                      {saved[rq.class_subject_id] ? (
                        <Badge tone="success">saved</Badge>
                      ) : rq.periods_per_week === 0 ? (
                        <Badge tone="warning">not set</Badge>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </Table>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
