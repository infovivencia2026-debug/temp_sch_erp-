import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Card, Dialog, ErrorState, FormNotice, Input, Loading, Select, SEG_BAR, segClass } from '@/components/ui'
import WeekGrid, { type WeekEntry } from '@/components/WeekGrid'
import { useOptimisticMutation } from '@/lib/optimistic'
import { useLiveTopic } from '@/lib/live-stream'
import { usePhone } from '@/lib/viewport'
import { mergePeriods, periodShape } from '@/lib/mergePeriods'
import { WEEKDAYS, cn } from '@/lib/utils'

/* THE TIMETABLE IN USE, EDITED WHERE IT STANDS (owner, 2026-10-28: "I should
   be able to edit the one I uploaded ... class-wise with a filter, and staff-
   wise too, editable right there").

   Pick a class and section, or a teacher, and the week is drawn with every
   period; a tap opens one cell: subject, teacher (a busy one says where),
   room, or clear. The server refuses a clash and names it
   (worker scheduling/live_edit.ts); the cell shows the change at once and
   goes back if refused. Breaks are not cells. Another person's edit arrives
   through the 'timetable' live topic. */

const LIVE = '/api/v1/master-timetable/live'

export interface LivePeriod {
  id: string; name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean; bell_schedule_id?: string | null
}
export interface LiveSection { section_id: string; section_name: string; class_name: string; level: number }
export interface LiveShape {
  weekdays: number[]
  periods: LivePeriod[]
  sections: LiveSection[]
  schedules?: { id: string; periods: LivePeriod[] }[]
  section_schedules?: Record<string, string>
}

interface LiveEntry {
  id: string; section_id: string; section_name: string; class_name: string; period_id: string; weekday: number
  class_subject_id: string; subject_name: string; teacher_id: string | null; teacher_name: string | null; room: string | null
}
interface Slot { busy: LiveEntry[]; subjects: { id: string; name: string }[]; teachers: { id: string; name: string }[] }
interface SaveVars { body: Record<string, unknown>; guess: LiveEntry | null; drop: string | null }

const secLabel = (s: { class_name: string; section_name: string }) => `${s.class_name} ${s.section_name}`.trim()

