import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, formatPaise } from '@/lib/utils'
import { BentoError, BentoLoading, Meter, useFeatureHref } from './bento-kit'
import { DotStrip, Figure, PersonaPage, WhoCell } from './persona-kit'
import { Widget } from './WidgetLayer'

/* The child's week, in the Bento language.

   ─────────────────────────────────────────────────────────────────────────
   WHICH CHILD. Read this before changing anything on this screen.
   ─────────────────────────────────────────────────────────────────────────
   A guardian may have more than one child, and this repository has shipped the
   wrong-sibling bug repeatedly — a counselling message that reached the wrong
   family, a hall-ticket code for the wrong sibling, a goal with no name on it.
   Two resolvers exist and mean opposite things by a missing `student_id`:
   `familyChildren` answers for every child the caller owns, `whichChild`
   silently answers for the eldest. So a dashboard that omits the id does not
   show "the family" — it shows one child, unlabelled, which is the worst of
   the three possibilities, because it is the one nobody can see is wrong.

   Two rules follow, and both are load-bearing:

     1. `student_id` is sent EXPLICITLY on every request this screen makes.
        Never omitted, never left to the resolver's default.
     2. Every cell carries `who` — the child's name and form. There is no cell
        on this screen whose subject a parent has to infer, and there must
        never be one. If you add a cell and cannot say whose figure it holds,
        the cell is wrong, not the rule.

   The switcher follows portal/Portal.tsx exactly, including its default of the
   first child, so a family that flips the layout switch finds the same child
   selected on both sides of it. What Bento adds is that the name never leaves
   the screen: the title, the description, and every one of the five cells says
   it, so the default being the eldest can never pass as "the family's".

   RE-LAID-OUT, NOT RE-FETCHED. `/api/v1/portal/students`,
   `/api/v1/portal/summary` and `/api/v1/portal/attendance` are the three calls
   the classic parent home already makes. No handler was added.

   LEFT OUT ON PURPOSE: `next_exam` (the summary carries the field but this
   school's demo data has none, and a cell that reads "—" is a cell that has
   nothing to say) and the "needs attention" reminders, which are their own
   screen with their own query — the cue belongs on a cell, not a second copy
   of that screen inlined here. */

interface PortalChild {
  student_id: string
  admission_no: string
  full_name: string
  class_name?: string
  section_name?: string
  roll_no?: number
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
}
interface AttendanceDay {
  date: string
  status: string
}

/* The same status colours the classic register uses, so a parent who switches
   layouts is not asked to learn a second legend. Tokens only — `--success`,
   `--warning` and `--destructive` were each darkened this month to clear
   4.5:1 against a light card, which is the only ground they appear on here. */
const DOT: Record<string, string> = {
  present: 'bg-success',
  late: 'bg-warning',
  absent: 'bg-destructive',
  half_day: 'bg-warning/60',
  leave: 'bg-muted-foreground/40',
  holiday: 'bg-border',
}

function daysUntil(iso: string) {
  return Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
}

