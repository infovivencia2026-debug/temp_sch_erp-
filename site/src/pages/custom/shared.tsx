import { PageHeader } from '@/components/layout/PageHeader'
import { Button, Card, CardHeader, useToast, Dropdown } from '@/components/ui'
import { activeModuleMap } from '@/industries'
import { canWrite } from '@/industries/access'
import { Download, Plus, Printer, MoveHorizontal } from 'lucide-react'
import { useApp } from '@/hooks/useAppState'
import { cx } from '@/lib/utils'

export interface ViewProps { moduleId: string }

/** Header used by whole-module custom pages so they match generic module pages. */
export function ModuleShell({ moduleId, subtitle, actions, children }: {
  moduleId: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode
}) {
  const mod = activeModuleMap()[moduleId]
  const app = useApp()
  const toast = useToast()
  /* Every whole-module bespoke page comes through here, so this is where the
     question "may this role change anything on it?" belongs. A student opens
     LMS for their own courses and was being offered "Create course". */
  const mayWrite = canWrite(app.role, moduleId)
  return (
    <div className="print-area" data-readonly={mayWrite ? undefined : 'true'}>
      <PageHeader
        title={mod?.label ?? moduleId}
        eyebrow={mod?.group}
        subtitle={subtitle ?? `${app.campus} · ${app.year}`}
        crumbs={[{ label: mod?.group ?? '' }, { label: mod?.label ?? '' }]}
        actions={
          <>
            <Button size="sm" icon={Printer} onClick={() => window.print()}>Print</Button>
            <Button size="sm" icon={Download} onClick={() => toast({ title: 'Export queued', tone: 'success' })}>Export</Button>
            {/* Reading and taking a copy are always allowed; the rest is not. */}
            {mayWrite && actions}
            {mayWrite && !actions && mod?.primaryAction && (
              <Button size="sm" variant="primary" icon={Plus}
                onClick={() => toast({ title: `${mod.primaryAction} — form opens here`, tone: 'info' })}>
                {mod.primaryAction}
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-10 px-6 py-10 sm:px-10">{children}</div>
    </div>
  )
}

/** Figures set as type, separated by rules rather than boxed into tiles — the
 *  number is the visual, so it does not need a container to prove it. */
export function StatRow({ items, cols = 4 }: { items: { label: string; value: string; sub?: string }[]; cols?: number }) {
  return (
    <div className={cx('grid grid-cols-1 sm:grid-cols-2 gap-px overflow-hidden rounded-lg bg-border reveal',
      cols === 3 ? 'lg:grid-cols-3' : cols === 5 ? 'md:grid-cols-3 lg:grid-cols-5' : 'md:grid-cols-4')}>
      {items.map((s) => (
        <div key={s.label} className="bg-card p-4 sm:p-6">
          <p className="eyebrow">{s.label}</p>
          <p className="mt-4 text-[24px] sm:text-[32px] font-medium leading-none tracking-[-0.035em] tabular-nums">{s.value}</p>
          {s.sub && <p className="mt-3 text-[13px] muted">{s.sub}</p>}
        </div>
      ))}
    </div>
  )
}

export function Panel({ title, subtitle, action, className, glow, children }: {
  title: string; subtitle?: string; action?: React.ReactNode; className?: string
  glow?: 'indigo' | 'violet' | 'emerald' | 'amber' | 'sky' | 'rose'; children: React.ReactNode
}) {
  return (
    <Card className={className} glow={glow}>
      <CardHeader title={title} subtitle={subtitle} action={action} />
      {children}
    </Card>
  )
}

/* ---------------------------------------------------------------------------
   MOVE TO STAGE

   The boards move cards with HTML5 drag-and-drop, which never fires on a touch
   screen — so on a phone a card could not be moved at all. Tapping the handle
   opens the same set of stages instead. Drag stays as it was for a mouse.
   --------------------------------------------------------------------------- */
export function MoveToStageMenu({ stages, current, onMove }: {
  stages: readonly string[]; current: string; onMove: (stage: string) => void
}) {
  return (
    <Dropdown
      align="right"
      trigger={
        <button aria-label={`Move from ${current}`} title="Move to…"
          className="rounded-md p-1.5 muted hover:bg-accent">
          <MoveHorizontal className="h-4 w-4" />
        </button>
      }
      items={stages.filter((s) => s !== current).map((s) => ({
        label: `Move to ${s}`,
        onClick: () => onMove(s),
      }))}
    />
  )
}
