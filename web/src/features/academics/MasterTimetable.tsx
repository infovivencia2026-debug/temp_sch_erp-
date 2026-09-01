import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Select,
  Input, Table, Td, Loading, ErrorState, FormNotice,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import WeekGrid from '@/components/WeekGrid'
import { WEEKDAYS, cn } from '@/lib/utils'

/* institution_admin.academics.master_timetable_generation
 *
 * The whole school's timetable: generate, review, correct, publish.
 *
 * None of the machinery is new here and none of it is reimplemented. The
 * solver, the draft model and the publish path already exist and are good —
 * generating writes a draft and never the live grid, publishing is a separate
 * deliberate act, and it refuses a draft with unmet requirements unless the
 * reviewer says they have read them. This screen calls exactly those
 * endpoints. TimetableOptimizer.tsx is the same machinery seen from the
 * generator's end: the inputs, the seed, one draft at a time.
 *
 * What this adds is the view the person responsible for the master timetable
 * actually has, which is the whole school at once:
 *
 *   every section, and whether it has a timetable at all
 *   which draft currently speaks for it
 *   what publishing will overwrite, stated before the button is pressed
 *   and the ability to move one period by hand, because the vice principal
 *   knows something the solver does not and always will
 *
 * A moved period is re-checked on the server against the same constraints the
 * solver honoured — the section, the teacher, their unavailable slots, their
 * daily and weekly caps, and whether the slot is a break. The refusal names
 * which one bound. Nothing on this screen decides that; a UI that greys out
 * the wrong cell is not a constraint.
 */

const BASE = '/api/v1/master-timetable'
const OPTIMIZER = '/api/v1/timetable-optimizer'

interface SectionStanding {
  section_id: string
  section_name: string
  class_name: string
  level: number
  required_periods: number
  live_periods: number
  draft_periods: number
  live_unstaffed: number
  draft_unstaffed: number
  draft_id?: string
  draft_name?: string
}

interface DraftHead {
  id: string; name: string; status: string; seed: number
  academic_year: string
  periods_required: number; periods_placed: number
  blocking_issues: number; warning_issues: number
  generated_by?: string; generated_at: string
  sections: number
}

interface GridPeriod {
  id: string; name: string; sequence: number
  starts_at: string; ends_at: string; is_break: boolean
}

interface Overview {
  academic_year_id: string
  academic_year: string
  weekdays: number[]
  periods: GridPeriod[]
  sections: SectionStanding[]
  open_drafts: DraftHead[]
  may_edit: boolean
  cells_a_week: number
  summary: {
    sections: number
    sections_without_timetable: number
    /* Absent when no class-subject carries a weekly period count — there is
       then no requirement to place periods against, which is not the same as
       a requirement of nought. `?? 0` below still reaches the "set the weekly
       periods first" stage; what it must not do is print a denominator. */
    required_periods?: number
    live_periods: number
    live_unstaffed: number
    draft_periods: number
    open_drafts: number
  }
}

interface DraftEntry {
  id: string; section_id: string; section_name: string; class_name: string
  period_id: string; period_name: string; weekday: number
  subject_name: string; subject_code: string
  teacher_id?: string; teacher_name?: string; room?: string
}

interface DraftIssue {
  kind: string; severity: string
  section_name?: string; subject_name?: string; teacher_name?: string
  periods_required: number; periods_placed: number
  detail: string
}

interface DraftDetail {
  draft: DraftHead
  entries: DraftEntry[]
  issues: DraftIssue[]
  periods: GridPeriod[]
  weekdays: number[]
}

interface PublishPreview {
  draft_id: string
  draft_name: string
  status: string
  publishable: boolean
  sections: {
    section_id: string; section_name: string; class_name: string
    live_periods_now: number; draft_periods: number; draft_unstaffed: number
  }[]
  issues: DraftIssue[]
  blocking_issues: number
  requires_acknowledgement: boolean
  periods_to_replace: number
  periods_to_write: number
  sections_untouched: number
  teacher_clashes: {
    teacher_name: string; weekday: number; period_name: string
    draft_section: string; live_section: string
  }[]
}

