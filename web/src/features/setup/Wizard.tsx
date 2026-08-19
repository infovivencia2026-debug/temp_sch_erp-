import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Check, ChevronRight, Lock, PartyPopper } from 'lucide-react'
import { actingInstitution, api, setActingInstitution, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, Loading, ErrorState, Button, Select, EmptyState,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { PANELS, type PanelProps } from './panels'

/* The first hour with the product.

   A checklist told an admin what was missing and left them to find the screen
   that fixed it — thirteen separate hunts through a 419-feature navigation
   before the school could take a single fee. This is the same checklist with
   the work brought to it: each step states why it matters, carries the form
   that satisfies it, and shows what is already there.

   The order is not editorial. Each step depends on the one above it: sections
   need classes, class-subject mapping needs both, a fee structure needs a
   class and a fee head. Steps below the first unfinished one stay reachable
   anyway — a school migrating from another system often has staff and
   students before it has decided on fee heads, and a wizard that refuses to
   let them jump is a wizard they abandon. */

interface Step {
  key: string
  label: string
  done: boolean
  count: number
  detail: string
  blocking: boolean
}
interface Status {
  steps: Step[]
  completed: number
  total: number
  blocking_remaining: number
  ready: boolean
}

interface School {
  id: string
  name: string
  short_name: string
  district?: string
  students: number
}

export default function Wizard() {
  // A platform operator has no school of their own, so this screen has to ask
  // which one they mean before it can ask anything else.
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ user?: { platform_admin: boolean } }>('/api/v1/session'),
  })
  const isPlatform = session?.user?.platform_admin ?? false

  const { data: schools } = useQuery({
    queryKey: ['institutions'],
    queryFn: () => api.get<List<School>>('/api/v1/admin/institutions'),
    enabled: isPlatform,
  })

  const qc = useQueryClient()
  const [acting, setActing] = useState(actingInstitution())
  const pickSchool = (id: string) => {
    setActingInstitution(id || null)
    setActing(id || null)
    qc.invalidateQueries()
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['setup-status', acting],
    queryFn: () => api.get<Status>('/api/v1/setup/status'),
    // Asking before a school is chosen would only produce the error that
    // tells the operator to choose one.
    enabled: !isPlatform || !!acting,
  })

  const [active, setActive] = useState<string | null>(null)

  // Land on the first thing that still needs doing. A returning admin should
  // not have to scroll past the nine steps they finished last week.
  const firstOpen = useMemo(
    () => data?.steps.find((s) => !s.done)?.key ?? data?.steps[0]?.key ?? null,
    [data],
  )
  useEffect(() => {
    setActive((cur) => cur ?? firstOpen)
  }, [firstOpen])

  const picker = isPlatform ? (
    <div className="flex items-center gap-2">
      <Building2 className="h-4 w-4 text-muted-foreground" />
      <Select
        value={acting ?? ''}
        onChange={pickSchool}
        placeholder="Choose a school"
        options={(schools?.items ?? []).map((s) => ({
          value: s.id,
          label: `${s.name} · ${s.students} students`,
        }))}
      />
    </div>
  ) : null

  if (isPlatform && !acting) {
    return (
      <>
        <PageHead
          eyebrow="Getting started"
          title="Which school are you setting up?"
          description="Your account runs the platform rather than a single school, so pick the one you are working on. Everything on this page then applies to it."
          actions={picker}
        />
        <PageBody>
          {(schools?.items ?? []).length === 0 ? (
            <EmptyState
              title="No schools yet"
              body="Create one with the migrate tool's create-admin command, then it appears here."
            />
          ) : (
            <div className="cell-grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3">
              {(schools?.items ?? []).map((s) => (
                <button key={s.id} type="button" onClick={() => pickSchool(s.id)}
                  className="cell text-left transition-colors duration-150 hover:bg-accent">
                  <p className="eyebrow">{s.district ?? 'School'}</p>
                  <p className="mt-2 text-[15px] font-medium">{s.name}</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {s.students} students · {s.short_name}
                  </p>
                </button>
              ))}
            </div>
          )}
        </PageBody>
      </>
    )
  }

  if (isLoading) return <Loading label="Checking what your school still needs…" />
  if (error) return <ErrorState error={error} />
  const d = data!

  const current = d.steps.find((s) => s.key === active) ?? d.steps[0]
  const idx = d.steps.findIndex((s) => s.key === current.key)
  const pct = Math.round((d.completed / d.total) * 100)

  // Advancing means going to the next step that is not already satisfied,
  // rather than the literal next one — otherwise finishing a step drops you
  // onto something you completed in an earlier session.
  const advance = () => {
    const rest = d.steps.slice(idx + 1)
    setActive((rest.find((s) => !s.done) ?? rest[0] ?? current).key)
  }

  /* Saving does not move you.
   *
   * It used to advance to the next unfinished step, which is wrong for every
   * step that is a list: adding one section, one class or one subject almost
   * always means adding another, and being thrown to the next step after each
   * one made the common case the punished case. The tick on the left and the
   * refreshed counts are the confirmation; "Next step" is right there when the
   * work is actually finished. */
  const done = () => {
    refetch()
  }

  const Panel = PANELS[current.key]

  return (
    <>
      <PageHead
        eyebrow="Getting started"
        title={d.ready ? 'Your school is running' : 'Set up your school'}
        description={
          d.ready
            ? 'Everything required is in place. The remaining steps unlock fees, grading and examinations.'
            : `${d.blocking_remaining} required ${d.blocking_remaining === 1 ? 'step' : 'steps'} left. Each one takes a minute, and the form is on this page.`
        }
        actions={
          <>
            {picker}
            <div className="w-44">
              <div className="flex items-baseline justify-between text-[13px]">
                <span className="text-muted-foreground">Progress</span>
                <span className="tabular-nums">{pct}%</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </>
        }
      />
      <PageBody>
        {d.ready && <ReadyBanner />}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:items-start">
          <Spine steps={d.steps} active={current.key} onPick={setActive} />

          <Card>
            <div className="border-b px-5 py-4">
              <p className="eyebrow">
                Step {idx + 1} of {d.steps.length}
                {current.blocking ? ' · required' : ' · optional'}
              </p>
              <h3 className="mt-1 text-[17px] tracking-tight">{current.label}</h3>
              <p className="mt-1 text-[14px] text-muted-foreground">{current.detail}</p>
            </div>
            <div className="px-5 py-5">
              {Panel ? (
                <Panel onDone={done} />
              ) : (
                <p className="text-[14px] text-muted-foreground">
                  This step has no form yet — use the module's own screen.
                </p>
              )}
            </div>
            <div className="flex items-center justify-between border-t px-5 py-3">
              <span className="text-[13px] text-muted-foreground">
                {current.done
                  ? current.count > 0
                    ? `${current.count} already added`
                    : 'Done'
                  : 'Not done yet'}
              </span>
              <Button variant="secondary" size="sm" onClick={advance}>
                {current.done ? 'Next step' : 'Skip for now'}
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  )
}

