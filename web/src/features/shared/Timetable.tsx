import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List, type Section, type TimetableEntry } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Button, Select, Loading, SkeletonTable, ErrorState, tabClass } from '@/components/ui'
import { Printer } from 'lucide-react'
import { printDocument } from '@/lib/print'
import { WEEKDAYS } from '@/lib/utils'
import { cn } from '@/lib/utils'
import DayTimeline from '@/components/DayTimeline'
import { useSession } from '@/lib/session'
import { usePhone } from '@/lib/viewport'

/* One screen, two audiences.

   A member of staff plans the week: they pick a section and can look at how
   the teaching load falls across the faculty. A student or a parent has no
   section to pick — they have theirs — and no business reading a staff
   workload report. Showing them both meant a picker that 403'd on load and a
   tab that answered 403 when opened.

   The endpoint now returns only the caller's own sections, so the difference
   here is entirely about what to offer, not what to hide. */
export default function Timetable() {
  const [tabId, setTab] = useState('grid')
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.call('GET /session'),
  })
  const held = session.data?.permissions ?? []
  const isStaff = held.includes('academics.read')

  /* Who may read the whole staff's load.
   *
   * "Faculty workload" lists every colleague, their weekly periods and who is
   * overloaded. That is a management view — the question a head of department
   * or a principal asks before moving a class, and it is answered by naming
   * which of your colleagues is carrying the most.
   *
   * It was offered to anybody who could read academics, which is every
   * teacher in the school. A teacher needs their own week and the week of a
   * class they teach; they have no business with a league table of their
   * colleagues, and being on one is worse. Gated on academics.write, which is
   * what separates the people who move periods from the people who teach
   * them. */
  const mayPlan = held.includes('academics.write')

  const tabs = mayPlan
    ? [
        { id: 'grid', label: 'Grid' },
        { id: 'workload', label: 'Faculty workload' },
      ]
    : [{ id: 'grid', label: isStaff ? 'My week' : 'My week' }]
  return (
    <Card>
      <CardHeader title="Timetable" />
      <div className={cn('flex gap-1 border-b px-3 pt-2', tabs.length === 1 && 'hidden')}>
        {tabs.map((t: { id: string; label: string }) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-t-md px-3 py-1.5 text-sm',
              t.id === tabId ? tabClass(true) : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabId === 'grid' || !mayPlan ? <Grid isStaff={isStaff} /> : <Workload />}
    </Card>
  )
}

/* WHOSE WEEK IS ON SCREEN, AND WHO MAY LOOK.

   A teacher sees their own week. A class teacher also sees the week of the
   class they are responsible for, with their own periods picked out. Nobody
   else on staff browses other classes: that is the head of department's, the
   principal's and the office's view, and they keep a picker of every class. */
type View = { mode: 'me' } | { mode: 'section'; sectionId: string }

const SEE_ALL_ROLES = ['hod', 'institution_admin', 'principal']

