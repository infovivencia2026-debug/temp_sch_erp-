import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Bars, Compare, Distribution, Gauge, Rows, Scale, Segments } from './bento-cards'
import {
  Facts, Part, PersonaCard, PersonaPage, Say, Split, Titled,
  cut, hhmm, lengthOf, mins, useNowMinutes, useShape,
} from './persona-kit'
import { Widget } from './WidgetLayer'

/* TODAY'S CLASSES, IN THE EDITORIAL CARD LANGUAGE.

   Five cells, every one of them `PersonaCard` around `CardShell` — header,
   figure, drawing, the drawing taking every pixel the figure did not — and
   every drawing one of the twelve in `bento-cards.tsx`.
   docs/BENTO_CARD_PATTERNS.md is the contract. Nothing here names a colour.

   SCOPE. Every figure is teacher-scoped by the server, not by this file:
   `/api/v1/teaching/today` filters on `teacher_user_id = the caller`,
   `/api/v1/teaching/classes` goes through the assigned-classes scope resolver,
   and `/api/v1/teaching/my-work` answers only for the signed-in teacher.

   ─── WHAT THE HANDLERS ACTUALLY RETURN ───────────────────────────────────

   Read from internal/api/role_scoped.go and internal/api/faculty_work.go, not
   from the interfaces below — the interfaces are a description and the
   handlers are the fact, and two of these three were declaring fewer fields
   than the server sends.

     /teaching/today    one row per timetabled lesson today, ordered by period
                        sequence, each with BOTH bell times as 'HH:MM' and its
                        own `attendance_marked`. So: a real per-lesson length,
                        a real position in the day, a real marked flag.
     /teaching/classes  one row per section this teacher teaches, with a real
                        `enrolled` head count and `marked_today`.
     /teaching/my-work  five kinds of item, each with `count`, and — not in the
                        old interface — `title`, `detail` and `due`.

   THE DENOMINATORS ON THIS BOARD, AND THEY ARE ALL REAL. Registers in is out
   of today's lessons, which arrived in the same payload. Registers taken is
   out of the sections this teacher teaches, likewise. Nothing else here is
   drawn as a share of anything: the outstanding queue is a count with no
   population, and it is drawn as a COMPOSITION by kind, whose parts sum back
   to the figure printed above them.

   THE UNITS ON `my-work` ARE NOT ONE UNIT. Eleven missing marks, one cover
   lesson and four notices are not sixteen of anything. So the only ranking
   drawn from it partitions the total by kind and says so; nothing declares a
   winner across kinds.

   WHAT EACH SIZE ADDS, and it is a ladder rather than four variations. It
   branches on the real WIDTH and HEIGHT, never on area: a wide cell buys marks
   along a row and a tall one buys rows, and a cell that folded the two into an
   area would draw the same thing at 2x1 and 1x2. */

type Translate = ReturnType<typeof useT>

interface TodayClass {
  entry_id: string
  section_id: string
  section_name: string
  class_name: string
  subject_name: string
  period_name: string
  starts_at: string
  ends_at: string
  room?: string
  attendance_marked: boolean
}
interface MyClass {
  section_id: string
  section_name: string
  class_name: string
  room?: string
  enrolled: number
  marked_today: boolean
}
/** Every field faculty_work.go puts on a row. `title`, `detail` and `due` were
    missing here and are what the due-date drawing is made of. */
interface WorkItem {
  kind: string
  title: string
  detail: string
  count: number
  due?: string
  overdue: boolean
}
interface MyWorkView {
  items: WorkItem[]
  outstanding: number
  sections: number
}

const where = (c: TodayClass) => `${c.class_name}-${c.section_name}`

/** The five kinds the handler emits, in words. An unknown kind falls through
    to its own key rather than to a blank: a probe added server-side should
    look unlabelled, not look like nothing. */
function kindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'submissions': return t('bento.faculty_today.kind_submissions')
    case 'marks': return t('bento.faculty_today.kind_marks')
    case 'substitution': return t('bento.faculty_today.kind_substitution')
    case 'leave': return t('bento.faculty_today.kind_leave')
    case 'announcement': return t('bento.faculty_today.kind_announcement')
    default: return kind
  }
}

/** Totals by key, in first-seen order rather than by size, so a row does not
    reshuffle itself between two visits to the same board. */
function tally<T>(rows: T[], key: (r: T) => string, weight: (r: T) => number) {
  const order: string[] = []
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = key(r)
    if (!m.has(k)) order.push(k)
    m.set(k, (m.get(k) ?? 0) + weight(r))
  }
  return order.map((k) => ({ label: k, value: m.get(k) ?? 0 }))
}

const DAY_MS = 86_400_000
function localMidnight(): number {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
}
/** Positive = falls due in that many days. Negative = that many days late. */
function daysOut(due: string | undefined, midnight: number): number | null {
  if (!due) return null
  const ms = Date.parse(`${due}T00:00:00`)
  if (!Number.isFinite(ms)) return null
  return Math.round((ms - midnight) / DAY_MS)
}

export default function FacultyToday() {
  const t = useT()
  const now = useNowMinutes()

  const toRegister = useFeatureHref('faculty.attendance.take_attendance')
  const toWork = useFeatureHref('faculty.home.my_work')
  const toClasses = useFeatureHref('faculty.my_classes.my_classes')
  const toTimetable = useFeatureHref('faculty.timetable.my_timetable')

  const today = useQuery({
    queryKey: ['teaching-today'],
    queryFn: () => api.get<List<TodayClass>>('/api/v1/teaching/today'),
  })
  const classes = useQuery({
    queryKey: ['teaching-classes'],
    queryFn: () => api.get<List<MyClass>>('/api/v1/teaching/classes'),
  })
  const work = useQuery({
    queryKey: ['my-work'],
    queryFn: () => api.get<MyWorkView>('/api/v1/teaching/my-work'),
  })

  if (today.isLoading || classes.isLoading || work.isLoading) {
    return <BentoLoading message={t('bento.faculty_today.loading')} />
  }
  /* "Nothing waiting on you" read off a failed request is worse than a blank
     page: it is a teacher told the registers are in when they are not. */
  if (today.error || classes.error || work.error || !work.data) {
    return <BentoError message={t('bento.faculty_today.failed')} />
  }

  const lessons = today.data?.items ?? []
  const mine = classes.data?.items ?? []
  const w = work.data

  const idxNow = lessons.findIndex((c) => {
    const a = hhmm(c.starts_at)
    const b = hhmm(c.ends_at)
    return a !== null && b !== null && now >= a && now < b
  })
  const idxNext = lessons.findIndex((c) => {
    const a = hhmm(c.starts_at)
    return a !== null && a > now
  })
  const current = idxNow >= 0 ? lessons[idxNow] : undefined
  const next = idxNext >= 0 ? lessons[idxNext] : undefined
  const focus = current ?? next
  const finished = lessons.length > 0 && !focus

  const marked = lessons.filter((c) => c.attendance_marked).length

  return (
    <PersonaPage
      eyebrow={t('bento.faculty_today.eyebrow')}
      title={t('bento.faculty_today.title')}
      description={t('bento.faculty_today.description', { count: lessons.length })}
      dashboard="faculty_today"
    >
      <Widget id="now" label={t('bento.faculty_today.now_label')} size="large" index={0}>
        {(span) => (
          <NowCell
            span={span} lessons={lessons} now={now}
            idxNow={idxNow} current={current} next={next} focus={focus}
            finished={finished} marked={marked} to={toRegister}
          />
        )}
      </Widget>

      <Widget id="marked" label={t('bento.faculty_today.marked_label')} size="small" index={1}>
        {(span) => (
          <MarkedCell span={span} lessons={lessons} mine={mine} marked={marked} to={toRegister} />
        )}
      </Widget>

      <Widget id="work" label={t('bento.faculty_today.work_label')} size="small" index={2}>
        {(span) => <WorkCell span={span} data={w} to={toWork} />}
      </Widget>

      <Widget id="sections" label={t('bento.faculty_today.sections_label')} size="small" index={3}>
        {(span) => <SectionsCell span={span} mine={mine} to={toClasses} />}
      </Widget>

      <Widget id="lessons" label={t('bento.faculty_today.lessons_label')} size="small" index={4}>
        {(span) => <LessonsCell span={span} lessons={lessons} idxNow={idxNow} to={toTimetable} />}
      </Widget>
    </PersonaPage>
  )
}

