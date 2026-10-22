import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List, type Section, type TimetableEntry } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Button, Select, Loading, SkeletonTable, ErrorState, TAB_BAR, tabClass, SEG_BAR, segClass, PageBody } from '@/components/ui'
import { Printer } from 'lucide-react'
import { printDocument } from '@/lib/print'
import { cn } from '@/lib/utils'
import DayTimeline from '@/components/DayTimeline'
import WeekGrid from '@/components/WeekGrid'
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
/** `embedded`: drawn under a page that already says "Timetable" (the
    student's), so the card does not say it a second time. */
export default function Timetable({ embedded = false }: { embedded?: boolean } = {}) {
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
    /* The page gutter. Without it this screen's card began at the exact
       pixel the sidebar ended and ran to the window's edge on the right.
       Every other screen gets it from PageBody; the ones built out of a
       bare Card never did. */
    <PageBody top>
    <Card>
      {!embedded && <CardHeader title="Timetable" />}
      <div className={cn(TAB_BAR, 'px-3', tabs.length === 1 && 'hidden')} role="tablist">
        {tabs.map((t: { id: string; label: string }) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tabId}
            onClick={() => setTab(t.id)}
            className={tabClass(t.id === tabId)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabId === 'grid' || !mayPlan ? <Grid isStaff={isStaff} /> : <Workload />}
    </Card>
    </PageBody>
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
    /* Every schedule's periods: a week can span classes on different timings. */
    queryKey: ['periods', 'all'],
    queryFn: () => api.call('GET /timetable/periods', { query: { all: '1' } }),
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

  /* THE ROWS ARE THE WEEK'S OWN BELL. Classes may run to different timings
     (Nursery's short morning, the school day), so every schedule's periods
     arrive. The grid keeps the schedules this week actually uses -- one, for
     a class or a teacher on one bell -- and falls back to the first. */
  const allPeriods = periods.data?.items ?? []
  const usedIds = new Set(cells.map((c) => c.period_id))
  const usedBells = new Set(allPeriods.filter((p) => usedIds.has(p.id)).map((p) => p.bell_schedule_id ?? ''))
  if (usedBells.size === 0 && allPeriods.length) usedBells.add(allPeriods[0].bell_schedule_id ?? '')
  /* A period that is the same in two bells (same name, same times) is one row. */
  const same = (p: { name: string; starts_at: string; ends_at: string; is_break: boolean }) => `${p.name}|${p.starts_at}|${p.ends_at}|${p.is_break}`
  const canon = new Map<string, string>(), rowOf = new Map<string, string>()
  const rows = allPeriods.filter((p) => usedBells.has(p.bell_schedule_id ?? ''))
    .sort((a, b) => (usedBells.size > 1 ? a.starts_at.localeCompare(b.starts_at) : 0) || a.sequence - b.sequence)
    .filter((p) => {
      const k = same(p), first = canon.get(k)
      rowOf.set(p.id, first ?? p.id)
      if (first) return false
      canon.set(k, p.id)
      return true
    })
  /* Your own periods are marked only on somebody else's week: on your own,
     every period is yours and a mark on all of them marks nothing. */
  const gridCells = cells.map((c) => ({
    weekday: c.weekday,
    period_id: rowOf.get(c.period_id) ?? c.period_id,
    title: c.subject,
    detail: c.who,
    room: c.room,
    mine: view.mode !== 'me' && c.mine,
    unstaffed: c.unstaffed,
  }))

  return (
    <>
      {isStaff && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className={SEG_BAR} role="tablist" aria-label="Whose week">
          <button type="button" role="tab" aria-selected={view.mode === 'me'} className={segClass(view.mode === 'me')} onClick={() => setView({ mode: 'me' })}>
            My timetable
          </button>
          {classes.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={sectionId === s.id} className={segClass(sectionId === s.id)}
              onClick={() => setView({ mode: 'section', sectionId: s.id })}>
              My class {label(s)}
            </button>
          ))}
          </div>
          {seeAll && (
            <div className="w-full sm:w-56">
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
            periods={allPeriods}
            entries={cells.map((c) => ({
              weekday: c.weekday,
              period_id: c.period_id,
              title: c.subject,
              detail: [c.who, c.room].filter(Boolean).join(' • '),
            }))}
          />
        </div>
      ) : (
        <div className="p-4">
          <p className="mb-3 text-[13px] text-muted-foreground">
            {view.mode === 'me'
              ? <>Every period you teach, across all your classes.</>
              : <>The whole week for <b className="text-foreground">{title}</b>{classes.some((c) => c.id === sectionId) ? '. Your own periods are highlighted.' : '.'}</>}
          </p>
          <WeekGrid id="staff-timetable" entries={gridCells} periods={rows}
            empty={view.mode === 'me' ? 'No periods are timetabled for you yet.' : 'Nothing is timetabled for this class yet.'} />
        </div>
      )}
    </>
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