function Grid({ isStaff }: { isStaff: boolean }) {
  const session = useSession()
  const me = session.user?.id
  const roles = session.user?.roles ?? []
  const phone = usePhone()
  const workspace = typeof window !== 'undefined' ? window.location.pathname.split('/')[1] : ''
  const seeAll = roles.some((r) => SEE_ALL_ROLES.includes(r)) || SEE_ALL_ROLES.includes(workspace)
  const [view, setView] = useState<View>(isStaff ? { mode: 'me' } : { mode: 'section', sectionId: '' })
  const sectionId = view.mode === 'section' ? view.sectionId : ''

  /* The class this person is class teacher of, if any. */
  const myClass = useQuery({
    queryKey: ['sections', 'class_teacher'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections?mine=class_teacher'),
    enabled: isStaff,
  })
  /* Every class, only for those who may look at any of them. */
  const allSections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
    enabled: isStaff && seeAll,
  })
  const periods = useQuery({
    queryKey: ['periods'],
    queryFn: () => api.call('GET /timetable/periods'),
  })
  const query = view.mode === 'me' ? '?teacher_id=me' : sectionId ? `?section_id=${sectionId}` : ''
  const entries = useQuery({
    queryKey: ['timetable', view.mode, sectionId],
    queryFn: () => api.get<List<TimetableEntry>>(`/api/v1/timetable/entries${query}`),
    enabled: view.mode === 'me' || sectionId !== '',
  })

  const classes = myClass.data?.items ?? []
  const sections = allSections.data?.items ?? []
  const label = (s: Section) => `${s.class_name}-${s.name}`
  const picked = [...classes, ...sections].find((x) => x.id === sectionId)
  const title = view.mode === 'me' ? (session.user?.full_name ?? 'My timetable') : picked ? label(picked) : 'Class timetable'

  if (periods.isLoading || entries.isLoading) return <Loading />
  if (entries.error) return <ErrorState error={entries.error} />

  const list = entries.data?.items ?? []
  const cells = list.map((e) => ({
    weekday: e.weekday,
    period_id: e.period_id,
    subject: e.subject_name || e.subject_code,
    /* Your own week names the class; a class's week names the teacher. */
    who: view.mode === 'me' ? `${e.class_name}-${e.section_name}` : (e.teacher_name ?? 'No teacher yet'),
    room: e.room,
    mine: view.mode === 'me' || (!!me && e.teacher_id === me),
    unstaffed: view.mode !== 'me' && !e.teacher_name,
  }))

  const tab = (on: boolean) => cn('rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
    on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')

  return (
    <>
      {isStaff && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <button type="button" className={tab(view.mode === 'me')} onClick={() => setView({ mode: 'me' })}>
            My timetable
          </button>
          {classes.map((s) => (
            <button key={s.id} type="button" className={tab(sectionId === s.id)}
              onClick={() => setView({ mode: 'section', sectionId: s.id })}>
              My class {label(s)}
            </button>
          ))}
          {seeAll && (
            <div className="w-56">
              <Select
                value={sectionId && !classes.some((c) => c.id === sectionId) ? sectionId : ''}
                onChange={(v) => v && setView({ mode: 'section', sectionId: v })}
                placeholder="Any class…"
                options={sections.map((s) => ({ value: s.id, label: label(s) }))}
              />
            </div>
          )}
          <span className="mr-auto" />
          {!phone && (
            <Button size="sm" variant="secondary"
              onClick={() => printDocument({ source: document.getElementById('staff-timetable'), title: 'Timetable', subtitle: title, landscape: true })}>
              <Printer className="h-3.5 w-3.5" /> Print
            </Button>
          )}
        </div>
      )}

      {phone ? (
        <div className="px-1 pb-2">
          <DayTimeline
            bare
            who={title}
            where={view.mode === 'me' ? 'Every period you teach, across all your classes' : 'The whole week for this class'}
            breaks={view.mode !== 'me'}
            periods={periods.data?.items ?? []}
            entries={cells.map((c) => ({
              weekday: c.weekday,
              period_id: c.period_id,
              title: c.subject,
              detail: [c.who, c.room].filter(Boolean).join(' • '),
            }))}
          />
        </div>
      ) : (
        <div id="staff-timetable" className="p-4">
          <p className="mb-3 text-[13px] text-muted-foreground">
            {view.mode === 'me'
              ? <>Every period you teach, across all your classes.</>
              : <>The whole week for <b className="text-foreground">{title}</b>{classes.some((c) => c.id === sectionId) ? '. Your own periods are highlighted.' : '.'}</>}
          </p>
          <StaffWeekGrid cells={cells} periods={periods.data?.items ?? []}
            empty={view.mode === 'me' ? 'No periods are timetabled for you yet.' : 'Nothing is timetabled for this class yet.'} />
        </div>
      )}
    </>
  )
}

interface StaffCell {
  weekday: number; period_id: string; subject: string; who: string
  room?: string; mine: boolean; unstaffed: boolean
}

/* The week as a wall timetable: periods down the side, Monday to Saturday
   across, breaks across the whole row. Today's column is tinted and the
   period running now is ringed. Your own periods are solid in the school's
   colour; everybody else's are light cards; an empty period says Free. */
