import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Footprints } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Checkbox, Field, Input, FormNotice,
  EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import type { ChildBusFeed } from './child-bus'
import {
  ALL_CHILDREN, PROXIMITY_MAX, PROXIMITY_MIN, currentFor, proximityError, savePrefs, walkText,
} from './transport-prefs'
import { ChildScope } from './transport-prefs-ui'

/* How close before you are told the bus is coming.

   The setting is a number of metres, and metres are not how anyone decides
   this. A parent judges it in the time it takes to get a child's shoes on and
   walk to the corner, so every choice on this screen carries the walk it
   corresponds to -- 800 m is roughly a ten-minute walk -- and the typed box
   restates it as you type.

   The straight-line caveat is repeated here rather than assumed known from
   the map screen. The alert fires on crow-flies distance, so a bus 500 m away
   with a level crossing between it and the stop is further off in minutes
   than the number suggests. A family choosing 300 m because it sounds close
   deserves to know that is the case where it will feel latest. */

const PRESETS = [300, 500, 800, 1500, 3000]

export default function BusProximityAlert() {
  const qc = useQueryClient()
  const feed = useQuery({
    queryKey: ['me-child-bus'],
    queryFn: () => api.get<ChildBusFeed>('/api/v1/me/child-bus'),
  })
  const rows = feed.data?.items ?? []

  const [student, setStudent] = useState(ALL_CHILDREN)
  const [metres, setMetres] = useState('')
  const [notify, setNotify] = useState(true)
  const current = currentFor(rows, student)

  useEffect(() => {
    setMetres(String(current.proximity))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student, current.proximity])

  const value = Number(metres)
  const problem = metres.trim() === '' ? 'Enter a distance in metres.' : proximityError(value)

  const save = useMutation({
    mutationFn: () =>
      savePrefs({
        ...(student ? { student_id: student } : {}),
        // Carried so that setting an alert distance does not quietly reset how
        // often the map refreshes, which lives on its own screen.
        refresh_seconds: current.refresh,
        proximity_m: value,
        notify_approach: notify,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-child-bus'] }),
  })

  if (feed.isLoading) return <ScreenSkeleton label="Reading your settings…" />
  if (feed.error && !feed.data) return <ScreenError error={feed.error} />

  return (
    <>
      <PageHead
        eyebrow="Alerts & preferences"
        title="Tell me when the bus is close"
        description="Choose how near the bus should be before you hear about it. The distance is measured in a straight line from your child's stop, not along the road — the bus will usually take a little longer to arrive than the number suggests."
      />
      <Freshness query={feed} />
      <PageBody width="form">
        {rows.length === 0 ? (
          <EmptyState
            title="No child of yours is on a school bus"
            body="This alert follows a child's transport allocation. Once the office puts a child of yours on a route, the setting applies here."
          />
        ) : (
          <Card>
            <CardHeader
              title="Approach alert"
              description={`Anywhere from ${PROXIMITY_MIN} m to ${PROXIMITY_MAX / 1000} km from the stop.`}
            />
            <div className="space-y-5 px-5 py-4">
              <ChildScope rows={rows} value={student} onChange={setStudent} mixed={current.mixed} />

              <Checkbox
                checked={notify}
                onChange={setNotify}
                label="Tell me when the bus is approaching the stop"
                hint="Switch this off and the distance below stops being used — the bus still appears on the live map, you simply are not told about it."
              />

              <div className="grid gap-2 sm:grid-cols-2">
                {PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={!notify}
                    onClick={() => setMetres(String(m))}
                    className={
                      'rounded-md border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ' +
                      (value === m ? 'border-primary bg-primary/5' : 'bg-card hover:bg-accent')
                    }
                  >
                    <span className="block text-[14px] font-medium">
                      {m >= 1000 ? `${m / 1000} km away` : `${m} m away`}
                    </span>
                    <span className="block text-[12.5px] text-muted-foreground">{walkText(m)}</span>
                  </button>
                ))}
              </div>

              <Field
                label="Or set it exactly"
                hint={`In metres, between ${PROXIMITY_MIN} and ${PROXIMITY_MAX}. Closer than ${PROXIMITY_MIN} m and the bus is effectively at the stop before you are told; further than ${PROXIMITY_MAX / 1000} km and it is not really news.`}
              >
                <Input value={metres} onChange={setMetres} type="number" className="max-w-[10rem]" />
              </Field>

              {!problem && (
                <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
                  <Footprints className="mt-0.5 h-4 w-4 shrink-0" />
                  {value.toLocaleString('en-IN')} m is {walkText(value)}. Measured straight from the
                  stop, so allow for the roads between.
                </p>
              )}
              {problem && metres.trim() !== '' && (
                <p className="text-[13px] text-destructive">{problem}</p>
              )}

              <div className="flex items-center gap-3">
                <Button disabled={!!problem || save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
                <span className="text-[13px] text-muted-foreground">
                  Currently {current.proximity.toLocaleString('en-IN')} m.
                </span>
              </div>

              <FormNotice
                error={save.error}
                ok={save.isSuccess && !save.isPending ? 'Saved.' : undefined}
              />
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
