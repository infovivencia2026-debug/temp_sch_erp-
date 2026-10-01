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
import { useT } from '@/lib/i18n'

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
  const t = useT()
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
  const problem = metres.trim() === '' ? t('portal.bus_proximity_alert.enter_distance') : proximityError(value)

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

  if (feed.isLoading && !feed.data) return <ScreenSkeleton label={t('portal.bus_proximity_alert.loading')} />
  if (feed.error && !feed.data) return <ScreenError error={feed.error} />

  return (
    <>
      <PageHead
        eyebrow={t('portal.bus_proximity_alert.eyebrow')}
        title={t('portal.bus_proximity_alert.title')}
        description={t('portal.bus_proximity_alert.description')}
      />
      <Freshness query={feed} />
      <PageBody width="form">
        {rows.length === 0 ? (
          <EmptyState
            title={t('portal.bus_proximity_alert.empty_title')}
            body={t('portal.bus_proximity_alert.empty_body')}
          />
        ) : (
          <Card>
            <CardHeader
              title={t('portal.bus_proximity_alert.card_title')}
              description={t('portal.bus_proximity_alert.card_description', { min: PROXIMITY_MIN, max_km: PROXIMITY_MAX / 1000 })}
            />
            <div className="space-y-5 px-5 py-4">
              <ChildScope rows={rows} value={student} onChange={setStudent} mixed={current.mixed} />

              <Checkbox
                checked={notify}
                onChange={setNotify}
                label={t('portal.bus_proximity_alert.notify_label')}
                hint={t('portal.bus_proximity_alert.notify_hint')}
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
                      {m >= 1000 ? t('portal.bus_proximity_alert.preset_km', { km: m / 1000 }) : t('portal.bus_proximity_alert.preset_m', { m })}
                    </span>
                    <span className="block text-[12.5px] text-muted-foreground">{walkText(m)}</span>
                  </button>
                ))}
              </div>

              <Field
                label={t('portal.bus_proximity_alert.exact_label')}
                hint={t('portal.bus_proximity_alert.exact_hint', { min: PROXIMITY_MIN, max: String(PROXIMITY_MAX), max_km: PROXIMITY_MAX / 1000 })}
              >
                <Input value={metres} onChange={setMetres} type="number" className="max-w-[10rem]" />
              </Field>

              {!problem && (
                <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
                  <Footprints className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('portal.bus_proximity_alert.walk_note', { m: value, walk: walkText(value) })}
                </p>
              )}
              {problem && metres.trim() !== '' && (
                <p className="text-[13px] text-destructive">{problem}</p>
              )}

              <div className="flex flex-wrap items-center gap-3 gap-y-2">
                <Button disabled={!!problem || save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? t('portal.bus_proximity_alert.saving') : t('portal.bus_proximity_alert.save')}
                </Button>
                <span className="text-[13px] text-muted-foreground">
                  {t('portal.bus_proximity_alert.currently', { m: current.proximity })}
                </span>
              </div>

              <FormNotice
                error={save.error}
                ok={save.isSuccess && !save.isPending ? t('portal.bus_proximity_alert.saved') : undefined}
              />
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
