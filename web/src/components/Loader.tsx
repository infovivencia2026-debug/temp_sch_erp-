import { cn } from '@/lib/utils'
import { useDelayed } from '@/components/Skeleton'

/* One loading mark for the whole product.
 *
 * Three small triangles, lit one after another. It is drawn in the current
 * ink at reduced opacity so it belongs to whatever surface it sits on, and it
 * never appears for the first 220ms so cached screens do not flicker a mark
 * on their way in. Under reduced motion the three sit still at half strength.
 *
 * The sentence is kept for screen readers: `role="status"` says it once. */
export function TriLoader({
  size = 20,
  className,
  label,
}: {
  size?: number
  className?: string
  label?: string
}) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex items-center justify-center', className)}>
      <svg
        className="tri-loader"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <polygon points="12,2 17,10 7,10" />
        <polygon points="6,13 11,21 1,21" />
        <polygon points="18,13 23,21 13,21" />
      </svg>
      <span className="sr-only">{label ?? 'Loading…'}</span>
    </span>
  )
}

/** A centred mark with room around it: the stand-in for a panel or page. */
export function LoaderBlock({ label, delay, className }: { label?: string; delay?: number; className?: string }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <div className={cn('flex items-center justify-center py-12', className)} aria-busy="true">
      <TriLoader size={22} label={label} className="text-muted-foreground" />
    </div>
  )
}
