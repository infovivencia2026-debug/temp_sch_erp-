import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, Bell, Check, CircleAlert, Info,
  IndianRupee, UserPlus, Users, X,
} from 'lucide-react'
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

/* A MARK PER FIGURE, MATCHED ON WHAT THE FIGURE COUNTS.
 *
 * The server sends a label and a number and no icon, and it should not send
 * one: the tiles are whatever a role's probes returned, and a column of icon
 * names in that response would be this file's job written somewhere it cannot
 * be read. Matched on the words the server already uses, with a plain count
 * as the fallback, so a new figure gets a neutral mark rather than none.
 *
 * The tints are the only colour on this row. They separate three numbers that
 * are otherwise identical in shape -- which is what makes a row of figures
 * scannable rather than a wall. */
const STAT_MARK: { test: RegExp; icon: typeof Users; tint: string }[] = [
  { test: /student|child|pupil|boarder/i, icon: Users,
    tint: 'bg-primary/10 text-primary' },
  { test: /collect|fee|paid|due|revenue|salary|pay/i, icon: IndianRupee,
    tint: 'bg-success/10 text-success' },
  { test: /enquir|admission|applicant|lead/i, icon: UserPlus,
    tint: 'bg-accent-foreground/10 text-accent-foreground' },
]

function markFor(label: string) {
  const hit = STAT_MARK.find((m) => m.test.test(label))
  return hit ?? { icon: Bell, tint: 'bg-muted text-muted-foreground' }
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
    staleTime: 120_000,
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
    <div className="flex flex-col gap-6">
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

      {catalog.roles.length > 1 && <RoleNote roleName={role?.name} />}

      {/* THE FIGURES FIRST, ACROSS THE PAGE.
       *
       * They used to be a narrow column beside the alerts, which made three
       * numbers compete for a third of the width and left the grid ending on
       * a half-empty row. They are the cheapest thing on the page to read and
       * the thing every role opens this for, so they take the full width and
       * one row: a card each, the figure large, the mark tinted by what it
       * counts. Three across on a desk, one under another in a hand. */}
      {summary.length > 0 && (
        <section>
          <p className="eyebrow mb-2.5">Today</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {summary.map((s) => {
              const { icon: Mark, tint } = markFor(s.label)
              return (
                <div
                  key={s.label}
                  className="flex items-start justify-between gap-3 rounded-xl border bg-card p-4 shadow-[var(--elev-1)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-muted-foreground">
                      {s.label}
                    </p>
                    <p className="font-display mt-1 text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
                      {s.value}
                    </p>
                    {s.hint && (
                      <p
                        className={cn(
                          'mt-1.5 text-[12px]',
                          s.tone === 'good' ? 'text-success' : 'text-muted-foreground',
                        )}
                      >
                        {s.hint}
                      </p>
                    )}
                  </div>
                  <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', tint)}>
                    <Mark className="size-5" aria-hidden />
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* WHAT NEEDS DOING, AS ONE CARD PER THING.
       *
       * A divided list made every alert the same weight as every other and
       * gave none of them room for the action that answers it. Each is its own
       * card now: a tinted head carrying the severity and the sentence, and a
       * foot carrying the buttons -- the thing to do, and the thing to do
       * about the people who should have done it. */}
      {items.length > 0 && (
        <section>
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <p className="eyebrow">Needs your attention</p>
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive sm:hidden">
              {items.length} pending
            </span>
          </div>
          {nudged && <p className="mb-2.5 text-[13px] text-success">{nudged}</p>}
          {/* ONE ROW EACH, IN ONE CARD, HOWEVER MANY THERE ARE.
           *
           * A card per alert reads well at one and badly at seven: seven
           * tinted headers and seven footers is a wall, and the page it makes
           * is longer than the work it describes. A school on a bad morning
           * has an unmarked register, a teacher out, two leave requests and a
           * fee run to answer -- that is the normal case, not the edge.
           *
           * So each is a row: the severity as a mark, the sentence, and the
           * one thing to do about it on the right. Seven of those is a list
           * somebody reads down. The tint moves to the mark, which is enough
           * to sort a critical from a warning at a glance and does not stripe
           * the page.
           *
           * The rows wrap on a phone, where a button beside a sentence at
           * 360px leaves neither of them readable. */}
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-[var(--elev-1)]">
            {items.map((item) => {
              const Icon = ICON[item.severity]
              const href = hrefFor(item.href)
              const chase = item.key === 'attendance.unmarked' && canChase
              const done = chase && nudge.isSuccess
              return (
                <div
                  key={item.key}
                  className="flex flex-col gap-2.5 p-4 sm:flex-row sm:items-center sm:gap-4"
                >
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-lg',
                      item.severity === 'critical' && 'bg-destructive/10 text-destructive',
                      item.severity === 'warning' &&
                        'bg-[hsl(var(--warn,38_92%_90%))] text-[hsl(var(--warning,38_92%_35%))]',
                      item.severity === 'info' && 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-medium leading-snug">{item.headline}</p>
                    {item.detail && (
                      <p className="mt-0.5 text-[12.5px] text-muted-foreground">{item.detail}</p>
                    )}
                  </div>

                  {/* THE ONE THING TO DO, AND WHAT IT LOOKS LIKE ONCE DONE.
                   *
                   * A reminder that has been sent must not offer itself again
                   * looking untouched: the register is still unmarked, so the
                   * row stays -- correctly, it is still true -- but the button
                   * has to say the sending happened or the reader presses it
                   * twice and the teachers get two. */}
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {chase && (
                      <button
                        type="button"
                        disabled={nudge.isPending || done}
                        onClick={() => nudge.mutate()}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors',
                          done
                            ? 'border bg-card text-muted-foreground'
                            : 'bg-primary text-primary-foreground hover:bg-primary/90',
                          'disabled:opacity-70',
                        )}
                      >
                        {done ? <Check className="size-3.5" aria-hidden />
                              : <Bell className="size-3.5" aria-hidden />}
                        {nudge.isPending ? 'Reminding\u2026'
                          : done ? 'Reminded' : 'Remind the class teachers'}
                      </button>
                    )}
                    {href && !chase && (
                      <button
                        type="button"
                        onClick={() => navigate(href)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                      >
                        {item.action}
                        <ArrowRight className="size-3.5" aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}
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
