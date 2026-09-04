import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CircleAlert, ChevronRight, Info, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useActiveRole, useCatalog } from '@/lib/catalog'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'

/* The panel every role opens the product to read.

   One component, not seventeen dashboards. The server decides what is in it —
   which probes the caller's permissions make meaningful, and which rows their
   scope reaches — so a class teacher's "attendance not marked" is their two
   sections and a vice principal's is the school, from the same request.

   The rule that keeps it worth reading: nothing with a count of zero is ever
   listed. A panel that reassures you about the fourteen things that are fine
   is a panel people stop reading, and then they stop seeing the one that
   isn't. */

interface AttentionItem {
  key: string
  severity: 'critical' | 'warning' | 'info'
  count: number
  headline: string
  detail?: string
  action: string
  href?: string
  amount_paise?: number
}

interface SummaryStat {
  label: string
  value: string
  hint?: string
  /* 'good' where the hint is the answer somebody wanted. Never 'bad' — what
     is wrong belongs in the attention panel above this strip. */
  tone?: string
  /* Columns this tile takes on a phone: 1 (default), 2 or 3 of the three.
     Set by the server for a figure that needs the room; a tile with no
     span still fills the rest of its row when it would be stranded. */
  span?: number
}

interface AttentionResponse {
  role: string
  greeting: string
  items: AttentionItem[]
  summary: SummaryStat[]
}

const ICON = {
  critical: CircleAlert,
  warning: AlertTriangle,
  info: Info,
}

