import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { usePhone } from '@/lib/viewport'
import { cn, formatPaise } from '@/lib/utils'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Compare } from './bento-cards'
import {
  Facts, IN_SCHOOL, PersonaCard, PersonaPage, Say, Split, Part, Titled,
  byMonth, hhmm, useNowMinutes, useShape, type RegisterDay,
} from './persona-kit'
import { Widget } from './WidgetLayer'
import type { ChildBusFeed, ChildBusRow } from '../portal/child-bus'
import { ChildSwitch } from '../portal/ChildSwitch'

/* THE PARENT'S HOME: one child at a time, the important number first.

   Eight cells, every one `PersonaCard` around `CardShell`. The board answers
   the four questions a parent opens the app with — is anything waiting on me,
   is money owed, was my child in, what is happening today — and then the
   things they check less often: homework, the bus, messages, the last result.

   ─────────────────────────────────────────────────────────────────────────
   WHICH CHILD. Read this before changing anything on this screen.
   ─────────────────────────────────────────────────────────────────────────
   A guardian may have more than one child, and this repository has shipped the
   wrong-sibling bug repeatedly. Two rules follow, and both are load-bearing:

     1. `student_id` is sent EXPLICITLY on every request this screen makes.
        Never omitted, never left to the resolver's default — `/portal/summary`
        and `/portal/fees` both answer for the eldest in silence without it.
     2. Every cell carries `who` — the child's first name and form — as the
        card header's own second line. It is short so it reads as a label, not
        a sentence, but it is never dropped.

   The chosen child is remembered under the same key the classic portal uses
   (`portal-last-child`) and carried in the URL, so the attendance screen a
   card opens is about the child the card was about.

   ─── WHERE THE FIGURES COME FROM ─────────────────────────────────────────

     /portal/students          the children, with class, section and roll.
     /portal/summary           attendance counts, homework, the balance, the
                               latest result and today's periods.
     /portal/attendance        ONE ROW PER MARKED DAY for 120 days.
     /portal/fees              every invoice with `net_paise` and `paid_paise`
                               — the only real denominator the money has.
     /attention                what is waiting on the parent.
     /me/child-bus             the bus, if the child travels by one.
     /portal/messages/teachers the teachers who can be written to, with unread.

   Everything past the summary DEGRADES, IT DOES NOT GATE: a cell whose feed
   failed says so, and never falls back to a confident zero.

   ─── THE PHONE ───────────────────────────────────────────────────────────
   The pager hands every cell its DECLARED size — a 2x2 "large" widget still
   reports w=2,h=2 on a 390px phone even though it is drawn one column wide
   and a third of the screen tall. Every drawing here therefore asks
   `shape()` below, which answers 1x1 on a phone regardless, so nothing lays
   out a four-panel split into a box the height of a thumb. */

interface PortalChild {
  student_id: string
  admission_no: string
  full_name: string
  class_name?: string
  section_name?: string
  roll_no?: number
  relation?: string
}
interface TodayPeriod {
  period: string
  starts_at?: string
  ends_at?: string
  subject: string
  teacher?: string
  room?: string
}
interface PortalSummary {
  student_id: string
  full_name: string
  attendance_pct: number
  present_days: number
  total_days: number
  absent_days: number
  homework_due: number
  next_homework_due?: string
  next_homework_title?: string
  outstanding_paise: number
  next_exam?: string
  latest_result_exam?: string
  latest_result_pct?: number
  latest_result_grade?: string
  today?: TodayPeriod[]
}
interface FamilyInvoice {
  invoice_no: string
  instalment_no?: number
  issued_on: string
  due_on?: string
  net_paise: number
  paid_paise: number
  due_paise: number
  fine_paise: number
  status: string
  days_overdue: number
}
interface FamilyFees {
  student_id: string
  student_name: string
  outstanding_paise: number
  invoices: FamilyInvoice[]
}
interface AttentionItem {
  key: string
  severity: string
  headline: string
  detail?: string
  href?: string
  action?: string
}
interface Teacher {
  user_id: string
  full_name: string
  subject?: string
  class_teacher: boolean
  unread: number
}

