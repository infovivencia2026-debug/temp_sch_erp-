import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Period, type TimetableEntry } from '@/lib/api'
import { Button, Card, Dialog, ErrorState, ExportTable, FormNotice, Input, Loading, Select, SEG_BAR, segClass } from '@/components/ui'
import WeekGrid, { type WeekEntry } from '@/components/WeekGrid'
import { useOptimisticMutation } from '@/lib/optimistic'
import { useLiveTopic } from '@/lib/live-stream'
import { usePhone } from '@/lib/viewport'
import { mergePeriods } from '@/lib/mergePeriods'
import { WEEKDAYS } from '@/lib/utils'

/* THE LIVE TIMETABLE, ONE SECTION AT A TIME — AND EDITABLE.
 *
 * The grid already in use, looked at class-wise (class, then section) or
 * staff-wise (one teacher's week), and corrected one period at a time: a tap
 * opens the cell, where its subject, teacher (a busy one says where) or room
 * is changed, or the period cleared. Owner, 2026-10-28: it lives under
 * Master timetable's "Current timetable" toggle, drawn in the shared WeekGrid
 * (a day timeline on phones), and every period shows, 9 and 10 included.
 *
 * Writes go to PUT /timetable/entries/cell and DELETE /timetable/entries/{id}
 * (worker routes/daily.ts), which refuse a teacher clash or a break and name
 * it, write the audit log and hint the 'timetable' live topic; another
 * person's edit refetches this grid. */

interface Section { id: string; class_id: string; class_name: string; name: string }
interface ClassSubject { subject_id: string; subject_name: string }
interface SaveVars { body: Record<string, unknown> | null; guess: TimetableEntry | null; drop: string | null }

const label = (e: { class_name: string; section_name: string }) => `${e.class_name} ${e.section_name}`.trim()
const hm = (s: string) => s.slice(0, 5)

