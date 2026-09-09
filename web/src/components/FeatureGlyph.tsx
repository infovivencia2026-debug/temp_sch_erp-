import type { CSSProperties, ReactNode } from 'react'
import { featureIcon } from '@/features/bento/feature-icons'
import './feature-glyph.css'

/* ONE ICON, ONE PLATE, EVERYWHERE A FEATURE IS DRAWN.
 *
 * The launcher grid, the command palette and any list of features render
 * the same round plate: a 14% tint of the workspace colour on the theme's
 * paper, and the feature's Material Symbol in the workspace colour. The
 * glyph is the ligature name typed into a span with the font applied; the
 * span is aria-hidden because the feature's name is always beside it.
 *
 * `tint` is a domain key -- "finance", "students" -- and resolves to the
 * app's --dom-* token, which is how the plate follows every palette the
 * app has without a colour of its own. Corner marks (the workspace's symbol,
 * a pin) come in as children and sit over the plate. */
export function FeatureGlyph({
  slug,
  section,
  tint,
  size = 40,
  className,
  style,
  children,
}: {
  slug: string
  section?: string
  /** Domain key, e.g. "finance". See hueFor() in BentoLauncher. */
  tint: string
  /** Plate diameter in px; the glyph is half of it. */
  size?: number
  className?: string
  style?: CSSProperties
  children?: ReactNode
}) {
  return (
    <span
      className={className ? `fg-plate ${className}` : 'fg-plate'}
      aria-hidden="true"
      style={{ '--t': `var(--dom-${tint}, hsl(var(--primary)))`, '--size': `${size}px`, ...style } as CSSProperties}
    >
      <span className={size <= 24 ? 'msr msr-sm' : 'msr'}>{featureIcon(slug, section)}</span>
      {children}
    </span>
  )
}
