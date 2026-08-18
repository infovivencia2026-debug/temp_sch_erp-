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

/** A percentage the server may have left null because the denominator was zero. */
export function pct(v?: number | null) {
  return v === null || v === undefined ? '—' : `${v}%`
}

/** Tone for a percentage where higher is better. */
export function goodPct(v?: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (v === null || v === undefined) return 'neutral'
  if (v >= 85) return 'success'
  if (v >= 60) return 'warning'
  return 'danger'
}

/** Tone for a count where any is bad. */
export function zeroIsGood(n: number): 'success' | 'warning' | 'danger' {
  if (n === 0) return 'success'
  return n > 5 ? 'danger' : 'warning'
}
