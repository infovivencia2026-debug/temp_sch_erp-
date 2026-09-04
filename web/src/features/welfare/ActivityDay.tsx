import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { DayBoard, type DayCard } from './DayBoard'

/* The coordinator's day: the clubs and teams running, how full they are, and
   the achievements written up but not yet in front of families. Places are
   real — capacity and enrolled both arrive on every activity row. */

interface Activity { id: string; is_active: boolean; capacity: number; enrolled: number }
interface Entry { id: string; is_published: boolean; consent_basis?: string }

export default function ActivityDay() {
  const t = useT()
  const activities = useQuery({
    queryKey: ['activities'],
    queryFn: () => api.get<List<Activity>>('/api/v1/academics/activities'),
  })
  const showcase = useQuery({
    queryKey: ['showcase', ''],
    queryFn: () => api.get<List<Entry>>('/api/v1/comms/achievements/'),
  })

  const running = (activities.data?.items ?? []).filter((a) => a.is_active)
  const enrolled = running.reduce((n, a) => n + a.enrolled, 0)
  const capped = running.filter((a) => a.capacity > 0)
  const places = capped.reduce((n, a) => n + Math.max(0, a.capacity - a.enrolled), 0)
  const full = capped.filter((a) => a.enrolled >= a.capacity).length
  const entries = showcase.data?.items ?? []
  const unpublished = entries.filter((e) => !e.is_published)
  const ready = unpublished.filter((e) => e.consent_basis).length

  const cards: DayCard[] = [
    {
      id: 'running',
      ground: 'academics',
      title: t('bento.welfare.activity.running'),
      value: running.length,
      change: enrolled ? t('bento.welfare.activity.enrolled', { n: enrolled }) : undefined,
      facts: running.length
        ? [
            { label: t('bento.welfare.activity.places'), value: String(places) },
            { label: t('bento.welfare.activity.full'), value: String(full) },
          ]
        : [],
      say: t('bento.welfare.activity.none'),
      opens: 'activity_coord.activities.clubs_activities',
      cue: t('bento.welfare.activity.cue_running'),
    },
    {
      id: 'publish',
      title: t('bento.welfare.activity.publish'),
      value: unpublished.length,
      facts: unpublished.length
        ? [
            { label: t('bento.welfare.activity.consented'), value: String(ready) },
            { label: t('bento.welfare.activity.awaiting_consent'), value: String(unpublished.length - ready) },
          ]
        : [],
      say: t('bento.welfare.activity.nothing_to_publish'),
      opens: 'activity_coord.activities.achievements_showcase',
      cue: t('bento.welfare.activity.cue_publish'),
    },
    {
      id: 'published',
      title: t('bento.welfare.activity.published'),
      value: entries.length - unpublished.length,
      say: entries.length ? t('bento.welfare.activity.published_note') : t('bento.welfare.activity.nothing_published'),
      opens: 'activity_coord.activities.achievements_showcase',
      cue: t('bento.welfare.activity.cue_publish'),
    },
  ]

  return (
    <DayBoard
      dashboard="activity_day"
      eyebrow={t('bento.welfare.activity.eyebrow')}
      title={t('bento.welfare.activity.title')}
      loading={activities.isLoading || showcase.isLoading}
      failed={!!(activities.error || showcase.error)}
      cards={cards}
    />
  )
}
