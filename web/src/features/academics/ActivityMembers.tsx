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
export default function ActivityMembers({ activity, onClose }: {
  activity: { id: string; name: string; fee_paise: number; capacity: number; enrolled: number }
  onClose: () => void
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
  }

  return (
    <Card>
      <CardHeader title={`Add students to ${activity.name}`}
        action={<Button size="sm" variant="secondary" onClick={onClose}>Close</Button>} />
      <div className="space-y-3 p-5">
        <p className="text-[13px] text-muted-foreground">
          {activity.fee_paise > 0 ? `Each child added is billed ${formatPaise(activity.fee_paise)}.` : 'This activity is free.'}
          {seatsLeft !== null && ` ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left.`}
        </p>
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
