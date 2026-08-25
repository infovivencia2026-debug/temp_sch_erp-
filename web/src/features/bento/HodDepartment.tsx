import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'
import {
  BentoError,
  BentoLoading,
  BentoPage,
  Cell,
  type CellSpan,
  Cue,
  useFeatureHref,
} from './bento-kit'
import { CardShell, Facts, Gauge, Rows } from './bento-cards'
import { Widget, WidgetLayer } from './WidgetLayer'

/* THE DEPARTMENT BEFORE NINE, IN THE EDITORIAL CARD LANGUAGE.

   Every cell is `CardShell` — header, figure, drawing — and every drawing is
   one of the twelve in `bento-cards.tsx`. docs/BENTO_CARD_PATTERNS.md is the
   contract. Nothing here names a colour; every mark is `currentColor`.

   One endpoint, /teaching/hod-dashboard, the same one the classic screen uses.

   The classic screen's own comment sets the brief and this board keeps it: a
   HOD is an approver before they are anything else, and the two things they
   chase rather than do are registers and marks. It is deliberately not the
   principal's board with the numbers changed — a HOD runs neither the money
   nor the admissions, and putting those figures here would make the page look
   important while answering nothing they can act on.

   ─── WHAT THE RESPONSE CARRIES ───────────────────────────────────────────

     departments / department_names   what this HOD heads
     teachers, sections               the size of it
     absent_today                     staff of theirs not in
     periods_uncovered                periods with nobody in front of them
     registers_not_taken              registers still unopened today
     leave_to_decide, subs_to_approve,
     papers_to_approve, marks_to_moderate   four queues, all theirs
     absent[]                         WHO, with how many periods each and how
                                      many of those nobody is covering

   ─── THE ONE PROPORTION THAT IS REAL ─────────────────────────────────────

   `periods_uncovered` out of the periods the absent staff were due to teach —
   both come off the same `absent[]` rows, summed at the same instant, and the
   uncovered count is a strict subset of the periods count. That is the
   morning's actual question: of the lessons that lost their teacher, how many
   still have nobody.

   NOTHING ELSE HERE IS A FRACTION. absent_today against teachers is a level
   against a level and is drawn as a count. The four approval queues are
   queues: there is no total-requests figure on this response to divide them
   by, and inventing one would be a percentage of nothing.
*/

interface Absentee {
  name: string
  reason: string
  periods: number
  uncovered: number
}

interface Dash {
  departments: number
  department_names: string[]
  teachers: number
  sections: number
  absent_today: number
  periods_uncovered: number
  registers_not_taken: number
  leave_to_decide: number
  subs_to_approve: number
  papers_to_approve: number
  marks_to_moderate: number
  absent: Absentee[]
}

// --- the shell ----------------------------------------------------------

/** A cell: the kit's ground and cue wrapped around the pattern file's shell.

    Same height budget as every other board in this directory. At one row the
    figure drops to 26px, the sub-line goes, and the cue becomes the compact
    pill, because a 38px figure plus a second header line plus a 34px pill
    leave a 172px cell about fifteen pixels of drawing. At 1x1 there is no cue:
    232 usable pixels do not hold both a pill and a drawing, and the drawing is
    what carries the meaning. */
function Card({
  span, dark, title, sub, value, change, to, cue, children,
}: {
  span: CellSpan
  dark?: boolean
  title: string
  sub?: string
  value: ReactNode
  change?: ReactNode
  to?: string
  cue?: string
  children?: ReactNode
}) {
  const { w, h } = useWidgetSize()
  const tall = h >= 2
  const room = w >= 2 || tall
  return (
    <Cell span={span} dark={dark} className={tall ? undefined : '[--bento-fig:26px]'}>
      <CardShell
        className="min-h-0 flex-1"
        title={title}
        sub={tall ? sub : undefined}
        value={value}
        change={change}
      >
        {children}
      </CardShell>
      {room && to && cue && (
        <div
          className={cn(
            'shrink-0',
            tall
              ? 'mt-2'
              : 'mt-1.5 [&_a]:px-2.5 [&_a]:py-1 [&_a]:text-[length:var(--card-action,11px)]',
          )}
        >
          <Cue to={to} label={cue} dark={dark} />
        </div>
      )}
    </Cell>
  )
}

