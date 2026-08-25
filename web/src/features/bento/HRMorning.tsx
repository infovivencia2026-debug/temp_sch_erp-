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

/* HR'S MORNING, IN THE EDITORIAL CARD LANGUAGE.

   Every cell is `CardShell` — header, figure, drawing — with the drawing in
   the row that takes all the remaining height, and every drawing is one of the
   twelve in `bento-cards.tsx`. docs/BENTO_CARD_PATTERNS.md is the contract.
   Nothing here names a colour; every mark is `currentColor`, which is what
   keeps the anchor's inverted ink legible.

   One endpoint, /hr/dashboard, the same one the classic screen uses.

   ─── WHAT THE RESPONSE CARRIES ───────────────────────────────────────────

   Read from internal/api/role_backoffice.go.

     headcount        active employees
     present_today    staff_attendance rows today at present or late
     absent_today     staff_attendance rows today at absent
     leave_pending    staff leave requests awaiting a decision
     new_joiners_30d  employees joined in the last 30 days
     departments      how many there are
     away_today[]     WHO is not in, from two sources — the register's absent
                      and leave marks, and separately the approved leave that
                      covers today
     attention[]      sentences with counts in them, each with a link

   ─── THE TRAP IN THESE THREE NUMBERS ─────────────────────────────────────

   present_today AND absent_today ARE NOT A PARTITION OF headcount.

   The first two count rows in today's staff register; the third counts active
   employees. Before the register is taken they are 0 and 0 against a headcount
   of ninety, and a "present" gauge drawn against headcount would report a
   school where nobody came to work.

   So there are two different proportions here and the board draws both, named
   for what they actually measure:

     marked / headcount            has the register been taken yet
     present / (present + absent)  of those marked, how many are in

   The second has a real denominator — both numerators count rows of the same
   table on the same date — and is the only attendance rate this response can
   honestly state.

   ─── AND ONE MORE ────────────────────────────────────────────────────────

   away_today is NOT absent_today. It unions the register's marks with the
   approved leave covering today, so it answers "whose classes need covering",
   which is the question at 8am — and it is deliberately longer than the absent
   count, because somebody on approved leave was never going to be marked
   absent by a register nobody has opened yet.
*/

interface Away {
  name: string
  employee_code: string
  reason: string
  until?: string
}

interface Alert {
  kind: 'danger' | 'warning' | 'neutral'
  text: string
  count: number
  link: string
}

interface HRKPIs {
  headcount: number
  present_today: number
  absent_today: number
  leave_pending: number
  new_joiners_30d: number
  departments: number
  away_today: Away[]
  attention: Alert[]
}

// --- the shell ----------------------------------------------------------

/** A cell: the kit's ground and cue wrapped around the pattern file's shell.

    The height budget is the whole design of this function, and it is the same
    one FinanceDashboard and AdmissionsDesk work to. A one-row cell is 172px,
    and a 38px figure plus a second header line plus a 34px pill leave the
    drawing about fifteen pixels — the "label, number, empty space" this card
    language exists to stop being. So at one row the figure drops to 26px, the
    sub-line goes, and the cue becomes the compact pill. At 1x1 there is no cue
    at all: 232 usable pixels do not hold both a pill and a drawing, and the
    drawing is the part that carries the meaning. */
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

/** The gauge, kept square by its HEIGHT rather than its width.

    `Gauge` is a circle at 78% of its container's width. In a one-row cell that
    container is five times wider than it is tall, so the circle is drawn taller
    than the card and clipped through the middle. A box whose width comes from
    the row's height makes it fit whatever room the row has, with no branch. */
function GaugeBox({ value, total, srLabel }: { value: number; total: number; srLabel: string }) {
  return (
    <div className="grid h-full min-h-0 place-items-center">
      <div className="grid aspect-square h-full max-h-full place-items-center">
        <Gauge value={value} total={total} srLabel={srLabel} />
      </div>
    </div>
  )
}

/** A short sentence where a drawing would go — the state a drawing must not be
    drawn in. Never a zero: "we could not ask" and "there is none" are different
    facts, and a chart at zero states the second while meaning the first. */
function Said({ children }: { children: ReactNode }) {
  return (
    <p className="flex h-full min-h-0 items-center text-[length:var(--card-sub,10px)] leading-snug opacity-60">
      {children}
    </p>
  )
}

// --- the cells ----------------------------------------------------------

/** THE ANCHOR — who is not in, by name, and the only dark cell on the page.

    Names rather than a count, because "3 away" tells HR a number and what they
    need is which three: each one is a class somebody has to go and stand in
    front of. The list is the union of the register's marks and the approved
    leave covering today, which is why it can be longer than absent_today. */
function AwayCell({ span, k, href }: { span: CellSpan; k: HRKPIs; href?: string }) {
  const t = useT()
  const away = k.away_today ?? []
  const returning = away.filter((a) => a.until).length
  return (
    <Card
      span={span}
      dark
      title={t('bento.hr.away')}
      sub={t('bento.hr.away_sub')}
      value={away.length}
      change={returning > 0 ? t('bento.hr.away_returning', { n: returning }) : undefined}
      to={href}
      cue={t('bento.hr.cue_cover')}
    >
      {away.length === 0 ? (
        <Said>{t('bento.hr.everyone_in')}</Said>
      ) : (
        <Facts
          items={away.slice(0, 6).map((a) => ({
            label: a.name || a.employee_code,
            value: a.reason,
          }))}
          srLabel={t('bento.hr.away_sr')}
        />
      )}
    </Card>
  )
}

/** Has the register been taken.

    marked / headcount, and named for that rather than for attendance. Both
    sides are counted at the same instant, but they count different tables:
    rows in today's staff register against active employees. That is a true
    completeness measure and a false attendance one, which is why the label
    says "marked" and not "present". */