/* ─── THE ANCHOR: the lesson happening now ────────────────────────────────

   The figure is the SUBJECT, because that is what a teacher opens this page at
   08:02 to read, and the change line is the room, the bell and whether the
   register is in. The drawing is where in the day that lesson sits.

   1x1  `Scale` — now, placed between the first bell and the last. One value in
        a real range: both ends came off the timetable.
   2x1  `Bars` — one bar per lesson, its height the lesson's real LENGTH in
        minutes, the current lesson the filled one. The width buys a mark per
        lesson, which a 1x1 has no room for.
   1x2  `Scale`, and under it the day's real figures. The height buys rows.
   2x2  `Bars` and the figures together.

   Lengths, not a count of equal blocks: `starts_at` and `ends_at` both arrive
   on every row, so the bars carry a measurement. A lesson missing either bell
   is left out of the drawing and named in the figures — a period with no time
   on it has no length, and assuming the school's usual one would be a number
   this response never carried. */
export function NowCell({
  span, lessons, now, idxNow, current, next, focus, finished, marked, to,
}: {
  span: CellSpan
  lessons: TodayClass[]
  now: number
  idxNow: number
  current?: TodayClass
  next?: TodayClass
  focus?: TodayClass
  finished: boolean
  marked: number
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const timed = lessons
    .map((c) => ({ c, len: lengthOf(c.starts_at, c.ends_at) }))
    .filter((x): x is { c: TodayClass; len: number } => x.len !== null)
  const starts = lessons.map((c) => hhmm(c.starts_at)).filter((n): n is number => n !== null)
  const ends = lessons.map((c) => hhmm(c.ends_at)).filter((n): n is number => n !== null)
  const first = starts.length ? Math.min(...starts) : null
  const last = ends.length ? Math.max(...ends) : null
  const teaching = timed.reduce((a, x) => a + x.len, 0)

  const value = lessons.length === 0
    ? t('bento.faculty_today.no_lessons')
    : finished
      ? t('bento.faculty_today.finished')
      : focus!.subject_name
  const change = lessons.length === 0
    ? t('bento.faculty_today.no_lessons_note')
    : finished
      ? t('bento.faculty_today.finished_note', { marked, count: lessons.length })
      : [
          where(focus!) + (focus!.room ? ` · ${focus!.room}` : ''),
          current
            ? t('bento.faculty_today.until', { period: focus!.period_name, ends: focus!.ends_at })
            : t('bento.faculty_today.starts', { period: focus!.period_name, at: focus!.starts_at }),
          focus!.attendance_marked
            ? t('bento.faculty_today.register_in')
            : t('bento.faculty_today.register_out'),
        ].join(' · ')

  const facts = cut(
    [
      first !== null ? { label: t('bento.faculty_today.fact_first'), value: fmtMin(first) } : null,
      last !== null ? { label: t('bento.faculty_today.fact_last'), value: fmtMin(last) } : null,
      timed.length ? { label: t('bento.faculty_today.fact_teaching'), value: mins(teaching) } : null,
      { label: t('bento.faculty_today.fact_registers'), value: `${marked}/${lessons.length}` },
      next ? { label: t('bento.faculty_today.fact_next'), value: next.starts_at } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 5 : 3,
  )

  const rail =
    first !== null && last !== null && last > first ? (
      <Scale
        value={now} min={first} max={last}
        srLabel={t('bento.faculty_today.rail_sr', { first: fmtMin(first), last: fmtMin(last) })}
      />
    ) : (
      <Say>{t('bento.faculty_today.no_bells')}</Say>
    )

  const bars = timed.length ? (
    <Bars
      values={timed.map((x) => x.len)}
      activeIndex={idxNow >= 0 ? timed.findIndex((x) => x.c.entry_id === lessons[idxNow].entry_id) : undefined}
      srLabel={t('bento.faculty_today.bars_sr', { count: timed.length, total: mins(teaching) })}
    />
  ) : (
    <Say>{t('bento.faculty_today.no_bells')}</Say>
  )

  let drawing: ReactNode = rail
  if (wide && tall) {
    drawing = (
      <Split>
        <Part grow={3}><Titled head={t('bento.faculty_today.head_day')}>{bars}</Titled></Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  } else if (wide) {
    drawing = <Titled head={t('bento.faculty_today.head_day')}>{bars}</Titled>
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={2}><Titled head={t('bento.faculty_today.head_now')}>{rail}</Titled></Part>
        <Part grow={3}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={current ? t('bento.faculty_today.now_label') : t('bento.faculty_today.next_label')}
      glyph="◷"
      value={value}
      change={change}
      to={to}
      cueLabel={t('bento.faculty_today.now_cue')}
    >
      {lessons.length === 0 ? <Say>{t('bento.faculty_today.no_lessons_note')}</Say> : drawing}
    </PersonaCard>
  )
}

/** 525 → "08:45". */
function fmtMin(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

/* ─── REGISTERS IN — the one coloured cell ─────────────────────────────────

   A proportion whose shape is the point, and the denominator is real: today's
   lessons, which arrived in the same payload as the marked flags.

   1x1  `Compare` — two tracks against one scale, in and outstanding. A ring is
        NOT drawn here: `Gauge` is an aspect-square sized off the drawing row's
        WIDTH, and on a one-row cell that row is about seventy pixels, so the
        bottom third of a 104px ring is cut off by the cell's own overflow.
   2x1  the same two tracks, and the figures beside them.
   1x2  the height buys the ring, over the figures.
   2x2  the ring, and beside it the pupils waiting on each register still to be
        taken — a real head count per lesson, joined from `/teaching/classes`,
        in one unit down the whole column. */
export function MarkedCell({
  span, lessons, mine, marked, to,
}: {
  span: CellSpan
  lessons: TodayClass[]
  mine: MyClass[]
  marked: number
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()
  const unmarked = lessons.length - marked

  const heads = new Map(mine.map((c) => [c.section_id, c.enrolled]))
  const waiting = lessons
    .filter((c) => !c.attendance_marked && heads.has(c.section_id))
    .map((c) => ({ label: `${c.period_name} ${where(c)}`, value: heads.get(c.section_id) ?? 0 }))
  const pupils = waiting.reduce((a, r) => a + r.value, 0)

  const facts = cut(
    [
      { label: t('bento.faculty_today.fact_lessons'), value: String(lessons.length) },
      { label: t('bento.faculty_today.fact_in'), value: String(marked) },
      { label: t('bento.faculty_today.fact_out'), value: String(unmarked) },
      waiting.length ? { label: t('bento.faculty_today.fact_waiting'), value: String(pupils) } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 4 : 3,
  )

  const tracks = (
    <Compare
      rows={[
        { label: t('bento.faculty_today.track_in'), value: marked },
        { label: t('bento.faculty_today.track_out'), value: unmarked },
      ]}
      srLabel={t('bento.faculty_today.marked_sr', { marked, count: lessons.length })}
    />
  )
  const ring = (
    <Gauge
      value={marked} total={lessons.length}
      srLabel={t('bento.faculty_today.marked_sr', { marked, count: lessons.length })}
    />
  )

  let drawing: ReactNode = tracks
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={2}>{ring}</Part>
        <Part grow={3}>
          {waiting.length ? (
            <Titled head={t('bento.faculty_today.head_waiting')}>
              <Rows items={cut(waiting, 5)} srLabel={t('bento.faculty_today.waiting_sr', { pupils })} />
            </Titled>
          ) : (
            <Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} />
          )}
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{tracks}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{ring}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      ground="attendance"
      title={t('bento.faculty_today.marked_label')}
      glyph="✓"
      value={`${marked}/${lessons.length}`}
      change={
        lessons.length === 0
          ? t('bento.faculty_today.lessons_none')
          : unmarked === 0
            ? t('bento.faculty_today.marked_all')
            : t('bento.faculty_today.marked_left', { count: unmarked })
      }
      to={to}
      cueLabel={t('bento.faculty_today.marked_cue')}
    >
      {lessons.length === 0 ? <Say>{t('bento.faculty_today.lessons_none')}</Say> : drawing}
    </PersonaCard>
  )
}

/* ─── OUTSTANDING ON YOU ──────────────────────────────────────────────────

   A count with NO population in the response, so nothing here is a share of
   anything. It is drawn as a COMPOSITION by kind — the parts sum back to the
   figure printed above them, which is the one honest reading of a total whose
   units differ between rows.

   1x1  `Rows` — the three largest kinds.
   2x1  the same, and the figures beside them.
   1x2  all five kinds, the height buying the rows.
   2x2  both, and a `Distribution` of when the DATED work falls due. Only marks
        and cover carry a due date; the rest are counted and named as undated
        rather than dropped into a band they were never given. */
export function WorkCell({ span, data, to }: { span: CellSpan; data: MyWorkView; to?: string }) {
  const t = useT()
  const { wide, tall } = useShape()

  /* Counted exactly as the handler counts `outstanding`: every item's count,
     except a leave request already decided. Any other rule here would draw
     parts that do not sum to the figure above them. */
  const queue = data.items.filter((i) => i.kind !== 'leave' || i.overdue)
  const segments = tally(queue, (i) => kindLabel(t, i.kind), (i) => i.count)
  const overdueRows = queue.filter((i) => i.overdue).length

  const midnight = localMidnight()
  const dated = queue.map((i) => daysOut(i.due, midnight)).filter((d): d is number => d !== null)
  const bands = [
    dated.filter((d) => d < 0).length,
    dated.filter((d) => d === 0).length,
    dated.filter((d) => d >= 1 && d <= 7).length,
    dated.filter((d) => d > 7).length,
  ]

  const facts = cut(
    [
      { label: t('bento.faculty_today.fact_kinds'), value: String(segments.length) },
      { label: t('bento.faculty_today.fact_rows'), value: String(queue.length) },
      { label: t('bento.faculty_today.fact_late'), value: String(overdueRows) },
      { label: t('bento.faculty_today.fact_sections'), value: String(data.sections) },
    ],
    tall ? 4 : 3,
  )

  /* WHAT THE DAY IS MADE OF, as one bar rather than a ranked list.

     These segments are shares of a single whole — every piece of work waiting
     on this teacher, split by kind — and `Rows` drew them as four independent
     bars on a shared scale, which is the drawing for "which is biggest", not
     for "what is it made of". A segmented bar with a legend answers the second
     question in a third of the height, and it is the drawing the reference
     uses for exactly this shape of data.

     The fallback to `Rows` is not laziness: at one column the legend wraps to
     four lines and the bar itself is 60px, so the shares stop being
     distinguishable and a ranked list says more. */
  const kinds = segments.length ? (
    <Titled head={t('bento.faculty_today.head_kinds')}>
      {wide ? (
        <Segments parts={segments} srLabel={t('bento.faculty_today.kinds_sr')} />
      ) : (
        <Rows items={tall ? segments : cut(segments, 3)} srLabel={t('bento.faculty_today.kinds_sr')} />
      )}
    </Titled>
  ) : (
    <Say>{t('bento.faculty_today.work_none')}</Say>
  )

  let drawing: ReactNode = kinds
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={3}>{kinds}</Part>
        <Part grow={2}>
          <Split>
            <Part>
              {dated.length ? (
                <Titled head={t('bento.faculty_today.head_due')}>
                  <Distribution values={bands} srLabel={t('bento.faculty_today.due_sr')} />
                </Titled>
              ) : (
                <Say>{t('bento.faculty_today.no_dates')}</Say>
              )}
            </Part>
            <Part><Facts items={cut(facts, 3)} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
          </Split>
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{kinds}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{kinds}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.faculty_today.work_label')}
      glyph="≡"
      value={data.outstanding}
      change={
        data.outstanding === 0
          ? t('bento.faculty_today.work_none')
          : overdueRows > 0
            ? t('bento.faculty_today.work_overdue', { count: overdueRows })
            : t('bento.faculty_today.work_some')
      }
      to={to}
      cueLabel={t('bento.faculty_today.work_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}

/* ─── SECTIONS YOU TEACH ──────────────────────────────────────────────────

   `enrolled` is a real head count per section, so the sections rank against
   each other in one unit, and `marked_today` gives a second real denominator:
   registers taken out of sections taught.

   1x1  `Rows` — the three biggest sections by roll.
   2x1  the same, and the figures beside them.
   1x2  every section, the height buying the rows.
   2x2  every section, and beside them the day's registers against the sections
        they are owed for. */
export function SectionsCell({ span, mine, to }: { span: CellSpan; mine: MyClass[]; to?: string }) {
  const t = useT()
  const { wide, tall } = useShape()

  const rows = mine
    .map((c) => ({ label: `${c.class_name}-${c.section_name}`, value: c.enrolled }))
    .sort((a, b) => b.value - a.value)
  const enrolled = mine.reduce((n, c) => n + c.enrolled, 0)
  const takenToday = mine.filter((c) => c.marked_today).length

  const facts = cut(
    [
      { label: t('bento.faculty_today.fact_sections'), value: String(mine.length) },
      { label: t('bento.faculty_today.fact_pupils'), value: String(enrolled) },
      rows.length ? { label: t('bento.faculty_today.fact_largest'), value: `${rows[0].label} · ${rows[0].value}` } : null,
      rows.length ? { label: t('bento.faculty_today.fact_smallest'), value: `${rows[rows.length - 1].label} · ${rows[rows.length - 1].value}` } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 4 : 3,
  )

  const roll = rows.length ? (
    <Titled head={t('bento.faculty_today.head_roll')}>
      <Rows
        items={cut(rows, tall ? 6 : 3)}
        srLabel={t('bento.faculty_today.roll_sr', { count: mine.length, pupils: enrolled })}
      />
    </Titled>
  ) : (
    <Say>{t('bento.faculty_today.sections_none')}</Say>
  )

  let drawing: ReactNode = roll
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={3}>{roll}</Part>
        <Part grow={2}>
          <Split>
            <Part>
              <Titled head={t('bento.faculty_today.head_taken')}>
                <Compare
                  rows={[
                    { label: t('bento.faculty_today.track_taken'), value: takenToday },
                    { label: t('bento.faculty_today.track_owed'), value: mine.length - takenToday },
                  ]}
                  srLabel={t('bento.faculty_today.taken_sr', { taken: takenToday, count: mine.length })}
                />
              </Titled>
            </Part>
            <Part><Facts items={cut(facts, 2)} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
          </Split>
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{roll}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{roll}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.faculty_today.sections_label')}
      glyph="⌗"
      value={mine.length}
      change={t('bento.faculty_today.sections_note', { count: enrolled })}
      to={to}
      cueLabel={t('bento.faculty_today.sections_cue')}
    >
      {mine.length === 0 ? <Say>{t('bento.faculty_today.sections_none')}</Say> : drawing}
    </PersonaCard>
  )
}

/* ─── LESSONS TODAY ───────────────────────────────────────────────────────

   The day's teaching load, in minutes, which is what both bell times on every
   row make measurable. Two different partitions of the same real total, so the
   two drawings are not the same drawing twice.

   1x1  `Facts` — the bells and the minutes. A count with no whole to be a
        share of, so no ring and no track: the honest small drawing is the
        other real figures around it.
   2x1  `Rows` — minutes by subject, and the figures beside them.
   1x2  the same, all subjects, stacked.
   2x2  minutes by subject AND by class, the second partition the width buys. */
export function LessonsCell({
  span, lessons, idxNow, to,
}: {
  span: CellSpan
  lessons: TodayClass[]
  idxNow: number
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const timed = lessons
    .map((c) => ({ c, len: lengthOf(c.starts_at, c.ends_at) }))
    .filter((x): x is { c: TodayClass; len: number } => x.len !== null)
  const teaching = timed.reduce((a, x) => a + x.len, 0)
  const starts = lessons.map((c) => hhmm(c.starts_at)).filter((n): n is number => n !== null)
  const ends = lessons.map((c) => hhmm(c.ends_at)).filter((n): n is number => n !== null)
  const first = starts.length ? Math.min(...starts) : null
  const last = ends.length ? Math.max(...ends) : null
  /* The gaps between lessons, not "free periods": this response carries the
     lessons this teacher has and says nothing about what else is in those
     minutes. Only the span between the first bell and the last is measured. */
  const between = first !== null && last !== null ? Math.max(0, last - first - teaching) : null

  const bySubject = tally(timed, (x) => x.c.subject_name, (x) => x.len)
    .sort((a, b) => b.value - a.value)
  const byClass = tally(timed, (x) => where(x.c), (x) => x.len).sort((a, b) => b.value - a.value)

  const facts = cut(
    [
      first !== null ? { label: t('bento.faculty_today.fact_first'), value: fmtMin(first) } : null,
      last !== null ? { label: t('bento.faculty_today.fact_last'), value: fmtMin(last) } : null,
      timed.length ? { label: t('bento.faculty_today.fact_teaching'), value: mins(teaching) } : null,
      between !== null ? { label: t('bento.faculty_today.fact_between'), value: mins(between) } : null,
      idxNow >= 0 ? { label: t('bento.faculty_today.fact_period'), value: lessons[idxNow].period_name } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 5 : 3,
  )

  const subjects = bySubject.length ? (
    <Titled head={t('bento.faculty_today.head_subject')}>
      <Rows
        items={cut(bySubject, tall ? 6 : 3)}
        formatValue={mins}
        srLabel={t('bento.faculty_today.subject_sr', { total: mins(teaching) })}
      />
    </Titled>
  ) : (
    <Say>{t('bento.faculty_today.no_bells')}</Say>
  )

  let drawing: ReactNode = <Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} />
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part>{subjects}</Part>
        <Part>
          <Titled head={t('bento.faculty_today.head_class')}>
            <Rows
              items={cut(byClass, 6)}
              formatValue={mins}
              srLabel={t('bento.faculty_today.class_sr', { total: mins(teaching) })}
            />
          </Titled>
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{subjects}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{subjects}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.faculty_today.facts_sr')} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.faculty_today.lessons_label')}
      glyph="▤"
      value={lessons.length}
      change={
        lessons.length === 0
          ? t('bento.faculty_today.lessons_none')
          : t('bento.faculty_today.lessons_note', {
              first: lessons[0].starts_at,
              last: lessons[lessons.length - 1].ends_at,
            })
      }
      to={to}
      cueLabel={t('bento.faculty_today.lessons_cue')}
    >
      {lessons.length === 0 ? <Say>{t('bento.faculty_today.lessons_none')}</Say> : drawing}
    </PersonaCard>
  )
}