/** The gauge, kept square by its HEIGHT rather than its width. In a one-row
    cell the container is five times wider than it is tall, and a circle sized
    from the width is drawn taller than the card and clipped through the
    middle. */
function GaugeBox({ value, total, srLabel }: { value: number; total: number; srLabel: string }) {
  return (
    <div className="grid h-full min-h-0 place-items-center">
      <div className="grid aspect-square h-full max-h-full place-items-center">
        <Gauge value={value} total={total} srLabel={srLabel} />
      </div>
    </div>
  )
}

/** A short sentence where a drawing would go. Never a zero: "we could not ask"
    and "there is none" are different facts, and a chart at zero states the
    second while meaning the first. */
function Said({ children }: { children: ReactNode }) {
  return (
    <p className="flex h-full min-h-0 items-center text-[length:var(--card-sub,10px)] leading-snug opacity-60">
      {children}
    </p>
  )
}

// --- the cells ----------------------------------------------------------

/** THE ANCHOR — the lessons with nobody in front of them.

    The only real proportion on this response: uncovered periods out of the
    periods the absent staff were due to teach, both summed from the same rows.
    The names are underneath because "4 uncovered" is a number and what a HOD
    needs at 8am is which teacher, so they know which door to knock on. */
function CoverCell({ span, d, href }: { span: CellSpan; d: Dash; href?: string }) {
  const t = useT()
  const rows = d.absent ?? []
  const periods = rows.reduce((n, a) => n + (a.periods || 0), 0)
  const uncovered = d.periods_uncovered
  return (
    <Card
      span={span}
      dark
      title={t('bento.hod.uncovered')}
      sub={t('bento.hod.uncovered_sub')}
      value={uncovered}
      change={periods > 0 ? t('bento.hod.of_periods', { n: periods }) : undefined}
      to={href}
      cue={t('bento.hod.cue_cover')}
    >
      {rows.length === 0 ? (
        <Said>{t('bento.hod.nobody_out')}</Said>
      ) : (
        <Facts
          items={rows.slice(0, 6).map((a) => ({
            label: a.name,
            value: a.uncovered > 0
              ? t('bento.hod.uncovered_of', { u: a.uncovered, p: a.periods })
              : t('bento.hod.all_covered_short'),
          }))}
          srLabel={t('bento.hod.uncovered_sr')}
        />
      )}
    </Card>
  )
}

/** The four queues, as one cell.

    Separately they are four small numbers that each look unimportant; together
    they are the answer to "what is waiting on me", which is the first question
    a HOD has. They are counts and not shares — this response carries no
    total-requests figure to divide them by, and a percentage of nothing is
    worse than a number. */
function QueuesCell({ span, d, href }: { span: CellSpan; d: Dash; href?: string }) {
  const t = useT()
  const items = [
    { label: t('bento.hod.q_leave'), value: d.leave_to_decide },
    { label: t('bento.hod.q_subs'), value: d.subs_to_approve },
    { label: t('bento.hod.q_papers'), value: d.papers_to_approve },
    { label: t('bento.hod.q_marks'), value: d.marks_to_moderate },
  ]
  const total = items.reduce((n, i) => n + i.value, 0)
  const waiting = items.filter((i) => i.value > 0)
  return (
    <Card
      span={span}
      title={t('bento.hod.waiting')}
      sub={t('bento.hod.waiting_sub')}
      value={total}
      change={waiting.length > 0 ? t('bento.hod.across_queues', { n: waiting.length }) : undefined}
      to={href}
      cue={t('bento.hod.cue_approvals')}
    >
      {total === 0 ? (
        <Said>{t('bento.hod.nothing_waiting')}</Said>
      ) : (
        <Rows
          items={waiting}
          srLabel={t('bento.hod.waiting_sr')}
          formatValue={(n) => String(n)}
        />
      )}
    </Card>
  )
}

/** Registers not taken.

    Drawn against sections, which is the number of registers there are to take,
    so this one IS a share — of the department's own registers, how many are
    still shut. A HOD chases this rather than doing it, which is why the cue
    goes to the register rather than to a report. */
