import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Card, CardHeader, FormNotice } from '@/components/ui'
import { useSession } from '@/lib/session'

/* QUICK ASSIST, the person's side (worker/src/routes/help/assist.ts).

   AssistCard: on the Help Centre, for staff. Makes a code to read out.
   AssistBanner: in the shell, while XULO support is looking. Polls only
   while a code was made in this tab in the last 45 minutes, so nobody else
   pays for it. */

const KEY = 'assist.until'
const watching = () => { try { return Number(sessionStorage.getItem(KEY) ?? 0) > Date.now() } catch { return false } }

export function AssistCard() {
  const roles = useSession().user?.roles ?? []
  const qc = useQueryClient()
  const [now, setNow] = useState(Date.now())
  const make = useMutation({
    mutationFn: () => api.post<{ code: string; expires_at: string }>('/api/v1/help/assist/code'),
    onSuccess: () => {
      try { sessionStorage.setItem(KEY, String(Date.now() + 45 * 60_000)) } catch { /* private mode */ }
      qc.invalidateQueries({ queryKey: ['assist', 'active'] })
    },
  })
  useEffect(() => { if (!make.data) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [make.data])
  if (roles.every((r) => r === 'parent' || r === 'student')) return null
  const left = make.data ? Math.max(0, Date.parse(make.data.expires_at) - now) : 0
  return (
    <Card>
      <CardHeader title="Let support see my screen" />
      <div className="space-y-3 p-[var(--card-pad)] text-[14px]">
        {make.data && left > 0 ? (
          <>
            <p className="text-[32px] font-semibold tracking-[0.2em] tabular-nums" aria-label={`Code ${make.data.code.split('').join(' ')}`}>{make.data.code}</p>
            <p className="text-muted-foreground">Read this code to XULO support. It works once, for {Math.floor(left / 60000)} min {String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} s more. They can look at the school for 30 minutes but cannot change anything, and you can end it at any time.</p>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">When XULO support asks to see what you see, make a code and read it to them. They can look but not change anything, and your school's administrator sees the session in the support register.</p>
            <Button variant="secondary" pending={make.isPending} onClick={() => make.mutate()}>{make.data ? 'Make a new code' : 'Make a code'}</Button>
          </>
        )}
        <FormNotice error={make.error} />
      </div>
    </Card>
  )
}

export function AssistBanner() {
  const session = useSession()
  const qc = useQueryClient()
  const school = !!session.institution && !session.user?.platform_admin
  const q = useQuery({
    queryKey: ['assist', 'active'],
    queryFn: () => api.get<{ session?: { id: string; operator: string; expires_at: string } }>('/api/v1/help/assist/active'),
    enabled: school && watching(),
    refetchInterval: 20_000,
    staleTime: 0,
  })
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/help/assist/${id}/end`),
    onSuccess: () => { try { sessionStorage.removeItem(KEY) } catch { /* private mode */ } qc.invalidateQueries({ queryKey: ['assist', 'active'] }) },
  })
  const s = q.data?.session
  if (!s) return null
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[125] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b-2 border-warning bg-card px-4 py-2 text-[14px] font-medium text-foreground shadow-lg"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 8px)' }}>
      <span>{s.operator} from XULO support can see the school until {new Date(s.expires_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}. Nothing can be changed.</span>
      <Button size="sm" variant="secondary" pending={end.isPending} onClick={() => end.mutate(s.id)}>End now</Button>
    </div>
  )
}
