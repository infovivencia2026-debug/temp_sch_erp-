import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CalendarCheck2, CircleSlash, Grid3x3, Users } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, ConfirmButton,
  Table, Td, Select, Input, Loading, Skeleton, ErrorState, EmptyState, FormNotice,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { WEEKDAYS, cn } from '@/lib/utils'

/* The timetable generator, and the honest account of what it could not do.

   Three sections, in the order somebody actually uses them.

   First the input. The commonest way a timetable run fails is that nobody ever
   said how many periods a week Class 8 Maths wants, or three subjects name a
   teacher who left in June. That is visible before the run and this screen
   shows it before offering the button.

   Then the run: a candidate, with a seed, so "generate another option" means
   something and yesterday's draft can be reproduced.

   Then the report, above the grid and not behind a tab. A generator that
   quietly places four of six Maths periods is worse than one that refuses,
   because the school finds out in week three from the class. The grid is the
   pretty part; the list of what is short is the part that gets acted on. */

interface Requirement {
  class_subject_id: string
  subject_name: string
  subject_code: string
  periods_per_week: number
  prefers_morning: boolean
  teacher_id?: string
  teacher_name?: string
}

interface InputsResponse {
  academic_year_id: string
  weekdays: number[]
  periods: { id: string; name: string; sequence: number; starts_at: string; is_break: boolean }[]
  sections: {
    id: string; name: string; class_name: string; level: number
    requirements: Requirement[]; required_periods: number
  }[]
  teachers: {
    user_id: string; full_name: string; employee_code: string; department?: string
    max_periods_per_day: number; max_periods_per_week: number
    demand_periods: number; scheduled_periods: number
    unavailable: { id?: string; weekday: number; period_id?: string; reason?: string }[]
  }[]
  summary: {
    sections: number
    teaching_slots_a_week: number
    required_periods: number
    subjects_without_requirement: number
    subjects_without_teacher: number
    teachers_over_cap: number
  }
}

interface Draft {
  id: string; name: string; status: string; seed: number
  academic_year: string
  periods_required: number; periods_placed: number
  blocking_issues: number; warning_issues: number
  generated_by?: string; generated_at: string
  published_by?: string; published_at?: string
  sections: number
}

interface DraftEntry {
  id: string; section_id: string; section_name: string; class_name: string
  period_id: string; period_name: string; weekday: number
  subject_name: string; subject_code: string
  teacher_id?: string; teacher_name?: string
}

interface DraftIssue {
  kind: string; severity: string
  section_name?: string; subject_name?: string; teacher_name?: string
  periods_required: number; periods_placed: number
  detail: string
}

