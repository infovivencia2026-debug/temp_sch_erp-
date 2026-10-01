import type { ReactNode } from 'react'

/** The one SVG progress ring. Draws a track and an arc starting at twelve
    o'clock (the svg is turned -90deg), sized in CSS pixels. `children` are
    rendered after the svg inside the wrapper, so callers place their own
    centre label (usually absolutely positioned). */
export function ProgressRing({
  pct,
  size,
  stroke,
  inset = stroke,
  arcColor,
  arcClassName,
  trackClassName = 'stroke-muted',
  linecap = 'round',
  as: Tag = 'div',
  className,
  label,
  children,
}: {
  /** 0-100; clamped. */
  pct: number
  size: number
  stroke: number
  /** Diameter lost to the stroke: radius = (size - inset) / 2. Defaults to `stroke`. */
  inset?: number
  arcColor?: string
  arcClassName?: string
  trackClassName?: string
  linecap?: 'round' | 'butt' | 'square'
  as?: 'div' | 'span'
  className?: string
  label: string
  children?: ReactNode
}) {
  const r = (size - inset) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct))
  return (
    <Tag className={className} style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className={trackClassName} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap={linecap}
          stroke={arcColor} strokeDasharray={c} strokeDashoffset={c - (c * p) / 100} className={arcClassName} />
      </svg>
      {children}
    </Tag>
  )
}
