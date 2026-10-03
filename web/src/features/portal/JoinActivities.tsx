import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatPaise, cn } from '@/lib/utils'

/* CLUBS & ACTIVITIES A CHILD CAN JOIN.

   Dance, skating, chess: every running activity with its fee and seats left.
   Join goes straight through (the owner's rule, no approval): the child is
   enrolled and the fee lands on the family's fees page, exactly as when the
   office enrols them. Shown on the parent's home and the student's My day. */
interface Act {
  id: string; name: string; category?: string; schedule?: string; venue?: string
  fee_paise: number; capacity: number; taken: number; joined: boolean
  payment?: 'paid' | 'unpaid' | 'no_fee' | null
}

export default function JoinActivities({ studentId }: { studentId?: string }) {
  const qc = useQueryClient()
  const q = studentId ? `?student_id=${studentId}` : ''
  const list = useQuery({
    queryKey: ['portal-activities', studentId ?? 'self'],
    queryFn: () => api.get<{ items: Act[] }>(`/api/v1/portal/activities${q}`),
    retry: false,
  })
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok?: string; err?: string } | null>(null)
  const items = list.data?.items ?? []
  if (list.error || items.length === 0) return null

  const join = async (a: Act) => {
    setBusy(true); setMsg(null)
    try {
      await api.post(`/api/v1/portal/activities/${a.id}/join`, { student_id: studentId })
      setMsg({ ok: `Joined ${a.name}.${a.fee_paise > 0 ? ` ${formatPaise(a.fee_paise)} is added to the fees page.` : ''}` })
      setAsking(null)
      void qc.invalidateQueries({ queryKey: ['portal-activities'] })
    } catch (e) {
      setMsg({ err: (e as Error).message })
    } finally { setBusy(false) }
  }

  return (
    <section className="card overflow-hidden p-0" aria-label="Clubs and activities">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <h2 className="text-[15px] font-bold">Clubs & activities</h2>
        {msg?.ok && <span className="text-[13px] font-semibold text-[#15803d]">✓ {msg.ok}</span>}
      </div>
      {msg?.err && <p className="mx-4 mb-2 rounded-lg bg-[#fef2f2] px-3 py-2 text-[13px] text-[#b91c1c]">{msg.err}</p>}
      <ul className="flex flex-col gap-2 px-3 pb-3">
        {items.map((a) => {
          const left = a.capacity > 0 ? Math.max(0, a.capacity - a.taken) : null
          const full = left === 0
          return (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3">
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold">{a.name}</span>
                <span className="block text-[12.5px] text-muted-foreground">
                  {[a.schedule, a.venue].filter(Boolean).join(' · ') || a.category}
                  {left !== null && ` · ${left} seat${left === 1 ? '' : 's'} left`}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-semibold tabular-nums">{a.fee_paise > 0 ? formatPaise(a.fee_paise) : 'Free'}</span>
                {a.joined ? (
                  a.payment === 'unpaid'
                    ? <span className="rounded-full bg-[#fef3c7] px-3 py-1 text-[12.5px] font-semibold text-[#b45309]">Enrolled · not paid yet</span>
                    : <span className="rounded-full bg-[#dcfce7] px-3 py-1 text-[12.5px] font-semibold text-[#15803d]">✓ Enrolled{a.payment === 'paid' ? ' · paid' : ''}</span>
                ) : asking === a.id ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => join(a)}
                      className="rounded-full bg-primary px-3.5 py-1.5 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60">
                      {busy ? 'Joining…' : a.fee_paise > 0 ? `Join & pay ${formatPaise(a.fee_paise)}` : 'Confirm'}
                    </button>
                    <button type="button" onClick={() => setAsking(null)} className="text-[12.5px] text-muted-foreground">Cancel</button>
                  </>
                ) : (
                  <button type="button" disabled={full} onClick={() => { setAsking(a.id); setMsg(null) }}
                    className={cn('rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold', full ? 'text-muted-foreground' : 'border-primary text-primary hover:bg-primary/10')}>
                    {full ? 'Full' : 'Join'}
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