export default function ParentWeek() {
  const t = useT()
  const [selected, setSelected] = useState<string | null>(null)

  const toAttendance = useFeatureHref('parent.attendance.attendance')
  const toFees = useFeatureHref('parent.fees.fees_payments')
  const toHomework = useFeatureHref('parent.academics.homework_academics')

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })

  const kids = children.data?.items ?? []
  const activeId = selected ?? kids[0]?.student_id ?? null
  const child = kids.find((c) => c.student_id === activeId)

  const summary = useQuery({
    queryKey: ['portal-summary', activeId],
    /* Named explicitly. The endpoint resolves the eldest when the id is
       absent, so omitting it makes the switcher change nothing and prints one
       child's balance under another child's name. */
    queryFn: () => api.get<PortalSummary>(`/api/v1/portal/summary?student_id=${activeId}`),
    enabled: !!activeId,
  })
  const attendance = useQuery({
    queryKey: ['portal-attendance', activeId],
    queryFn: () => api.get<List<AttendanceDay>>(`/api/v1/portal/attendance?student_id=${activeId}`),
    enabled: !!activeId,
  })

  if (children.isLoading) return <BentoLoading message={t('bento.parent_week.loading')} />
  if (children.error) return <BentoError message={t('bento.parent_week.failed_children')} />

  /** "Grade 6-A · Roll 2" — blank parts drop out rather than leaving stray
   *  separators, because a child admitted last week has no roll number yet. */
  const form = (c?: PortalChild) =>
    !c
      ? ''
      : [
          c.class_name ? `${c.class_name}${c.section_name ? `-${c.section_name}` : ''}` : null,
          c.roll_no ? t('bento.common.roll', { roll: c.roll_no }) : null,
        ]
          .filter(Boolean)
          .join(' · ')

  if (!kids.length) {
    return (
      <PersonaPage eyebrow={t('bento.parent_week.eyebrow')} title={t('bento.parent_week.title')}>
        <div className="rounded-[14px] border bg-card p-5 text-[13.5px] text-muted-foreground sm:col-span-2">
          {t('bento.parent_week.no_link')}
        </div>
      </PersonaPage>
    )
  }

  /* The switcher. Rendered only when there is genuinely something to pick — a
     parent of one asked which child they meant is a portal built for somebody
     else — and every child is a button rather than a dropdown, so the whole
     set is visible without opening anything and the selected one is visible
     without reading it. */
  const switcher =
    kids.length > 1 ? (
      <div
        role="group"
        aria-label={t('bento.parent_week.switcher_sr')}
        className="flex flex-wrap gap-1.5"
      >
        {kids.map((c) => (
          <button
            key={c.student_id}
            type="button"
            aria-pressed={c.student_id === activeId}
            onClick={() => setSelected(c.student_id)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-[13px] font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              c.student_id === activeId
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-card text-card-foreground',
            )}
          >
            {c.full_name}
          </button>
        ))}
      </div>
    ) : undefined

  /* `arrange` is off for the loading and error bodies: those render no
     <Widget> at all, so an arranger toolbar above them would offer to edit a
     board with nothing on it. */
  const header = (body: React.ReactNode, arrange = false) => (
    <PersonaPage
      eyebrow={t('bento.parent_week.eyebrow')}
      title={child?.full_name ?? t('bento.parent_week.title')}
      /* A guardian of two is told, in words, that what follows is one child of
         several — not the household's figures. A guardian of one gets the
         child's form instead, which is what the office asks for on the
         telephone. */
      description={
        kids.length > 1
          ? t('bento.parent_week.one_of_many', {
              name: child?.full_name ?? '',
              form: form(child),
              count: kids.length,
            })
          : form(child) || undefined
      }
      actions={switcher}
      dashboard={arrange ? 'parent_week' : undefined}
    >
      {body}
    </PersonaPage>
  )

  if (summary.isLoading || attendance.isLoading) {
    return header(
      <div className="sm:col-span-2">
        <BentoLoading message={t('bento.parent_week.loading_child', { name: child?.full_name ?? '' })} />
      </div>,
    )
  }
  /* Never an empty state from a failure: "nothing owed" read off a 500 is a
     sentence a parent will act on by not paying. */
  if (summary.error || attendance.error || !summary.data) {
    return header(
      <div className="sm:col-span-2">
        <BentoError message={t('bento.parent_week.failed_child', { name: child?.full_name ?? '' })} />
      </div>,
    )
  }

  const s = summary.data
  const days = [...(attendance.data?.items ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const recent = days.slice(-14)
  const hwDays = s.next_homework_due ? daysUntil(s.next_homework_due) : undefined

  /* WHO. This string goes on every cell below, without exception. `s.full_name`
     rather than the switcher's copy of the name deliberately: it is the name
     the summary endpoint answered with, so a cell can only ever be labelled
     with the child the figures in it are actually about. If the two ever
     disagreed, this is the one that is right. */
  const who = form(child) ? `${s.full_name} · ${form(child)}` : s.full_name

  return header(
    <>
      {/* THE ANCHOR — 2x2, light, because it is read. The child's week: how
          often they were there, and the shape of when they were not. */}
      <Widget id="week" label={t('bento.parent_week.week_label')} size="large" index={0}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.parent_week.week_label')}
        who={who}
        to={toAttendance}
        cue={t('bento.parent_week.week_cue')}
      >
        <Figure
          span={span}
          value={`${s.attendance_pct}%`}
          note={t('bento.parent_week.week_note', {
            name: s.full_name,
            present: s.present_days,
            total: s.total_days,
          })}
        />
        {recent.length > 0 ? (
          <DotStrip
            dots={recent.map((d) => ({
              key: d.date,
              title: `${d.date} — ${d.status.replace('_', ' ')}`,
              className: DOT[d.status] ?? 'bg-muted',
            }))}
            srLabel={t('bento.parent_week.strip_sr', {
              name: s.full_name,
              count: recent.length,
            })}
          />
        ) : (
          <p className="mt-3 text-[12.5px] text-muted-foreground">
            {t('bento.parent_week.no_register', { name: s.full_name })}
          </p>
        )}
      </WhoCell>
        )}
      </Widget>

      {/* THE ONE DARK CELL — what is owed, for this child and no other. It is
          the figure a parent came to act on, so it takes the single dark
          ground on the page. Drawn in the inverted foreground pair only; the
          semantic tokens were measured against a light card. */}
      <Widget id="fees" label={t('bento.parent_week.fees_label')} size="small" index={1}>
        {(span) => (
      <WhoCell
        dark
        span={span}
        label={t('bento.parent_week.fees_label')}
        who={who}
        to={toFees}
        cue={t('bento.parent_week.fees_cue')}
      >
        <Figure
          dark
          value={formatPaise(s.outstanding_paise)}
          note={
            s.outstanding_paise > 0
              ? t('bento.parent_week.fees_owed', { name: s.full_name })
              : t('bento.parent_week.fees_settled', { name: s.full_name })
          }
        />
      </WhoCell>
        )}
      </Widget>

      <Widget id="homework" label={t('bento.parent_week.homework_label')} size="small" index={2}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.parent_week.homework_label')}
        who={who}
        to={toHomework}
        cue={t('bento.parent_week.homework_cue')}
      >
        <Figure
          value={s.homework_due}
          note={
            s.homework_due === 0
              ? t('bento.parent_week.homework_none', { name: s.full_name })
              : hwDays === undefined
                ? undefined
                : hwDays < 0
                  ? t('bento.parent_week.homework_overdue', { days: -hwDays })
                  : hwDays === 0
                    ? t('bento.parent_week.homework_today')
                    : t('bento.parent_week.homework_days', { days: hwDays })
          }
        />
      </WhoCell>
        )}
      </Widget>

      <Widget id="absent" label={t('bento.parent_week.absent_label')} size="small" index={3}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.parent_week.absent_label')}
        who={who}
        to={toAttendance}
        cue={t('bento.parent_week.absent_cue')}
      >
        <Figure
          value={s.absent_days}
          note={t('bento.parent_week.absent_note', { name: s.full_name, total: s.total_days })}
        />
        <div className="mt-3">
          <Meter
            value={s.present_days}
            total={s.total_days}
            tone={s.absent_days > 0 ? 'warning' : 'success'}
            srLabel={t('bento.parent_week.absent_sr', {
              name: s.full_name,
              present: s.present_days,
              total: s.total_days,
            })}
          />
        </div>
      </WhoCell>
        )}
      </Widget>

      {/* Days present. No cue of its own: the register behind it is already
          one click away from the anchor and from the absence cell, and a third
          route to the same screen is noise, not disclosure. */}
      <Widget id="present" label={t('bento.parent_week.present_label')} size="small" index={4}>
        {(span) => (
      <WhoCell span={span} label={t('bento.parent_week.present_label')} who={who}>
        <Figure
          value={s.present_days}
          note={t('bento.parent_week.present_note', { name: s.full_name })}
        />
      </WhoCell>
        )}
      </Widget>
    </>,
    true,
  )
}