export default function LiveTimetable({ shape, mayWrite }: { shape: LiveShape; mayWrite: boolean }) {
  const phone = usePhone()
  const qc = useQueryClient()
  const [by, setBy] = useState<'class' | 'staff'>('class')
  const [classID, setClassID] = useState('')
  const [sectionID, setSectionID] = useState('')
  const [teacherID, setTeacherID] = useState('')
  const [day, setDay] = useState(() => {
    const t = ((new Date().getDay() + 6) % 7) + 1
    return shape.weekdays.includes(t) ? t : (shape.weekdays[0] ?? 1)
  })
  const [open, setOpen] = useState<{ weekday: number; period: LivePeriod } | null>(null)

  const classes = useMemo(() => {
    const m = new Map<string, { name: string; level: number }>()
    for (const s of shape.sections) m.set(s.class_name, { name: s.class_name, level: s.level })
    return [...m.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
  }, [shape.sections])
  const sectionsOfClass = shape.sections.filter((s) => s.class_name === classID)

  const staff = useQuery({
    queryKey: ['master-timetable', 'live', 'teachers'],
    queryFn: () => api.get<Slot>(`${LIVE}/slot`),
  })
  const filter = by === 'class' ? (sectionID ? `section_id=${sectionID}` : '') : (teacherID ? `teacher_id=${teacherID}` : '')
  const live = useQuery({
    queryKey: ['master-timetable', 'live', 'grid', filter],
    queryFn: () => api.get<{ items: LiveEntry[] }>(`${LIVE}?${filter}`),
    enabled: filter !== '',
  })
  useLiveTopic('timetable', useCallback(() => { void qc.invalidateQueries({ queryKey: ['master-timetable', 'live', 'grid'] }) }, [qc]))

  const periodsOfSection = useCallback((id: string): LivePeriod[] =>
    shape.schedules?.find((x) => x.id === shape.section_schedules?.[id])?.periods ?? shape.periods, [shape])
  const allPeriods = useMemo(() => {
    const list = shape.schedules?.flatMap((s) => s.periods) ?? []
    return list.length ? list : shape.periods
  }, [shape])

  const items = live.data?.items ?? []
  const rawPeriods = by === 'class' ? (sectionID ? periodsOfSection(sectionID) : []) : allPeriods
  const { periods, entries: merged } = mergePeriods(rawPeriods, items)
  const at = new Map(merged.map((e) => [`${e.weekday}:${e.period_id}`, e]))
  const grid: WeekEntry[] = merged.map((e) => ({
    weekday: e.weekday, period_id: e.period_id,
    title: by === 'class' ? e.subject_name : `${secLabel(e)} · ${e.subject_name}`,
    detail: by === 'class' ? (e.teacher_name ?? 'No teacher') : null,
    unstaffed: by === 'class' && !e.teacher_id, room: e.room,
  }))

  const pick = (weekday: number, periodID: string) => {
    const p = periods.find((x) => x.id === periodID)
    if (p && !p.is_break && mayWrite) setOpen({ weekday, period: p })
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
          <div className={SEG_BAR} role="group" aria-label="View by">
            <button type="button" className={segClass(by === 'class')} aria-pressed={by === 'class'} onClick={() => setBy('class')}>By class</button>
            <button type="button" className={segClass(by === 'staff')} aria-pressed={by === 'staff'} onClick={() => setBy('staff')}>By staff</button>
          </div>
          {by === 'class' ? (
            <>
              <div className="sm:w-48">
                <Select value={classID} placeholder="Class" onChange={(v) => {
                  setClassID(v)
                  const first = shape.sections.filter((s) => s.class_name === v)
                  setSectionID(first.length === 1 ? first[0].section_id : '')
                }} options={classes.map((k) => ({ value: k.name, label: k.name }))} />
              </div>
              <div className="sm:w-40">
                <Select value={sectionID} placeholder="Section" onChange={setSectionID}
                  options={sectionsOfClass.map((s) => ({ value: s.section_id, label: s.section_name }))} />
              </div>
            </>
          ) : (
            <div className="sm:w-64">
              <Select value={teacherID} placeholder="Teacher" onChange={setTeacherID}
                options={(staff.data?.teachers ?? []).map((t) => ({ value: t.id, label: t.name }))} />
            </div>
          )}
          {phone && (
            <Select value={String(day)} onChange={(v) => setDay(Number(v))}
              options={shape.weekdays.map((d) => ({ value: String(d), label: WEEKDAYS[d - 1] ?? `Day ${d}` }))} />
          )}
        </div>
      </Card>

      {filter === '' ? (
        <p className="py-6 text-center text-[14px] text-muted-foreground">
          {by === 'class' ? 'Choose a class and section to see its week.' : 'Choose a teacher to see their week.'}
        </p>
      ) : live.isLoading ? (
        <Loading shape="table" label="Reading the timetable…" />
      ) : live.error ? (
        <ErrorState error={live.error} />
      ) : phone ? (
        <ol className="flex flex-col gap-2">
          {periods.map((p) => {
            const e = at.get(`${day}:${p.id}`)
            const time = `${p.starts_at.slice(0, 5)}–${p.ends_at.slice(0, 5)}`
            if (p.is_break) {
              return <li key={p.id} className="rounded-xl bg-muted/50 px-4 py-2 text-center text-[14px] text-muted-foreground">{p.name} · {time}</li>
            }
            return (
              <li key={p.id}>
                <button type="button" disabled={!mayWrite} onClick={() => pick(day, p.id)}
                  className="flex min-h-[52px] w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left">
                  <span className="w-20 shrink-0 text-[14px]"><span className="block font-semibold">{p.name}</span><span className="text-[12px] text-muted-foreground">{time}</span></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-medium">{e ? (by === 'class' ? e.subject_name : `${secLabel(e)} · ${e.subject_name}`) : 'Free'}</span>
                    {e && <span className={cn('block truncate text-[14px]', by === 'class' && !e.teacher_id ? 'text-warning' : 'text-muted-foreground')}>
                      {[by === 'class' ? (e.teacher_name ?? 'No teacher') : null, e.room].filter(Boolean).join(' · ')}
                    </span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      ) : (
        <WeekGrid entries={grid} periods={periods} weekdays={shape.weekdays} onCell={mayWrite ? pick : undefined}
          empty={by === 'class' ? 'No timetable for this section yet.' : 'This teacher has no periods.'} />
      )}

      {open && (
        <CellDialog key={`${open.weekday}:${open.period.id}`} by={by} weekday={open.weekday} row={open.period}
          entry={at.get(`${open.weekday}:${open.period.id}`) ?? null}
          sectionID={by === 'class' ? sectionID : ''} teacherID={by === 'staff' ? teacherID : ''}
          shape={shape} periodsOfSection={periodsOfSection} gridKey={['master-timetable', 'live', 'grid', filter]}
          onClose={() => setOpen(null)} />
      )}
    </div>
  )
}

function CellDialog({ by, weekday, row, entry, sectionID: fixedSection, teacherID: fixedTeacher, shape, periodsOfSection, gridKey, onClose }: {
  by: 'class' | 'staff'
  weekday: number
  row: LivePeriod
  entry: LiveEntry | null
  sectionID: string
  teacherID: string
  shape: LiveShape
  periodsOfSection: (id: string) => LivePeriod[]
  gridKey: unknown[]
  onClose: () => void
}) {
  const [section, setSection] = useState(entry?.section_id ?? fixedSection)
  const [subject, setSubject] = useState(entry?.class_subject_id ?? '')
  const [teacher, setTeacher] = useState(entry?.teacher_id ?? fixedTeacher)
  const [room, setRoom] = useState(entry?.room ?? '')

  // The chosen section's own period at this time (the staff view's rows are merged across bells).
  const period = useMemo(() => {
    if (!section) return row
    const own = periodsOfSection(section)
    return own.find((p) => p.id === row.id) ?? own.find((p) => periodShape(p) === periodShape(row))
      ?? own.find((p) => p.starts_at.slice(0, 5) === row.starts_at.slice(0, 5) && !p.is_break) ?? null
  }, [section, row, periodsOfSection])

  const slot = useQuery({
    queryKey: ['master-timetable', 'live', 'slot', weekday, period?.id ?? row.id, section],
    queryFn: () => api.get<Slot>(`${LIVE}/slot?weekday=${weekday}&period_id=${period?.id ?? row.id}${section ? `&section_id=${section}` : ''}`),
  })
  const busyOf = new Map<string, LiveEntry>()
  for (const b of slot.data?.busy ?? []) if (b.teacher_id && b.id !== entry?.id) busyOf.set(b.teacher_id, b)

  const sec = shape.sections.find((s) => s.section_id === section)
  const sub = slot.data?.subjects.find((s) => s.id === subject)
  const tName = slot.data?.teachers.find((t) => t.id === teacher)?.name ?? null

  const save = useOptimisticMutation<SaveVars>({
    mutationFn: (v) => v.drop
      ? api.del(`${LIVE}/entries/${v.drop}`)
      : api.put(`${LIVE}/cell`, v.body),
    queryKeys: [gridKey],
    invalidate: [['master-timetable', 'live'], ['master-timetable', 'overview']],
    apply: (old, v) => {
      const o = old as { items: LiveEntry[] } | undefined
      if (!o?.items) return old
      const keep = o.items.filter((e) => e.id !== (v.drop ?? v.guess?.id))
      return { ...o, items: v.guess ? [...keep, v.guess] : keep }
    },
    failure: "Couldn't change that period",
  })

  const submit = () => {
    if (!sec || !sub || !period) return
    const body = { entry_id: entry?.id ?? null, section_id: section, period_id: period.id, weekday, class_subject_id: subject, teacher_id: teacher || null, room }
    save.mutate({
      body, drop: null,
      guess: {
        id: entry?.id ?? `pending-${weekday}-${period.id}`, section_id: section, section_name: sec.section_name, class_name: sec.class_name,
        period_id: period.id, weekday, class_subject_id: subject, subject_name: sub.name,
        teacher_id: teacher || null, teacher_name: teacher ? tName : null, room: room || null,
      },
    })
    onClose()
  }
  const clear = () => {
    if (!entry) return
    save.mutate({ body: {}, guess: null, drop: entry.id })
    onClose()
  }

  const clashWith = teacher ? busyOf.get(teacher) : undefined
  const title = `${WEEKDAYS[weekday - 1] ?? `Day ${weekday}`} · ${row.name}`

  return (
    <Dialog onClose={onClose} title={title} description={`${row.starts_at.slice(0, 5)}–${row.ends_at.slice(0, 5)}`}
      footer={(
        <div className="flex w-full flex-wrap justify-end gap-2">
          {entry && <Button variant="ghost" tone="danger" onClick={clear}>Clear period</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!sec || !sub || !period} onClick={submit}>Save</Button>
        </div>
      )}>
      <div className="space-y-3">
        {by === 'staff' && (
          <label className="block space-y-1">
            <span className="text-[13px] font-medium">Class and section</span>
            <Select value={section} placeholder="Choose a class" onChange={(v) => { setSection(v); setSubject('') }}
              options={shape.sections.map((s) => ({ value: s.section_id, label: secLabel(s) }))} />
          </label>
        )}
        {section && !period && <p className="text-[13px] text-warning">This class has no period at this time in its own timings.</p>}
        {slot.isLoading ? <Loading shape="inline" label="Reading the class's subjects…" /> : slot.error ? <ErrorState error={slot.error} /> : (
          <>
            <label className="block space-y-1">
              <span className="text-[13px] font-medium">Subject</span>
              <Select value={subject} placeholder={section ? 'Choose a subject' : 'Choose a class first'} onChange={setSubject}
                options={(slot.data?.subjects ?? []).map((s) => ({ value: s.id, label: s.name }))} />
            </label>
            <label className="block space-y-1">
              <span className="text-[13px] font-medium">Teacher</span>
              <Select value={teacher} placeholder="No teacher" onChange={setTeacher}
                options={[{ value: '', label: 'No teacher' }, ...(slot.data?.teachers ?? []).map((t) => {
                  const b = busyOf.get(t.id)
                  return { value: t.id, label: b ? `${t.name} (busy: ${secLabel(b)} ${b.subject_name})` : t.name }
                })]} />
            </label>
            {clashWith && (
              <p className="text-[13px] text-warning">
                Already teaching {clashWith.subject_name} to {secLabel(clashWith)} at this time. Saving is refused unless it is the same subject (a combined class).
              </p>
            )}
            <label className="block space-y-1">
              <span className="text-[13px] font-medium">Room</span>
              <Input value={room} onChange={setRoom} placeholder="Optional" srLabel="Room" />
            </label>
          </>
        )}
        <FormNotice error={save.error} />
      </div>
    </Dialog>
  )
}
