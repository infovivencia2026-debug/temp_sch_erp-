import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Select, Button, FormNotice, Loading, ErrorState,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* THE LIVE TIMETABLE, ONE SECTION AT A TIME — AND EDITABLE.
 *
 * The Master Timetable could generate and publish a whole draft, but the grid
 * already in use could not be looked at section by section, let alone have a
 * single cell corrected. This shows the week for one section and lets a slot's
 * subject, teacher or room be changed, or the slot cleared, against the live
 * grid — the plain edit a school reaches for when one period moves. */

interface Section { id: string; class_id: string; class_name: string; name: string }
interface Period { id: string; name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean }
interface Entry {
  id: string; period_name: string; weekday: number
  subject_name: string; subject_code: string
  teacher_id?: string; teacher_name?: string; room?: string
}
interface ClassSubject { subject_id: string; subject_name: string }
interface Teacher { user_id: string; full_name: string }

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' },
]

export default function SectionGrid() {
  const qc = useQueryClient()
  const [sectionID, setSectionID] = useState('')
  const [cell, setCell] = useState<{ weekday: number; period: string } | null>(null)
  const [subject, setSubject] = useState('')
  const [teacher, setTeacher] = useState('')
  const [err, setErr] = useState('')

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const section = sections.data?.items.find((s) => s.id === sectionID)

  const periods = useQuery({
    queryKey: ['periods', sectionID],
    queryFn: () => api.get<List<Period>>(`/api/v1/timetable/periods?section_id=${sectionID}`),
    enabled: !!sectionID,
  })
  const entries = useQuery({
    queryKey: ['tt-entries', sectionID],
    queryFn: () => api.get<List<Entry>>(`/api/v1/timetable/entries?section_id=${sectionID}`),
    enabled: !!sectionID,
  })
  const subjects = useQuery({
    queryKey: ['class-subjects', section?.class_id],
    queryFn: () => api.get<List<ClassSubject>>(`/api/v1/setup/class-subjects?class_id=${section!.class_id}`),
    enabled: !!section?.class_id,
  })
  const teachers = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/timetable/teachers'),
  })

  // entry by "weekday|periodName"
  const byCell = useMemo(() => {
    const m = new Map<string, Entry>()
    for (const e of entries.data?.items ?? []) m.set(`${e.weekday}|${e.period_name}`, e)
    return m
  }, [entries.data])

  const teach = periods.data?.items.filter((p) => !p.is_break) ?? []

  const refresh = () => qc.invalidateQueries({ queryKey: ['tt-entries', sectionID] })

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/timetable/entries/cell', {
        section_id: sectionID, weekday: cell!.weekday, period_name: cell!.period,
        subject_code: subject, teacher_user_id: teacher, room: '',
      }),
    onSuccess: () => { setCell(null); setErr(''); refresh() },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not save'),
  })
  const clear = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/timetable/entries/${id}`),
    onSuccess: () => { setCell(null); setErr(''); refresh() },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not clear'),
  })

  const openCell = (weekday: number, period: string) => {
    const e = byCell.get(`${weekday}|${period}`)
    setCell({ weekday, period })
    setSubject(e?.subject_name ?? '')
    setTeacher(e?.teacher_id ?? '')
    setErr('')
  }

  const current = cell ? byCell.get(`${cell.weekday}|${cell.period}`) : undefined

  return (
    <Card>
      <CardHeader
        title="Section timetable"
        description="The live week for one section. Click any slot to change its subject, teacher, or to clear it."
        action={
          <Select
            value={sectionID}
            onChange={(v) => { setSectionID(v); setCell(null) }}
            placeholder="Choose a section"
            options={(sections.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.class_name}-${s.name}` }))}
          />
        }
      />
      <div className="p-5">
        {!sectionID ? (
          <p className="text-[14px] text-muted-foreground">Pick a section to see its timetable.</p>
        ) : periods.isLoading || entries.isLoading ? (
          <Loading />
        ) : entries.error ? (
          <ErrorState error={entries.error} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="border p-2 text-left text-muted-foreground">Period</th>
                    {DAYS.map((d) => (
                      <th key={d.n} className="border p-2 text-left text-muted-foreground">{d.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teach.map((p) => (
                    <tr key={p.id}>
                      <td className="border p-2 align-top">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-[11px] text-muted-foreground">{p.starts_at}–{p.ends_at}</div>
                      </td>
                      {DAYS.map((d) => {
                        const e = byCell.get(`${d.n}|${p.name}`)
                        const on = cell?.weekday === d.n && cell?.period === p.name
                        return (
                          <td
                            key={d.n}
                            onClick={() => openCell(d.n, p.name)}
                            className={cn(
                              'border p-2 align-top cursor-pointer hover:bg-surface-hover',
                              on && 'ring-2 ring-primary',
                            )}
                          >
                            {e ? (
                              <>
                                <div className="font-medium">{e.subject_name}</div>
                                <div className={cn('text-[11px]', e.teacher_name ? 'text-muted-foreground' : 'text-warning')}>
                                  {e.teacher_name ?? 'no teacher'}
                                </div>
                              </>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {cell && (
              <div className="mt-5 rounded-lg border p-4">
                <p className="mb-3 text-[13px] font-medium">
                  {section?.class_name}-{section?.name} · {DAYS.find((d) => d.n === cell.weekday)?.label} · {cell.period}
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-[13px]">
                    <span className="mb-1 block text-muted-foreground">Subject</span>
                    <Select
                      value={subject}
                      onChange={setSubject}
                      placeholder="Choose subject"
                      options={(subjects.data?.items ?? []).map((s) => ({ value: s.subject_name, label: s.subject_name }))}
                    />
                  </label>
                  <label className="text-[13px]">
                    <span className="mb-1 block text-muted-foreground">Teacher</span>
                    <Select
                      value={teacher}
                      onChange={setTeacher}
                      placeholder="No teacher"
                      options={[{ value: '', label: 'No teacher' }, ...(teachers.data?.items ?? []).filter((t) => t.user_id).map((t) => ({ value: t.user_id, label: t.full_name }))]}
                    />
                  </label>
                  <Button disabled={!subject || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                  {current && (
                    <Button variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate(current.id)}>
                      Clear this slot
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => { setCell(null); setErr('') }}>Cancel</Button>
                </div>
                {err && <div className="mt-2"><FormNotice error={new Error(err)} /></div>}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
