import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { DayBoard, weekAgo, type DayCard } from './DayBoard'

/* The discipline officer's day: what is still open in the incident log, and
   what was written about conduct this week. The summary figures come off the
   log endpoint itself, so the numbers here are the numbers on that screen. */

interface Log {
  items: { id: string }[]
  summary: { incidents: number; open: number; serious: number; suspensions: number; parent_meetings: number }
}
interface Note { id: string; occurred_on: string; is_positive: boolean }

export default function DisciplineDay() {
  const t = useT()
  const log = useQuery({
    queryKey: ['incidents', '', ''],
    queryFn: () => api.get<Log>('/api/v1/academics/admin/incidents?concerns_only=1'),
  })
  const notes = useQuery({
    queryKey: ['discipline-notes'],
    queryFn: () => api.get<List<Note>>('/api/v1/students/notes'),
  })

  const s = log.data?.summary
  const since = weekAgo()
  const week = (notes.data?.items ?? []).filter((n) => n.occurred_on >= since)
  const praise = week.filter((n) => n.is_positive).length
  const concern = week.length - praise

  const cards: DayCard[] = [
    {
      id: 'open',
      ground: 'students',
      title: t('bento.welfare.discipline.open'),
      value: s?.open ?? 0,
      change: s?.incidents ? t('bento.welfare.discipline.of_term', { n: s.incidents }) : undefined,
      facts: s?.open
        ? [
            { label: t('bento.welfare.discipline.serious'), value: String(s.serious) },
            { label: t('bento.welfare.discipline.suspensions'), value: String(s.suspensions) },
            { label: t('bento.welfare.discipline.meetings'), value: String(s.parent_meetings) },
          ]
        : [],
      say: t('bento.welfare.discipline.nothing_open'),
      opens: 'discipline_officer.discipline.incident_log',
      cue: t('bento.welfare.discipline.cue_log'),
    },
    {
      id: 'week',
      title: t('bento.welfare.discipline.week'),
      value: week.length,
      facts: week.length
        ? [
            { label: t('bento.welfare.discipline.praise'), value: String(praise) },
            { label: t('bento.welfare.discipline.concerns'), value: String(concern) },
          ]
        : [],
      say: t('bento.welfare.discipline.no_notes'),
      opens: 'discipline_officer.discipline.conduct_notes',
      cue: t('bento.welfare.discipline.cue_notes'),
    },
    {
      id: 'serious',
      title: t('bento.welfare.discipline.serious_title'),
      value: s?.serious ?? 0,
      say: s?.serious ? t('bento.welfare.discipline.serious_note') : t('bento.welfare.discipline.no_serious'),
      opens: 'discipline_officer.discipline.incident_log',
      cue: t('bento.welfare.discipline.cue_log'),
    },
  ]

  return (
    <DayBoard
      dashboard="discipline_day"
      eyebrow={t('bento.welfare.discipline.eyebrow')}
      title={t('bento.welfare.discipline.title')}
      loading={log.isLoading || notes.isLoading}
      failed={!!(log.error || notes.error)}
      cards={cards}
    />
  )
}
