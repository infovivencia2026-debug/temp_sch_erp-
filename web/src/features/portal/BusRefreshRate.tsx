import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BatteryMedium } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Field, Input, FormNotice,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import type { ChildBusFeed } from './child-bus'
import {
  ALL_CHILDREN, REFRESH_MAX, REFRESH_MIN, batteryText, currentFor, refreshError, savePrefs,
} from './transport-prefs'
import { ChildScope } from './transport-prefs-ui'

/* How often the map updates.

   Written in the parent's terms rather than the system's. Nothing on this
   screen says "poll interval": what a family is choosing is how fresh the
   picture is against how much of their own phone battery goes on fetching it,
   and that trade is stated on every preset rather than left as a number to
   guess at.

   The presets are the screen; the box is for the parent who wants 45. Both go
   through the same bound check, and a value outside 10-300 is refused with
   the bound named. Not clamped: a form that turns 5 into 10 without saying so
   is a form the parent will swear they set to 5. */

const PRESETS = [
  { seconds: 10, label: 'Every 10 seconds', when: 'while you are waiting at the stop' },
  { seconds: 20, label: 'Every 20 seconds', when: 'the usual choice' },
  { seconds: 60, label: 'Every minute', when: 'keeping half an eye on it' },
  { seconds: 180, label: 'Every 3 minutes', when: 'just want to know it is coming' },
]

export default function BusRefreshRate() {
  const qc = useQueryClient()
  const feed = useQuery({
    queryKey: ['me-child-bus'],
    queryFn: () => api.get<ChildBusFeed>('/api/v1/me/child-bus'),
  })
  const rows = feed.data?.items ?? []

  const [student, setStudent] = useState(ALL_CHILDREN)
  const [seconds, setSeconds] = useState('')
  const current = currentFor(rows, student)

  // The box follows whichever child is selected, so switching target never
  // leaves last child's number sitting in a field about to be saved.
  useEffect(() => {
    setSeconds(String(current.refresh))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student, current.refresh])

  const value = Number(seconds)
  const problem = seconds.trim() === '' ? 'Enter a number of seconds.' : refreshError(value)

  const save = useMutation({
    mutationFn: () =>
      savePrefs({
        ...(student ? { student_id: student } : {}),
        refresh_seconds: value,
        // Carried, not defaulted. Omitting it would reset the family's alert
        // distance to the server's 800 m as a side effect of changing the map
        // speed, on a screen that never mentions distance.
        proximity_m: current.proximity,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-child-bus'] }),
  })

  if (feed.isLoading) return <Loading label="Reading your settings…" />
  if (feed.error) return <ErrorState error={feed.error} />

  return (
    <>
      <PageHead
        eyebrow="Alerts & preferences"
        title="How often the bus map updates"
        description="The live map fetches the bus's position on a timer. A faster timer means a fresher picture and more of your phone's battery; a slower one means the bus may be a street or two past where the map shows it."
      />
      <PageBody width="form">
        {rows.length === 0 ? (
          <EmptyState
            title="No child of yours is on a school bus"
            body="This setting only affects the live bus map, and that map appears once a child of yours has a transport allocation."
          />
        ) : (
          <Card>
            <CardHeader
              title="Map refresh"
              description={`Anything from ${REFRESH_MIN} seconds to ${REFRESH_MAX} seconds (5 minutes).`}
            />
            <div className="space-y-5 px-5 py-4">
              <ChildScope rows={rows} value={student} onChange={setStudent} mixed={current.mixed} />

              <div className="grid gap-2 sm:grid-cols-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.seconds}
                    type="button"
                    onClick={() => setSeconds(String(p.seconds))}
                    className={
                      'rounded-md border px-3 py-2.5 text-left transition-colors ' +
                      (value === p.seconds
                        ? 'border-primary bg-primary/5'
                        : 'bg-card hover:bg-accent')
                    }
                  >
                    <span className="block text-[14px] font-medium">{p.label}</span>
                    <span className="block text-[12.5px] text-muted-foreground">{p.when}</span>
                  </button>
                ))}
              </div>

              <Field
                label="Or set it exactly"
                hint={`In seconds, between ${REFRESH_MIN} and ${REFRESH_MAX}. The school sets these limits: a one-second refresh spends your battery and the school's server, and neither is yours alone to spend.`}
              >
                <Input value={seconds} onChange={setSeconds} type="number" className="max-w-[10rem]" />
              </Field>

              {!problem && (
                <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
                  <BatteryMedium className="mt-0.5 h-4 w-4 shrink-0" />
                  {batteryText(value)}
                </p>
              )}
              {problem && seconds.trim() !== '' && (
                <p className="text-[13px] text-destructive">{problem}</p>
              )}

              <div className="flex items-center gap-3">
                <Button disabled={!!problem || save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
                <span className="text-[13px] text-muted-foreground">
                  Currently {current.refresh} seconds
                  {student ? '' : rows.length > 1 ? ' for the first of your children' : ''}.
                </span>
              </div>

              <FormNotice
                error={save.error}
                ok={save.isSuccess && !save.isPending ? 'Saved. The map picks it up on its next fetch.' : undefined}
              />
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
