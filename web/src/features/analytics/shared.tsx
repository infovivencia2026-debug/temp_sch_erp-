import { Download } from 'lucide-react'
import { Button } from '@/components/ui'

/**
 * Helpers shared by the seven administrative roll-up screens.
 *
 * Kept in the feature folder rather than pushed into components/ui: the CSV
 * convention below is this tier's, not the whole product's, and widening a
 * shared component to accommodate one area is how shared components stop being
 * shareable.
 */

/**
 * Download link for a roll-up's CSV.
 *
 * ui.tsx's ExportButton points at /api/v1/export/{name}, which is a fixed
 * allowlist of whole-table extracts. These reports answer CSV from the same
 * query and the same scope as their JSON — ?format=csv on the endpoint the
 * screen is already reading — so the file a head of department downloads
 * contains their department and nothing else. That property is the whole
 * reason not to reuse the other button.
 *
 * A plain anchor rather than fetch-and-blob so the browser streams it to disk
 * and the session cookie rides along.
 */
export function CsvButton({ href, label = 'Export CSV' }: { href: string; label?: string }) {
  const sep = href.includes('?') ? '&' : '?'
  return (
    <a href={`${href}${sep}format=csv`} download>
      <Button variant="outline" size="sm">
        <Download className="h-3.5 w-3.5" />
        {label}
      </Button>
    </a>
  )
}

/**
 * A percentage the server may have left null because the denominator was zero.
 *
 * It may also be impossible. A share of something cannot exceed the whole, so
 * a value above 100 (or below zero) is not a high score — it is the arithmetic
 * faithfully reporting that the two halves of the ratio do not belong to each
 * other. The known case is marks entered against a different maximum from the
 * one printed on the paper: 50 on a paper out of 20 gives an honest 250%.
 *
 * Such a value is refused rather than clamped. Clamping to 100% would turn a
 * data-entry error somebody can still fix into a plausible number nobody will
 * ever question, and the school would go on quoting it. The screens that use
 * this pair a refused cell with a line naming the cause; `impossiblePct` is
 * how they find out they need to.
 */
export function pct(v?: number | null) {
  if (v === null || v === undefined) return '—'
  if (impossiblePct(v)) return '—'
  // One decimal, always. The roll-up SQL rounds to one; anything reaching here
  // unrounded printed as 87.66325536062378%.
  return `${Number(v.toFixed(1))}%`
}

/** True when a percentage cannot be what it says it is. See `pct`. */
export function impossiblePct(v?: number | null): boolean {
  return v !== null && v !== undefined && (v > 100 || v < 0)
}

/** Tone for a percentage where higher is better. */
export function goodPct(v?: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (v === null || v === undefined) return 'neutral'
  // An impossible percentage is not an excellent one.
  if (impossiblePct(v)) return 'danger'
  if (v >= 85) return 'success'
  if (v >= 60) return 'warning'
  return 'danger'
}

/**
 * The line that goes with a refused percentage.
 *
 * A cell reading "—" is honest but mute, and mute is how a real data-entry
 * error stays unfixed. Wherever `pct` refuses a value, this says what was
 * refused and what to do about it, and it names the cause rather than the
 * symptom: the percentages are only impossible because the marks behind them
 * are above the maximum printed on the paper.
 *
 * Renders nothing when nothing was refused, so a screen can mount it
 * unconditionally.
 */
export function RefusedPctNotice({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">
        {count === 1 ? 'One figure is' : `${count} figures are`} not shown.
      </span>{' '}
      They worked out above 100%, which a share of a paper cannot be. It happens
      when marks were entered against a different maximum from the one on the
      paper — 50 recorded on a paper out of 20 is an honest 250%. Correct the
      marks, or the paper&rsquo;s maximum, in mark entry; nothing here has been
      rounded down to hide it.
    </p>
  )
}

/** Tone for a count where any is bad. */
export function zeroIsGood(n: number): 'success' | 'warning' | 'danger' {
  if (n === 0) return 'success'
  return n > 5 ? 'danger' : 'warning'
}
