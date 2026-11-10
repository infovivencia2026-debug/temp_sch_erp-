import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { BentoError, BentoLoading, useFeatureHref } from './bento-kit'
import { Facts, PersonaCard, PersonaPage, Say } from './persona-kit'
import { Widget } from './WidgetLayer'
import { inClassic } from './classic-board'

/* THE TRANSPORT OFFICE'S FOCUS BOARD (owner, 2026-11-10: "everyone has their
   own bentos on focus"). One source, /ops/transport/today, the same summary
   the Work desk reads. */

type Today = {
  routes: number; running: number; completed: number; not_started: number
  failed_checks: { vehicle: string; leg: string; failed_items: string[] }[]
  expiring: { vehicle: string; kind: string; on_date: string; days: number }[]
  gaps: { route: string; gap: string }[]
  open_incidents: number
}

function TransportBoard() {
  const q = useQuery({ queryKey: ['transport-today'], queryFn: () => api.get<Today>('/api/v1/ops/transport/today'), refetchInterval: 60_000 })
  const toRuns = useFeatureHref('transport_manager.transport.todays_runs')
  const toDelays = useFeatureHref('transport_manager.transport.delays_exceptions')
  const toReports = useFeatureHref('transport_manager.reports.transport_reports')
  if (q.isLoading) return <BentoLoading message="Opening the transport desk…" />
  if (q.error || !q.data) return <BentoError message={String(q.error ?? 'No data')} />
  const d = q.data
  return (
    <PersonaPage eyebrow="Home" title="Transport desk" dashboard="transport_board">
      <Widget id="out" label="Buses out" size="large" index={0}>
        {(span) => (
          <PersonaCard span={span} ground="operations" title="Buses out now" glyph="▶" value={d.running}
            change={`${d.routes} routes · ${d.completed} finished · ${d.not_started} not started`} to={toRuns} cueLabel="Open today's runs">
            <Facts srLabel="Runs today" items={[
              { label: 'Running', value: String(d.running) }, { label: 'Finished', value: String(d.completed) }, { label: 'Not started', value: String(d.not_started) },
            ]} />
          </PersonaCard>
        )}
      </Widget>
      <Widget id="checks" label="Failed checks" size="small" index={1}>
        {(span) => (
          <PersonaCard span={span} ground="critical" title="Failed checks" glyph="!" value={d.failed_checks.length}
            change={d.failed_checks.length ? 'Buses that failed the morning check' : 'Every bus cleared'} to={toRuns} cueLabel="Open today's runs">
            {d.failed_checks.length ? <Facts srLabel="Failed checks" items={d.failed_checks.slice(0, 3).map((c) => ({ label: c.vehicle, value: c.leg }))} /> : <Say>Nothing failed</Say>}
          </PersonaCard>
        )}
      </Widget>
      <Widget id="incidents" label="Incidents" size="small" index={2}>
        {(span) => (
          <PersonaCard span={span} ground="staff" title="Open incidents" glyph="◔" value={d.open_incidents}
            change={d.open_incidents ? 'Waiting to be closed' : 'None open'} to={toDelays} cueLabel="Open delays and exceptions">
            <Say>{d.gaps.length ? `${d.gaps.length} route gaps today` : 'Every route is covered'}</Say>
          </PersonaCard>
        )}
      </Widget>
      <Widget id="papers" label="Papers expiring" size="small" index={3}>
        {(span) => (
          <PersonaCard span={span} ground="reports" title="Papers expiring" glyph="◷" value={d.expiring.length}
            change={d.expiring.length ? 'Insurance, permits and fitness due' : 'Nothing due soon'} to={toReports} cueLabel="Open transport reports">
            {d.expiring.length ? <Facts srLabel="Expiring papers" items={d.expiring.slice(0, 3).map((x) => ({ label: `${x.vehicle} ${x.kind}`, value: `${x.days}d` }))} /> : <Say>All papers in date</Say>}
          </PersonaCard>
        )}
      </Widget>
    </PersonaPage>
  )
}

export const Classic = inClassic(TransportBoard)
export default TransportBoard
