import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Check, ChevronRight, FolderOpen, Lock, X } from 'lucide-react'
import { actingInstitution, api, setActingInstitution, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, Loading, ErrorState, Button, Select, Reload, EmptyState,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { PANELS, type PanelProps } from './panels'
import {
  clearPack, packEntries, readPack, setPack, subscribeToPack, wasTaken,
  type PackEntry,
} from './setup-pack'

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

  const { data, isLoading, error, refetch, isFetching } = useQuery({
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
        eyebrow={d.ready ? 'School' : 'Getting started'}
        title={d.ready ? 'School details' : 'Set up your school'}
        description={
          d.ready
            ? 'The classes, sections, subjects, staff, fee heads and the school day — all of it, editable. Pick a section on the left and change what needs changing.'
            : `${d.blocking_remaining} required ${d.blocking_remaining === 1 ? 'step' : 'steps'} left. Each one takes a minute, and the form is on this page.`
        }
        actions={
          <>
            {picker}
            <Reload onClick={() => refetch()} busy={isFetching} label="Re-read the school" />
            {/* A progress bar is a promise that this ends. Once it has, the bar
                is not just useless but wrong: a school opening this to change a
                fee head is not 93% of the way through anything. */}
            {!d.ready && (
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
            )}
          </>
        }
      />
      <PageBody>

        {/* THE RAIL IS AS WIDE AS THE NAMES IT CARRIES.

            The step list was a fixed 17rem track, which left 155px of text
            room once the numbered dot, the padding, the lock and the count
            had taken theirs. "Create classes and their sections" wants 216px,
            so 28% of it sat behind an ellipsis -- and it read exactly the same
            at 1920 as at 1024, with 280px of empty gutter beside it, because
            the track never grew. A list whose only job is naming the steps
            should not be the one screen element that hides their names.

            Two changes, and both are needed. The track goes to 22rem once
            there is a desk-sized window to spend it in, which is where the
            gutter actually exists; and the label wraps instead of truncating,
            which is what makes this correct rather than merely wider. A
            wider rail alone only moves the cut-off to the next long label
            somebody writes, and to the narrow laptop that never reaches xl.
            Wrapping costs a second line on two of sixteen rows and can never
            hide a word at any width. */}
        {/* `minmax(0,1fr)` on the single-column case as well, not only on the
            two-column ones. Below lg the grid had no template at all, so its
            implicit column was sized by its content with no lower bound on the
            minimum -- which means anything inside the panel that refuses to
            shrink, such as a table of file names that must not break words,
            widens the whole panel past the viewport instead of scrolling
            inside its own box. The two desktop tracks already said
            `minmax(0,...)` for exactly this reason; the phone case was the one
            that had never been written down. */}
        <PackGate onOpen={setActive} />

        <div className="grid gap-6 grid-cols-[minmax(0,1fr)]
                        lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]
                        xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
          <Spine steps={d.steps} active={current.key} onPick={setActive} settled={d.ready} />

          <Card>
            <div className="border-b px-5 py-4">
              <p className="eyebrow">
                {d.ready
                  ? 'Section'
                  : `Step ${idx + 1} of ${d.steps.length}${current.blocking ? ' · required' : ' · optional'}`}
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
            {/* Skip on the left, Next on the right.
                One button did both jobs and changed its label depending on
                whether the step was finished, so the control that moves you
                forward sat in a different place from one step to the next --
                and on an unfinished step there was no way to go on at all
                without pressing something that reads like giving up. They are
                two buttons now, always in the same two places. */}
            <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
              {!d.ready && (
                <Button variant="ghost" size="sm" onClick={advance}>
                  Skip for now
                </Button>
              )}
              <span className="text-[13px] text-muted-foreground">
                {current.count > 0
                  ? `${current.count} on record`
                  : d.ready
                    ? 'Nothing here yet'
                    : current.done
                      ? 'Done'
                      : 'Not done yet'}
              </span>
              {!d.ready && (
                <Button
                  variant={current.done ? 'primary' : 'secondary'}
                  size="sm"
                  className="ml-auto"
                  onClick={advance}
                >
                  Next step
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  )
}

/* DO THEY ALREADY HAVE THE SHEETS?
 *
 * Schools are sent a folder of templates before they ever open this screen,
 * and the ones that filled it in arrive with ten files and no way to say so.
 * The wizard asked for them one at a time, buried a step deep each, which is
 * ten separate hunts for a folder already open on the desktop.
 *
 * So it is asked once, at the top, and only until it is answered. A school
 * that has no folder presses nothing and sees the wizard it always saw --
 * this is a shortcut past typing, not a new way in, and there is no state
 * where the normal setup is unavailable because of it.
 *
 * Handing the folder over imports nothing. Each sheet is put into its own
 * step's uploader, where the dry run, the row-by-row report and the commit
 * button are exactly what they are for a file dropped by hand.
 */
function PackGate({ onOpen }: { onOpen: (step: string) => void }) {
  const [asked, setAsked] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const folderRef = useRef<HTMLInputElement>(null)

  // The pack is module state -- the uploaders take files out of it as they
  // pick them up -- so this list has to hear about that to tick them off.
  const [, bump] = useState(0)
  useEffect(() => subscribeToPack(() => bump((n) => n + 1)), [])
  const entries = packEntries()

  const accept = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setNote('')
    try {
      const found = await readPack(Array.from(files))
      if (found.length === 0) {
        setNote(
          'None of those look like the setup sheets. They are the files whose names ' +
            'start 01 to 10 — pick the folder they are in, not the zip.',
        )
        return
      }
      setPack(found)
    } finally {
      setBusy(false)
    }
  }

  if (dismissed && entries.length === 0) return null

  if (entries.length > 0) {
    const left = entries.filter((e) => !wasTaken(e.entity)).length
    return (
      <Card className="mb-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-4">
          <h3 className="text-[15px] tracking-tight">Your filled-in sheets</h3>
          <p className="text-[13px] text-muted-foreground">
            {left > 0
              ? `${left} of ${entries.length} still to load. Open a step and its sheet is already in the box — it is checked there, and nothing is written until you say so.`
              : 'Every sheet has been handed to its step.'}
          </p>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={clearPack}>
            <X className="h-3.5 w-3.5" />
            Put them away
          </Button>
        </div>
        <ul className="divide-y">
          {entries.map((e: PackEntry) => {
            const done = wasTaken(e.entity)
            return (
              <li key={e.file.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
                <span className="text-[14px]">{e.label}</span>
                <span className="text-[13px] text-muted-foreground">{e.file.name}</span>
                {done ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-[13px] text-muted-foreground">
                    <Check className="h-3.5 w-3.5" />
                    In its step
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-auto"
                    onClick={() => onOpen(e.step)}
                  >
                    Open {e.label.toLowerCase()}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </Card>
    )
  }

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-[16rem] flex-1">
          <p className="text-[15px] tracking-tight">
            Were you sent the setup sheets to fill in?
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {asked
              ? 'Choose the folder they are in. Every sheet it recognises goes into the step it belongs to, and each one is still checked before anything is written.'
              : 'If the school filled in the ten template sheets, hand the folder over here rather than finding each one again below.'}
          </p>
          {note && <p className="mt-2 text-[13px] text-destructive">{note}</p>}
        </div>
        {asked ? (
          <Button size="sm" disabled={busy} onClick={() => folderRef.current?.click()}>
            {busy ? 'Reading…' : 'Choose the folder'}
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={() => setAsked(true)}>
              Yes, I have them
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
              No, set it up here
            </Button>
          </>
        )}
      </div>
      {/* Both, because a browser that will not hand over a folder still hands
          over ten selected files, and a school on a phone has neither. */}
      <input
        ref={folderRef}
        type="file"
        multiple
        accept=".csv,text/csv"
        // Not in React's DOM typings; the folder picker is the whole point.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        className="hidden"
        onChange={(e) => {
          void accept(e.target.files)
          e.target.value = ''
        }}
      />
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
  settled,
}: {
  steps: Step[]
  active: string
  onPick: (k: string) => void
  /** True once nothing is owed: the list is sections, not remaining steps. */
  settled?: boolean
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
                  {s.done ? <Check className="h-3 w-3" strokeWidth={3} /> : settled ? '·' : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-[14px] leading-snug',
                      s.done && !on && 'text-muted-foreground',
                    )}
                  >
                    {s.label}
                  </span>
                </span>
                {!settled && !s.done && s.blocking && (
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