export default function NeedsAttention({ name }: { name?: string }) {
  const navigate = useNavigate()
  const role = useActiveRole()
  const catalog = useCatalog()

  /* One reminder per teacher, naming their own sections.
   *
   * Not a broadcast: the class teacher of 6-B has no use for a reminder about
   * 8-A, and a notification that is usually not about you is one people stop
   * opening. A section with no class teacher is reported back rather than
   * silently skipped — a register nobody owns is a staffing gap, and sending
   * it again tomorrow will not fix that. */
  /* Chasing is oversight, not marking. */
  const canChase = useCan()('academics.attendance.read.all')
  const [nudged, setNudged] = useState('')
  const nudge = useMutation({
    mutationFn: () =>
      api.post<{ sections: number; notified: number; sections_without_a_class_teacher: string[] }>(
        '/api/v1/attendance/nudge',
        {},
      ),
    onSuccess: (r) => {
      const unowned = r.sections_without_a_class_teacher
      setNudged(
        `${r.notified} ${r.notified === 1 ? 'teacher' : 'teachers'} reminded about ` +
          `${r.sections} unmarked ${r.sections === 1 ? 'register' : 'registers'}.` +
          (unowned.length
            ? ` ${unowned.join(', ')} ${unowned.length === 1 ? 'has' : 'have'} no class teacher, so nobody could be told.`
            : ''),
      )
    },
  })

  /* ONE REQUEST, NOT ONE PER PANEL THAT WANTS IT.
   *
   * This asked for `/api/v1/attention?role=<key>` under the key
   * ['attention', role.key], and the bento principal board asked for
   * `/api/v1/attention` under ['attention', 'bento-principal'] — whose own
   * comment says the key is chosen so that "a board and the classic attention
   * panel share a single cached response rather than racing for the same
   * rows". They never shared it: two different keys are two cache entries, and
   * two different URLs are two requests. Both mount on Home together, so every
   * visit to the dashboard ran the whole probe set twice, which the probe
   * measured as `x2 231ms GET /attention`.
   *
   * The role went out of the URL rather than into the other caller's, because
   * the server never used it: getAttention in internal/api/attention.go copies
   * the parameter straight back into the response's `role` field and decides
   * what to run from the caller's own permissions and scope. Nothing on this
   * screen reads that field either — the role rendered here is useActiveRole()
   * — so the parameter's only effect in the product's life was to keep two
   * identical requests from looking identical.
   *
   * The key is now the bare ['attention'], which is also what the twelve or so
   * `invalidateQueries({ queryKey: ['attention'] })` calls across the finance,
   * HR and admissions screens have always been aiming at. */
  const q = useQuery({
    queryKey: ['attention'],
    queryFn: () => api.get<AttentionResponse>('/api/v1/attention'),
    // A school day moves; a panel that answers "what needs me now" should not
    // be answering it from ten minutes ago. One of the three queries that keep
    // focus refetching now that App.tsx's default is off.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })

  if (q.isLoading || q.error || !q.data) return null
  /* Defaulted at the point of use as well as on the server.

     The server now always sends arrays, but this panel renders on every
     role's Home and is the first thing drawn after sign-in: if it throws,
     the route blanks with no error boundary to catch it. A missing list is
     worth rendering nothing over, not worth taking the page down. */
  const { greeting } = q.data
  const items = q.data.items ?? []
  const summary = q.data.summary ?? []

  /* An attention item names a destination in the abstract — "attendance",
     "fees" — and the concrete route depends on which workspace this role keeps
     that in. Resolving it here rather than server-side keeps the engine from
     having to know the shape of seventeen navigation trees. */
  function hrefFor(target?: string) {
    if (!target || !role) return null
    /* Several names for the same destination, tried in order.

       A probe names where it wants to go in the abstract — "marks" — and each
       workspace calls that screen something different: a class teacher's is
       marks_report_cards/report_cards, a head's is examinations/exams_results.
       One word matched the first and not the second, so "10 report cards
       awaiting publication" sat on the principal's dashboard as a line of text
       with nothing to press — the one person who could act on it. */
    /* THIS WORKSPACE FIRST, THEN ANY OF THEM.

       Searching only the workspace somebody happens to be standing in left
       rows with nothing to press whenever the screen that acts on them lives
       somewhere else — a principal's certificate queue is reached from the
       Students section of the admin workspace, and a head reading the same row
       from a teaching workspace found no match and got a line of text.

       The person can reach every workspace in their own catalogue by
       definition, so a row that is actionable anywhere is actionable. */
    const search = (r: typeof role) => {
      if (!r) return null
      for (const want of target.split(/\s+/).filter(Boolean)) {
        for (const section of r.sections) {
          for (const f of section.features) {
            if (!f.live || !f.in_scope) continue
            const hay = `${section.slug} ${f.slug}`
            if (hay.includes(want)) return `/${r.key}/${section.slug}/${f.slug}`
          }
        }
      }
      return null
    }
    const here = search(role)
    if (here) return here
    for (const other of catalog.roles) {
      if (other.key === role.key) continue
      const there = search(other)
      if (there) return there
    }
    return null
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-[-0.02em]">
          {greeting}
          {name ? `, ${name}` : ''}
        </h2>
        {items.length === 0 && (
          <p className="mt-1 text-[14px] text-muted-foreground">
            Nothing needs you right now.
          </p>
        )}
      </div>

      {/* WHICH WORKSPACE THIS IS, SAID BEFORE THE FIGURES AND NOT AFTER.

          It sat under the tiles as a grey last line, which is where a reader
          looks once and never again -- and it is the sentence that explains
          why the numbers above it are the numbers they are. Above the panel
          now, and closable, because it is orientation rather than news. */}
      {catalog.roles.length > 1 && <RoleNote roleName={role?.name} />}

      {/* THE READING ORDER IS NOT THE SAME ON A DESK AND IN A HAND.

          On a desk the eye starts top left, so what needs doing goes there and
          today's figures take the narrow right-hand column. On a phone there
          is one column and no glance: the figures are three numbers worth a
          thumb-length, and burying them under three action cards means
          scrolling past the work to find out how the day is going. So the
          tiles come first there, by order alone -- the markup says it once. */}
      <div className="grid gap-5 lg:grid-cols-3 lg:items-start">
        {items.length > 0 && (
          <section className="order-2 lg:order-1 lg:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="eyebrow">Needs your attention</p>
              {/* How many, on the phone where the list is separate cards and
                  its length is not one glance. */}
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive sm:hidden">
                {items.length} pending
              </span>
            </div>
            {nudged && <p className="mb-2 text-[13px] text-success">{nudged}</p>}
            <ul className="flex flex-col gap-3 sm:gap-0 sm:divide-y sm:rounded-md sm:border sm:bg-card">
              {items.map((item) => {
                const Icon = ICON[item.severity]
                const href = hrefFor(item.href)
                const chase = item.key === 'attendance.unmarked' && canChase
                return (
                  <li
                    key={item.key}
                    className="overflow-hidden rounded-md border bg-card sm:rounded-none sm:border-0"
                  >
                    <button
                      type="button"
                      disabled={!href}
                      onClick={() => href && navigate(href)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors sm:items-center',
                        href ? 'hover:bg-accent' : 'cursor-default',
                      )}
                    >
                      {/* A tinted square in a hand, a bare glyph in a dense
                          desktop row: the same severity at the weight each
                          layout can carry. */}
                      <span
                        className={cn(
                          'shrink-0 rounded-md p-2 sm:bg-transparent sm:p-0',
                          item.severity === 'critical' && 'bg-destructive/10',
                          item.severity === 'warning' && 'bg-[hsl(var(--warn,38_92%_92%))]',
                          item.severity === 'info' && 'bg-muted',
                        )}
                      >
                        <Icon
                          className={cn(
                            'h-4 w-4',
                            item.severity === 'critical' && 'text-destructive',
                            item.severity === 'warning' && 'text-[hsl(var(--warning,38_92%_40%))]',
                            item.severity === 'info' && 'text-muted-foreground',
                          )}
                          aria-hidden
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        {/* Wraps in a hand, one line on a desk. The headline is
                            the whole of what the row says, and an ellipsis
                            through the middle of it at 360px is the row saying
                            nothing. */}
                        <span className="block text-[14px] font-medium sm:truncate">
                          {item.headline}
                        </span>
                        {item.detail && (
                          <span className="block text-[12.5px] text-muted-foreground">
                            {item.detail}
                          </span>
                        )}
                      </span>
                      {href && (
                        <span className="hidden shrink-0 items-center gap-1 text-[13px] text-muted-foreground sm:flex">
                          {item.action}
                          <ChevronRight className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </button>

                    {/* An unmarked register is the one warning the reader
                        cannot act on themselves: a principal does not mark
                        registers and should not. What they do at that moment
                        is chase somebody, so that is the button.

                        Indented under its own row rather than sitting flush
                        with the list, because it belongs to the line above it
                        and read as an alert of its own at the old alignment. */}
                    {chase && (
                      <div className="px-4 pb-3 sm:border-t sm:py-2">
                        <button
                          type="button"
                          disabled={nudge.isPending}
                          onClick={() => nudge.mutate()}
                          className="ml-11 text-[13px] font-medium text-primary hover:underline disabled:opacity-60 sm:ml-7"
                        >
                          {nudge.isPending ? 'Reminding…' : 'Remind the class teachers'}
                        </button>
                      </div>
                    )}

                    {/* The same action as a thumb-sized footer, for the one
                        layout where a chevron at the end of a row is a 13px
                        target against the screen edge. */}
                    {href && (
                      <button
                        type="button"
                        onClick={() => navigate(href)}
                        className="flex w-full items-center justify-between border-t bg-muted/40 px-4 py-2.5 text-[13px] font-medium active:bg-accent sm:hidden"
                      >
                        <span>{item.action}</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {summary.length > 0 && (
          <section className={cn('order-1 lg:order-2', items.length === 0 && 'lg:col-span-3')}>
            <p className="eyebrow mb-2">Today</p>
            {/* THREE ACROSS IN A HAND, ONE COLUMN ON A DESK.

                The tiles ran the full width in a four-up strip, which on a
                phone stacked into four full-width blocks: four screenfuls of
                one number each. Beside the attention list they are a narrow
                column, and on a phone a single row of small figures divided by
                hairlines -- a glance, which is all a count of students is.

                Written out rather than computed because Tailwind only ships
                the classes it can see in the source. */}
            {/* NO STRANDED TILE.

                Four tiles on a three-column phone grid put the fourth alone
                on a second row beside two thirds of nothing, drawn in the
                border colour: a grey block that looked like a tile that had
                failed to load. The grid stays three across, and a last tile
                that would be stranded takes the rest of its row, so the grid
                always ends on a full line. Phone only: the wider grids below
                have their own counts. */}
            {(() => {
              // Written out: Tailwind only ships the classes it can read.
              const SPAN: Record<number, string> = {
                2: 'col-span-2 sm:col-span-1',
                3: 'col-span-3 sm:col-span-1',
              }
              const spanOf = (s: SummaryStat) => Math.min(3, Math.max(1, Math.round(s.span ?? 1)))
              const used = summary.reduce((n, s) => n + spanOf(s), 0)
              const stranded = used % 3
              const lastSpan = stranded === 0 ? '' : SPAN[3 - stranded + spanOf(summary[summary.length - 1])] ?? ''
              return (
            <div
              className={cn(
                'grid gap-px overflow-hidden rounded-md border bg-border',
                'grid-cols-3 sm:grid-cols-4',
                items.length === 0 ? 'lg:grid-cols-4' : 'lg:grid-cols-2',
                summary.length === 1 && 'grid-cols-1 sm:grid-cols-1 lg:grid-cols-1',
                summary.length === 2 && 'grid-cols-2 sm:grid-cols-2',
              )}
            >
              {summary.map((s, i) => (
                <div
                  key={s.label}
                  className={cn(
                    'bg-card px-3 py-3 text-center sm:px-4 sm:text-left',
                    i === summary.length - 1 ? lastSpan || SPAN[spanOf(s)] : SPAN[spanOf(s)],
                  )}
                >
                  <p className="font-display text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums sm:text-[24px]">
                    {s.value}
                  </p>
                  <p className="mt-1.5 text-[12px] text-muted-foreground">{s.label}</p>
                  {s.hint && (
                    <p className={cn(
                      'text-[11.5px]',
                      s.tone === 'good' ? 'text-success' : 'text-muted-foreground/70',
                    )}>
                      {s.hint}
                    </p>
                  )}
                </div>
              ))}
            </div>
              )
            })()}
          </section>
        )}
      </div>
    </div>
  )
}

const ROLE_NOTE_KEY = 'role-note-dismissed'

/* Orientation, not news -- so it closes, and stays closed for the session. */
function RoleNote({ roleName }: { roleName?: string }) {
  /* Read on mount rather than during render: a private window throws on
     sessionStorage rather than returning nothing, and the first thing drawn
     after sign-in is not where anybody wants to find that out. */
  const [gone, setGone] = useState(true)
  useEffect(() => {
    try {
      setGone(sessionStorage.getItem(ROLE_NOTE_KEY) === '1')
    } catch {
      setGone(false)
    }
  }, [])
  if (gone) return null
  return (
    <div className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-2.5">
      <Info className="mt-px h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
        This is your {roleName} workspace. Switch roles from the top bar to see what needs
        you elsewhere.
      </p>
      <button
        type="button"
        aria-label="Hide this note"
        onClick={() => {
          setGone(true)
          try {
            sessionStorage.setItem(ROLE_NOTE_KEY, '1')
          } catch {
            // A browser that will not remember it shows the note again
            // tomorrow, which is the harmless half of that failure.
          }
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/* One status vocabulary, rendered one way.

   The tones come from the database's own enums — invoices already distinguish
   partial from overdue, applications already carry the enquiry-to-enrolled
   ladder — so this maps rather than invents. A second vocabulary in the client
   would be a second answer to "what does partial mean". */
const TONE: Record<string, string> = {
  paid: 'good', success: 'good', partial: 'warn', unpaid: 'warn',
  overdue: 'bad', failed: 'bad', bounced: 'bad', refunded: 'neutral',
  cancelled: 'neutral', draft: 'neutral',
  present: 'good', late: 'warn', half_day: 'warn',
  absent: 'bad', leave: 'neutral', holiday: 'neutral', week_off: 'neutral',
  new: 'neutral', contacted: 'neutral', visit_scheduled: 'neutral',
  submitted: 'neutral', under_review: 'warn', documents_pending: 'warn',
  test_scheduled: 'neutral', interviewed: 'neutral', waitlisted: 'warn',
  offered: 'good', accepted: 'good', applied: 'good',
  rejected: 'bad', withdrawn: 'neutral', lost: 'bad',
  pending: 'warn', approved: 'good', requested: 'warn', issued: 'good',
  active: 'good', promoted: 'good', detained: 'warn',
  transferred: 'neutral', completed: 'good',
}

const TONE_CLASS: Record<string, string> = {
  good: 'border-transparent bg-[hsl(var(--ok,152_45%_92%))] text-[hsl(var(--ok-fg,152_60%_24%))]',
  warn: 'border-transparent bg-[hsl(var(--warn,38_92%_92%))] text-[hsl(var(--warn-fg,32_80%_28%))]',
  bad: 'border-transparent bg-destructive/10 text-destructive',
  neutral: 'border-border bg-transparent text-muted-foreground',
}

/** Renders a record's status the same way everywhere it appears. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const key = status.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const tone = TONE[key] ?? 'neutral'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-4',
        TONE_CLASS[tone],
        className,
      )}
    >
      {key.replace(/_/g, ' ')}
    </span>
  )
}
