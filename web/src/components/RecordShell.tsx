import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { cn } from '@/lib/utils'
import ScrollBox from './ScrollBox'

/* A record, not a screenful of features.

   The catalogue thinks in features: "student directory", "fee history",
   "certificates issued". A school thinks in objects — a child, a teacher, an
   applicant — and everything it wants to know or do is a property of one of
   them. Opening Aarav Reddy and finding attendance, fees and documents under
   one name is how a person who is on the phone to his mother actually works.

   So this is the shell every record screen wears: who this is, what state they
   are in, what you can do to them, and tabs across the facts. Three records use
   it today and they look identical on purpose — learning the student screen
   should teach you the teacher screen. */

export interface RecordTab {
  key: string
  label: string
  /** Rendered lazily: a tab nobody opens costs nothing. */
  render: () => ReactNode
  /** Shown against the tab — an overdue count, a missing document. */
  badge?: number
}

export interface RecordAction {
  label: string
  onClick: () => void
  /** Destructive or irreversible actions read differently. */
  tone?: 'danger'
  disabled?: boolean
  /** Why it is unavailable, so a greyed-out control explains itself. */
  disabledReason?: string
}

export function RecordShell({
  title,
  subtitle,
  status,
  facts,
  tabs,
  actions = [],
  onBack,
  backLabel = 'Back',
  /** Query-string key holding the open tab, so a tab is linkable. */
  tabParam = 'tab',
}: {
  title: string
  subtitle?: string
  status?: string
  /** The two or three numbers that matter about this record, always visible. */
  facts?: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }[]
  tabs: RecordTab[]
  actions?: RecordAction[]
  onBack?: () => void
  backLabel?: string
  tabParam?: string
}) {
  const [params, setParams] = useSearchParams()
  const [menuOpen, setMenuOpen] = useState(false)

  const active = tabs.find((t) => t.key === params.get(tabParam)) ?? tabs[0]

  function openTab(key: string) {
    const next = new URLSearchParams(params)
    // The first tab is the default, so it does not need to be in the URL —
    // a link to a record should be the short form unless it means otherwise.
    if (key === tabs[0].key) next.delete(tabParam)
    else next.set(tabParam, key)
    setParams(next, { replace: true })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* --- identity ---------------------------------------------------- */}
      <header className="chrome border-b px-5 pt-4 sm:px-7">
        {onBack && (
          <button
            onClick={onBack}
            className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {backLabel}
          </button>
        )}

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate font-display text-[26px] font-semibold tracking-[-0.02em]">
                {title}
              </h1>
              {status && <StatusPill status={status} />}
            </div>
            {subtitle && (
              <p className="mt-0.5 text-[13.5px] text-muted-foreground">{subtitle}</p>
            )}
          </div>

          {actions.length > 0 && (
            <div className="relative shrink-0">
              <Button variant="secondary" onClick={() => setMenuOpen((v) => !v)}>
                Actions
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />
              </Button>
              {menuOpen && (
                <>
                  {/* Click-away, so the menu does not need a global listener. */}
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
                  {/* Bounded and scrollable. The menu grew to nine items and
                      ran off the bottom of the viewport, so the last two —
                      including the one that ends a child's enrolment — were
                      cut in half with nothing to say more was there. */}
                  <div className="absolute right-0 z-50 mt-1 min-w-[220px] overflow-hidden rounded-md border bg-card shadow-lg">
                    <ScrollBox className="max-h-[min(60vh,380px)]">
                    {actions.map((a) => (
                      <button
                        key={a.label}
                        disabled={a.disabled}
                        title={a.disabled ? a.disabledReason : undefined}
                        onClick={() => {
                          setMenuOpen(false)
                          a.onClick()
                        }}
                        className={cn(
                          'block w-full px-4 py-2 text-left text-[14px] transition-colors',
                          a.disabled
                            ? 'cursor-not-allowed text-muted-foreground/60'
                            : 'hover:bg-accent',
                          a.tone === 'danger' && !a.disabled && 'text-destructive',
                        )}
                      >
                        {a.label}
                        {/* The reason, printed rather than left on `title`.

                            Four items, three of them greyed out and silent,
                            reads as a broken menu; the explanation existed
                            all along but only a mouse that hovered and
                            waited ever saw it, and a keyboard never did. It
                            stays on `title` as well, because a truncated
                            reason is still worth a tooltip. */}
                        {a.disabled && a.disabledReason && (
                          <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground/70">
                            {a.disabledReason}
                          </span>
                        )}
                      </button>
                    ))}
                    </ScrollBox>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* The two or three numbers that stay on screen whichever tab is open,
            because "what does he owe" is asked while you are looking at his
            attendance. */}
        {facts && facts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
            {facts.map((f) => (
              <div key={f.label}>
                <p
                  className={cn(
                    'font-display text-[19px] font-semibold leading-none tracking-[-0.015em] tabular-nums',
                    f.tone === 'bad' && 'text-destructive',
                    f.tone === 'warn' && 'text-[hsl(var(--warning,38_92%_38%))]',
                  )}
                >
                  {f.value}
                </p>
                <p className="mt-1 text-[11.5px] text-muted-foreground">{f.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* --- tabs ------------------------------------------------------- */}
        <nav className="-mb-px mt-3 flex gap-1 overflow-x-auto" aria-label="Record sections">
          {tabs.map((t) => {
            const on = t.key === active.key
            return (
              <button
                key={t.key}
                onClick={() => openTab(t.key)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] transition-colors',
                  on
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {t.badge ? (
                  <span className="rounded-sm bg-destructive/10 px-1 text-[11px] font-medium text-destructive">
                    {t.badge}
                  </span>
                ) : null}
              </button>
            )
          })}
        </nav>
      </header>

      <div className="flex flex-col gap-6 px-5 py-6 sm:px-7">{active.render()}</div>
    </div>
  )
}

/** A labelled fact inside a record tab. */
export function Field({ k, v, mono }: { k: string; v?: string | null; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('text-right font-medium', mono && 'font-mono text-[12px]')}>
        {v || '—'}
      </dd>
    </div>
  )
}
