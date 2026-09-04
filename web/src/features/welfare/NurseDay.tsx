import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { DayBoard, today, type DayCard } from './DayBoard'

/* The clinic's day. Every figure is read from the registers the nurse keeps;
   nothing here is a share of anything, because a school has no "expected
   visits" to divide by. */

interface Visit { id: string; outcome: string; on_date: string }
interface Dose { id: string; administered_at: string }
interface Health { student_id: string; allergies?: string; chronic_conditions?: string }

export default function NurseDay() {
  const t = useT()
  const visits = useQuery({
    queryKey: ['infirmary-visits', 'today'],
    queryFn: () => api.get<List<Visit>>('/api/v1/ops/infirmary/visits'),
  })
  const doses = useQuery({
    queryKey: ['infirmary-medications'],
    queryFn: () => api.get<List<Dose>>('/api/v1/ops/infirmary/medications'),
  })
  const flagged = useQuery({
    queryKey: ['health', '', true],
    queryFn: () => api.get<List<Health>>('/api/v1/ops/health/students?q=&flagged=true'),
  })

  const v = visits.data?.items ?? []
  const day = today()
  const givenToday = (doses.data?.items ?? []).filter((d) => d.administered_at?.startsWith(day))
  const flags = flagged.data?.items ?? []
  const byOutcome = new Map<string, number>()
  for (const x of v) byOutcome.set(x.outcome, (byOutcome.get(x.outcome) ?? 0) + 1)

  const cards: DayCard[] = [
    {
      id: 'visits',
      ground: 'attendance',
      title: t('bento.welfare.nurse.visits'),
      value: v.length,
      change: v.length ? t('bento.welfare.nurse.visits_change', { n: givenToday.length }) : undefined,
      facts: [...byOutcome].map(([k, n]) => ({ label: k.replace(/_/g, ' '), value: String(n) })),
      say: t('bento.welfare.nurse.no_visits'),
      opens: 'nurse.clinic.visits_medication',
      cue: t('bento.welfare.nurse.cue_visits'),
    },
    {
      id: 'doses',
      title: t('bento.welfare.nurse.doses'),
      value: givenToday.length,
      say: givenToday.length ? t('bento.welfare.nurse.doses_note') : t('bento.welfare.nurse.no_doses'),
      opens: 'nurse.clinic.visits_medication',
      cue: t('bento.welfare.nurse.cue_doses'),
    },
    {
      id: 'flags',
      title: t('bento.welfare.nurse.flags'),
      value: flags.length,
      facts: flags.length
        ? [
            { label: t('bento.welfare.nurse.allergies'), value: String(flags.filter((f) => f.allergies).length) },
            { label: t('bento.welfare.nurse.chronic'), value: String(flags.filter((f) => f.chronic_conditions).length) },
          ]
        : [],
      say: t('bento.welfare.nurse.no_flags'),
      opens: 'nurse.clinic.health_records',
      cue: t('bento.welfare.nurse.cue_flags'),
    },
  ]

  return (
    <DayBoard
      dashboard="nurse_day"
      eyebrow={t('bento.welfare.nurse.eyebrow')}
      title={t('bento.welfare.nurse.title')}
      loading={visits.isLoading || doses.isLoading || flagged.isLoading}
      failed={!!(visits.error || doses.error || flagged.error)}
      cards={cards}
    />
  )
}