export default function TimetableOptimizer() {
  const qc = useQueryClient()
  const can = useCan()
  /* Reads are on timetable.read so a head of department can look at a draft
     somebody else generated (timetable_ops.go:74); every write is
     timetable.write. Without this the read-only reader was shown Generate,
     Publish and Discard and got a bare 403 on pressing them. */
  const mayWrite = can('academics.timetable.write')
  const [openDraft, setOpenDraft] = useState('')
  const [seed, setSeed] = useState('1')

  const inputs = useQuery({
    queryKey: ['timetable-optimizer', 'inputs'],
    queryFn: () => api.get<InputsResponse>('/api/v1/timetable-optimizer/inputs'),
  })
  const drafts = useQuery({
    queryKey: ['timetable-optimizer', 'drafts'],
    queryFn: () => api.get<{ items: Draft[] }>('/api/v1/timetable-optimizer/drafts'),
  })

  const generate = useMutation({
    mutationFn: () =>
      api.post<Draft>('/api/v1/timetable-optimizer/drafts', { seed: Number(seed) || 0 }),
    onSuccess: (d) => {
      setOpenDraft(d.id)
      qc.invalidateQueries({ queryKey: ['timetable-optimizer', 'drafts'] })
    },
  })

  if (inputs.isLoading) return <Loading label="Reading the year's requirements…" />
  if (inputs.error) return <ErrorState error={inputs.error} />

  const s = inputs.data?.summary
  const ready = (s?.required_periods ?? 0) > 0

  return (
    <>
      <PageHead
        eyebrow="AI & automation"
        title="Timetable optimizer"
        description="Generates a candidate week that obeys every hard constraint, and tells you plainly which requirements it could not meet. Nothing reaches the live timetable until you publish it."
        actions={
          mayWrite && (
            <>
              <Input
                value={seed}
                onChange={setSeed}
                className="w-24"
                placeholder="Seed"
                srLabel="Seed for the generator, so a run can be reproduced"
              />
              <Button onClick={() => generate.mutate()} disabled={!ready || generate.isPending}>
                {generate.isPending ? 'Working…' : 'Generate a draft'}
              </Button>
            </>
          )
        }
      />
      <PageBody>
        <FormNotice error={generate.error} />

        <CellGrid cols={4}>
          <Stat
            label="Periods required"
            value={s?.required_periods ?? 0}
            icon={CalendarCheck2}
            hint={`${s?.teaching_slots_a_week ?? 0} teaching slots a week`}
          />
          <Stat label="Sections" value={s?.sections ?? 0} icon={Grid3x3} />
          <Stat
            label="No weekly requirement"
            value={s?.subjects_without_requirement ?? 0}
            icon={CircleSlash}
            hint="These subjects will not be placed at all"
          />
          <Stat
            label="Teachers over cap"
            value={s?.teachers_over_cap ?? 0}
            icon={Users}
            hint="Asked for more periods than their weekly limit"
          />
        </CellGrid>

        {!ready && (
          <Card>
            <EmptyState
              title="No subject has a weekly requirement yet"
              body="The generator satisfies requirements; without any it has nothing to place. Set periods per week against each class subject below, then generate."
            />
          </Card>
        )}

        <Requirements data={inputs.data} mayWrite={mayWrite} />
        <Teachers data={inputs.data} mayWrite={mayWrite} />

        <Card>
          <CardHeader
            title="Drafts"
            description="Every run is kept with its seed, so a candidate somebody liked can be reproduced."
          />
          {drafts.isLoading ? (
            <Skeleton rows={3} />
          ) : drafts.error ? (
            /* "No draft has been generated yet" is what this said when the
               request failed, which is a different and much more comfortable
               statement than the truth. */
            <ErrorState error={drafts.error} />
          ) : (
          <Table
            head={['Draft', 'Placed', 'Unmet', 'Status', 'Generated', '']}
            empty={(drafts.data?.items ?? []).length === 0}
            emptyLabel="No draft has been generated yet."
          >
            {(drafts.data?.items ?? []).map((d) => (
              <tr key={d.id}>
                <Td>
                  <div className="font-medium">{d.name}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {d.sections} sections · seed {d.seed}
                  </div>
                </Td>
                <Td className="tabular-nums">
                  {d.periods_placed} / {d.periods_required}
                </Td>
                <Td>
                  {d.blocking_issues > 0 ? (
                    <Badge tone="danger">{d.blocking_issues} unmet</Badge>
                  ) : (
                    <Badge tone="success">complete</Badge>
                  )}
                </Td>
                <Td>
                  <Badge
                    tone={
                      d.status === 'published' ? 'success'
                        : d.status === 'discarded' ? 'neutral' : 'info'
                    }
                  >
                    {d.status}
                  </Badge>
                </Td>
                <Td className="text-[13px] text-muted-foreground">
                  {d.generated_at.slice(0, 10)}
                  {d.generated_by ? ` · ${d.generated_by}` : ''}
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setOpenDraft(openDraft === d.id ? '' : d.id)}
                  >
                    {openDraft === d.id ? 'Close' : 'Review'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
          )}
        </Card>

        {openDraft && (
          <DraftReview
            key={openDraft}
            id={openDraft}
            mayWrite={mayWrite}
            onGone={() => setOpenDraft('')}
          />
        )}
      </PageBody>
    </>
  )
}

/* The requirement table, editable in place.

   Periods per week is the single number the whole generator runs on, and it
   lives on class_subjects — the row that already means "Maths in Class 8". A
   subject sitting at zero is not placed at all, which is worth showing in red
   rather than explaining in a tooltip. */
function Requirements({ data, mayWrite }: { data?: InputsResponse; mayWrite: boolean }) {
  const qc = useQueryClient()
  const [section, setSection] = useState('')
  /* The typing lives here rather than in each row, because the rows are plain
     <tr>s so that <Table> can name their cells for a phone — see labelCells in
     components/ui.tsx. Keyed by class_subject_id, so switching section shows
     the server's numbers again rather than the last section's edits. */
  const [edits, setEdits] = useState<Record<string, { ppw: string; morning: boolean }>>({})

  const save = useMutation({
    mutationFn: (v: { class_subject_id: string; periods_per_week: number; prefers_morning: boolean }) =>
      api.put('/api/v1/timetable-optimizer/requirements', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['timetable-optimizer'] }),
  })

  const sections = data?.sections ?? []
  const shown = section ? sections.filter((x) => x.id === section) : sections.slice(0, 1)

  return (
    <Card>
      <CardHeader
        title="What each class needs"
        description="Periods a week, per subject. A subject left at zero is not timetabled."
        action={
          <Select
            value={section}
            onChange={setSection}
            placeholder={sections[0] ? `${sections[0].class_name}-${sections[0].name}` : 'Section'}
            options={sections.map((x) => ({
              value: x.id, label: `${x.class_name}-${x.name}`,
            }))}
          />
        }
      />
      <FormNotice error={save.error} />
      {shown.map((sec) => (
        <div key={sec.id}>
          <Table
            head={['Subject', 'Teacher', 'Periods a week', 'Morning', '']}
            empty={sec.requirements.length === 0}
            emptyLabel="This class has no subjects yet."
          >
            {sec.requirements.map((r) =>
              requirementRow({
                req: r,
                value: edits[r.class_subject_id] ?? {
                  ppw: String(r.periods_per_week),
                  morning: r.prefers_morning,
                },
                onChange: (v) => setEdits({ ...edits, [r.class_subject_id]: v }),
                onSave: (v) => save.mutate(v),
                saving: save.isPending,
                mayWrite,
              }),
            )}
          </Table>
          <div className="border-t px-5 py-3 text-[13px] text-muted-foreground">
            {sec.class_name}-{sec.name} wants{' '}
            <span className="font-medium text-foreground tabular-nums">{sec.required_periods}</span>{' '}
            periods against {data?.summary.teaching_slots_a_week ?? 0} slots in the week.
          </div>
        </div>
      ))}
    </Card>
  )
}

function requirementRow({
  req, value, onChange, onSave, saving, mayWrite,
}: {
  req: Requirement
  value: { ppw: string; morning: boolean }
  onChange: (v: { ppw: string; morning: boolean }) => void
  onSave: (v: { class_subject_id: string; periods_per_week: number; prefers_morning: boolean }) => void
  saving: boolean
  mayWrite: boolean
}) {
  const typed = value.ppw.trim()
  /* An emptied box is not "nought periods a week", which on this screen means
     "never timetable this subject". Number('' || 0) is 0, so clearing the box
     used to offer a Save that quietly took Maths out of the week. A zero is
     still sayable — by typing one. */
  const bad = typed === '' || !Number.isFinite(Number(typed)) || Number(typed) < 0
  const dirty =
    (!bad && Number(typed) !== req.periods_per_week) || value.morning !== req.prefers_morning

  return (
    <tr key={req.class_subject_id}>
      <Td>
        <span className="font-medium">{req.subject_name}</span>
        <span className="ml-2 text-[12px] text-muted-foreground">{req.subject_code}</span>
      </Td>
      <Td>
        {req.teacher_name ?? (
          <span className="text-destructive">nobody allocated</span>
        )}
      </Td>
      <Td>
        <Input
          value={value.ppw}
          onChange={(v) => onChange({ ...value, ppw: v })}
          type="number"
          className="w-20"
          srLabel={`Periods a week for ${req.subject_name}`}
        />
      </Td>
      <Td>
        <Button
          size="sm"
          variant={value.morning ? 'primary' : 'secondary'}
          onClick={() => onChange({ ...value, morning: !value.morning })}
        >
          {value.morning ? 'Earlier in the day' : 'Any period'}
        </Button>
      </Td>
      <Td>
        {mayWrite && dirty && !bad && (
          <Button
            size="sm"
            disabled={saving}
            onClick={() =>
              onSave({
                class_subject_id: req.class_subject_id,
                periods_per_week: Number(typed),
                prefers_morning: value.morning,
              })
            }
          >
            Save
          </Button>
        )}
      </Td>
    </tr>
  )
}

/* Teacher caps and demand, side by side.

   The one comparison that predicts a failed run: what the requirements ask of
   somebody against what they may be given. A teacher owing 42 periods against
   a 35-period cap produces seven confusing per-subject failures later and one
   obvious red row here. */
function Teachers({ data, mayWrite }: { data?: InputsResponse; mayWrite: boolean }) {
  const qc = useQueryClient()
  const [edits, setEdits] = useState<Record<string, { day: string; week: string }>>({})
  const save = useMutation({
    mutationFn: (v: { teacher_user_id: string; max_periods_per_day: number; max_periods_per_week: number }) =>
      api.put('/api/v1/timetable-optimizer/load-rules', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['timetable-optimizer'] }),
  })

  const teachers = data?.teachers ?? []
  return (
    <Card>
      <CardHeader
        title="Who may teach how much"
        description="Demand is what the requirements ask; the cap is what the school allows. Demand above the cap cannot be timetabled, however good the generator is."
      />
      <FormNotice error={save.error} />
      <Table
        head={['Teacher', 'Department', 'Demand', 'Cap / week', 'Cap / day', 'Unavailable', '']}
        empty={teachers.length === 0}
        emptyLabel="No active staff on file."
      >
        {teachers.map((t) =>
          teacherRow({
            t,
            value: edits[t.user_id] ?? {
              day: String(t.max_periods_per_day),
              week: String(t.max_periods_per_week),
            },
            onChange: (v) => setEdits({ ...edits, [t.user_id]: v }),
            onSave: (v) => save.mutate(v),
            saving: save.isPending,
            mayWrite,
          }),
        )}
      </Table>
    </Card>
  )
}

function teacherRow({
  t, value, onChange, onSave, saving, mayWrite,
}: {
  t: NonNullable<InputsResponse['teachers']>[number]
  value: { day: string; week: string }
  onChange: (v: { day: string; week: string }) => void
  onSave: (v: { teacher_user_id: string; max_periods_per_day: number; max_periods_per_week: number }) => void
  saving: boolean
  mayWrite: boolean
}) {
  const day = value.day.trim()
  const week = value.week.trim()
  /* `Number(day) || 1` turned an emptied cap into a cap of one period a week,
     silently, on Save. A cap has to be a number somebody typed. */
  const bad =
    day === '' || week === '' ||
    !Number.isFinite(Number(day)) || !Number.isFinite(Number(week)) ||
    Number(day) < 1 || Number(week) < 1
  const dirty =
    !bad && (Number(day) !== t.max_periods_per_day || Number(week) !== t.max_periods_per_week)
  const over = t.demand_periods > t.max_periods_per_week

  return (
    <tr key={t.user_id}>
      <Td>
        <div className="font-medium">{t.full_name}</div>
        <div className="text-[12px] text-muted-foreground">{t.employee_code}</div>
      </Td>
      <Td className="text-[13px] text-muted-foreground">{t.department || '—'}</Td>
      <Td className={cn('tabular-nums', over && 'font-medium text-destructive')}>
        {t.demand_periods}
      </Td>
      <Td>
        <Input
          value={value.week}
          onChange={(v) => onChange({ ...value, week: v })}
          type="number"
          className="w-20"
          srLabel={`Weekly period cap for ${t.full_name}`}
        />
      </Td>
      <Td>
        <Input
          value={value.day}
          onChange={(v) => onChange({ ...value, day: v })}
          type="number"
          className="w-16"
          srLabel={`Daily period cap for ${t.full_name}`}
        />
      </Td>
      <Td className="text-[13px] text-muted-foreground">
        {t.unavailable.length === 0
          ? '—'
          : t.unavailable
              .map((u) => (u.period_id ? `${WEEKDAYS[u.weekday - 1]} one period` : WEEKDAYS[u.weekday - 1]))
              .join(', ')}
      </Td>
      <Td>
        {mayWrite && dirty && (
          <Button
            size="sm"
            disabled={saving}
            onClick={() =>
              onSave({
                teacher_user_id: t.user_id,
                max_periods_per_day: Number(day),
                max_periods_per_week: Number(week),
              })
            }
          >
            Save
          </Button>
        )}
      </Td>
    </tr>
  )
}

/* The review: the report first, then the grid, then publish.

   Publishing is the only destructive act on this screen, and a draft with
   unmet requirements takes a second, explicit confirmation. A timetable
   published two periods short should be a decision somebody made, not one
   that happened. */
function DraftReview({
  id, mayWrite, onGone,
}: { id: string; mayWrite: boolean; onGone: () => void }) {
  const qc = useQueryClient()
  const [section, setSection] = useState('')

  const draft = useQuery({
    queryKey: ['timetable-optimizer', 'draft', id],
    queryFn: () =>
      api.get<{
        draft: Draft
        entries: DraftEntry[]
        issues: DraftIssue[]
        periods: InputsResponse['periods']
        weekdays: number[]
      }>(`/api/v1/timetable-optimizer/drafts/${id}`),
  })

  const publish = useMutation({
    mutationFn: (ack: boolean) =>
      api.post(`/api/v1/timetable-optimizer/drafts/${id}/publish`, { acknowledge_unmet: ack }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable-optimizer'] })
      qc.invalidateQueries({ queryKey: ['timetable'] })
    },
  })
  const discard = useMutation({
    mutationFn: () => api.post(`/api/v1/timetable-optimizer/drafts/${id}/discard`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable-optimizer'] })
      onGone()
    },
  })

  if (draft.isLoading) return <Loading label="Reading the draft…" />
  if (draft.error) return <ErrorState error={draft.error} />

  const d = draft.data!.draft
  const issues = draft.data!.issues
  const blocking = issues.filter((i) => i.severity === 'blocking')
  const warnings = issues.filter((i) => i.severity !== 'blocking')
  const periods = draft.data!.periods.filter((p) => !p.is_break)

  const sections = [...new Map(
    draft.data!.entries.map((e) => [e.section_id, `${e.class_name}-${e.section_name}`]),
  )]
  const active = section || sections[0]?.[0] || ''
  const cells = new Map(
    draft.data!.entries
      .filter((e) => e.section_id === active)
      .map((e) => [`${e.weekday}:${e.period_id}`, e]),
  )

  return (
    <>
      <Card>
        <CardHeader
          title={`${d.name} — what it could not do`}
          description={`${d.periods_placed} of ${d.periods_required} periods placed.`}
          action={
            d.status === 'draft' && mayWrite ? (
              <>
                <ConfirmButton
                  confirmLabel="Publish"
                  /* Both halves, always.

                     The two branches each used to say one half, and the more
                     dangerous branch said the safer half: a draft that leaves
                     requirements unmet warned about the unmet count and never
                     mentioned that publishing overwrites the live week, while
                     the clean draft mentioned the overwrite and not the count.
                     Publishing replaces a grid a school may have spent a week
                     building, so what it destroys is named first, with the
                     number of sections it destroys it for, and the unmet count
                     is added to it rather than replacing it. The list of what
                     is unmet stays on screen underneath while this is read —
                     ConfirmButton asks inline, it does not cover the page. */
                  question={
                    blocking.length
                      ? `Replaces the live timetable for ${sections.length} section${
                          sections.length === 1 ? '' : 's'
                        }, and ${blocking.length} requirement${
                          blocking.length === 1 ? '' : 's'
                        } listed below stay unmet.`
                      : `Replaces the live timetable for ${sections.length} section${
                          sections.length === 1 ? '' : 's'
                        }.`
                  }
                  variant="primary"
                  onConfirm={() => publish.mutate(blocking.length > 0)}
                  disabled={publish.isPending}
                >
                  {blocking.length ? 'Publish anyway' : 'Publish'}
                </ConfirmButton>
                <ConfirmButton
                  confirmLabel="Discard"
                  question="The candidate is thrown away."
                  tone="danger"
                  onConfirm={() => discard.mutate()}
                >
                  Discard
                </ConfirmButton>
              </>
            ) : (
              <Badge tone={d.status === 'published' ? 'success' : 'neutral'}>{d.status}</Badge>
            )
          }
        />
        <FormNotice error={publish.error ?? discard.error} ok={publish.isSuccess ? 'Published to the live timetable.' : undefined} />

        {issues.length === 0 ? (
          <EmptyState
            title="Every requirement was met"
            body="No subject is short a period and no soft preference had to bend."
          />
        ) : (
          <ul className="divide-y">
            {[...blocking, ...warnings].map((i, n) => (
              <li key={n} className="flex items-start gap-3 px-5 py-3">
                <AlertTriangle
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    i.severity === 'blocking' ? 'text-destructive' : 'text-warning',
                  )}
                />
                <div className="min-w-0">
                  <p className="text-[14px] leading-relaxed">{i.detail}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {i.severity === 'blocking' ? 'Unmet' : 'Worth a look'} ·{' '}
                    {i.kind.replace(/_/g, ' ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="The candidate week"
          description="Edit after publishing on the timetable screen; this is a proposal."
          action={
            <Select
              value={active}
              onChange={setSection}
              options={sections.map(([id2, label]) => ({ value: id2, label }))}
            />
          }
        />
        <div className="scroll-x p-4">
          <table className="w-full min-w-[720px] border-separate border-spacing-1 text-[13px]">
            <thead>
              <tr>
                <th className="w-24" />
                {periods.map((p) => (
                  <th key={p.id} className="rounded bg-muted px-2 py-1.5 text-[12px] font-medium">
                    <div>{p.name}</div>
                    <div className="font-normal text-muted-foreground">{p.starts_at}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft.data!.weekdays.map((wd) => (
                <tr key={wd}>
                  <th className="rounded bg-muted px-2 py-1.5 text-[12px] font-medium">
                    {WEEKDAYS[wd - 1]}
                  </th>
                  {periods.map((p) => {
                    const e = cells.get(`${wd}:${p.id}`)
                    return (
                      <td
                        key={p.id}
                        className={cn(
                          'rounded border px-2 py-1.5 align-top',
                          !e && 'bg-muted/30',
                        )}
                      >
                        {e ? (
                          <>
                            <div className="font-medium">{e.subject_name}</div>
                            <div className="text-[12px] text-muted-foreground">
                              {e.teacher_name ?? 'no teacher'}
                            </div>
                          </>
                        ) : (
                          <span className="text-[12px] text-muted-foreground">free</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
