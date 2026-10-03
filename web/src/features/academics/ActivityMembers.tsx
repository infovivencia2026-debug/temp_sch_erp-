import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Section } from '@/lib/api'
import { Button, Card, CardHeader, Select, FormNotice } from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* ADD STUDENTS TO AN ACTIVITY, from the activity.

   Adding a child used to happen one at a time from each child's Student 360,
   which is where nobody looks when they are standing up the dance club. Pick
   a class, tick the children, Add: each is enrolled exactly as Student 360
   would (the seat is taken and the fee is billed to the family). */
export default function ActivityMembers({ activity, onClose, show = 'add' }: {
  activity: { id: string; name: string; fee_paise: number; capacity: number; enrolled: number }
  onClose: () => void
  /* WHICH QUESTION THIS PANEL WAS OPENED TO ANSWER.

     One panel does two things: it lists who is enrolled, and it adds more.
     Opened from the enrolment count it was still headed "Add students to
     dance", with the list of names below a class picker and a Add button --
     so pressing "1" to see who that one person is produced a form for
     enrolling a second. The answer was on screen and did not look like one.

     Same panel, two orders: asked who is in it, the names come first and the
     adding is underneath; asked to add somebody, the picker comes first. */
  show?: 'add' | 'members'
}) {
  const qc = useQueryClient()
  const [section, setSection] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: number; failed: string[] } | null>(null)
  const sections = useQuery({
    queryKey: ['academics', 'sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const students = useQuery({
    queryKey: ['students', 'section', section],
    queryFn: () => api.get<List<{ id: string; full_name: string; admission_no: string }>>(`/api/v1/students?section_id=${section}&limit=200`),
    enabled: !!section,
  })
  const members = useQuery({
    queryKey: ['activity-members', activity.id],
    queryFn: () => api.get<List<{ id: string; name: string; admission_no: string; class_label?: string; guardian_name?: string; guardian_phone?: string; payment: 'paid' | 'unpaid' | 'no_fee' }>>(`/api/v1/academics/activities/${activity.id}/members`),
  })
  const seatsLeft = activity.capacity > 0 ? Math.max(0, activity.capacity - activity.enrolled) : null

  const add = async () => {
    setBusy(true)
    const failed: string[] = []
    let ok = 0
    const names = new Map((students.data?.items ?? []).map((s) => [s.id, s.full_name]))
    for (const id of picked) {
      try {
        await api.post(`/api/v1/students/${id}/activities`, { activity_id: activity.id })
        ok++
      } catch (e) {
        failed.push(`${names.get(id) ?? 'A child'}: ${(e as Error).message}`)
      }
    }
    setBusy(false)
    setResult({ ok, failed })
    setPicked(new Set())
    void qc.invalidateQueries({ queryKey: ['activities'] })
    void qc.invalidateQueries({ queryKey: ['activity-members', activity.id] })
  }

  return (
    <Card>
      <CardHeader
        title={show === 'members' ? `Who is enrolled in ${activity.name}` : `Add students to ${activity.name}`}
        description={show === 'members'
          ? 'Every child in this activity, their class, the parent to ring and whether the fee is paid.'
          : undefined}
        action={<Button size="sm" variant="secondary" onClick={onClose}>Close</Button>} />
      <div className={show === 'members' ? 'flex flex-col-reverse gap-3 p-5' : 'space-y-3 p-5'}>
        {/* The billing note belongs to adding somebody, so it sits with the
            adding. Reversing the column keeps both orders in one tree rather
            than writing the panel twice and letting the two drift. */}
        <p className="text-[13px] text-muted-foreground">
          {activity.fee_paise > 0 ? `Each child added is billed ${formatPaise(activity.fee_paise)}.` : 'This activity is free.'}
          {seatsLeft !== null && ` ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left.`}
        </p>
        {(members.data?.items ?? []).length > 0 && (
          <div className="rounded-xl border">
            <div className="flex items-center justify-between border-b px-4 py-2 text-[12.5px] font-semibold text-muted-foreground">
              <span>Enrolled · {members.data!.items.length}</span>
              <span>{members.data!.items.filter((m) => m.payment === 'unpaid').length} not paid yet</span>
            </div>
            {/* WHO, WHERE, WHO TO RING, AND WHETHER THEY HAVE PAID.

                It was a name, a class and a badge. The one thing anybody does
                with "not paid" is telephone the family, and the number was two
                screens away -- the child's record and back. It is a table now,
                with the parent's name and number beside each child and the
                number a tap-to-call link, because on the phone this screen is
                most often read on, that is the whole errand. */}
            <ul className="max-h-72 divide-y overflow-auto">
              {members.data!.items.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold">{m.name}</span>
                    <span className="block truncate text-[12.5px] text-muted-foreground">
                      {[m.class_label, m.admission_no].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="min-w-0 shrink-0 text-right">
                    {m.guardian_phone ? (
                      <a href={`tel:${m.guardian_phone}`} className="block font-mono text-[13px] text-primary">
                        {m.guardian_phone}
                      </a>
                    ) : (
                      <span className="block text-[12.5px] text-muted-foreground">no number on record</span>
                    )}
                    {m.guardian_name && (
                      <span className="block truncate text-[11.5px] text-muted-foreground">{m.guardian_name}</span>
                    )}
                  </span>
                  <span className={'shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ' + (m.payment === 'unpaid' ? 'bg-[#fef3c7] text-[#b45309]' : m.payment === 'paid' ? 'bg-[#dcfce7] text-[#15803d]' : 'bg-muted text-muted-foreground')}>
                    {m.payment === 'unpaid' ? 'Not paid' : m.payment === 'paid' ? 'Paid' : 'No fee'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="pt-1 text-[13px] font-semibold">Add more</p>
        <div className="max-w-xs">
          <Select value={section} onChange={(v) => { setSection(v); setPicked(new Set()) }} placeholder="Pick a class"
            options={(sections.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.class_name}-${s.name}` }))} />
        </div>
        {section && (
          <div className="max-h-80 divide-y overflow-auto rounded-xl border">
            {(students.data?.items ?? []).map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
                <input type="checkbox" className="h-4 w-4" checked={picked.has(s.id)}
                  onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n })} />
                <span className="text-[14px] font-medium">{s.full_name}</span>
                <span className="font-mono text-[12px] text-muted-foreground">{s.admission_no}</span>
              </label>
            ))}
            {students.data && students.data.items.length === 0 && <p className="px-4 py-3 text-[13px] text-muted-foreground">No children in this class.</p>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!picked.size || busy} onClick={add}>
            {busy ? 'Adding…' : `Add ${picked.size || ''} ${picked.size === 1 ? 'child' : 'children'}`.replace('  ', ' ')}
          </Button>
          {result && result.ok > 0 && (
            <span className="text-[14px] font-semibold text-[#15803d]">✓ {result.ok} added{activity.fee_paise > 0 ? ' and billed' : ''}.</span>
          )}
        </div>
        {result && result.failed.length > 0 && <FormNotice error={new Error(result.failed.join(' · '))} />}
      </div>
    </Card>
  )
}
