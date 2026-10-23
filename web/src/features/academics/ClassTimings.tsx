import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  Card, CardHeader, Button, Select, Input, Table, Td, Checkbox, Dialog, ConfirmButton, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'
import { WEEKDAYS } from '@/lib/utils'

/* TIMINGS PER CLASS (owner, 2026-10-13: "let them edit the timings per class
 * while creating a timetable").
 *
 * Every class runs to the school day unless it is given timings of its own:
 * Nursery going home at noon, primary with a longer lunch. A section can
 * differ from its class too. The rule lives on the server
 * (worker/src/routes/scheduling/bell.ts); this card only chooses.
 *
 * "Edit timings for this class" copies the day the class runs to now into a
 * new set named after it, so the person starts from something real and only
 * changes what differs. A class that already has a timetable keeps it:
 * lessons follow the period of the same number, and anything that has no
 * place in the new day is named before it is dropped.
 */

const BASE = '/api/v1/setup/bell-schedules'

interface BellPeriod { id?: string; name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean }
interface Schedule {
  id: string; name: string; is_default: boolean; periods: BellPeriod[]
  classes: { id: string; name: string }[]
  sections: { id: string; name: string; class_id: string; class_name: string }[]
}
interface Listing {
  items: Schedule[]
  classes: { id: string; name: string; bell_schedule_id: string | null }[]
  sections: { id: string; name: string; class_id: string; class_name: string; bell_schedule_id: string | null }[]
}
interface Dropped { section: string; weekday: number; period: string; subject: string; draft: boolean }

const EDIT = '__edit'
const SAME = ''

/** The slots a change would drop, when the server refused for that reason. */
const droppedOf = (e: unknown): Dropped[] | null =>
  e instanceof ApiError && e.status === 409 && (e.body as { code?: string })?.code === 'slots_dropped'
    ? ((e.body as { dropped?: Dropped[] }).dropped ?? [])
    : null

