import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { cn } from '@/lib/utils'

/* Platform announcements for the signed-in user (GET /platform-notices, now
   targeted by school, plan, group and audience; seller/announcements.ts).
   Shown once mounted in the shell; each one shown is marked seen, and the
   cross dismisses it for this user. */

interface Notice { id: string; severity: 'info' | 'warning' | 'critical'; title: string; body?: string; seen?: boolean }

const KEY = ['platform-notices']

export function AnnouncementsBanner() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<List<Notice>>('/api/v1/platform-notices'),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: false,
  })
  const items = q.data?.items ?? []
  const unseen = items.filter((n) => !n.seen).map((n) => n.id).join(',')
  useEffect(() => {
    if (!unseen) return
    for (const id of unseen.split(',')) api.post(`/api/v1/platform-notices/${id}/seen`).catch(() => {})
  }, [unseen])
  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/platform-notices/${id}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-40 flex max-w-[min(420px,calc(100vw-32px))] flex-col gap-2">
      {items.map((n) => (
        <div
          key={n.id}
          role={n.severity === 'critical' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-lg border bg-card px-4 py-3 text-[13px] shadow-lg',
            n.severity === 'critical' && 'border-destructive/50',
            n.severity === 'warning' && 'border-warning/50',
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{n.title}</div>
            {n.body && <div className="mt-0.5 text-muted-foreground">{n.body}</div>}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => dismiss.mutate(n.id)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
