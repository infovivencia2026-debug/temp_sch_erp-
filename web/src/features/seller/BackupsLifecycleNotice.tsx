import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

interface SchoolStatus { state: string; read_only: boolean; read_only_until: string | null; notice: string | null }

/* One line above every screen while a school is leaving the platform: what is
   happening and, once it is read-only, that saving will be refused (the
   server answers 423 with the same words). Nothing while the school is active. */
export function BackupsLifecycleNotice() {
  const { data } = useQuery({
    queryKey: ['school-status'],
    queryFn: () => api.get<SchoolStatus>('/api/v1/school-status'),
    staleTime: 5 * 60_000,
    retry: false,
  })
  if (!data?.notice) return null
  return (
    <div
      role="status"
      className={`mb-4 rounded-md border px-3 py-2 text-[13px] ${data.read_only ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border bg-muted/40 text-muted-foreground'}`}
    >
      {data.notice}
    </div>
  )
}
