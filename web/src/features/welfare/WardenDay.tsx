import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { DayBoard, type DayCard } from './DayBoard'

/* The warden's day: passes waiting on a decision, boarders out and late back,
   beds against boarders, and complaints still open. Occupancy is the one real
   proportion — occupied beds out of beds that exist, both off the same rows. */

interface Pass { id: string; status: string; overdue: boolean }
interface Room { room_id: string; beds: number; occupied: number; free: number }
interface Complaint { id: string; status: string }

export default function WardenDay() {
  const t = useT()
  const passes = useQuery({
    queryKey: ['outpasses', ''],
    queryFn: () => api.get<List<Pass>>('/api/v1/ops/hostel/outpasses'),
  })
  const rooms = useQuery({
    queryKey: ['hostel-occupancy'],
    queryFn: () => api.get<List<Room>>('/api/v1/ops/hostel/occupancy'),
  })
  const complaints = useQuery({
    queryKey: ['hostel-complaints', ''],
    queryFn: () => api.get<List<Complaint>>('/api/v1/ops/hostel/complaints'),
  })

  const p = passes.data?.items ?? []
  const waiting = p.filter((x) => x.status === 'requested').length
  const out = p.filter((x) => x.status === 'out').length
  const late = p.filter((x) => x.overdue).length
  const r = rooms.data?.items ?? []
  const beds = r.reduce((n, x) => n + x.beds, 0)
  const occupied = r.reduce((n, x) => n + x.occupied, 0)
  const openComplaints = (complaints.data?.items ?? []).filter((c) => c.status === 'open').length

  const cards: DayCard[] = [
    {
      id: 'passes',
      ground: 'operations',
      title: t('bento.welfare.warden.passes'),
      value: waiting,
      change: out ? t('bento.welfare.warden.out_now', { n: out }) : undefined,
      facts: p.length
        ? [
            { label: t('bento.welfare.warden.out'), value: String(out) },
            { label: t('bento.welfare.warden.late'), value: String(late) },
          ]
        : [],
      say: t('bento.welfare.warden.no_passes'),
      opens: 'hostel_warden.hostel.outpasses_mess',
      cue: t('bento.welfare.warden.cue_passes'),
    },
    {
      id: 'beds',
      title: t('bento.welfare.warden.beds'),
      value: occupied,
      change: beds ? t('bento.welfare.warden.of_beds', { n: beds }) : undefined,
      facts: beds
        ? [
            { label: t('bento.welfare.warden.free'), value: String(beds - occupied) },
            { label: t('bento.welfare.warden.rooms'), value: String(r.length) },
          ]
        : [],
      say: t('bento.welfare.warden.no_rooms'),
      opens: 'hostel_warden.hostel.hostel_rooms',
      cue: t('bento.welfare.warden.cue_beds'),
    },
    {
      id: 'complaints',
      title: t('bento.welfare.warden.complaints'),
      value: openComplaints,
      say: openComplaints ? t('bento.welfare.warden.complaints_note') : t('bento.welfare.warden.no_complaints'),
      opens: 'hostel_warden.hostel.outpasses_mess',
      cue: t('bento.welfare.warden.cue_complaints'),
    },
  ]

  return (
    <DayBoard
      dashboard="warden_day"
      eyebrow={t('bento.welfare.warden.eyebrow')}
      title={t('bento.welfare.warden.title')}
      loading={passes.isLoading || rooms.isLoading || complaints.isLoading}
      failed={!!(passes.error || rooms.error || complaints.error)}
      cards={cards}
    />
  )
}
