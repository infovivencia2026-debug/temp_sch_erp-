import { useState, useCallback } from 'react'
import { shortcutLabel } from '@/lib/platform'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight, CheckCircle2, ClipboardList, GraduationCap, IndianRupee,
  LayoutGrid, Users, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useOverlayHistory } from '@/lib/overlay-history'

/* The first morning.

   A school buys the software, the vendor hands the principal a username and a
   password, and the principal signs in — to an empty system, alone, with no
   data and no instructions. Whatever happens in the next ten minutes decides
   whether the rollout happens at all; industry surveys put ERP implementation
   failure at 60-70%, and almost none of it is the software.

   So this is not a feature tour. It answers the four questions somebody in
   that seat actually has, in the order they have them: where am I, what do I
   do first, how do my staff get in, and who do I ask. Then it puts them on the
   setup wizard and gets out of the way.

   Shown once per person, because the principal, the clerk and the head of
   department each arrive on a different day — and replayable, because the
   first time is usually spent working out that it can be dismissed. */

interface Tour {
  seen: boolean
  role: string
  school_name: string
  is_first_user: boolean
}

interface Step {
  icon: typeof LayoutGrid
  title: string
  body: string
  aside?: string
}

/** What a principal setting a school up needs to know, in order. */
function stepsFor(t: Tour): Step[] {
  const first: Step[] = [
    {
      icon: LayoutGrid,
      title: `Welcome to ${t.school_name}`,
      body:
        'This is your school on the system. Nothing is here yet — no classes, no students, ' +
        'no fees — because you decide all of it, and the next few screens walk you through ' +
        'it in the order things depend on each other.',
      aside: 'Roughly an afternoon for a school of 500. You can stop and come back.',
    },
    {
      icon: ClipboardList,
      title: 'Start with the checklist',
      body:
        'The setup page lists fifteen steps and carries the form for each one, so you never ' +
        'have to go looking. Work down it: your school details, then classes and sections, ' +
        'then subjects, then staff, then students.',
      aside: 'Presets fill in the usual answers — Classes 1 to 10, the state syllabus, a ' +
        'seven-period day — and you edit what differs.',
    },
    {
      icon: Users,
      title: 'Then let your staff in',
      body:
        'Create an account per person and give them the roles they actually do. One person ' +
        'can hold several — in a small school the accountant often runs the library too — ' +
        'and each role keeps its own workspace rather than merging into one screen.',
      aside: 'A teacher sees nothing until they are made class teacher of a section or given ' +
        'a subject in one. That is deliberate.',
    },
    {
      icon: IndianRupee,
      title: 'Money last',
      body:
        'Fee heads, then a structure per class, then invoices. Once that is in place the ' +
        'counter can take payments and every receipt is numbered without gaps, which is the ' +
        'part an auditor checks.',
      aside: 'Nothing you enter now is permanent. Change a fee structure and it applies from ' +
        'the next invoice, not retrospectively.',
    },
  ]

  // Somebody joining a school that already runs has a different first ten
  // minutes: no setup, just their own work.
  const joining: Step[] = [
    {
      icon: LayoutGrid,
      title: `Welcome to ${t.school_name}`,
      body:
        'The left rail switches between the roles you hold; the column beside it lists what ' +
        'you can do in the one you are in. Everything you see is scoped to you — your ' +
        'sections, your children, your department.',
    },
    {
      icon: GraduationCap,
      title: 'Your day is the first screen',
      body:
        'It opens on what is happening now: the classes you teach today, whose register is ' +
        'still unmarked, and anything waiting on your approval.',
    },
    {
      icon: Users,
      title: `Press ${shortcutLabel('K')} to find anything`,
      body:
        'Search jumps to any screen or student without navigating. It is faster than the ' +
        'menu once you know the name of what you want.',
    },
  ]

  return t.is_first_user && t.role === 'institution_admin' ? first : joining
}

export default function FirstRunTour() {
  const qc = useQueryClient()
  const [at, setAt] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const { data } = useQuery({
    queryKey: ['tour'],
    queryFn: () => api.get<Tour>('/api/v1/tour'),
    // A network failure here must never block the application: the tour is
    // the least important thing on the screen.
    retry: false,
  })

  const finish = useMutation({
    mutationFn: () => api.post('/api/v1/tour', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tour'] }),
  })

  const showing = !!data && !data.seen && !dismissed
  const dismiss = useCallback(() => {
    setDismissed(true)
    finish.mutate()
  }, [finish])
  // The phone's Back dismisses the tour, like every overlay: see overlay-history.ts.
  useOverlayHistory(showing, dismiss)
  if (!showing) return null
  const steps = stepsFor(data)
  const step = steps[at]
  const Icon = step.icon
  const last = at === steps.length - 1

  const close = dismiss

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4"
      /* Fixed elements escape the body's notch padding; the card should
         centre within the safe area, not the glass. Zero in a browser and on
         Android. */
      style={{
        paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
      }}
    >
      <div className="w-full max-w-lg rounded-xl border bg-card shadow-pop">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {steps.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1 w-6 rounded-full transition-colors duration-150',
                  i <= at ? 'bg-primary' : 'bg-border',
                )}
              />
            ))}
            <span className="ml-1 tabular-nums">
              {at + 1} of {steps.length}
            </span>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Skip the introduction"
            className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-6">
          <span className="mb-4 inline-grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </span>
          <h2 id="tour-title" className="text-[18px] font-semibold tracking-[-0.015em]">
            {step.title}
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-secondary-foreground">{step.body}</p>
          {step.aside && (
            <p className="mt-3 rounded-md border-l-2 border-border bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
              {step.aside}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
          <Button variant="ghost" onClick={close}>
            {last ? 'Close' : 'Skip'}
          </Button>
          <div className="flex items-center gap-2">
            {at > 0 && (
              <Button variant="secondary" onClick={() => setAt(at - 1)}>
                Back
              </Button>
            )}
            {last ? (
              <Button onClick={close}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                Start setting up
              </Button>
            ) : (
              <Button onClick={() => setAt(at + 1)}>
                Next
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
