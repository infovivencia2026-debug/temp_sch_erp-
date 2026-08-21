import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardHeader, Button } from '@/components/ui'

/* What a school that is not set up yet should see instead of zeroes.
 *
 * getSetupStatus has carried this comment since it was written: "An empty ERP
 * is indistinguishable from a broken one, so the first screen a fresh tenant
 * sees should be a checklist rather than a dashboard of zeroes." The endpoint
 * was built and the dashboard never called it, so a school that had just paid
 * arrived at nought students, nought staff, nought per cent attendance and
 * nothing collected — which reads as a product that does not work rather than
 * one that has not been filled in.
 *
 * Three states, because a school passes through all of them:
 *
 *   Nothing required left, nothing optional left  — say nothing. The dashboard
 *     is the point of the screen and a congratulation that never goes away is
 *     noise.
 *   Required steps outstanding — take over the top of the page. The numbers
 *     below are all zero and explaining why is more use than showing them.
 *   Only optional steps left — one quiet line. Grading and fee structures
 *     matter, but a school taking attendance is running, and it should not be
 *     nagged as though it were broken.
 */

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

/* Where the wizard lives in the principal's own workspace.

   It moved. Academics used to carry an "Academic structure" entry that opened
   the setup wizard, and trimming that menu removed it as a duplicate of
   Getting Started — correctly, but this link kept pointing at the dead route.
   A route the catalogue no longer knows resolves to the first screen in the
   section instead, so every "Open setup" landed on the master timetable: no
   error, no clue, and the one button whose whole job is to finish setting the
   school up went somewhere else entirely. */
const WIZARD = '/institution_admin/getting_started/school_setup'

export default function SetupProgress() {
  const navigate = useNavigate()
  const { data, isLoading, error } = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<Status>('/api/v1/setup/status'),
    staleTime: 30_000,
  })

  // Silent while loading and silent on failure. This panel is an aid, and a
  // dashboard that refuses to render because the checklist could not be read
  // would be a worse bug than the one it exists to fix.
  if (isLoading || error || !data) return null

  const pct = data.total ? Math.round((data.completed / data.total) * 100) : 0
  const outstanding = data.steps.filter((s) => !s.done)
  if (!outstanding.length) return null

  if (data.ready) {
    const optional = outstanding.length
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-3 text-[13px]">
        <span className="font-medium">Your school is running.</span>
        <span className="text-muted-foreground">
          {optional} optional {optional === 1 ? 'step' : 'steps'} left —{' '}
          {outstanding.slice(0, 3).map((s) => s.label.toLowerCase()).join(', ')}
          {optional > 3 ? ' and more' : ''}.
        </span>
        <Link to={WIZARD} className="ml-auto text-[13px] underline underline-offset-2">
          Finish setup
        </Link>
      </div>
    )
  }

  // Required steps outstanding. Show the next three rather than all fifteen:
  // the wizard is the place to work through them, and a fourteen-item list on
  // the dashboard is a second wizard competing with the first.
  const blocking = outstanding.filter((s) => s.blocking)
  const next = blocking.slice(0, 3)

  return (
    <Card className="mb-5 border-primary/40">
      <CardHeader
        title="Finish setting up your school"
        description={
          `${data.blocking_remaining} required ${data.blocking_remaining === 1 ? 'step' : 'steps'} left. ` +
          'The rest of the menu appears once these are done — attendance with nobody ' +
          'to mark and report cards with no exam would each be correct and, together, ' +
          'would read as a product that does not work.'
        }
        action={
          <Button size="sm" onClick={() => navigate(WIZARD)}>
            Open setup
            <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        }
      />

      <div className="px-4 pb-4">
        <div className="flex items-center gap-3">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Setup progress"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: pct + '%' }} />
          </div>
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {data.completed} of {data.total}
          </span>
        </div>

        <ol className="mt-4 space-y-2.5">
          {next.map((s, i) => (
            <li key={s.key} className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border text-[11px] tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-medium">{s.label}</p>
                <p className="text-[12.5px] text-muted-foreground">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>

        {blocking.length > next.length && (
          <p className="mt-3 text-[12.5px] text-muted-foreground">
            …and {blocking.length - next.length} more after those.
          </p>
        )}

      </div>
    </Card>
  )
}
