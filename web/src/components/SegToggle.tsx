import { cn } from '@/lib/utils'

/* A SEGMENTED TOGGLE, drawn like the sign-in page's Parent / Student / Staff
   control (worker/src/auth/login-page.ts `.who`): a sunken pill track and a
   filled thumb in the school's colour that slides under the chosen segment,
   with the chosen label in white. Every segment is a 48px target. */
export function SegToggle<T extends string>({ value, onChange, options, ariaLabel, className }: {
  value: T
  onChange: (v: T) => void
  options: readonly { value: T; label: string }[]
  ariaLabel: string
  className?: string
}) {
  const n = Math.max(1, options.length)
  const i = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div role="tablist" aria-label={ariaLabel}
      className={cn('relative flex w-full rounded-full border bg-muted p-1', className)}>
      <span aria-hidden
        className="pointer-events-none absolute bottom-1 left-1 top-1 rounded-full bg-primary shadow-[0_2px_6px_hsl(var(--foreground)/0.22)] transition-transform duration-[400ms] ease-[cubic-bezier(0.68,-0.55,0.265,1.55)] motion-reduce:transition-none"
        style={{ width: `calc((100% - 8px) / ${n})`, transform: `translateX(${i * 100}%)` }} />
      {options.map((o) => {
        const on = o.value === value
        return (
          <button key={o.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(o.value)}
            className={cn('relative z-[1] flex min-h-[48px] min-w-0 flex-1 items-center justify-center rounded-full px-3 text-[15px] font-medium transition-colors',
              on ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
            <span className="truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export default SegToggle
