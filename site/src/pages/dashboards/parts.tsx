import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, Download, Plus, Printer } from 'lucide-react'
import { Button, useToast } from '@/components/ui'
import { Link, useNavigate } from '@/lib/nav'
import { cx } from '@/lib/utils'
import type { DashboardConfig, KpiDef } from '@/industries/types'
import { Sparkline } from '@/components/viz'

/* ---------------------------------------------------------------------------
   Shared pieces for the ten dashboard layouts.

   Deliberately small: a stat, a panel, a delta. The layouts differ in their
   page skeleton, not in what a number looks like, so anything shared lives
   here and anything structural stays in the layout that owns it.
   --------------------------------------------------------------------------- */

/**
 * The dashboard's actions. Deliberately unstyled as a bar: each layout places
 * this where its own skeleton has room — in an editorial masthead, a utility
 * strip, a command line — so no two share a top chrome.
 */
export function DashActions({ cfg, compact }: { cfg: DashboardConfig; compact?: boolean }) {
  const toast = useToast()
  const nav = useNavigate()
  return (
    <div className={cx('flex items-center gap-1.5',
      // The 5% shrink is a desktop refinement; on a phone it pulls a 44px
      // target down to 42 and the buttons stop being comfortably tappable.
      compact && 'origin-right sm:scale-95')}>
      <Button size="sm" icon={Printer} aria-label="Print" title="Print"
        onClick={() => window.print()}>{compact ? '' : 'Print'}</Button>
      <Button size="sm" icon={Download} aria-label="Export" title="Export"
        onClick={() => toast({ title: 'Export started', tone: 'success' })}>
        {compact ? '' : 'Export'}
      </Button>
      <Button size="sm" variant="primary" icon={Plus} onClick={() => nav(cfg.primaryAction.to)}>
        {cfg.primaryAction.label}
      </Button>
    </div>
  )
}

export function Delta({ up, children }: { up: boolean; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1 text-[11.5px] tabular-nums',
      up ? 'text-emerald-500' : 'text-rose-500')}>
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {children}
    </span>
  )
}

/** A KPI that carries its own recent history rather than a bare number. */
export function StatWithSpark({ kpi, spark, size = 'md', className }: {
  kpi: KpiDef; spark?: number[]; size?: 'sm' | 'md' | 'lg'; className?: string
}) {
  const value = size === 'lg' ? 'text-[34px]' : size === 'sm' ? 'text-[19px]' : 'text-[25px]'
  return (
    <Link to={kpi.to} className={cx('group block min-w-0', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] uppercase tracking-wider muted">{kpi.label}</p>
        <kpi.icon className="h-3.5 w-3.5 shrink-0 muted" />
      </div>
      <p className={cx('mt-2 font-semibold leading-none tracking-[-0.02em] tabular-nums', value)}>{kpi.value}</p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <Delta up={kpi.up}>{kpi.delta}</Delta>
        {spark && <Sparkline data={spark} w={64} h={20} />}
      </div>
    </Link>
  )
}

/** A titled region. Every layout has regions; only their arrangement differs. */
export function Region({ title, sub, action, className, bodyClass, children }: {
  title?: string; sub?: string; action?: ReactNode
  className?: string; bodyClass?: string; children: ReactNode
}) {
  return (
    <section className={cx('flex min-h-0 min-w-0 flex-col', className)}>
      {(title || action) && (
        <header className="flex items-baseline gap-3 pb-3">
          <div className="min-w-0">
            {title && <h3 className="truncate text-[13px] font-semibold tracking-tight">{title}</h3>}
            {sub && <p className="truncate text-[11px] muted">{sub}</p>}
          </div>
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </header>
      )}
      <div className={cx('min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  )
}

/** The label a layout uses to name a band, a sector or a pane. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('eyebrow', className)}>{children}</p>
}

export function AlertList({ cfg, limit = 4, compact }: { cfg: DashboardConfig; limit?: number; compact?: boolean }) {
  return (
    <ul className="space-y-2.5">
      {cfg.alerts.slice(0, limit).map((a) => (
        <li key={a.title} className="flex gap-2.5">
          <span className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
            a.tone === 'red' ? 'bg-rose-500' : a.tone === 'amber' ? 'bg-amber-500' : 'bg-sky-500')} />
          <div className="min-w-0">
            <p className={cx('leading-snug', compact ? 'text-[12px]' : 'text-[12.5px] font-medium')}>{a.title}</p>
            {!compact && <p className="text-[11px] muted">{a.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ApprovalList({ cfg, limit = 4 }: { cfg: DashboardConfig; limit?: number }) {
  return (
    <ul className="divide-y">
      {cfg.approvals.slice(0, limit).map((p) => (
        <li key={p.id} className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px]">{p.detail}</p>
            <p className="text-[11px] muted">{p.type} · {p.id}</p>
          </div>
          <span className="shrink-0 text-[12px] font-medium tabular-nums">{p.value}</span>
        </li>
      ))}
    </ul>
  )
}

export function RankBars({ rows, unit = '%' }: { rows: { name: string; value: number }[]; unit?: string }) {
  const max = Math.max(...rows.map((r) => r.value))
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-3">
          <span className="w-[34%] shrink-0 truncate text-[12px]">{r.name}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-[2px]" style={{ background: 'hsl(var(--muted))' }}>
            <span className="block h-full rounded-[2px]" style={{ width: `${(r.value / max) * 100}%`, background: 'hsl(var(--primary))' }} />
          </span>
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums muted">{r.value}{unit}</span>
        </div>
      ))}
    </div>
  )
}