function StaffWeekGrid({ cells, periods, empty }: {
  cells: StaffCell[]
  periods: { id: string; name: string; starts_at: string; ends_at?: string; is_break?: boolean }[]
  empty: string
}) {
  const at = new Map<string, StaffCell>()
  for (const c of cells) at.set(`${c.weekday}:${c.period_id}`, c)
  const days = [1, 2, 3, 4, 5, 6]
  const now = new Date()
  const today = ((now.getDay() + 6) % 7) + 1
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const time = (p: { starts_at: string; ends_at?: string }) =>
    p.ends_at ? `${p.starts_at.slice(0, 5)}–${p.ends_at.slice(0, 5)}` : p.starts_at.slice(0, 5)

  if (!periods.some((p) => !p.is_break)) {
    return <p className="py-6 text-center text-[13.5px] text-muted-foreground">The school day has no periods yet, so there is nothing to lay a timetable on.</p>
  }
  if (cells.length === 0) return <p className="py-6 text-center text-[13.5px] text-muted-foreground">{empty}</p>

  return (
    <div className="scroll-x rounded-xl border">
      <table className="w-full min-w-[52rem] table-fixed border-collapse text-[12.5px]">
        <thead>
          <tr>
            <th className="w-28 border-b bg-muted/50 px-3 py-2.5 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Period</th>
            {days.map((d) => (
              <th key={d} className={cn('border-b border-l px-3 py-2.5 text-center text-[11.5px] font-semibold uppercase tracking-wide',
                d === today ? 'bg-primary/[0.07] text-primary' : 'bg-muted/50 text-muted-foreground')}>
                {WEEKDAYS[d - 1]}{d === today ? ' (today)' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => p.is_break ? (
            <tr key={p.id}>
              <td colSpan={days.length + 1} className="border-b bg-muted/60 px-3 py-1.5 text-center text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {p.name} · {time(p)}
              </td>
            </tr>
          ) : (
            <tr key={p.id} className="align-top">
              <td className="border-b bg-muted/30 px-3 py-2">
                <div className="text-[13px] font-semibold">{p.name}</div>
                <div className="text-[11px] text-muted-foreground">{time(p)}</div>
              </td>
              {days.map((d) => {
                const c = at.get(`${d}:${p.id}`)
                const live = d === today && p.ends_at && p.starts_at.slice(0, 5) <= hhmm && hhmm < p.ends_at.slice(0, 5)
                return (
                  <td key={d} className={cn('border-b border-l p-2', d === today && 'bg-primary/[0.03]')}>
                    {c ? (
                      /* A HIGHLIGHT MARKS THE EXCEPTION, NOT THE RULE.

                         Own periods were filled solid in the brand colour. On
                         a class timetable that reads well -- three of eight
                         periods are yours and they stand out. On your OWN
                         timetable every period is yours, so the grid came out
                         as forty saturated red blocks with white text, a wall
                         of colour that is tiring to read, impossible to skim
                         and wrong in the one way that matters: a highlight
                         that covers everything highlights nothing.

                         A rail down the left edge and a faint tint say "yours"
                         just as clearly at a glance, and leave the subject in
                         ordinary black on white where it can actually be read.
                         Somebody else's period keeps a plain card. */
                      <div className={cn('flex min-h-[4.25rem] flex-col gap-0.5 rounded-lg border px-2.5 py-2',
                        c.mine ? 'border-l-[3px] border-l-primary bg-primary/[0.06]' : 'bg-card',
                        live && 'ring-2 ring-primary ring-offset-1')}>
                        <span className="text-[13px] font-semibold leading-snug">{c.subject}</span>
                        <span className={cn('text-[11px] leading-snug',
                          c.unstaffed ? 'text-warning' : 'text-muted-foreground')}>
                          {c.who}
                        </span>
                        {c.room && (
                          <span className="mt-auto w-fit rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
                            {c.room}
                          </span>
                        )}
                      </div>
                    ) : (
                      /* An empty period is the quietest thing on the grid: it
                         is what the eye should skip over on its way to a
                         lesson, not a card competing with one. */
                      <div className={cn('flex min-h-[4.25rem] items-center justify-center rounded-lg border border-dashed bg-surface-sunken/30 text-[11px] font-medium text-muted-foreground/70',
                        live && 'ring-2 ring-primary ring-offset-1')}>
                        Free
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

function Workload() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.call('GET /timetable/teachers'),
  })
  if (isLoading && !data) return <SkeletonTable columns={4} />
  if (error) return <ErrorState error={error} />
  const rows = data?.items ?? []
  return (
    <Table head={['Code', 'Teacher', 'Weekly periods', 'Load']} empty={!rows.length}>
      {rows.map((t) => {
        // Absent for anybody who does not plan the timetable.
        const load = t.weekly_periods ?? 0
        return (
        <tr key={t.user_id}>
          <Td className="font-mono text-xs">{t.employee_code}</Td>
          <Td className="font-medium">{t.full_name}</Td>
          <Td className="tabular-nums">{t.weekly_periods ?? '-'}</Td>
          <Td>
            {/* 30 periods a week is the usual CBSE ceiling for a full-time
                teacher; over that is worth flagging, not blocking. */}
            <Badge tone={load > 30 ? 'danger' : load > 24 ? 'primary' : 'success'}>
              {load > 30 ? 'Overloaded' : load > 24 ? 'Heavy' : 'Normal'}
            </Badge>
          </Td>
        </tr>
        )
      })}
    </Table>
  )
}
