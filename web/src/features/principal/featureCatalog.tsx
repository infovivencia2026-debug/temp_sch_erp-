import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/* One grantable screen, as served by GET /api/v1/admin/features: one item per
   catalogue KEY. The same name in two workspaces is two screens ("Take
   attendance" for a teacher is their register; for the office it is the
   school's register with import and export), so it is listed, held and
   granted by its exact key, with the workspace it belongs to beside it. */
export interface FeatureItem {
  key: string
  name: string
  summary: string
  unlocks: string[]
  role_key: string
  role_name: string
  section: string
}

export interface RoleFeatures {
  role_key: string
  role_name: string
  items: FeatureItem[]
}

/** Groups by workspace, in the order the catalogue lists the workspaces. */
export function groupByRole(items: FeatureItem[]): RoleFeatures[] {
  const out: RoleFeatures[] = []
  const idx = new Map<string, RoleFeatures>()
  for (const f of items) {
    let g = idx.get(f.role_key)
    if (!g) { g = { role_key: f.role_key, role_name: f.role_name, items: [] }; idx.set(f.role_key, g); out.push(g) }
    g.items.push(f)
  }
  return out
}

/** A collapsible workspace heading with how many of its screens are held.
    Closed by default; `forceOpen` opens it while a search has hits inside. */
export function RoleGroup({ name, held, total, forceOpen, children }: {
  name: string
  held: number
  total: number
  forceOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const shown = open || forceOpen
  return (
    <div className="border-b last:border-b-0">
      <button type="button" onClick={() => setOpen(!shown)} aria-expanded={shown}
        className="flex min-h-[44px] w-full items-center gap-2 px-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[40px]">
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{name}</span>
        <span className="shrink-0 text-[12.5px] text-muted-foreground">{held} of {total} held</span>
        <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150', !shown && '-rotate-90')} />
      </button>
      {shown && <div className="pb-3 pt-1">{children}</div>}
    </div>
  )
}
