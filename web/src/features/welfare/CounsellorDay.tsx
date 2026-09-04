import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { DayBoard, weekAgo, type DayCard } from './DayBoard'

/* The counsellor's day: the threads they are in, the concerns teachers wrote
   this week, and the children whose health file says something. Threads are
   only the ones this account is a participant of — the server refuses the
   rest, so the count is honest by construction. */

interface Thread { id: string; status: string; urgency: string; unread: number }
interface Note { id: string; occurred_on: string; is_positive: boolean }
interface Health { student_id: string; allergies?: string; chronic_conditions?: string }

export default function CounsellorDay() {
  const t = useT()
  const threads = useQuery({
    queryKey: ['counselor-threads'],
    queryFn: () => api.get<List<Thread>>('/api/v1/comms/counselor/threads'),
  })
  const notes = useQuery({
    queryKey: ['discipline-notes'],
    queryFn: () => api.get<List<Note>>('/api/v1/students/notes'),
  })
  const flagged = useQuery({
    queryKey: ['health', '', true],
    queryFn: () => api.get<List<Health>>('/api/v1/ops/health/students?q=&flagged=true'),
  })

  const open = (threads.data?.items ?? []).filter((x) => x.status === 'open')
  const unread = open.reduce((n, x) => n + (x.unread || 0), 0)
  const urgent = open.filter((x) => x.urgency === 'urgent').length
  const since = weekAgo()
  const week = (notes.data?.items ?? []).filter((n) => n.occurred_on >= since)
  const concerns = week.filter((n) => !n.is_positive).length
  const flags = flagged.data?.items ?? []

  const cards: DayCard[] = [
    {
      id: 'threads',
      ground: 'communication',
      title: t('bento.welfare.counsellor.threads'),
      value: open.length,
      change: unread ? t('bento.welfare.counsellor.unread', { n: unread }) : undefined,
      facts: open.length
        ? [
            { label: t('bento.welfare.counsellor.urgent'), value: String(urgent) },
            { label: t('bento.welfare.counsellor.unread_label'), value: String(unread) },
          ]
        : [],
      say: t('bento.welfare.counsellor.no_threads'),
      opens: 'counsellor.counselling.family_conversations',
      cue: t('bento.welfare.counsellor.cue_threads'),
    },
    {
      id: 'concerns',
      title: t('bento.welfare.counsellor.concerns'),
      value: concerns,
      change: week.length ? t('bento.welfare.counsellor.of_notes', { n: week.length }) : undefined,
      say: t('bento.welfare.counsellor.no_concerns'),
      opens: 'counsellor.counselling.conduct_notes',
      cue: t('bento.welfare.counsellor.cue_concerns'),
    },
    {
      id: 'flags',
      title: t('bento.welfare.counsellor.flags'),
      value: flags.length,
      facts: flags.length
        ? [
            { label: t('bento.welfare.nurse.allergies'), value: String(flags.filter((f) => f.allergies).length) },
            { label: t('bento.welfare.nurse.chronic'), value: String(flags.filter((f) => f.chronic_conditions).length) },
          ]
        : [],
      say: t('bento.welfare.nurse.no_flags'),
      opens: 'counsellor.counselling.health_records',
      cue: t('bento.welfare.nurse.cue_flags'),
    },
  ]

  return (
    <DayBoard
      dashboard="counsellor_day"
      eyebrow={t('bento.welfare.counsellor.eyebrow')}
      title={t('bento.welfare.counsellor.title')}
      loading={threads.isLoading || notes.isLoading || flagged.isLoading}
      failed={!!(threads.error || notes.error || flagged.error)}
      cards={cards}
    />
  )
}