function DropWarning({ dropped, onConfirm, onCancel, pending }: {
  dropped: Dropped[]; onConfirm: () => void; onCancel: () => void; pending?: boolean
}) {
  return (
    <div className="rounded-lg border border-warning/50 bg-warning/5 p-3 text-[13px]">
      <p className="font-medium">
        {dropped.length === 1 ? 'This slot has' : `These ${dropped.length} slots have`} no place in the new timings and will be removed:
      </p>
      <ul className="mt-1.5 max-h-40 list-disc overflow-y-auto pl-5 text-muted-foreground">
        {dropped.map((d, i) => (
          <li key={i}>
            {d.section} · {WEEKDAYS[d.weekday - 1]} · {d.period}{d.subject ? ` · ${d.subject}` : ''}{d.draft ? ' (suggestion)' : ''}
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button size="sm" tone="danger" pending={pending} onClick={onConfirm}>Change anyway</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

export default function ClassTimings() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['bell-schedules', 'setup'], queryFn: () => api.get<Listing>(BASE) })
  const [editing, setEditing] = useState<string | null>(null)
  const [openClass, setOpenClass] = useState<string | null>(null)
  const [pendingAssign, setPendingAssign] = useState<{ body: Record<string, unknown>; dropped: Dropped[] } | null>(null)

  const refresh = () => {
    for (const k of [['bell-schedules'], ['master-timetable'], ['periods'], ['timetable']]) qc.invalidateQueries({ queryKey: k })
  }

  const assign = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put(`${BASE}/assign`, body),
    onSuccess: () => { setPendingAssign(null); refresh() },
    onError: (e, body) => { const d = droppedOf(e); if (d) setPendingAssign({ body, dropped: d }) },
  })

  /* "Edit timings for this class": a copy of what it runs to now, named after it. */
  const ownCopy = useMutation({
    mutationFn: async ({ classId, className, from }: { classId: string; className: string; from: string }) => {
      const taken = new Set((list.data?.items ?? []).map((s) => s.name.toLowerCase()))
      let name = `${className} timings`
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${className} timings ${n}`
      const made = await api.post<{ id: string }>(BASE, { name, copy_from: from })
      await api.put(`${BASE}/assign`, { class_id: classId, bell_schedule_id: made.id })
      return made.id
    },
    onSuccess: (id) => { refresh(); setEditing(id) },
  })

  if (list.isLoading) return <Card><SkeletonTable rows={4} /></Card>
  if (list.error) return <Card><ErrorState error={list.error} /></Card>

  const data = list.data!
  const schedules = data.items
  const schoolDay = schedules.find((s) => s.is_default)
  const others = schedules.filter((s) => !s.is_default)
  const nameOf = (id: string | null) => (id ? schedules.find((s) => s.id === id)?.name ?? 'School day' : 'School day')
  const span = (s?: Schedule) => {
    const ps = s?.periods ?? []
    if (!ps.length) return ''
    return `${ps.filter((p) => !p.is_break).length} periods, ${ps[0].starts_at}–${ps[ps.length - 1].ends_at}`
  }

  return (
    <Card>
      <CardHeader
        title="Class timings"
        description="Every class runs to the school day unless it has timings of its own."
      />
      {!schoolDay ? (
        <p className="px-5 py-4 text-[13.5px] text-muted-foreground">
          Set the school day first (Setup, The school day). Classes can then have timings of their own.
        </p>
      ) : (
        <>
          <Table head={['Class', 'Timings', '']} empty={data.classes.length === 0} emptyLabel="No classes yet.">
            {data.classes.map((cl) => {
              const own = cl.bell_schedule_id && cl.bell_schedule_id !== schoolDay.id ? cl.bell_schedule_id : ''
              const secs = data.sections.filter((s) => s.class_id === cl.id)
              const differing = secs.filter((s) => s.bell_schedule_id)
              return (
                <tr key={cl.id} className="align-top">
                  <Td className="font-medium">
                    {cl.name}
                    {differing.length > 0 && (
                      <p className="text-[12px] font-normal text-muted-foreground">
                        {differing.map((s) => `${s.name}: ${nameOf(s.bell_schedule_id)}`).join(' · ')}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <div className="w-60">
                      <Select
                        value={own}
                        onChange={(v) => {
                          if (v === EDIT) {
                            if (own) setEditing(own)
                            else ownCopy.mutate({ classId: cl.id, className: cl.name, from: schoolDay.id })
                            return
                          }
                          assign.mutate({ class_id: cl.id, bell_schedule_id: v || null })
                        }}
                        options={[
                          { value: '', label: `School day${span(schoolDay) ? ` (${span(schoolDay)})` : ''}` },
                          ...others.map((s) => ({ value: s.id, label: `${s.name}${span(s) ? ` (${span(s)})` : ''}` })),
                          { value: EDIT, label: own ? 'Edit these timings…' : 'Edit timings for this class…' },
                        ]}
                      />
                    </div>
                    {openClass === cl.id && secs.map((s) => (
                      <div key={s.id} className="mt-2 flex items-center gap-2">
                        <span className="w-16 text-[12.5px] text-muted-foreground">{cl.name}-{s.name}</span>
                        <div className="w-44">
                          <Select
                            value={s.bell_schedule_id ?? SAME}
                            onChange={(v) => assign.mutate({ section_id: s.id, bell_schedule_id: v || null })}
                            options={[
                              { value: SAME, label: 'Same as class' },
                              ...schedules.map((x) => ({ value: x.id, label: x.is_default ? 'School day' : x.name })),
                            ]}
                          />
                        </div>
                      </div>
                    ))}
                  </Td>
                  <Td className="text-right">
                    {secs.length > 1 && (
                      <Button size="sm" variant="ghost" onClick={() => setOpenClass(openClass === cl.id ? null : cl.id)}>
                        {openClass === cl.id ? 'Done' : 'By section'}
                      </Button>
                    )}
                  </Td>
                </tr>
              )
            })}
          </Table>
          {pendingAssign && (
            <div className="px-5 pb-4">
              <DropWarning
                dropped={pendingAssign.dropped}
                pending={assign.isPending}
                onConfirm={() => assign.mutate({ ...pendingAssign.body, confirm: true })}
                onCancel={() => setPendingAssign(null)}
              />
            </div>
          )}
          {!pendingAssign && <div className="px-5"><FormNotice error={droppedOf(assign.error) ? undefined : assign.error ?? ownCopy.error} /></div>}

          {others.length > 0 && (
            <div className="border-t px-5 py-4">
              <p className="eyebrow mb-2 text-muted-foreground">Saved timings</p>
              <ul className="space-y-2">
                {others.map((s) => (
                  <SavedRow key={s.id} s={s} span={span(s)} onEdit={() => setEditing(s.id)} onChanged={refresh} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {editing && (() => {
        const s = schedules.find((x) => x.id === editing)
        return s ? <TimingsEditor key={s.id} schedule={s} onClose={() => setEditing(null)} onSaved={() => { refresh(); setEditing(null) }} /> : null
      })()}
    </Card>
  )
}

function SavedRow({ s, span, onEdit, onChanged }: { s: Schedule; span: string; onEdit: () => void; onChanged: () => void }) {
  const [dropped, setDropped] = useState<Dropped[] | null>(null)
  const del = useMutation({
    mutationFn: (confirm: boolean) => api.del(`${BASE}/${s.id}${confirm ? '?confirm=1' : ''}`),
    onSuccess: () => { setDropped(null); onChanged() },
    onError: (e) => setDropped(droppedOf(e)),
  })
  const used = [...s.classes.map((c) => c.name), ...s.sections.map((x) => `${x.class_name}-${x.name}`)]
  return (
    <li className="rounded-lg border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{s.name}</span>
        <span className="text-[12.5px] text-muted-foreground">{span || 'no periods yet'}</span>
        <span className="text-[12.5px] text-muted-foreground">{used.length ? `Used by ${used.join(', ')}` : 'Not used'}</span>
        <span className="ml-auto" />
        <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>
        <ConfirmButton
          tone="danger"
          variant="ghost"
          confirmLabel="Delete"
          question={used.length ? 'Its classes go back to the school day.' : 'Delete these timings?'}
          onConfirm={() => del.mutate(false)}
        >
          Delete
        </ConfirmButton>
      </div>
      {dropped && (
        <div className="mt-2">
          <DropWarning dropped={dropped} pending={del.isPending} onConfirm={() => del.mutate(true)} onCancel={() => setDropped(null)} />
        </div>
      )}
      {!dropped && <FormNotice error={droppedOf(del.error) ? undefined : del.error} />}
    </li>
  )
}

/* The rows of one set of timings: name, start, end, break. Order is the
   order of the day; lessons are matched to periods by that order. */
function TimingsEditor({ schedule, onClose, onSaved }: { schedule: Schedule; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(schedule.name)
  const [rows, setRows] = useState<BellPeriod[]>(schedule.periods.map((p) => ({ ...p })))
  const [dropped, setDropped] = useState<Dropped[] | null>(null)

  const save = useMutation({
    mutationFn: (confirm: boolean) => api.put(`${BASE}/${schedule.id}`, {
      name,
      periods: rows.map((r, i) => ({ name: r.name, sequence: i + 1, starts_at: r.starts_at, ends_at: r.ends_at, is_break: r.is_break })),
      confirm,
    }),
    onSuccess: onSaved,
    onError: (e) => setDropped(droppedOf(e)),
  })

  const set = (i: number, patch: Partial<BellPeriod>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    setRows(next)
  }
  const add = () => {
    const last = rows[rows.length - 1]
    const start = last?.ends_at || '09:00'
    const [h, m] = start.split(':').map(Number)
    const end = h * 60 + m + 40
    const hhmm = `${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
    setRows([...rows, { name: `Period ${rows.filter((r) => !r.is_break).length + 1}`, sequence: rows.length + 1, starts_at: start, ends_at: hhmm, is_break: false }])
  }

  return (
    <Dialog
      onClose={onClose}
      title={schedule.is_default ? 'School day' : 'Edit timings'}
      size="lg"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button pending={save.isPending} onClick={() => save.mutate(false)} disabled={rows.length === 0}>Save</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="w-72">
          <Input value={name} onChange={setName} placeholder="Name" srLabel="Name of these timings" />
        </div>
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-5 text-right text-[12px] tabular-nums text-muted-foreground">{i + 1}</span>
              <Input value={r.name} onChange={(v) => set(i, { name: v })} className="w-36" srLabel={`Name of row ${i + 1}`} />
              <Input type="time" value={r.starts_at} onChange={(v) => set(i, { starts_at: v })} className="w-28" srLabel={`Start of ${r.name}`} />
              <Input type="time" value={r.ends_at} onChange={(v) => set(i, { ends_at: v })} className="w-28" srLabel={`End of ${r.name}`} />
              <Checkbox checked={r.is_break} onChange={(v) => set(i, { is_break: v })} label="Break" />
              <Button size="sm" variant="ghost" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={add}>Add a period</Button>
        {dropped && (
          <DropWarning dropped={dropped} pending={save.isPending} onConfirm={() => save.mutate(true)} onCancel={() => setDropped(null)} />
        )}
        {!dropped && <FormNotice error={droppedOf(save.error) ? undefined : save.error} />}
      </div>
    </Dialog>
  )
}