const LAST_CHILD_KEY = 'portal-last-child'

function rememberedChild(): string | null {
  try {
    return localStorage.getItem(LAST_CHILD_KEY)
  } catch {
    return null
  }
}

function daysUntil(iso: string) {
  return Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
}

/** "25 Sep" — the short date a parent reads on a fridge calendar. */
function shortDate(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

/** The real dimensions on a desktop; 1x1 on a phone, whatever was declared. */
function useCellShape() {
  const shape = useShape()
  const phone = usePhone()
  /* One column always; the height is the one thing a phone card can be
     given. A card set to Tall in the edit sheet takes two of the page's three
     rows, and the drawing may use that depth the way a tall desktop cell does.
     Never wide: nothing on a phone has a neighbour. */
  return phone ? { ...shape, w: 1, h: shape.h >= 2 ? 2 : 1, wide: false, tall: shape.h >= 2, anchor: false } : shape
}

/** "Class 5-A" — the form, without the roll number, for the card label. */
function formOf(c?: PortalChild) {
  if (!c?.class_name) return ''
  return `${c.class_name}${c.section_name ? `-${c.section_name}` : ''}`
}

export default function ParentWeek() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(
    () => params.get('student_id') ?? rememberedChild(),
  )

  const toAttendance = useFeatureHref('parent.attendance.attendance')
  const toFees = useFeatureHref('parent.fees.fees_payments')
  const toHomework = useFeatureHref('parent.academics.homework_academics')
  const toBus = useFeatureHref('parent.my_childs_bus.live_bus_tracking')
  const toMessages = useFeatureHref('parent.messages.direct_teacher_messaging')
  const toResults = useFeatureHref('parent.academics.results_report_cards')
  const toDashboard = useFeatureHref('parent.home.dashboard')

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })

  const kids = children.data?.items ?? []
  const known = selected && kids.some((c) => c.student_id === selected) ? selected : null
  const activeId = known ?? kids[0]?.student_id ?? null
  const child = kids.find((c) => c.student_id === activeId)

  const chooseChild = useCallback((id: string) => {
    setSelected(id)
    try {
      localStorage.setItem(LAST_CHILD_KEY, id)
    } catch {
      /* private window; the URL still carries the choice */
    }
  }, [])

  // The address bar names the child on screen, so a link copied from here
  // opens on the same child. Replace, not push: switching is not a step to
  // press Back through.
  useEffect(() => {
    if (!activeId || params.get('student_id') === activeId) return
    const next = new URLSearchParams(params)
    next.set('student_id', activeId)
    setParams(next, { replace: true })
  }, [activeId, params, setParams])

  const withChild = (href?: string) =>
    href && activeId ? `${href}?student_id=${activeId}` : href

  const summary = useQuery({
    queryKey: ['portal-summary', activeId],
    queryFn: () => api.get<PortalSummary>(`/api/v1/portal/summary?student_id=${activeId}`),
    enabled: !!activeId,
  })
  const attendance = useQuery({
    queryKey: ['portal-attendance', activeId],
    queryFn: () => api.get<List<RegisterDay>>(`/api/v1/portal/attendance?student_id=${activeId}`),
    enabled: !!activeId,
  })
  const ledger = useQuery({
    queryKey: ['portal-fees', activeId],
    queryFn: () => api.get<FamilyFees>(`/api/v1/portal/fees?student_id=${activeId}`),
    enabled: !!activeId,
  })
  const attention = useQuery({
    queryKey: ['attention', 'parent'],
    queryFn: () => api.get<{ items: AttentionItem[] }>('/api/v1/attention'),
  })
  const bus = useQuery({
    queryKey: ['child-bus', 'home'],
    queryFn: () => api.get<ChildBusFeed>('/api/v1/me/child-bus'),
    refetchInterval: 30_000,
  })
  const teachers = useQuery({
    queryKey: ['portal-teachers', activeId],
    queryFn: () => api.get<List<Teacher>>(`/api/v1/portal/messages/teachers?student_id=${activeId}`),
    enabled: !!activeId,
  })

  if (children.isLoading) return <BentoLoading message={t('bento.parent_week.loading')} />
  if (children.error) return <BentoError message={t('bento.parent_week.failed_children')} />

  if (!kids.length) {
    return (
      <PersonaPage eyebrow={t('bento.parent_week.eyebrow')} title={t('bento.parent_week.title')}>
        <div className="rounded-[14px] border bg-card p-5 text-[13.5px] text-muted-foreground sm:col-span-2">
          {t('bento.parent_week.no_link')}
        </div>
      </PersonaPage>
    )
  }

  /* THE SWITCHER: small, obvious, first names.

     A segmented control rather than a row of buttons carrying the full name
     and the relation — "Kabir Gupta · Mother" twice across the top of the
     screen was the loudest thing on the page and said the least. The name is
     in the title; the switcher only has to say "the other one". */
  const switcher = (
    <ChildSwitch
      kids={kids}
      activeId={activeId}
      onChoose={chooseChild}
      label={t('bento.parent_week.switcher_sr')}
      switchLabel={t('bento.parent_week.switch_child')}
    />
  )

  const header = (body: ReactNode, arrange = false) => (
    <PersonaPage
      eyebrow={t('bento.parent_week.eyebrow')}
      title={child?.full_name ?? t('bento.parent_week.title')}
      description={
        [formOf(child), child?.roll_no ? t('bento.common.roll', { roll: child.roll_no }) : null]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      actions={switcher}
      dashboard={arrange ? 'parent_week' : undefined}
    >
      {body}
    </PersonaPage>
  )

  if (summary.isLoading || attendance.isLoading || ledger.isLoading) {
    return header(
      <div className="sm:col-span-2">
        <BentoLoading message={t('bento.parent_week.loading_child', { name: child?.full_name ?? '' })} />
      </div>,
    )
  }
  if (summary.error || !summary.data) {
    return header(
      <div className="sm:col-span-2">
        <BentoError message={t('bento.parent_week.failed_child', { name: child?.full_name ?? '' })} />
      </div>,
    )
  }

  const s = summary.data
  const days: RegisterDay[] | null = attendance.error ? null : (attendance.data?.items ?? [])
  const fees: FamilyFees | null = ledger.error ? null : (ledger.data ?? null)
  const first = s.full_name.split(' ')[0]
  const who = formOf(child) ? `${first} · ${formOf(child)}` : first
  const items = attention.data?.items ?? []
  const busRow = bus.data?.items.find((r) => r.student_id === activeId) ?? null

  return header(
    <>
      <Widget id="attention" label={t('bento.parent_week.attention_label')} size="small" index={0}>
        {(span) => (
          <AttentionCell
            span={span}
            who={who}
            items={items}
            failed={!!attention.error}
            loading={attention.isLoading}
            to={withChild(toDashboard)}
          />
        )}
      </Widget>

      <Widget id="fees" label={t('bento.parent_week.fees_label')} size="small" index={1}>
        {(span) => <FeesCell span={span} who={who} s={s} fees={fees} to={withChild(toFees)} />}
      </Widget>

      <Widget id="week" label={t('bento.parent_week.week_label')} size="medium" index={2}>
        {(span) => <WeekCell span={span} who={who} s={s} days={days} to={withChild(toAttendance)} />}
      </Widget>

      <Widget id="today" label={t('bento.parent_week.today_label')} size="medium" index={3}>
        {(span) => <TodayCell span={span} who={who} s={s} to={withChild(toAttendance)} />}
      </Widget>

      <Widget id="homework" label={t('bento.parent_week.homework_label')} size="small" index={4}>
        {(span) => <HomeworkCell span={span} who={who} s={s} to={withChild(toHomework)} />}
      </Widget>

      {busRow && (
        <Widget id="bus" label={t('bento.parent_week.bus_label')} size="small" index={5}>
          {(span) => <BusCell span={span} who={who} row={busRow} to={toBus} />}
        </Widget>
      )}

      <Widget id="messages" label={t('bento.parent_week.messages_label')} size="small" index={6}>
        {(span) => (
          <MessagesCell
            span={span}
            who={who}
            teachers={teachers.data?.items ?? null}
            failed={!!teachers.error}
            to={withChild(toMessages)}
          />
        )}
      </Widget>

      <Widget id="results" label={t('bento.parent_week.results_label')} size="small" index={7}>
        {(span) => <ResultsCell span={span} who={who} s={s} to={withChild(toResults)} />}
      </Widget>
    </>,
    true,
  )
}

