import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

/* Plan-limit alerts for the school admin (raised nightly by seller:usage_alerts).
   The server returns nothing for anyone who is not an institution admin. */
interface Alert { metric: string; level: number; pct: number; message: string }

export function SchoolHealthBanner() {
  const q = useQuery({
    queryKey: ['usage-alerts'],
    queryFn: () => api.get<{ items: Alert[] }>('/api/v1/usage-alerts'),
    staleTime: 30 * 60_000,
    retry: false,
  })
  const items = q.data?.items ?? []
  if (!items.length) return null
  const full = items.some((a) => a.level >= 100)
  return (
    <div role="status" className={full
      ? 'flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-[13px] text-destructive'
      : 'flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[13px] text-warning'}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <span className="font-medium">{full ? 'Plan limit reached.' : 'Approaching your plan limit.'}</span>{' '}
        {items.map((a) => a.message).join(' ')} Contact your provider to raise the limit.
      </span>
    </div>
  )
}
