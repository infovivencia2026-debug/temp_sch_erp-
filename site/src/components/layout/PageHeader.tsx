import { Link } from '@/lib/nav'
import { ChevronRight, Home } from 'lucide-react'

/**
 * Editorial page opening: a micro-label sets context, then one large statement
 * at medium weight, then the supporting line. The eyebrow is what stops an
 * oversized headline from arriving without a frame.
 */
export function PageHeader({ title, subtitle, crumbs, actions, eyebrow, index }: {
  title: string
  subtitle?: string
  crumbs?: { label: string; to?: string }[]
  actions?: React.ReactNode
  /** Micro-context above the headline — usually the module group. */
  eyebrow?: string
  /** Section number, rendered as the catalogue-style "/ 03". */
  index?: number
}) {
  return (
    <div className="page-head border-b px-6 pb-10 pt-8 sm:px-10">
      <nav aria-label="Breadcrumb" className="crumbs mb-6 flex items-center gap-1.5 text-[12px] muted no-print">
        <Link to="/" title="All industries" className="transition-colors hover:text-foreground"><Home className="h-3.5 w-3.5" /></Link>
        {(crumbs ?? []).filter((c) => c.to || c === crumbs?.[crumbs.length - 1]).map((c) => (
          <span key={c.label} className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 opacity-40" />
            {c.to ? <Link to={c.to} className="transition-colors hover:text-foreground">{c.label}</Link> : <span>{c.label}</span>}
          </span>
        ))}
      </nav>

      <div className="head-row flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="head-copy min-w-0 max-w-3xl reveal">
          {(eyebrow || index !== undefined) && (
            <div className="mb-4 flex items-baseline gap-4">
              {index !== undefined && <span className="section-no">{String(index).padStart(2, '0')}</span>}
              {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            </div>
          )}
          <h1 className="display">{title}</h1>
          {subtitle && <p className="head-sub mt-5 max-w-xl text-[17px] leading-relaxed muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2.5 no-print reveal reveal-1">{actions}</div>}
      </div>
    </div>
  )
}
