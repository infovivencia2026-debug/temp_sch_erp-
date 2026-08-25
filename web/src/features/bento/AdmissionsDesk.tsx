import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
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
import { CardShell, Distribution, Funnel, Gauge, Rows } from './bento-cards'
import { Widget, WidgetLayer } from './WidgetLayer'

/* THE ADMISSIONS DESK, IN THE EDITORIAL CARD LANGUAGE.

   Four roles landed on the classic screen while five got a board: admissions,
   HR and the two vendor roles. This is the first of the four. Every cell is
   `CardShell` — header, figure, drawing — with the drawing taking all the
   remaining height, and every drawing is one of the twelve in
   `bento-cards.tsx`. docs/BENTO_CARD_PATTERNS.md is the contract; this is an
   application of it. Nothing here names a colour: every mark is
   `currentColor`, which is what keeps the anchor's inverted ink legible.

   The same two endpoints as `web/src/features/admissions/Dashboard.tsx` —
   /admissions/dashboard and /admissions/enquiries — and no others.

   ─── WHAT THE RESPONSE ACTUALLY CARRIES ──────────────────────────────────

   Read from internal/api/role_backoffice.go, not from the interface below.
   Seven counts, and each is a `count(*)` over a whole table with no date
   bound at all:

     enquiries       every enquiry ever recorded
     new_enquiries   those still at status 'new'
     applications    every application ever recorded
     incomplete      applications still at 'draft'
     admitted        applications at 'offered'
     enrolled        applications with a student_id — the conversion
     follow_ups_due  enquiries whose next_follow_up is today or earlier and
                     which have not already applied or been lost

   ─── WHAT IT DOES NOT CARRY, AND WHAT THAT FORBIDS ───────────────────────

   THERE IS NO TIME AXIS. Not a week, not a month, not a season. So there is
   no `Line`, no `Area` and no `Bars` of days anywhere on this board, and
   nothing here says "this week" or "up on last month". An admissions team is
   measured on a season, and this response cannot see one; drawing a trend
   from a single instant would be inventing the axis.

   THE STAGES ARE NOT A CLEAN FUNNEL EITHER, and the funnel says so. Enquiries
   and applications are different tables — an application can exist with no
   enquiry before it, so `applications` is not a subset of `enquiries` and the
   pair cannot be a proportion. Inside applications the three stages ARE
   nested rows of one table, and those are drawn as the honest funnel.

   ─── THE PROPORTIONS THAT ARE REAL ───────────────────────────────────────

   1. `enrolled / applications`. Both count rows of `applications`, one with
      the extra predicate `student_id IS NOT NULL`. A strict subset of the
      same measure at the same instant — the one denominator this board can
      put in a `Gauge`.

   2. `incomplete / applications`. The same shape: `status = 'draft'` is a
      predicate over the same rows.

   3. `new_enquiries / enquiries`. Also a strict subset, and the one that
      matters to a desk in the morning: how much of the pile nobody has
      touched.

   `admitted` is NOT compared to `enrolled` as a ratio anywhere, though it is
   tempting. 'offered' and 'has a student_id' are two different columns being
   tested, and an application can be enrolled without ever having passed
   through 'offered' in this schema. They sit as stages, never as a fraction.
*/

interface AdmissionsKPIs {
  enquiries: number
  new_enquiries: number
  applications: number
  incomplete: number
  admitted: number
  enrolled: number
  follow_ups_due: number
}

interface EnquiryRow {
  id: string
  student_name: string
  parent_name?: string
  phone: string
  source: string
  status: string
  next_follow_up?: string
  assigned_to?: string
  created_at: string
}

type CellStatus = 'loading' | 'error' | 'ready'

const DAY_MS = 86_400_000

/** A `YYYY-MM-DD` from the server as LOCAL midnight.

    Not `Date.parse`, which reads a bare date as UTC: subtracting a UTC
    midnight from a local one puts the difference out by the offset and rounds
    a day the wrong way. The same helper, for the same reason, as
    FinanceDashboard — copied rather than shared, because a Bento screen may
    not edit anything the classic layout renders and this is not worth a new
    shared module. */
function localMidnight(iso: string | undefined): number | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

