import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Input, Select, Badge, Button,
  Loading, ErrorState, FormNotice,
} from '@/components/ui'

/* HOW MANY PERIODS A WEEK EACH SUBJECT WANTS, ON THE SCREEN THAT NEEDS IT.

   The master timetable cannot run until something says what to place, and it
   said so — then sent the person to Academics → Class Setup, or to a CSV with a
   periods_per_week column. Both are real routes and both are somewhere else: a
   school with eighteen sections was told the one thing standing between it and
   a timetable, and then asked to leave the page to do it.

   So the requirement is edited here, in front of the button that consumes it,
   one section at a time. Eighteen classes of boxes stacked down a page is a
   form nobody finishes; one section chosen from a list, its own subjects, its
   own total and its own Make button is a job with an end to it.

   WHAT IS PER SECTION AND WHAT IS NOT. The TIMETABLE is per section: the solver
   builds Grade 1 BODHA its own grid and Grade 1 HITHA another, and the endpoint
   takes section_ids so one can be built without touching the rest. The
   REQUIREMENT is per class: `class_subjects` hangs off the class, so both
   sections of Grade 1 read one Maths number and always have. Presenting the
   requirement per section without saying so would be a lie the person finds out
   about when they set BODHA to 6 and HITHA changes too — so where a class has
   more than one section, the panel says which sections a number reaches BEFORE
   it is typed, not after. */

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

export default function PeriodsNeeded({
  mayWrite,
  onGenerated,
}: {
  mayWrite: boolean
  /** So the page can open the draft this section just produced. */
  onGenerated?: (draftID: string, sectionName: string) => void
}) {
  const qc = useQueryClient()
  const [pick, setPick] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, true>>({})

  const inputs = useQuery({
    queryKey: ['timetable-inputs'],
    queryFn: () => api.get<Inputs>('/api/v1/timetable-optimizer/inputs'),
  })

  const sections = useMemo(
    () =>
      [...(inputs.data?.sections ?? [])].sort(
        (a, b) => a.level - b.level || a.class_name.localeCompare(b.class_name) || a.name.localeCompare(b.name),
      ),
    [inputs.data],
  )

  /* Open on the first section that still needs numbers, not on the first
     section alphabetically. Somebody arriving with fourteen classes done and
     four to go should land on the work, not on Pre Nursery again. */
  useEffect(() => {
    if (pick || sections.length === 0) return
    const unset = sections.find((s) => s.requirements.some((r) => r.periods_per_week === 0))
    setPick((unset ?? sections[0]).id)
  }, [sections, pick])

  const chosen = sections.find((s) => s.id === pick)

  /* Which other sections read the same numbers. A requirement belongs to the
     class, so this is every other section of the same class. */
  const siblings = chosen
    ? sections.filter((s) => s.class_name === chosen.class_name && s.id !== chosen.id)
    : []

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

  /* One section's timetable, without the other seventeen.

     A school does not finish the whole school and then press one button — it
     settles Grade 8, looks at it, and moves on. The endpoint has taken
     section_ids all along; nothing on screen had ever passed them. */
  const generate = useMutation({
    mutationFn: (sectionID: string) =>
      api.post<{ id: string }>('/api/v1/timetable-optimizer/drafts', {
        seed: Date.now() % 100000,
        section_ids: [sectionID],
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['master-timetable'] })
      onGenerated?.(d.id, chosen ? `${chosen.class_name} ${chosen.name}` : 'this section')
    },
  })

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

  if (sections.length === 0) {
    return (
      <Card>
        <CardHeader
          title="No subjects to give periods to"
          description="Add subjects to your classes under Academics → Class Setup, or upload the class-subjects sheet. They appear here once a class teaches something."
        />
      </Card>
    )
  }

  const slots = inputs.data?.summary.teaching_slots_a_week ?? 0
  const subjects = chosen?.requirements ?? []
  const total = subjects.reduce((n, rq) => {
    const v = edits[rq.class_subject_id]
    const own = v !== undefined && Number.isFinite(Number(v)) ? Number(v) : rq.periods_per_week
    return n + (own || 0)
  }, 0)
  const over = slots > 0 && total > slots
  const ready = total > 0 && !over

  /* How far the school has got, said once. Counted over sections rather than
     classes because a section is what a person is choosing between. */
  const done = sections.filter((s) => s.requirements.some((r) => r.periods_per_week > 0)).length

  return (
    <Card>
      <CardHeader
        title="Periods a week"
        description="Choose a class and section, say how many periods a week each subject wants, then make that section's timetable. You do not have to finish the school before you start."
      />

      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem]">
            <label className="mb-1 block text-[12.5px] text-muted-foreground" htmlFor="tt-section">
              Class and section
            </label>
            <Select
              value={pick}
              onChange={(v) => setPick(v)}
              placeholder="Choose a class and section"
              options={sections.map((s) => ({
                value: s.id,
                label:
                  `${s.class_name} — ${s.name}` +
                  (s.requirements.some((r) => r.periods_per_week > 0) ? '' : ' · nothing set'),
              }))}
            />
          </div>
          <p className="pb-2 text-[12.5px] text-muted-foreground">
            <span className="tabular-nums">{done}</span> of{' '}
            <span className="tabular-nums">{sections.length}</span> sections have periods set
          </p>
        </div>

        {chosen && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[14px] font-medium">
                {chosen.class_name} — {chosen.name}
              </div>
              {/* The one number that decides whether this can be solved: a
                  section asking for more periods than the week holds cannot be
                  placed however good the solver is, and finding that out from
                  a failed run is slower than reading it here. */}
              <div className={over ? 'text-[13px] text-destructive' : 'text-[13px] text-muted-foreground'}>
                <span className="tabular-nums font-medium">{total}</span>
                {slots > 0 && (
                  <>
                    {' '}of {slots} periods a week{over && ' — more than the week holds'}
                  </>
                )}
              </div>
            </div>

            {/* Said before the number is typed, not after it surprises somebody. */}
            {siblings.length > 0 && (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-secondary-foreground">
                {chosen.class_name} also has {siblings.map((s) => s.name).join(', ')}. These
                periods belong to the class, so all{' '}
                {siblings.length + 1} sections ask for the same subjects and the same amounts
                — each still gets its own timetable, built separately.
              </p>
            )}

            <FormNotice error={save.error} />
            <FormNotice error={generate.error} />

            <Table head={['Subject', 'Periods a week', 'Teacher', '']}>
              {subjects.map((rq) => (
                <tr key={rq.class_subject_id}>
                  <Td className="text-[13.5px]">{rq.subject_name}</Td>
                  <Td>
                    {mayWrite ? (
                      <Input
                        type="number"
                        className="w-24"
                        srLabel={`Periods a week for ${rq.subject_name} in ${chosen.class_name}`}
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
                      <span className="tabular-nums text-[13.5px]">{rq.periods_per_week || '—'}</span>
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

            {mayWrite && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!ready || generate.isPending}
                  onClick={() => generate.mutate(chosen.id)}
                >
                  {generate.isPending
                    ? 'Working it out…'
                    : `Make ${chosen.class_name} ${chosen.name}'s timetable`}
                </Button>
                <span className="text-[12.5px] text-muted-foreground">
                  {over
                    ? 'Bring the total down to the length of the school week first.'
                    : total === 0
                      ? 'Give at least one subject its periods first.'
                      : 'Only this section. Nothing changes for teachers until you put the draft in use.'}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