export default function SectionGrid({ weekdays, mayWrite }: { weekdays: number[]; mayWrite: boolean }) {
  const phone = usePhone()
  const qc = useQueryClient()
  const [by, setBy] = useState<'class' | 'staff'>('class')
  const [classID, setClassID] = useState('')
  const [sectionID, setSectionID] = useState('')
  const [teacherID, setTeacherID] = useState('')
  const [open, setOpen] = useState<{ weekday: number; period: Period } | null>(null)

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const teachers = useQuery({ queryKey: ['teachers'], queryFn: () => api.call('GET /timetable/teachers') })
  const allSections = sections.data?.items ?? []
  const classes = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of allSections) m.set(s.class_id, s.class_name)
    return [...m.entries()].map(([value, label]) => ({ value, label }))
  }, [allSections])

  const filter = by === 'class' ? (sectionID ? { section_id: sectionID } : null) : (teacherID ? { teacher_id: teacherID } : null)
  const entriesKey = ['tt-entries', by === 'class' ? sectionID : `t:${teacherID}`]
  const periods = useQuery({
    /* Every bell schedule's periods: a school with one schedule per weekday
       (Yajur) gives each day its own period ids, and a section's own list
       held only one day's, so the other five days drew as Free. mergePeriods
       folds them into one row per period. */
    queryKey: ['periods', 'all'],
    queryFn: () => api.call('GET /timetable/periods', { query: { all: '1' } }),
    enabled: !!filter,
  })
  const entries = useQuery({
    queryKey: entriesKey,
    queryFn: () => api.call('GET /timetable/entries', { query: filter ?? {} }),
    enabled: !!filter,
  })
  useLiveTopic('timetable', useCallback(() => { void qc.invalidateQueries({ queryKey: ['tt-entries'] }) }, [qc]))

  const merged = mergePeriods(periods.data?.items ?? [], entries.data?.items ?? [])
  const at = new Map(merged.entries.map((e) => [`${e.weekday}:${e.period_id}`, e]))
  const grid: WeekEntry[] = merged.entries.map((e) => ({
    weekday: e.weekday, period_id: e.period_id,
    title: by === 'class' ? e.subject_name : `${label(e)} · ${e.subject_name}`,
    detail: by === 'class' ? (e.teacher_name ?? 'No teacher') : null,
    unstaffed: by === 'class' && !e.teacher_id, room: e.room,
  }))
  const pick = (weekday: number, periodID: string) => {
    const p = merged.periods.find((x) => x.id === periodID)
    if (p && !p.is_break) setOpen({ weekday, period: p })
  }
  const who = by === 'class'
    ? (() => { const s = allSections.find((x) => x.id === sectionID); return s ? `${s.class_name} ${s.name}` : '' })()
    : (teachers.data?.items.find((t) => t.user_id === teacherID)?.full_name ?? '')

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
                <Select value={classID} placeholder="Class" options={classes} onChange={(v) => {
                  setClassID(v)
                  const own = allSections.filter((s) => s.class_id === v)
                  setSectionID(own.length === 1 ? own[0].id : '')
                }} />
              </div>
              <div className="sm:w-40">
                <Select value={sectionID} placeholder="Section" onChange={setSectionID}
                  options={allSections.filter((s) => s.class_id === classID).map((s) => ({ value: s.id, label: s.name }))} />
              </div>
            </>
          ) : (
            <div className="sm:w-64">
              <Select value={teacherID} placeholder="Teacher" onChange={setTeacherID}
                options={(teachers.data?.items ?? []).filter((t) => t.user_id).map((t) => ({ value: t.user_id, label: t.full_name }))} />
            </div>
          )}
          {filter && !phone && <div className="sm:ml-auto"><ExportTable tableId="section-grid" name="timetable" /></div>}
        </div>
      </Card>

      {sections.error ? <ErrorState error={sections.error} /> : !filter ? (
        <p className="py-6 text-center text-[14px] text-muted-foreground">
          {by === 'class' ? 'Choose a class and section to see its week.' : 'Choose a teacher to see their week.'}
        </p>
      ) : periods.isLoading || entries.isLoading ? (
        <Loading shape="table" label="Reading the timetable…" />
      ) : entries.error || periods.error ? (
        <ErrorState error={entries.error ?? periods.error} />
      ) : (
        <WeekGrid id="section-grid" entries={grid} periods={merged.periods} weekdays={weekdays} who={who}
          onCell={mayWrite ? pick : undefined}
          empty={by === 'class' ? 'No timetable for this section yet.' : 'This teacher has no periods.'} />
      )}

      {open && (
        <CellDialog key={`${open.weekday}:${open.period.id}`} by={by} weekday={open.weekday} row={open.period}
          entry={at.get(`${open.weekday}:${open.period.id}`) ?? null}
          fixedSection={by === 'class' ? sectionID : ''} fixedTeacher={by === 'staff' ? teacherID : ''}
          sections={allSections} teachers={(teachers.data?.items ?? []).filter((t) => t.user_id).map((t) => ({ id: t.user_id, name: t.full_name }))}
          entriesKey={entriesKey} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}

function CellDialog({ by, weekday, row, entry, fixedSection, fixedTeacher, sections, teachers, entriesKey, onClose }: {
  by: 'class' | 'staff'
  weekday: number
  row: Period
  entry: TimetableEntry | null
  fixedSection: string
  fixedTeacher: string
  sections: Section[]
  teachers: { id: string; name: string }[]
  entriesKey: unknown[]
  onClose: () => void
}) {
  const [section, setSection] = useState(entry?.section_id ?? fixedSection)
  const [subject, setSubject] = useState(entry?.subject_name ?? '')
  const [teacher, setTeacher] = useState(entry?.teacher_id ?? fixedTeacher)
  const [room, setRoom] = useState(entry?.room ?? '')
  const sec = sections.find((s) => s.id === section)

  const subjects = useQuery({
    queryKey: ['class-subjects', sec?.class_id],
    queryFn: () => api.get<List<ClassSubject>>(`/api/v1/setup/class-subjects?class_id=${sec!.class_id}`),
    enabled: !!sec?.class_id,
  })
  // Who is teaching at this time anywhere in the school, to say where a busy teacher is.
  const everyone = useQuery({ queryKey: ['tt-entries', 'all'], queryFn: () => api.call('GET /timetable/entries', { query: {} }) })
  const allPeriods = useQuery({ queryKey: ['periods', 'all'], queryFn: () => api.call('GET /timetable/periods', { query: { all: '1' } }) })
  const busyOf = useMemo(() => {
    const times = new Map((allPeriods.data?.items ?? []).map((p) => [p.id, p]))
    const m = new Map<string, TimetableEntry>()
    for (const e of everyone.data?.items ?? []) {
      const p = times.get(e.period_id)
      if (e.weekday !== weekday || !e.teacher_id || e.id === entry?.id || !p) continue
      if (hm(p.starts_at) < hm(row.ends_at) && hm(row.starts_at) < hm(p.ends_at)) m.set(e.teacher_id, e)
    }
    return m
  }, [everyone.data, allPeriods.data, weekday, row, entry])

  const save = useOptimisticMutation<SaveVars>({
    mutationFn: (v) => v.drop ? api.del(`/api/v1/timetable/entries/${v.drop}`) : api.put('/api/v1/timetable/entries/cell', v.body),
    queryKeys: [entriesKey],
    invalidate: [['tt-entries'], ['master-timetable', 'overview']],
    apply: (old, v) => {
      const o = old as { items: TimetableEntry[] } | undefined
      if (!o?.items) return old
      const gone = v.drop ?? v.guess?.id
      const keep = o.items.filter((e) => e.id !== gone)
      return { ...o, items: v.guess ? [...keep, v.guess] : keep }
    },
    failure: "Couldn't change that period",
  })

  const submit = () => {
    if (!sec || !subject) return
    save.mutate({
      drop: null,
      body: { section_id: section, weekday, period_name: row.name, subject_code: subject, teacher_user_id: teacher, room },
      guess: {
        id: entry?.id ?? `pending-${weekday}-${row.id}`, section_id: section, section_name: sec.name, class_name: sec.class_name,
        period_id: entry?.period_id ?? row.id, period_name: row.name, weekday, subject_name: subject, subject_code: subject,
        teacher_id: teacher || undefined, teacher_name: teachers.find((t) => t.id === teacher)?.name, room: room || undefined,
      },
    })
    onClose()
  }
  const clear = () => {
    if (!entry) return
    save.mutate({ body: null, guess: null, drop: entry.id })
    onClose()
  }
  const clash = teacher ? busyOf.get(teacher) : undefined

  return (
    <Dialog onClose={onClose} title={`${WEEKDAYS[weekday - 1] ?? `Day ${weekday}`} · ${row.name}`}
      description={`${hm(row.starts_at)}–${hm(row.ends_at)}`}
      footer={(
        <div className="flex w-full flex-wrap justify-end gap-2">
          {entry && <Button variant="ghost" tone="danger" onClick={clear}>Clear period</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!sec || !subject} onClick={submit}>Save</Button>
        </div>
      )}>
      <div className="space-y-3">
        {by === 'staff' && (
          <label className="block space-y-1">
            <span className="text-[13px] font-medium">Class and section</span>
            <Select value={section} placeholder="Choose a class" onChange={(v) => { setSection(v); setSubject('') }}
              options={sections.map((s) => ({ value: s.id, label: `${s.class_name} ${s.name}` }))} />
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-[13px] font-medium">Subject</span>
          <Select value={subject} placeholder={sec ? 'Choose a subject' : 'Choose a class first'} onChange={setSubject}
            options={(subjects.data?.items ?? []).map((s) => ({ value: s.subject_name, label: s.subject_name }))} />
        </label>
        <label className="block space-y-1">
          <span className="text-[13px] font-medium">Teacher</span>
          <Select value={teacher} placeholder="No teacher" onChange={setTeacher}
            options={[{ value: '', label: 'No teacher' }, ...teachers.map((t) => {
              const b = busyOf.get(t.id)
              return { value: t.id, label: b ? `${t.name} (busy: ${label(b)} ${b.subject_name})` : t.name }
            })]} />
        </label>
        {clash && (
          <p className="text-[13px] text-warning">
            Already teaching {clash.subject_name} to {label(clash)} at this time. Saving is refused unless it is the same subject (a combined class).
          </p>
        )}
        <label className="block space-y-1">
          <span className="text-[13px] font-medium">Room</span>
          <Input value={room} onChange={setRoom} placeholder="Optional" srLabel="Room" />
        </label>
        <FormNotice error={save.error} />
      </div>
    </Dialog>
  )
}
