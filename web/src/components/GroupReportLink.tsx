import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Network } from 'lucide-react'
import { api, type List } from '@/lib/api'

/* The way into a school group's combined report (features/shared/GroupReport),
   in the shell header beside the school switcher. Shown only to someone the
   server lists as a group admin; the report itself is checked server-side. */

interface MyGroup { id: string; name: string }

export function useMyGroups() {
  return useQuery({
    queryKey: ['my-groups'],
    queryFn: () => api.get<List<MyGroup>>('/api/v1/me/groups'),
    staleTime: 5 * 60 * 1000,
  })
}

/** Header link, shown only to a group admin. */
export function GroupReportLink() {
  const mine = useMyGroups()
  if (!(mine.data?.items ?? []).length) return null
  return (
    <Link
      to="/group-report"
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] bg-surface-hover/60 px-2 text-[12.5px] text-muted-foreground hover:text-foreground"
      title="Combined numbers for your group of schools"
    >
      <Network className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">Group</span>
    </Link>
  )
}
