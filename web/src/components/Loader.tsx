import { cn } from '@/lib/utils'
import { useDelayed } from '@/components/Skeleton'

/* One loading mark for the whole product.
 *
 * A thin ring with one lit arc, turning. It replaces three small triangles
 * lit in sequence, which at 22px in the middle of an empty panel read as a
 * glyph nobody recognised -- a stray icon rather than "working". A ring
 * is the mark every phone and browser already uses for the same fact, so
 * it needs no learning. Drawn in the current ink at reduced opacity so it
 * belongs to whatever surface it sits on; the arc is the ink at full
 * strength. Under reduced motion it holds still at the same strength: a
 * ring with a gap still says "not finished", which was always the message.
 *
 * The name stays TriLoader so the three call sites are untouched. The
 * sentence is kept for screen readers: `role="status"` says it once. */
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
      <span
        className="ring-loader"
        style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 9)) }}
        aria-hidden="true"
      />
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
