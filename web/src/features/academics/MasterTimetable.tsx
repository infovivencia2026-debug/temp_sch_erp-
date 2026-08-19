import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Select,
  Input, Table, Td, Loading, ErrorState, EmptyState, FormNotice,
} from '@/components/ui'
import { useCan } from '@/lib/session'
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
    required_periods: number
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

  const overview = useQuery({
    queryKey: ['master-timetable', 'overview'],
    queryFn: () => api.get<Overview>(`${BASE}/overview`),
  })

  const generate = useMutation({
    mutationFn: () => api.post<DraftHead>(`${OPTIMIZER}/drafts`, { seed: Date.now() % 100000 }),
    onSuccess: (d) => {
      setOpenDraft(d.id)
      setNote('Draft generated. Nothing has changed in the live timetable yet.')
      qc.invalidateQueries({ queryKey: ['master-timetable'] })
    },
  })

  if (overview.isLoading) return <Loading label="Reading the year's timetable…" />
  // A failed read is never drawn as "no sections". "We could not read this"
  // and "this school has no timetable" are opposite conclusions.
  if (overview.error) return <ErrorState error={overview.error} />

  const d = overview.data
  const s = d?.summary

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Master timetable"
        description="The whole school's week: what each section needs, what it currently runs, and the draft waiting to replace it. Generating never touches the live timetable — publishing does, once, deliberately."
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-muted-foreground">
            Academic year {d?.academic_year}
          </span>
          {mayWrite && (
            <Button size="sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
              {generate.isPending ? 'Generating…' : 'Generate a draft for the whole school'}
            </Button>
          )}
        </div>

        <FormNotice error={generate.error} ok={note} />

        <CellGrid cols={4}>
          <Stat
            label="Sections"
            value={s?.sections ?? 0}
            hint={s?.sections_without_timetable
              ? `${s.sections_without_timetable} with no timetable at all`
              : 'every section has a timetable'}
          />
          <Stat
            label="Periods live"
            value={`${s?.live_periods ?? 0} of ${s?.required_periods ?? 0}`}
            hint="against what the subjects ask for"
          />
          <Stat
            label="Unstaffed periods"
            value={s?.live_unstaffed ?? 0}
            hint="placed, with nobody to teach them"
          />
          <Stat label="Open drafts" value={s?.open_drafts ?? 0} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Drafts waiting"
            description="A draft is a candidate. It becomes the school's timetable only when somebody publishes it."
          />
          {(d?.open_drafts.length ?? 0) === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No draft open"
                body="Generate one to see what the solver can place and, more usefully, what it cannot."
              />
            </div>
          ) : (
            <Table head={['Draft', 'Sections', 'Placed', 'Unmet', 'Generated', '']}>
              {(d?.open_drafts ?? []).map((x) => (
                <tr key={x.id}>
                  <Td className="font-medium">{x.name}</Td>
                  <Td className="tabular-nums">{x.sections}</Td>
                  <Td className="tabular-nums">
                    {x.periods_placed} of {x.periods_required}
                  </Td>
                  <Td>
                    {x.blocking_issues > 0 ? (
                      <Badge tone="danger">{x.blocking_issues} unmet</Badge>
                    ) : (
                      <Badge tone="success">everything placed</Badge>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {x.generated_at.slice(0, 16).replace('T', ' ')}
                    {x.generated_by ? ` · ${x.generated_by}` : ''}
                  </Td>
                  <Td>
                    <Button size="sm" variant="secondary"
                      onClick={() => setOpenDraft(openDraft === x.id ? '' : x.id)}>
                      {openDraft === x.id ? 'Close' : 'Review'}
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
            draftID={openDraft}
            mayWrite={mayWrite && (d?.may_edit ?? false)}
            onPublished={(m) => {
              setOpenDraft('')
              setNote(m)
              qc.invalidateQueries({ queryKey: ['master-timetable'] })
            }}
          />
        )}

        <Card>
          <CardHeader
            title="Every section"
            description="What each one needs, what it runs today, and what the draft would give it. A school at 96% of its periods can still have one Class 9 with no Chemistry, which is why this is per section and not a percentage."
          />
          <Table
            head={['Class', 'Section', 'Needs', 'Live now', 'Unstaffed', 'In draft', 'Draft']}
            empty={!(d?.sections.length ?? 0)}
            emptyLabel="No sections in this academic year yet."
          >
            {(d?.sections ?? []).map((x) => (
              <tr key={x.section_id}>
                <Td>{x.class_name}</Td>
                <Td className="font-medium">{x.section_name}</Td>
                <Td className="tabular-nums">{x.required_periods}</Td>
                <Td className={cn('tabular-nums',
                  x.live_periods === 0 && 'font-medium text-destructive')}>
                  {x.live_periods === 0 ? 'none' : x.live_periods}
                </Td>
                <Td className={cn('tabular-nums',
                  x.live_unstaffed > 0 && 'text-warning')}>
                  {x.live_unstaffed || '—'}
                </Td>
                <Td className="tabular-nums">{x.draft_periods || '—'}</Td>
                <Td className="text-muted-foreground">{x.draft_name ?? '—'}</Td>
              </tr>
            ))}
          </Table>
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
      api.post<{ periods_replaced: number; periods_written: number }>(
        `${OPTIMIZER}/drafts/${draftID}/publish`,
        { acknowledge_unmet: acknowledged },
      ),
    onSuccess: (r) =>
      onPublished(
        `Published: ${r.periods_written} periods written, ${r.periods_replaced} replaced.`,
      ),
  })

  const discard = useMutation({
    mutationFn: () => api.post(`${OPTIMIZER}/drafts/${draftID}/discard`, {}),
    onSuccess: () => onPublished('Draft discarded. The live timetable is untouched.'),
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
            Every requirement was met. Read the overwrite summary below before publishing anyway.
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
          title="What publishing will overwrite"
          description="Publishing replaces the live timetable for exactly the sections this draft covers, in this academic year. Sections it is silent about keep theirs."
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
                {publish.isPending ? 'Publishing…' : 'Publish to the live timetable'}
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
          title="The draft grid"
          description="Correct a period before publishing. Every move is re-checked on the server against the same rules the solver honoured, and the refusal says which one bound."
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
        <Table
          head={['Day', 'Period', 'Subject', 'Teacher', 'Room', '']}
          empty={!dd.entries.some((e) => e.section_id === chosen)}
          emptyLabel="This draft places nothing for that section."
        >
          {dd.entries
            .filter((e) => e.section_id === chosen)
            .sort((a, b) => a.weekday - b.weekday || a.period_name.localeCompare(b.period_name))
            .map((e) =>
              entryRows(e, {
                periods: dd.periods.filter((p) => !p.is_break),
                weekdays: dd.weekdays,
                mayWrite,
                draftID,
                onChanged: () => {
                  qc.invalidateQueries({ queryKey: ['master-timetable'] })
                },
              }),
            )}
        </Table>
      </Card>
    </>
  )
}

/* One period of the draft, and — when it is being moved — the row of controls
   underneath it.
 *
 * A plain function returning an ARRAY of <tr>s rather than a component, so
 * <Table> walks each row and labels its cells for a phone. A <MyRow /> element
 * would be walked as one opaque element and every cell in this table would
 * lose its label below 640px; the codebase has shipped that four times.
 */
function entryRows(
  e: DraftEntry,
  ctx: {
    periods: GridPeriod[]
    weekdays: number[]
    mayWrite: boolean
    draftID: string
    onChanged: () => void
  },
) {
  return [
    <tr key={e.id}>
      <Td>{WEEKDAYS[e.weekday - 1]}</Td>
      <Td>{e.period_name}</Td>
      <Td className="font-medium">{e.subject_name}</Td>
      <Td className={cn(!e.teacher_name && 'text-destructive')}>
        {e.teacher_name ?? 'nobody allocated'}
      </Td>
      <Td className="text-muted-foreground">{e.room ?? '—'}</Td>
      <Td>
        {ctx.mayWrite && <MoveCell entry={e} ctx={ctx} />}
      </Td>
    </tr>,
  ]
}

function MoveCell({ entry, ctx }: {
  entry: DraftEntry
  ctx: {
    periods: GridPeriod[]
    weekdays: number[]
    draftID: string
    onChanged: () => void
  }
}) {
  const [open, setOpen] = useState(false)
  return open ? (
    <MoveForm
      /* Keyed by the period being moved: without it the controls keep the
         previous row's day and period in state and the next move sends
         Tuesday's slot for Thursday's lesson. */
      key={entry.id}
      entry={entry}
      ctx={ctx}
      onDone={() => { setOpen(false); ctx.onChanged() }}
      onCancel={() => setOpen(false)}
    />
  ) : (
    <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Move</Button>
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