function RegistersCell({ span, d, href }: { span: CellSpan; d: Dash; href?: string }) {
  const t = useT()
  return (
    <Card
      span={span}
      title={t('bento.hod.registers')}
      sub={t('bento.hod.registers_sub')}
      value={d.registers_not_taken}
      change={d.sections > 0 ? t('bento.hod.of_sections', { n: d.sections }) : undefined}
      to={href}
      cue={t('bento.hod.cue_registers')}
    >
      {d.sections > 0 ? (
        <GaugeBox
          value={d.registers_not_taken}
          total={d.sections}
          srLabel={t('bento.hod.registers_sr')}
        />
      ) : (
        <Said>{t('bento.hod.no_sections')}</Said>
      )}
    </Card>
  )
}

/** A plain count. Levels, not fractions. */
function CountCell({
  span, title, sub, value, note, href, cue,
}: {
  span: CellSpan
  title: string
  sub: string
  value: number
  note: string
  href?: string
  cue: string
}) {
  return (
    <Card span={span} title={title} sub={sub} value={value} to={href} cue={cue}>
      <Said>{note}</Said>
    </Card>
  )
}

// --- the board ----------------------------------------------------------

export default function HodDepartment() {
  const t = useT()
  const dash = useQuery({
    queryKey: ['hod-dashboard'],
    queryFn: () => api.get<Dash>('/api/v1/teaching/hod-dashboard'),
  })

  const subsHref = useFeatureHref('hod.timetable.substitution_requests')
  const leaveHref = useFeatureHref('hod.staff.leaves_subs')
  const marksHref = useFeatureHref('hod.exams.mark_moderation')
  const papersHref = useFeatureHref('hod.exams.question_paper_approval')
  const registerHref = useFeatureHref('hod.attendance.take_attendance')
  const allocationHref = useFeatureHref('hod.academics.faculty_allocation')

  if (dash.isLoading) return <BentoLoading message={t('bento.hod.loading')} />
  // Never a zero that is really a failed fetch: "no periods uncovered" is the
  // one sentence on this page a HOD must not be told by mistake.
  if (dash.error) return <BentoError message={t('bento.hod.failed')} />

  const d = dash.data!
  const dept = (d.department_names ?? []).join(', ')

  return (
    <BentoPage
      eyebrow={dept || t('bento.hod.eyebrow')}
      title={t('bento.hod.title')}
    >
      <WidgetLayer dashboard="hod">
        <Widget id="cover" label={t('bento.hod.uncovered')} size="large" index={0}>
          {(span) => <CoverCell span={span} d={d} href={subsHref} />}
        </Widget>

        <Widget id="waiting" label={t('bento.hod.waiting')} size="small" index={1}>
          {(span) => <QueuesCell span={span} d={d} href={leaveHref ?? marksHref ?? papersHref} />}
        </Widget>

        <Widget id="registers" label={t('bento.hod.registers')} size="small" index={2}>
          {(span) => <RegistersCell span={span} d={d} href={registerHref} />}
        </Widget>

        <Widget id="absent" label={t('bento.hod.absent')} size="small" index={3}>
          {(span) => (
            <CountCell
              span={span}
              title={t('bento.hod.absent')}
              sub={t('bento.hod.absent_sub')}
              value={d.absent_today}
              note={t('bento.hod.absent_note', { n: d.teachers })}
              href={leaveHref}
              cue={t('bento.hod.cue_leave')}
            />
          )}
        </Widget>

        <Widget id="marks" label={t('bento.hod.q_marks')} size="small" index={4}>
          {(span) => (
            <CountCell
              span={span}
              title={t('bento.hod.q_marks')}
              sub={t('bento.hod.marks_sub')}
              value={d.marks_to_moderate}
              note={t('bento.hod.marks_note')}
              href={marksHref}
              cue={t('bento.hod.cue_marks')}
            />
          )}
        </Widget>

        <Widget id="size" label={t('bento.hod.department')} size="small" index={5}>
          {(span) => (
            <CountCell
              span={span}
              title={t('bento.hod.department')}
              sub={t('bento.hod.department_sub')}
              value={d.teachers}
              note={t('bento.hod.department_note', { s: d.sections, d: d.departments })}
              href={allocationHref}
              cue={t('bento.hod.cue_allocation')}
            />
          )}
        </Widget>
      </WidgetLayer>
    </BentoPage>
  )
}