function ReadyBanner() {
  return (
    <Card className="flex items-start gap-3 border-success/40 bg-success/[0.06] p-5">
      <PartyPopper className="mt-0.5 h-[18px] w-[18px] shrink-0 text-success" />
      <div>
        <p className="text-[14px] font-medium">Your school can be operated today.</p>
        <p className="mt-1 text-[14px] text-muted-foreground">
          Teachers can mark attendance, the office can admit a student and the counter can take a
          fee. Anything still unticked below adds capability rather than unblocking the basics.
        </p>
      </div>
    </Card>
  )
}

/**
 * The timeline spine: the pulse language's vertical rule with a dot per step.
 * Sticky on a desktop so the list of what remains never scrolls out of sight
 * while a long form is being filled.
 */
function Spine({
  steps,
  active,
  onPick,
}: {
  steps: Step[]
  active: string
  onPick: (k: string) => void
}) {
  return (
    <Card className="lg:sticky lg:top-4">
      <ol className="relative py-2">
        <span
          aria-hidden
          className="absolute bottom-6 left-[27px] top-6 w-px bg-border"
        />
        {steps.map((s, i) => {
          const on = s.key === active
          return (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onPick(s.key)}
                className={cn(
                  'relative flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-150',
                  on ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <span
                  className={cn(
                    'relative z-10 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-[12px] tabular-nums',
                    s.done
                      ? 'border-success bg-success text-white'
                      : on
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card text-muted-foreground',
                  )}
                >
                  {s.done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-[14px]',
                      s.done && !on && 'text-muted-foreground',
                    )}
                  >
                    {s.label}
                  </span>
                </span>
                {!s.done && s.blocking && (
                  <Lock className="h-3 w-3 shrink-0 text-warning" aria-label="required" />
                )}
                {s.count > 0 && (
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {s.count}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

export type { PanelProps }