function RegisterCell({ span, k, href }: { span: CellSpan; k: HRKPIs; href?: string }) {
  const t = useT()
  const marked = k.present_today + k.absent_today
  return (
    <Card
      span={span}
      title={t('bento.hr.register')}
      sub={t('bento.hr.register_sub')}
      value={marked}
      change={t('bento.hr.of_staff', { n: k.headcount })}
      to={href}
      cue={t('bento.hr.cue_register')}
    >
      {k.headcount > 0 ? (
        <GaugeBox value={marked} total={k.headcount} srLabel={t('bento.hr.register_sr')} />
      ) : (
        <Said>{t('bento.hr.no_staff')}</Said>
      )}
    </Card>
  )
}

/** In, of those marked.

    The one honest attendance rate on this response: both numbers count rows of
    staff_attendance for the same date, so the denominator is real. It is
    deliberately NOT drawn against headcount — before the register is taken
    that would report a school where nobody came to work. */
function PresentCell({ span, k, href }: { span: CellSpan; k: HRKPIs; href?: string }) {
  const t = useT()
  const marked = k.present_today + k.absent_today
  return (
    <Card
      span={span}
      title={t('bento.hr.present')}
      sub={t('bento.hr.present_sub')}
      value={k.present_today}
      change={marked > 0 ? t('bento.hr.of_marked', { n: marked }) : undefined}
      to={href}
      cue={t('bento.hr.cue_register')}
    >
      {marked > 0 ? (
        <GaugeBox value={k.present_today} total={marked} srLabel={t('bento.hr.present_sr')} />
      ) : (
        <Said>{t('bento.hr.register_not_taken')}</Said>
      )}
    </Card>
  )
}

/** What is waiting on a decision.

    The server writes these as sentences with counts in them rather than as
    bare numbers, so they are printed as written. A dashboard that turns "4
    certificates expire this month" back into "4" has thrown away the half that
    said what to do. */
function AttentionCell({ span, k, href }: { span: CellSpan; k: HRKPIs; href?: string }) {
  const t = useT()
  const items = k.attention ?? []
  const urgent = items.filter((a) => a.kind === 'danger').length
  return (
    <Card
      span={span}
      title={t('bento.hr.attention')}
      sub={t('bento.hr.attention_sub')}
      value={items.reduce((n, a) => n + a.count, 0)}
      change={urgent > 0 ? t('bento.hr.urgent', { n: urgent }) : undefined}
      to={href}
      cue={t('bento.hr.cue_attention')}
    >
      {items.length === 0 ? (
        <Said>{t('bento.hr.nothing_waiting')}</Said>
      ) : (
        <Rows
          items={items.slice(0, 6).map((a) => ({ label: a.text, value: a.count }))}
          srLabel={t('bento.hr.attention_sr')}
          formatValue={(n) => String(n)}
        />
      )}
    </Card>
  )
}

/** A plain count, for the figures that have no honest denominator here.

    Leave pending is a queue, not a share of anything on this response. New
    joiners is a period count against a level. Neither is a fraction and
    neither is drawn as one. */
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

export default function HRMorning() {
  const t = useT()
  const kpis = useQuery({
    queryKey: ['hr-dashboard'],
    queryFn: () => api.get<HRKPIs>('/api/v1/hr/dashboard'),
  })

  const registerHref = useFeatureHref('hr.attendance.staff_register')
  const leaveHref = useFeatureHref('hr.leave.leave')
  const recordsHref = useFeatureHref('hr.records.staff_records')
  const substitutionHref = useFeatureHref('hr.attendance.substitution_cover')

  if (kpis.isLoading) return <BentoLoading message={t('bento.hr.loading')} />
  // Never a zero that is really a failed fetch. "Nobody is away" and "we could
  // not ask" send an HR office to two different mornings.
  if (kpis.error) return <BentoError message={t('bento.hr.failed')} />

  const k = kpis.data!

  return (
    <BentoPage eyebrow={t('bento.hr.eyebrow')} title={t('bento.hr.title')}>
      <WidgetLayer dashboard="hr">
        <Widget id="away" label={t('bento.hr.away')} size="large" index={0}>
          {(span) => <AwayCell span={span} k={k} href={substitutionHref ?? registerHref} />}
        </Widget>

        <Widget id="attention" label={t('bento.hr.attention')} size="small" index={1}>
          {(span) => <AttentionCell span={span} k={k} href={recordsHref} />}
        </Widget>

        <Widget id="register" label={t('bento.hr.register')} size="small" index={2}>
          {(span) => <RegisterCell span={span} k={k} href={registerHref} />}
        </Widget>

        <Widget id="present" label={t('bento.hr.present')} size="small" index={3}>
          {(span) => <PresentCell span={span} k={k} href={registerHref} />}
        </Widget>

        <Widget id="leave" label={t('bento.hr.leave')} size="small" index={4}>
          {(span) => (
            <CountCell
              span={span}
              title={t('bento.hr.leave')}
              sub={t('bento.hr.leave_sub')}
              value={k.leave_pending}
              note={t('bento.hr.leave_note')}
              href={leaveHref}
              cue={t('bento.hr.cue_leave')}
            />
          )}
        </Widget>

        <Widget id="joiners" label={t('bento.hr.joiners')} size="small" index={5}>
          {(span) => (
            <CountCell
              span={span}
              title={t('bento.hr.joiners')}
              sub={t('bento.hr.joiners_sub')}
              value={k.new_joiners_30d}
              note={t('bento.hr.joiners_note', { n: k.departments })}
              href={recordsHref}
              cue={t('bento.hr.cue_records')}
            />
          )}
        </Widget>
      </WidgetLayer>
    </BentoPage>
  )
}