/* ─── NEEDS YOU ────────────────────────────────────────────────────────────

   The reason the app was opened. The figure is how many things are waiting;
   the sentence is the first of them; the drawing lists the rest. The whole
   card opens the first item's screen, because a card cannot hold a link per
   row without nesting links. */
function AttentionCell({
  span, who, items, failed, loading, to,
}: {
  span: CellSpan
  who: string
  items: AttentionItem[]
  failed: boolean
  loading: boolean
  to?: string
}) {
  const t = useT()
  const { tall, wide } = useCellShape()
  const phone = usePhone()
  const top = items[0]
  const lines = phone ? (tall ? 4 : 1) : tall ? 6 : wide ? 3 : 2
  /* THE SENTENCE IS NEVER BLANK.

     Seen on a phone: the figure "1" and nothing under it. The one item had
     a headline with nothing in it, and a card whose sentence is an empty
     string is a card that has said its number and stopped. So the first
     item's headline is used when it has words, its detail when it does not,
     and the count-in-words when neither does. */
  const first = top?.headline?.trim() || top?.detail?.trim() || ''
  const sentence = failed
    ? t('bento.parent_week.attention_unread')
    : items.length === 0
      ? t('bento.parent_week.attention_none')
      : first || t('bento.parent_week.attention_count', { count: items.length })
  /* THE LOWER HALF SAYS SOMETHING TOO.

     With two or more items the drawing lists the rest. With exactly one, it
     used to list nothing, and a card with a figure, a sentence and half a
     tile of air under them reads as unfinished. The one item's detail —
     "Due by 05 Sep" — is the line that belongs there, when it is not already
     the sentence. */
  const rest =
    items.length > 1
      ? items.slice(1, lines + 1).map((i) => ({ key: i.key, text: i.headline?.trim() || i.detail || '', high: i.severity === 'high' || i.severity === 'critical' }))
      : top?.detail && top.detail.trim() !== first
        ? [{ key: top.key, text: top.detail, high: false }]
        : []
  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.attention_label')}
      who={who}
      value={loading ? '…' : failed ? '—' : items.length}
      change={sentence}
      to={top?.href ?? to}
      cueLabel={top?.action ?? t('bento.parent_week.attention_cue')}
    >
      {rest.length > 0 ? (
        <ul className="parent-list" aria-label={t('bento.parent_week.attention_sr')}>
          {rest.filter((i) => i.text).map((i) => (
            <li key={i.key} className="parent-list__row">
              <span className={cn('parent-list__dot', i.high && 'is-high')} aria-hidden="true" />
              <span className="parent-list__text">{i.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </PersonaCard>
  )
}

/* ─── FEES — the one coloured cell, and only while something is owed ───────

   BILLED IS A REAL WHOLE: every non-cancelled invoice arrives with its own
   `net_paise` and `paid_paise`. If the ledger cannot be read, no track is
   drawn — the outstanding figure alone has no denominator. */
export function FeesCell({
  span, who, s, fees, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  fees: FamilyFees | null
  to?: string
}) {
  const t = useT()
  const { tall } = useCellShape()

  const invoices = fees?.invoices ?? []
  const billed = invoices.reduce((a, i) => a + i.net_paise, 0)
  const paid = invoices.reduce((a, i) => a + i.paid_paise, 0)
  const due = fees ? fees.outstanding_paise : s.outstanding_paise
  const open = invoices.filter((i) => i.due_paise > 0).sort((a, b) => b.days_overdue - a.days_overdue)
  const worst = open[0]
  /* OWED MEANS A RUPEE OR MORE, OR A DAY OR MORE LATE.

     Seen on a phone: the card tinted as money owed, headed "Fees
     outstanding", showing ₹0 — an instalment due that same day and a balance
     that rounds to nothing. The tint is the board's one coloured cell and it
     is for the morning something is actually wrong. A remainder under a rupee
     is not that, and neither is a bill that is not late yet, so the card
     stays plain, keeps its "Fees" title, and still names the instalment and
     its date in the sentence — which is the fact worth reading. */
  const overdue = !!worst && worst.days_overdue > 0
  const owed = due >= 100 || overdue

  let change: string
  if (!owed && !worst) change = t('bento.parent_week.fees_settled_short')
  else if (worst && worst.days_overdue > 0)
    change = t('bento.parent_week.fees_overdue', {
      n: worst.instalment_no ?? '',
      days: worst.days_overdue,
    })
  else if (worst?.due_on)
    change = t('bento.parent_week.fees_due_on', {
      n: worst.instalment_no ?? '',
      date: shortDate(worst.due_on),
    })
  else change = t('bento.parent_week.fees_owed_short')

  const facts = [
    fees ? { label: t('bento.parent_week.fact_billed'), value: formatPaise(billed) } : null,
    fees ? { label: t('bento.parent_week.fact_paid'), value: formatPaise(paid) } : null,
    fees && open.length ? { label: t('bento.parent_week.fact_invoices'), value: `${open.length}/${invoices.length}` } : null,
  ].filter((f): f is { label: string; value: string } => f !== null)

  const sr = t('bento.parent_week.fees_sr', {
    name: s.full_name, paid: formatPaise(paid), billed: formatPaise(billed),
  })
  const tracks =
    billed > 0 ? (
      <Compare
        rows={[
          { label: t('bento.parent_week.track_paid'), value: paid },
          { label: t('bento.parent_week.track_due'), value: Math.max(0, billed - paid) },
        ]}
        formatValue={formatPaise}
        srLabel={sr}
      />
    ) : (
      <Say>
        {fees
          ? t('bento.parent_week.no_invoices', { name: s.full_name })
          : t('bento.parent_week.ledger_unread', { name: s.full_name })}
      </Say>
    )

  const drawing = tall ? (
    <Split>
      <Part grow={2}>{tracks}</Part>
      <Part grow={3}><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
    </Split>
  ) : tracks

  return (
    <PersonaCard
      span={span}
      ground={owed ? 'finance' : undefined}
      title={owed ? t('bento.parent_week.fees_label') : t('bento.parent_week.fees_label_clear')}
      who={who}
      value={formatPaise(due)}
      change={change}
      to={to}
      cueLabel={owed ? t('bento.parent_week.fees_pay_cue') : t('bento.parent_week.fees_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}

/* ─── ATTENDANCE — the anchor ──────────────────────────────────────────────

   The register is a real series — one row per marked day — so the drawing is
   the weekly rate, as quiet bars over a baseline rather than a jagged area.
   A week the school marked nothing is left out rather than drawn as nought.

   1x1  eight weeks of bars.
   2x1  sixteen weeks.
   1x2  eight weeks, and the months under them.
   2x2  sixteen weeks beside days present by month. */
export function WeekCell({
  span, who, s, days, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  days: RegisterDay[] | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useCellShape()

  const months = days ? byMonth(days, (d) => IN_SCHOOL.has(d.status), tall ? 6 : 4) : []
  /* The last thirty marked days as a strip: a present day is a faint mark, a
     missed one is full ink. Thirty is about six school weeks, which is the
     window a parent means by "recently". The bars (weekly rate) are kept for
     the wide cell, where sixteen of them have room to read as a series;
     eight bars spread across a phone card read as a barcode. */
  const window = wide ? 60 : 30
  const recent = days ? [...days].sort((a, b) => a.date.localeCompare(b.date)).slice(-window) : []
  const strip = recent.length ? (
    <div className="parent-strip" role="img" aria-label={t('bento.parent_week.strip_sr', { name: s.full_name, count: recent.length })}>
      {recent.map((d) => (
        <span
          key={d.date}
          title={`${shortDate(d.date)} · ${d.status.replace('_', ' ')}`}
          className={cn(
            'parent-strip__day',
            d.status === 'absent' && 'is-absent',
            (d.status === 'late' || d.status === 'half_day') && 'is-part',
            d.status === 'holiday' && 'is-off',
          )}
        />
      ))}
    </div>
  ) : null
  const bars =
    days === null ? (
      <Say>{t('bento.parent_week.register_unread', { name: s.full_name })}</Say>
    ) : days.length === 0 ? null : strip
  const head = wide ? t('bento.parent_week.head_recent_wide') : t('bento.parent_week.head_recent')

  const monthFacts = months.map((m) => ({ label: m.label, value: `${m.value}` }))

  let drawing: ReactNode = strip ? <Titled head={head}>{bars}</Titled> : bars
  if (wide && strip && monthFacts.length) {
    drawing = (
      <Split row>
        <Part grow={3}><Titled head={head}>{bars}</Titled></Part>
        <Part grow={2}>
          <Facts items={monthFacts.slice(tall ? -6 : -2)} srLabel={t('bento.parent_week.months_sr', { name: s.full_name })} />
        </Part>
      </Split>
    )
  } else if (tall && strip && monthFacts.length) {
    drawing = (
      <Split>
        <Part grow={2}><Titled head={head}>{bars}</Titled></Part>
        <Part grow={3}>
          <Facts items={monthFacts.slice(-4)} srLabel={t('bento.parent_week.months_sr', { name: s.full_name })} />
        </Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.week_label')}
      who={who}
      value={s.total_days > 0 ? `${s.attendance_pct}%` : '—'}
      change={
        s.total_days > 0
          ? t('bento.parent_week.week_note_short', {
              present: s.present_days, total: s.total_days, absent: s.absent_days,
            })
          : t('bento.parent_week.no_register', { name: s.full_name })
      }
      to={to}
      cueLabel={t('bento.parent_week.week_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}

/* ─── TODAY — the timetable, read from now ────────────────────────────────

   The figure is the subject happening now (or next); the sentence is its
   time, teacher and room; the drawing is the rest of the day. After the last
   period the card says the day is over rather than pointing at nothing. */
function TodayCell({
  span, who, s, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  to?: string
}) {
  const t = useT()
  const { tall, wide } = useCellShape()
  const now = useNowMinutes()
  const periods = (s.today ?? []).filter((p) => p.subject && p.subject.toLowerCase() !== 'break')

  const current = periods.find((p) => {
    const a = hhmm(p.starts_at)
    const b = hhmm(p.ends_at)
    return a !== null && b !== null && now >= a && now < b
  })
  const next = periods.find((p) => {
    const a = hhmm(p.starts_at)
    return a !== null && a > now
  })
  const over = periods.length > 0 && !current && !next
  const lead = current ?? next
  const state = current ? 'now' : next ? 'next' : 'over'

  const detail = (p: TodayPeriod) =>
    [
      p.starts_at ? `${p.starts_at}${p.ends_at ? `–${p.ends_at}` : ''}` : null,
      p.teacher ?? null,
      p.room ?? null,
    ]
      .filter(Boolean)
      .join(' · ')

  const rest = lead ? periods.filter((p) => p !== lead) : periods
  const phone = usePhone()
  const lines = phone ? 2 : tall ? (wide ? 8 : 6) : wide ? 4 : 3
  const later = lead ? periods.slice(periods.indexOf(lead) + 1) : rest

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.today_label')}
      who={who}
      value={
        periods.length === 0
          ? t('bento.parent_week.today_free')
          : over
            ? t('bento.parent_week.today_over')
            : lead?.subject ?? '—'
      }
      change={
        periods.length === 0
          ? t('bento.parent_week.today_free_note')
          : over
            ? t('bento.parent_week.today_over_note', { count: periods.length })
            : lead
              ? `${state === 'now' ? t('bento.parent_week.today_now') : t('bento.parent_week.today_next')} · ${detail(lead)}`
              : undefined
      }
      to={to}
      cueLabel={t('bento.parent_week.today_cue')}
    >
      {later.length > 0 ? (
        <ul className="parent-list" aria-label={t('bento.parent_week.today_sr', { name: s.full_name })}>
          {later.slice(0, lines).map((p, i) => (
            <li key={`${p.period}-${i}`} className="parent-list__row">
              <span className="parent-list__time">{p.starts_at ?? '—'}</span>
              <span className="parent-list__text">{p.subject}</span>
              {p.room && <span className="parent-list__meta">{p.room}</span>}
            </li>
          ))}
        </ul>
      ) : null}
    </PersonaCard>
  )
}

/* ─── HOMEWORK DUE ────────────────────────────────────────────────────────

   No denominator exists for this one and none is invented. The count, the
   soonest piece and when it is due; the next exam under it, because it is the
   only other dated thing this payload carries. */
export function HomeworkCell({
  span, who, s, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  to?: string
}) {
  const t = useT()
  const { tall } = useCellShape()
  const hwDays = s.next_homework_due ? daysUntil(s.next_homework_due) : undefined

  const when =
    hwDays === undefined
      ? ''
      : hwDays < 0
        ? t('bento.parent_week.days_late', { days: -hwDays })
        : hwDays === 0
          ? t('bento.parent_week.due_today')
          : hwDays === 1
            ? t('bento.parent_week.due_tomorrow')
            : t('bento.parent_week.due_on', { date: shortDate(s.next_homework_due) })

  const facts = [
    s.next_homework_due ? { label: t('bento.parent_week.fact_soonest'), value: shortDate(s.next_homework_due) } : null,
  ].filter((f): f is { label: string; value: string } => f !== null)

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.homework_label')}
      who={who}
      value={s.homework_due}
      change={
        s.homework_due === 0
          ? t('bento.parent_week.homework_none_short')
          : [s.next_homework_title, when].filter(Boolean).join(' · ')
      }
      to={to}
      cueLabel={t('bento.parent_week.homework_cue')}
    >
      {facts.length ? (
        <Facts
          items={facts.slice(0, tall ? 4 : 2)}
          srLabel={t('bento.parent_week.homework_sr', { name: s.full_name, count: s.homework_due })}
        />
      ) : null}
    </PersonaCard>
  )
}

/* ─── THE BUS ─────────────────────────────────────────────────────────────

   Only rendered when the child travels by bus — the board leaves the widget
   out otherwise. The figure is minutes away when the server can say, then
   distance, then the scheduled time; the sentence names the stop. */
function BusCell({
  span, who, row, to,
}: {
  span: CellSpan
  who: string
  row: ChildBusRow
  to?: string
}) {
  const t = useT()
  const { tall } = useCellShape()
  const km = row.metres_away != null ? (row.metres_away / 1000).toFixed(1) : null
  const value =
    row.eta_minutes != null
      ? t('bento.parent_week.bus_min', { min: row.eta_minutes })
      : km
        ? `${km} km`
        : row.scheduled_at ?? '—'
  const change =
    row.state === 'running'
      ? t('bento.parent_week.bus_moving', { stop: row.stop ?? row.route })
      : row.state === 'arrived'
        ? t('bento.parent_week.bus_arrived', { at: row.arrived_at ?? row.scheduled_at ?? '' })
        : row.state === 'stale' || row.state === 'no_signal'
          ? t('bento.parent_week.bus_quiet')
          : t('bento.parent_week.bus_scheduled', { at: row.scheduled_at ?? '—', stop: row.stop ?? row.route })

  const facts = [
    { label: t('bento.parent_week.fact_route'), value: row.route },
    row.registration_no ? { label: t('bento.parent_week.fact_vehicle'), value: row.registration_no } : null,
    row.driver ? { label: t('bento.parent_week.fact_driver'), value: row.driver } : null,
    km ? { label: t('bento.parent_week.fact_away'), value: `${km} km` } : null,
  ].filter((f): f is { label: string; value: string } => f !== null)

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.bus_label')}
      who={who}
      value={value}
      change={change}
      to={to}
      cueLabel={t('bento.parent_week.bus_cue')}
    >
      <Facts items={facts.slice(0, tall ? 4 : 2)} srLabel={t('bento.parent_week.bus_sr', { name: row.student_name })} />
    </PersonaCard>
  )
}

/* ─── MESSAGES ────────────────────────────────────────────────────────────

   Unread notes from the child's teachers, and who they are from. */
function MessagesCell({
  span, who, teachers, failed, to,
}: {
  span: CellSpan
  who: string
  teachers: Teacher[] | null
  failed: boolean
  to?: string
}) {
  const t = useT()
  const { tall } = useCellShape()
  const unread = (teachers ?? []).reduce((a, x) => a + x.unread, 0)
  const from = (teachers ?? []).filter((x) => x.unread > 0)
  const classTeacher = (teachers ?? []).find((x) => x.class_teacher)

  const facts = (from.length ? from : classTeacher ? [classTeacher] : []).map((x) => ({
    label: x.full_name,
    value: x.unread > 0 ? t('bento.parent_week.unread_n', { n: x.unread }) : x.subject ?? '',
  }))

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.messages_label')}
      who={who}
      value={failed ? '—' : teachers === null ? '…' : unread}
      change={
        failed
          ? t('bento.parent_week.messages_unread_failed')
          : unread === 0
            ? t('bento.parent_week.messages_none')
            : t('bento.parent_week.messages_from', { name: from[0]?.full_name ?? '' })
      }
      to={to}
      cueLabel={t('bento.parent_week.messages_cue')}
    >
      {facts.length ? (
        <Facts items={facts.slice(0, tall ? 4 : 2)} srLabel={t('bento.parent_week.messages_sr')} />
      ) : null}
    </PersonaCard>
  )
}

/* ─── THE LAST RESULT ─────────────────────────────────────────────────────

   A result that exists beats an exam that is coming: once marks are out the
   figure is the percentage; until then the card names the next exam. */
function ResultsCell({
  span, who, s, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  to?: string
}) {
  const t = useT()
  const { tall } = useCellShape()
  const has = s.latest_result_pct != null
  const facts = [
    has && s.latest_result_exam ? { label: t('bento.parent_week.fact_which'), value: s.latest_result_exam } : null,
    has && s.latest_result_grade ? { label: t('bento.parent_week.fact_grade'), value: s.latest_result_grade } : null,
  ].filter((f): f is { label: string; value: string } => f !== null)

  return (
    <PersonaCard
      span={span}
      title={has ? t('bento.parent_week.results_label') : t('bento.parent_week.next_exam_label')}
      who={who}
      value={has ? `${s.latest_result_pct!.toFixed(1)}%` : s.next_exam ?? '—'}
      change={
        s.next_exam
          ? t('bento.parent_week.next_exam_note', { exam: s.next_exam })
          : has
            ? s.latest_result_exam
            : t('bento.parent_week.results_none')
      }
      to={to}
      cueLabel={t('bento.parent_week.results_cue')}
    >
      {facts.length ? (
        <Facts items={facts.slice(0, tall ? 3 : 2)} srLabel={t('bento.parent_week.results_sr', { name: s.full_name })} />
      ) : null}
    </PersonaCard>
  )
}