export default function MasterTimetable() {
  const qc = useQueryClient()
  const can = useCan()
  /* Reads are academics.timetable.read; every write is academics.timetable.write.
     A head of department may read a draft somebody else generated, and would
     otherwise be shown Generate and Publish and given a bare 403 on pressing
     them. */
  const mayWrite = can('academics.timetable.write')

  const [openDraft, setOpenDraft] = useState('')
  const [note, setNote] = useState('')
  // Old attempts are history, not work. Collapsed by default.
  const [showHistory, setShowHistory] = useState(false)
  const [showClasses, setShowClasses] = useState(false)

  const overview = useQuery({
    queryKey: ['master-timetable', 'overview'],
    queryFn: () => api.get<Overview>(`${BASE}/overview`),
  })

  const generate = useMutation({
    mutationFn: () => api.post<DraftHead>(`${OPTIMIZER}/drafts`, { seed: Date.now() % 100000 }),
    onSuccess: (d) => {
      setOpenDraft(d.id)
      setNote('Worked out. Nothing has changed for teachers yet — open it to look.')
      qc.invalidateQueries({ queryKey: ['master-timetable'] })
    },
  })

  if (overview.isLoading) return <Loading label="Reading the year's timetable…" />
  // A failed read is never drawn as "no sections". "We could not read this"
  // and "this school has no timetable" are opposite conclusions.
  if (overview.error) return <ErrorState error={overview.error} />

  const d = overview.data
  const s = d?.summary
  const sections = d?.sections ?? []
  const drafts = d?.open_drafts ?? []

  /* One question, answered at the top: what happens next.
   *
   * The page opened with four counters, two tables and a draft panel, and on
   * a school that has not started they are four zeroes and two empty boxes.
   * Everything on it was true and none of it said what to do — so the screen
   * that exists to get a timetable built was the screen you could not begin
   * on.
   *
   * The order below is the order the work actually happens in, and exactly
   * one of them is ever the answer.
   */
  const needsRequirements = (s?.required_periods ?? 0) === 0
  const hasDraft = drafts.length > 0
  const allLive = !needsRequirements && (s?.sections_without_timetable ?? 0) === 0

  const stage = needsRequirements
    ? {
        tone: 'warn' as const,
        title: 'First, say how many periods each subject needs',
        body:
          'The solver places periods against what the subjects ask for, and nothing asks ' +
          'for any yet. Set periods per week under Academics → Class Setup, or upload the ' +
          'class-subjects sheet with a periods_per_week column. Nothing here can run until ' +
          'it knows what to place.',
      }
    : hasDraft
      ? {
          tone: 'go' as const,
          title:
            drafts.length === 1
              ? 'A suggested timetable is ready to check'
              : drafts.length + ' suggested timetables are ready to check',
          body:
            'Open it to see what it filled in, change anything it could not know about, ' +
            'and put it in use when it looks right.',
        }
      : allLive
        ? {
            tone: 'done' as const,
            title: 'Every class has a timetable',
            body: 'Make a new one only when the year, the staff or the subjects change.',
          }
        : {
            tone: 'go' as const,
            title: 'Make a timetable',
            body:
              'The computer works one out from the subjects, the teachers and the school ' +
              'day. It is only a suggestion — nothing changes for anybody until you look ' +
              'at it and put it in use.',
          }

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Master timetable"
        description="The whole school's week. Making one only suggests it — nothing changes for teachers until you put it in use."
      />
      <PageBody>
        {/* The single instruction, and the single button that acts on it. */}
        <Card
          className={cn(
            'border-l-4',
            stage.tone === 'warn' && 'border-l-warning',
            stage.tone === 'go' && 'border-l-primary',
            stage.tone === 'done' && 'border-l-success',
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-4 p-5">
            <div className="min-w-0 max-w-2xl">
              <p className="text-[15px] font-medium">{stage.title}</p>
              <p className="mt-1 text-[13.5px] text-muted-foreground">{stage.body}</p>
              <p className="mt-2 text-[12.5px] text-muted-foreground">
                {d?.academic_year} · {s?.sections ?? 0} sections ·{' '}
                {/* "200 of 0 periods in use" was a numerator over a
                    denominator that does not exist: nothing has said how many
                    periods a week each subject needs, so there is no total to
                    be a fraction of. The periods placed are still a fact and
                    are still printed; the missing half says it is missing. */}
                {needsRequirements ? (
                  <>
                    <span className="tabular-nums">{s?.live_periods ?? 0}</span> periods in
                    use · no weekly periods set for any subject, so there is
                    nothing to count them against
                  </>
                ) : (
                  <>
                    <span className="tabular-nums">
                      {s?.live_periods ?? 0} of {s?.required_periods}
                    </span>{' '}
                    periods in use
                  </>
                )}
                {(s?.live_unstaffed ?? 0) > 0 && ` · ${s?.live_unstaffed} with no teacher`}
              </p>
            </div>
            {mayWrite && !needsRequirements && (
              <Button disabled={generate.isPending} onClick={() => generate.mutate()}>
                {generate.isPending
                  ? 'Working it out…'
                  : hasDraft
                    ? 'Make another'
                    : 'Make a timetable'}
              </Button>
            )}
          </div>
        </Card>

        <FormNotice error={generate.error} ok={note} />

        {/* THE LATEST DRAFT, AS A CARD. THE REST BEHIND A LINK.

            Every draft ever generated sat in one table, so a school that had
            tried four times on four days was reading four rows to find the one
            it made this morning — and the obsolete ones were indistinguishable
            from the current one at a glance. Only the newest is a real
            decision; the others are history, and history belongs behind a
            word rather than in front of the work. */}
        {hasDraft && (
          <>
            <DraftCard
              draft={drafts[0]}
              open={openDraft === drafts[0].id}
              mayWrite={mayWrite}
              onOpen={() => setOpenDraft(openDraft === drafts[0].id ? '' : drafts[0].id)}
            />
            {drafts.length > 1 && (
              <Card>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-5 py-3 text-left text-[13.5px]"
                  onClick={() => setShowHistory(!showHistory)}
                >
                  <span className="text-muted-foreground">
                    {drafts.length - 1} earlier{' '}
                    {drafts.length === 2 ? 'attempt' : 'attempts'}, still open
                  </span>
                  <span className="text-primary">{showHistory ? 'Hide' : 'Show'}</span>
                </button>
                {showHistory && (
                  <Table head={['Made', 'Filled', 'Left out', 'By', '']}>
                    {drafts.slice(1).map((x) => (
                      <tr key={x.id}>
                        <Td className="font-medium">{x.name}</Td>
                        <Td className="tabular-nums">
                          {x.periods_placed} of {x.periods_required}
                        </Td>
                        <Td>
                          {x.blocking_issues > 0
                            ? <Badge tone="danger">{x.blocking_issues}</Badge>
                            : <Badge tone="success">none</Badge>}
                        </Td>
                        <Td className="text-muted-foreground">
                          {x.generated_at.slice(0, 16).replace('T', ' ')}
                          {x.generated_by ? ` · ${x.generated_by}` : ''}
                        </Td>
                        <Td>
                          <Button size="sm" variant="secondary"
                            onClick={() => setOpenDraft(openDraft === x.id ? '' : x.id)}>
                            {openDraft === x.id ? 'Close' : 'Open it'}
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )}
          </>
        )}

        {openDraft && (
          <DraftReview
            key={openDraft}
            draftID={openDraft}
            mayWrite={mayWrite && (d?.may_edit ?? false)}
            onPublished={(m) => {
              setOpenDraft('')
              setNote(m)
              qc.invalidateQueries({ queryKey: ['master-timetable'] })
            }}
          />
        )}

        {/* Three columns, not seven, and the draft column only while a draft
            exists — a column of dashes is a column you have to read to
            discover it says nothing. */}
        <Card>
          <CardHeader
            title="Class by class"
            description="A school that has filled 96% of its periods can still have one class with no science lessons at all, which is why this is listed per class rather than as one number."
            action={
              <Button size="sm" variant="secondary"
                onClick={() => setShowClasses(!showClasses)}>
                {showClasses ? 'Hide' : `Show all ${sections.length}`}
              </Button>
            }
          />
          {/* Collapsed to the classes that need attention. A school with
              forty sections was reading forty rows to find the two with no
              timetable, and the other thirty-eight said "fine" at length. */}
          {!showClasses && sections.every((x) => x.live_periods > 0) && (
            <p className="px-5 py-4 text-[13.5px] text-muted-foreground">
              Every class has a timetable.
            </p>
          )}
          {(showClasses || sections.some((x) => x.live_periods === 0)) && (
          <Table
            head={
              hasDraft
                ? ['Class', 'Periods needed', 'In use now', 'In the suggestion']
                : ['Class', 'Periods needed', 'In use now']
            }
            empty={sections.length === 0}
            emptyLabel="No classes in this year yet."
          >
            {(showClasses ? sections : sections.filter((x) => x.live_periods === 0)).map((x) => (
              <tr key={x.section_id}>
                <Td className="font-medium">
                  {x.class_name}-{x.section_name}
                </Td>
                <Td className="tabular-nums">{x.required_periods || '—'}</Td>
                <Td
                  className={cn(
                    'tabular-nums',
                    x.live_periods === 0 && 'font-medium text-destructive',
                  )}
                >
                  {x.live_periods === 0 ? 'no timetable yet' : x.live_periods}
                  {x.live_unstaffed > 0 && (
                    <span className="ml-1.5 text-[12px] text-warning">
                      {x.live_unstaffed} with no teacher
                    </span>
                  )}
                </Td>
                {hasDraft && <Td className="tabular-nums">{x.draft_periods || '—'}</Td>}
              </tr>
            ))}
          </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/* One draft, reviewed: what it could not do, what publishing will overwrite,
   and the grid itself, correctable a cell at a time. */
function DraftReview({ draftID, mayWrite, onPublished }: {
  draftID: string
  mayWrite: boolean
  onPublished: (msg: string) => void
}) {
  const qc = useQueryClient()
  const [section, setSection] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  const draft = useQuery({
    queryKey: ['master-timetable', 'draft', draftID],
    queryFn: () => api.get<DraftDetail>(`${OPTIMIZER}/drafts/${draftID}`),
  })
  const preview = useQuery({
    queryKey: ['master-timetable', 'preview', draftID],
    queryFn: () => api.get<PublishPreview>(`${BASE}/drafts/${draftID}/publish-preview`),
  })

  const publish = useMutation({
    mutationFn: () =>
      api.post<{ periods_replaced: number; periods_written: number; people_notified: number }>(
        `${OPTIMIZER}/drafts/${draftID}/publish`,
        { acknowledge_unmet: acknowledged },
      ),
    onSuccess: (r) =>
      onPublished(
        /* Who was told, not only what was written. Publishing now notifies
           the teachers who lost or gained a period, the children in those
           sections and their families — and a message saying only "204
           periods set" leaves somebody wondering whether they still have to
           tell the school themselves. */
        `Now in use: ${r.periods_written} periods set, ${r.periods_replaced} replaced.`
        + (r.people_notified
          ? ` ${r.people_notified} teachers, students and parents have been told in the app.`
          : ''),
      ),
  })

  const discard = useMutation({
    mutationFn: () => api.post(`${OPTIMIZER}/drafts/${draftID}/discard`, {}),
    onSuccess: () => onPublished('Suggestion thrown away. The timetable in use is unchanged.'),
  })

  if (draft.isLoading || preview.isLoading) return <Loading label="Reading the draft…" />
  if (draft.error) return <ErrorState error={draft.error} />
  if (preview.error) return <ErrorState error={preview.error} />

  const dd = draft.data
  const pv = preview.data
  if (!dd || !pv) return null

  const blocking = dd.issues.filter((i) => i.severity === 'blocking')
  const warnings = dd.issues.filter((i) => i.severity === 'warning')
  const sections = Array.from(
    new Map(dd.entries.map((e) => [e.section_id, e])).values(),
  ).sort((a, b) => `${a.class_name}${a.section_name}`.localeCompare(`${b.class_name}${b.section_name}`))
  const chosen = section || sections[0]?.section_id || ''

  return (
    <>
      <Card>
        <CardHeader
          title={`${dd.draft.name} — what it could not do`}
          description="The real output of a generator. Each line names the constraint that bound, because 'required 6, placed 4' suggests no fix and 'the only Maths teacher is at 34 of 35 periods' does."
        />
        {dd.issues.length === 0 ? (
          <div className="p-5 text-[13px] text-muted-foreground">
            Everything asked for was filled in. Check below what it will replace before you put it in use.
          </div>
        ) : (
          <Table head={['', 'Class', 'Subject', 'Required', 'Placed', 'What bound']}>
            {dd.issues.map((i, n) => (
              <tr key={`${i.kind}-${n}`}>
                <Td>
                  <Badge tone={i.severity === 'blocking' ? 'danger' : 'warning'}>
                    {i.severity === 'blocking' ? 'unmet' : 'bent'}
                  </Badge>
                </Td>
                <Td>{i.section_name ?? '—'}</Td>
                <Td>{i.subject_name ?? '—'}</Td>
                <Td className="tabular-nums">{i.periods_required || '—'}</Td>
                <Td className="tabular-nums">{i.periods_placed || '—'}</Td>
                <Td className="text-muted-foreground">{i.detail}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="What this will replace"
          description="It replaces the timetable only for the classes it covers. Any class it says nothing about keeps the one it has."
        />
        <div className="p-5 text-[13px]">
          <p>
            <span className="font-medium tabular-nums">{pv.periods_to_write}</span> periods written
            over <span className="font-medium tabular-nums">{pv.periods_to_replace}</span> existing
            ones, across {pv.sections.length} section{pv.sections.length === 1 ? '' : 's'}.{' '}
            {pv.sections_untouched > 0 && (
              <>
                <span className="font-medium tabular-nums">{pv.sections_untouched}</span> section
                {pv.sections_untouched === 1 ? '' : 's'} this draft does not cover keep the timetable
                they have.
              </>
            )}
          </p>
        </div>
        <Table head={['Class', 'Section', 'Live now', 'From the draft', 'Unstaffed']}>
          {pv.sections.map((x) => (
            <tr key={x.section_id}>
              <Td>{x.class_name}</Td>
              <Td className="font-medium">{x.section_name}</Td>
              <Td className="tabular-nums">{x.live_periods_now}</Td>
              <Td className="tabular-nums">{x.draft_periods}</Td>
              <Td className={cn('tabular-nums', x.draft_unstaffed > 0 && 'text-warning')}>
                {x.draft_unstaffed || '—'}
              </Td>
            </tr>
          ))}
        </Table>
        {pv.teacher_clashes.length > 0 && (
          <>
            <div className="px-5 pt-5 text-[13px] text-destructive">
              These teachers are already committed in the live grid, in sections this draft does not
              cover. Publishing will be refused rather than dropping the periods — move them here
              first.
            </div>
            <Table head={['Teacher', 'Day', 'Period', 'In the draft', 'Already teaching']}>
              {pv.teacher_clashes.map((c, n) => (
                <tr key={`${c.teacher_name}-${n}`}>
                  <Td className="font-medium">{c.teacher_name}</Td>
                  <Td>{WEEKDAYS[c.weekday - 1]}</Td>
                  <Td>{c.period_name}</Td>
                  <Td>{c.draft_section}</Td>
                  <Td>{c.live_section}</Td>
                </tr>
              ))}
            </Table>
          </>
        )}

        {mayWrite && (
          <div className="space-y-3 p-5">
            <FormNotice error={publish.error ?? discard.error} />
            {pv.requires_acknowledgement && (
              <label className="flex max-w-2xl items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 h-[15px] w-[15px] shrink-0 accent-primary"
                />
                <span>
                  I have read the {blocking.length} unmet requirement
                  {blocking.length === 1 ? '' : 's'} above and want to publish anyway. A timetable
                  published with periods missing is a decision somebody should make on purpose.
                </span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  publish.isPending
                  || !pv.publishable
                  || (pv.requires_acknowledgement && !acknowledged)
                }
                onClick={() => publish.mutate()}
              >
                {publish.isPending ? 'Putting it in use…' : 'Put this timetable in use'}
              </Button>
              <Button variant="ghost" disabled={discard.isPending} onClick={() => discard.mutate()}>
                Discard this draft
              </Button>
            </div>
            {warnings.length > 0 && (
              <p className="text-[13px] text-muted-foreground">
                {warnings.length} soft preference{warnings.length === 1 ? '' : 's'} had to bend —
                stacked subjects and the like. Worth a look, not a reason to refuse.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="The week"
          description="What this class would run, day by day. Breaks are shown across the row because lunch is not one class's business."
          action={
            <Select
              value={chosen}
              onChange={setSection}
              options={sections.map((x) => ({
                value: x.section_id, label: `${x.class_name}-${x.section_name}`,
              }))}
            />
          }
        />
        <div className="px-5 pb-5">
          <WeekGrid
            entries={dd.entries
              .filter((e) => e.section_id === chosen)
              .map((e) => ({
                weekday: e.weekday,
                period_id: e.period_id,
                title: e.subject_name,
                detail: (e.teacher_name ?? 'no teacher') + (e.room ? ` · ${e.room}` : ''),
                unstaffed: !e.teacher_name,
              }))}
            periods={dd.periods}
            weekdays={dd.weekdays}
            empty="This suggestion places nothing for that class."
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Change a period"
          description="Move one before you put the timetable in use. Every move is checked against the same rules, and if it cannot be done the reason says why."
          action={
            <Select
              value={chosen}
              onChange={setSection}
              options={sections.map((x) => ({
                value: x.section_id, label: `${x.class_name}-${x.section_name}`,
              }))}
            />
          }
        />
        {!dd.entries.some((e) => e.section_id === chosen) ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-muted-foreground">
            This draft places nothing for that section.
          </p>
        ) : (
          <DraftWeekGrid
            entries={dd.entries.filter((e) => e.section_id === chosen)}
            periods={dd.periods}
            weekdays={dd.weekdays}
            mayWrite={mayWrite}
            draftID={draftID}
            onChanged={() => qc.invalidateQueries({ queryKey: ['master-timetable'] })}
          />
        )}
      </Card>
    </>
  )
}

function MoveForm({ entry, ctx, onDone, onCancel }: {
  entry: DraftEntry
  ctx: { periods: GridPeriod[]; weekdays: number[]; draftID: string }
  onDone: () => void
  onCancel: () => void
}) {
  const [weekday, setWeekday] = useState(String(entry.weekday))
  const [periodID, setPeriodID] = useState(entry.period_id)
  const [room, setRoom] = useState(entry.room ?? '')

  const move = useMutation({
    mutationFn: () =>
      api.put(`${BASE}/drafts/${ctx.draftID}/entries/${entry.id}`, {
        weekday: Number(weekday),
        period_id: periodID,
        room,
      }),
    onSuccess: onDone,
  })
  const remove = useMutation({
    mutationFn: () => api.del(`${BASE}/drafts/${ctx.draftID}/entries/${entry.id}`),
    onSuccess: onDone,
  })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={weekday}
          onChange={setWeekday}
          options={ctx.weekdays.map((w) => ({ value: String(w), label: WEEKDAYS[w - 1] }))}
        />
        <Select
          value={periodID}
          onChange={setPeriodID}
          options={ctx.periods.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Input
          value={room}
          onChange={setRoom}
          className="w-28"
          placeholder="Room"
          srLabel={`Room for ${entry.subject_name}`}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={move.isPending} onClick={() => move.mutate()}>
          {move.isPending ? 'Moving…' : 'Move it'}
        </Button>
        <Button size="sm" variant="ghost" tone="danger" disabled={remove.isPending}
          onClick={() => remove.mutate()}>
          Remove
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <FormNotice error={move.error ?? remove.error} />
    </div>
  )
}

/* THE ONE DRAFT THAT IS A DECISION, as a card rather than a row.

   A table row gives every draft the same weight, and only the newest is
   actually a choice somebody has to make. This says what it did, whether it
   managed everything, who made it and when — and puts the three things that
   can be done with it where the eye already is. */
function DraftCard({ draft, open, mayWrite, onOpen }: {
  draft: DraftHead
  open: boolean
  mayWrite: boolean
  onOpen: () => void
}) {
  const complete = draft.blocking_issues === 0
  return (
    <Card className={cn('border-l-4', complete ? 'border-l-success' : 'border-l-warning')}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0">
          <p className="eyebrow text-muted-foreground">Suggested timetable, not yet in use</p>
          <p className="mt-1 text-[15px] font-medium">
            {complete
              ? `All ${draft.periods_placed} periods placed`
              : `${draft.periods_placed} of ${draft.periods_required} periods placed`}
          </p>
          {!complete && (
            <p className="mt-0.5 text-[13.5px] text-warning">
              {draft.blocking_issues} {draft.blocking_issues === 1 ? 'requirement' : 'requirements'} could
              not be met — open it to read which, and why.
            </p>
          )}
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">
            {draft.name} · {draft.generated_at.slice(0, 16).replace('T', ' ')}
            {draft.generated_by ? ` · by ${draft.generated_by}` : ''}
            {draft.sections ? ` · ${draft.sections} sections` : ''}
          </p>
        </div>
        <Button variant={open ? 'secondary' : 'primary'} onClick={onOpen}>
          {open ? 'Close' : mayWrite ? 'Review and put in use' : 'Look at it'}
        </Button>
      </div>
    </Card>
  )
}

/* THE WEEK AS A GRID, which is how a timetable has been drawn for a century.

   It was a linear list — one row per period, sorted by day then name, with a
   Move button on each — so reading "what does 6-A do on Wednesday" meant
   scanning thirty rows for the six that said Wednesday, and the shape a
   timetable has in everybody's head was nowhere on the screen. Days across,
   periods down, and a clash or a hole is visible without reading anything.

   Clicking a cell opens the same move controls the button used to. The
   controls did not need replacing; what needed replacing was having to find
   the row they were attached to. */
function DraftWeekGrid({ entries, periods, weekdays, mayWrite, draftID, onChanged }: {
  entries: DraftEntry[]
  periods: GridPeriod[]
  weekdays: number[]
  mayWrite: boolean
  draftID: string
  onChanged: () => void
}) {
  const [openCell, setOpenCell] = useState<string | null>(null)

  const at = (weekday: number, periodID: string) =>
    entries.find((e) => e.weekday === weekday && e.period_id === periodID)

  const teaching = periods.filter((p) => !p.is_break)

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-separate border-spacing-1 p-3">
        <thead>
          <tr>
            <th className="w-28 text-left text-[12px] font-medium text-muted-foreground">
              Period
            </th>
            {weekdays.map((wd) => (
              <th key={wd} className="text-left text-[12px] font-medium text-muted-foreground">
                {WEEKDAYS[wd - 1]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {teaching.map((pd) => (
            <tr key={pd.id}>
              <td className="align-top">
                <p className="text-[13px] font-medium">{pd.name}</p>
                <p className="text-[11px] tabular-nums text-muted-foreground">
                  {pd.starts_at?.slice(0, 5)}
                </p>
              </td>
              {weekdays.map((wd) => {
                const e = at(wd, pd.id)
                const key = `${wd}-${pd.id}`
                return (
                  <td key={key} className="align-top">
                    {e ? (
                      <button
                        type="button"
                        disabled={!mayWrite}
                        onClick={() => setOpenCell(openCell === key ? null : key)}
                        className={cn(
                          'w-full rounded-lg border px-2 py-1.5 text-left',
                          e.teacher_name ? 'bg-primary/5' : 'border-destructive bg-destructive/5',
                          mayWrite && 'hover:border-primary',
                        )}
                      >
                        <span className="block truncate text-[12.5px] font-medium">
                          {e.subject_name}
                        </span>
                        {/* A period with nobody allocated is the thing this
                            grid exists to make findable, so it is coloured
                            rather than left as a quiet dash. */}
                        <span className={cn(
                          'block truncate text-[11.5px]',
                          e.teacher_name ? 'text-muted-foreground' : 'text-destructive',
                        )}>
                          {e.teacher_name ?? 'no teacher'}
                        </span>
                        {e.room && (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {e.room}
                          </span>
                        )}
                      </button>
                    ) : (
                      <div className="rounded-lg border border-dashed px-2 py-1.5 text-[11.5px] text-muted-foreground">
                        free
                      </div>
                    )}
                    {openCell === key && e && mayWrite && (
                      <div className="mt-1 rounded-lg border bg-muted/30 p-2">
                        <MoveForm
                          key={e.id}
                          entry={e}
                          ctx={{ periods: teaching, weekdays, draftID }}
                          onDone={() => { setOpenCell(null); onChanged() }}
                          onCancel={() => setOpenCell(null)}
                        />
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