function todayMidnight(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const daysBetween = (from: number, to: number) => Math.round((to - from) / DAY_MS)

/** The follow-ups that are actually due, worked out from the rows.

    The KPI carries the COUNT of these and the list carries the rows, and the
    two are asked of the database at slightly different moments. Where the
    board needs names it uses the rows; where it needs the number it uses the
    count — never the length of the list, which is capped at 300 server-side
    and would quietly under-report a desk that has let things pile up.

    'applied' and 'lost' are excluded here to match the KPI's own predicate. A
    list that included them would disagree with the number printed above it. */
interface Overdue {
  rows: { id: string; who: string; days: number }[]
  oldestDays: number
  untouched: number
}

function overdueFollowUps(items: EnquiryRow[]): Overdue {
  const now = todayMidnight()
  const rows: Overdue['rows'] = []
  let oldestDays = 0
  let untouched = 0

  for (const e of items) {
    if (e.status === 'applied' || e.status === 'lost') continue
    if (e.status === 'new') untouched++
    const due = localMidnight(e.next_follow_up)
    if (due === null) continue
    const days = daysBetween(due, now)
    if (days < 0) continue
    if (days > oldestDays) oldestDays = days
    rows.push({ id: e.id, who: e.student_name || e.phone, days })
  }
  // Oldest first: the enquiry nobody has rung in nine days is the one that is
  // about to be lost, and it is not the one at the top of a list sorted by
  // when it arrived.
  rows.sort((a, b) => b.days - a.days)
  return { rows, oldestDays, untouched }
}

/** Where enquiries came from, counted off the rows.

    Exact while the list is short. The list is capped at 300 rows server-side,
    so when it comes back full the cell says how many enquiries the shares
    actually cover rather than implying they describe every one. */
interface Sources {
  labels: string[]
  values: number[]
  covered: number
}

function sources(items: EnquiryRow[]): Sources {
  const tally = new Map<string, number>()
  for (const e of items) {
    const key = (e.source || 'unknown').trim() || 'unknown'
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  return {
    labels: ranked.map(([k]) => k),
    values: ranked.map(([, v]) => v),
    covered: items.length,
  }
}

// --- the shell ----------------------------------------------------------

/** A cell: the kit's ground and cue wrapped around the pattern file's shell.

    The height budget is the whole design of this function, and it is the same
    budget FinanceDashboard works to. A one-row cell is 172px, and a 38px
    figure plus a second header line plus a 34px pill leave the drawing row
    about fifteen pixels — which is the "label, number, empty space" the board
    language exists to stop being. So at one row the figure drops to 26px
    through `--bento-fig`, the sub-line goes, and the cue becomes the compact
    pill. At 1x1 there is no cue at all: 232 usable pixels do not hold both a
    pill and a drawing, and the drawing is the part that carries the meaning. */
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
    container is five times wider than it is tall, so the circle is drawn
    taller than the card and clipped through the middle. A box whose width
    comes from the row's height makes it fit whatever room the row has, at
    every size, with no branch. */
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
    drawn in. Never a zero: "we could not ask" and "there is none" are
    different facts, and a chart drawn at zero states the second while meaning
    the first. */
function Said({ children }: { children: ReactNode }) {
  return (
    <p className="flex h-full min-h-0 items-center text-[length:var(--card-sub,10px)] leading-snug opacity-60">
      {children}
    </p>
  )
}

// --- the cells ----------------------------------------------------------

/** THE ANCHOR — the funnel, and the only dark cell on the page.

    Three stages of ONE table: applications, of which some are offered, of
    which some became students. Nested predicates over the same rows, so the
    funnel is honest — which is why enquiries are not in it. `enquiries` is a
    different table and an application can exist without one, so putting them
    in the same funnel would draw a taper that is not a taper. */
function FunnelCell({
  span, k, href,
}: {
  span: CellSpan
  k: AdmissionsKPIs
  href?: string
}) {
  const t = useT()
  const conversion = k.applications
    ? Math.round((k.enrolled / k.applications) * 100)
    : 0
  return (
    <Card
      span={span}
      dark
      title={t('bento.admissions.funnel')}
      sub={t('bento.admissions.funnel_sub')}
      value={`${conversion}%`}
      change={t('bento.admissions.of_applications', { n: k.applications })}
      to={href}
      cue={t('bento.admissions.cue_applications')}
    >
      {k.applications > 0 ? (
        <Funnel
          stages={[
            { label: t('bento.admissions.stage_applied'), value: k.applications },
            { label: t('bento.admissions.stage_offered'), value: k.admitted },
            { label: t('bento.admissions.stage_enrolled'), value: k.enrolled },
          ]}
          srLabel={t('bento.admissions.funnel_sr')}
          formatValue={(n) => String(n)}
        />
      ) : (
        <Said>{t('bento.admissions.no_applications')}</Said>
      )}
    </Card>
  )
}

/** Follow-ups due, with the names.

    The figure is the KPI's count, not the list's length: the list is capped at
    300 rows server-side, so counting it would under-report exactly the desk
    that has let the most pile up. The rows underneath are what the list is
    for. */
function FollowUpCell({
  span, k, due, status, href,
}: {
  span: CellSpan
  k: AdmissionsKPIs
  due: Overdue
  status: CellStatus
  href?: string
}) {
  const t = useT()
  return (
    <Card
      span={span}
      title={t('bento.admissions.follow_ups')}
      sub={t('bento.admissions.follow_ups_sub')}
      value={k.follow_ups_due}
      change={
        due.oldestDays > 0
          ? t('bento.admissions.oldest_days', { n: due.oldestDays })
          : undefined
      }
      to={href}
      cue={t('bento.admissions.cue_follow_ups')}
    >
      {status === 'error' ? (
        <Said>{t('bento.admissions.list_failed')}</Said>
      ) : status === 'loading' ? (
        <Said>{t('bento.admissions.list_loading')}</Said>
      ) : due.rows.length === 0 ? (
        <Said>{t('bento.admissions.none_overdue')}</Said>
      ) : (
        <Rows
          items={due.rows.slice(0, 6).map((r) => ({ label: r.who, value: r.days }))}
          srLabel={t('bento.admissions.follow_ups_sr')}
          formatValue={(n) => t('bento.admissions.days_short', { n })}
        />
      )}
    </Card>
  )
}

/** The untouched pile.

    `new_enquiries / enquiries` is a strict subset of the same count, so the
    gauge is honest. It is also the morning question: how much of the pile has
    nobody yet rung. */
function NewEnquiriesCell({
  span, k, href,
}: {
  span: CellSpan
  k: AdmissionsKPIs
  href?: string
}) {
  const t = useT()
  return (
    <Card
      span={span}
      title={t('bento.admissions.new_enquiries')}
      sub={t('bento.admissions.new_enquiries_sub')}
      value={k.new_enquiries}
      change={t('bento.admissions.of_enquiries', { n: k.enquiries })}
      to={href}
      cue={t('bento.admissions.cue_enquiries')}
    >
      {k.enquiries > 0 ? (
        <GaugeBox
          value={k.new_enquiries}
          total={k.enquiries}
          srLabel={t('bento.admissions.new_enquiries_sr')}
        />
      ) : (
        <Said>{t('bento.admissions.no_enquiries')}</Said>
      )}
    </Card>
  )
}

/** Applications not finished.

    'draft' over the same rows — a subset, so a gauge. This is the one a desk
    can actually act on: an incomplete application is a family that started and
    stopped, and somebody ringing them is worth more than any new lead. */
function IncompleteCell({
  span, k, href,
}: {
  span: CellSpan
  k: AdmissionsKPIs
  href?: string
}) {
  const t = useT()
  return (
    <Card
      span={span}
      title={t('bento.admissions.incomplete')}
      sub={t('bento.admissions.incomplete_sub')}
      value={k.incomplete}
      change={t('bento.admissions.of_applications', { n: k.applications })}
      to={href}
      cue={t('bento.admissions.cue_incomplete')}
    >
      {k.applications > 0 ? (
        <GaugeBox
          value={k.incomplete}
          total={k.applications}
          srLabel={t('bento.admissions.incomplete_sr')}
        />
      ) : (
        <Said>{t('bento.admissions.no_applications')}</Said>
      )}
    </Card>
  )
}

/** Where the enquiries came from.

    Off the rows rather than the KPI, which does not carry sources at all. Says
    what it covers when the server's cap has bitten, because a share of 300
    rows presented as a share of everything is the kind of wrong that changes
    where a school spends its advertising money. */
function SourceCell({
  span, src, total, status, href,
}: {
  span: CellSpan
  src: Sources
  total: number
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const partial = src.covered > 0 && src.covered < total
  return (
    <Card
      span={span}
      title={t('bento.admissions.sources')}
      sub={t('bento.admissions.sources_sub')}
      value={src.labels.length}
      change={
        partial
          ? t('bento.admissions.sources_partial', { n: src.covered })
          : undefined
      }
      to={href}
      cue={t('bento.admissions.cue_sources')}
    >
      {status === 'error' ? (
        <Said>{t('bento.admissions.list_failed')}</Said>
      ) : status === 'loading' ? (
        <Said>{t('bento.admissions.list_loading')}</Said>
      ) : src.values.length === 0 ? (
        <Said>{t('bento.admissions.no_enquiries')}</Said>
      ) : (
        <Distribution values={src.values} srLabel={t('bento.admissions.sources_sr')} />
      )}
    </Card>
  )
}

/** A plain count, for the stages that are stages and not fractions.

    'offered' is not compared to 'enrolled' as a ratio: they test two different
    columns, and an application can reach a student_id without passing through
    'offered' in this schema. So it is a number with a place in the funnel, and
    the funnel above is where the relationship is shown. */
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

export default function AdmissionsDesk() {
  const t = useT()
  const kpis = useQuery({
    queryKey: ['admissions-dashboard'],
    queryFn: () => api.get<AdmissionsKPIs>('/api/v1/admissions/dashboard'),
  })
  const enquiries = useQuery({
    queryKey: ['admissions-enquiries'],
    queryFn: () => api.get<List<EnquiryRow>>('/api/v1/admissions/enquiries'),
  })

  const enquiriesHref = useFeatureHref('admissions.admissions_workspace.enquiries_leads')
  const followUpsHref = useFeatureHref('admissions.admissions_workspace.follow_ups')
  const applicationsHref = useFeatureHref('admissions.admissions_workspace.applications')
  const offersHref = useFeatureHref('admissions.admissions_workspace.offers_admission_decisions')

  if (kpis.isLoading) return <BentoLoading message={t('bento.admissions.loading')} />
  // Never a zero that is really a failed fetch. "No enquiries" and "we could
  // not ask" send a desk to two different places for the morning.
  if (kpis.error) return <BentoError message={t('bento.admissions.failed')} />

  const k = kpis.data!
  const rows = enquiries.data?.items ?? []
  const listStatus: CellStatus = enquiries.error
    ? 'error'
    : enquiries.isLoading
      ? 'loading'
      : 'ready'
  const due = overdueFollowUps(rows)
  const src = sources(rows)

  return (
    <BentoPage eyebrow={t('bento.admissions.eyebrow')} title={t('bento.admissions.title')}>
      <WidgetLayer dashboard="admissions">
        <Widget id="funnel" label={t('bento.admissions.funnel')} size="large" index={0}>
          {(span) => <FunnelCell span={span} k={k} href={applicationsHref} />}
        </Widget>

        <Widget id="follow-ups" label={t('bento.admissions.follow_ups')} size="small" index={1}>
          {(span) => (
            <FollowUpCell
              span={span}
              k={k}
              due={due}
              status={listStatus}
              href={followUpsHref}
            />
          )}
        </Widget>

        <Widget id="new-enquiries" label={t('bento.admissions.new_enquiries')} size="small" index={2}>
          {(span) => <NewEnquiriesCell span={span} k={k} href={enquiriesHref} />}
        </Widget>

        <Widget id="incomplete" label={t('bento.admissions.incomplete')} size="small" index={3}>
          {(span) => <IncompleteCell span={span} k={k} href={applicationsHref} />}
        </Widget>

        <Widget id="offered" label={t('bento.admissions.offered')} size="small" index={4}>
          {(span) => (
            <CountCell
              span={span}
              title={t('bento.admissions.offered')}
              sub={t('bento.admissions.offered_sub')}
              value={k.admitted}
              note={t('bento.admissions.offered_note')}
              href={offersHref}
              cue={t('bento.admissions.cue_offers')}
            />
          )}
        </Widget>

        <Widget id="sources" label={t('bento.admissions.sources')} size="small" index={5}>
          {(span) => (
            <SourceCell
              span={span}
              src={src}
              total={k.enquiries}
              status={listStatus}
              href={enquiriesHref}
            />
          )}
        </Widget>
      </WidgetLayer>
    </BentoPage>
  )
}
