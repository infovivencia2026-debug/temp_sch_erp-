import { useEffect, useRef, useState } from 'react'

/**
 * Counts a figure up from zero on mount, and again only when the value
 * materially changes — not on every render, and not on a timer.
 *
 * requestAnimationFrame rather than a library: the whole job is one eased
 * interpolation, and a spring engine would be a dependency for the sake of it.
 * Honours prefers-reduced-motion by landing on the final value immediately.
 */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

export function useCountUp(target: number, duration = 750, enabled = true) {
  const [value, setValue] = useState(enabled ? 0 : target)
  const frame = useRef<number>()
  const previous = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) { setValue(target); return }

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced || target === previous.current) { setValue(target); previous.current = target; return }

    const from = 0
    const start = performance.now()
    previous.current = target

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      setValue(from + (target - from) * easeOut(t))
      if (t < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => { if (frame.current) cancelAnimationFrame(frame.current) }
  }, [target, duration, enabled])

  return value
}

/**
 * Formats a counted figure back into the string it came from, so "₹8.42 Cr"
 * animates as a number but still reads as currency at rest.
 */
export function useCountUpText(text: string, duration = 750) {
  const match = String(text).match(/-?[\d,]*\.?\d+/)
  const numeric = match ? parseFloat(match[0].replace(/,/g, '')) : null
  const counted = useCountUp(numeric ?? 0, duration, numeric !== null)

  if (numeric === null || !match) return text

  const decimals = (match[0].split('.')[1] ?? '').length
  const grouped = match[0].includes(',')
  const shown = grouped
    ? counted.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : counted.toFixed(decimals)

  return text.replace(match[0], shown)
}
