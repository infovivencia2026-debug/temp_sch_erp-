import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { ChevronLeft } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Card, CardHeader, Button, Loading, ErrorState } from '@/components/ui'
import { AcademicsYear, AttendanceCalendar } from '@/features/shared/StudentYearTabs'
import { formatDate, cn } from '@/lib/utils'

/* ONE CHILD'S PROGRESS, NOT THEIR WHOLE RECORD.

   The owner asked that "Profile" on Student progress open the child's
   progress -- overall figures, every subject with its trend, the attendance
   calendar, and the remarks written about them -- rather than leaving for
   Student 360, which is the office's file on the child. It opens over the
   roster and Back returns to it. */

interface Row {
  student_id: string
  full_name: string
  admission_no: string
  class_name: string
  section: string
  attendance_percent?: number
  homework_set: number
  homework_submitted: number
  marks_percent?: number
  commendations: number
  notes_of_concern: number
  risks: string[]
}
interface Note {
  id: string
  occurred_on: string
  category: string
  is_positive: boolean
  description: string
  recorded_by?: string
}

function Stat({ label, value, small, tone }: { label: string; value: string; small?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border bg-card px-5 py-4">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{label}</span>
      <div className={cn('flex items-baseline gap-1.5 text-[22px] font-bold', tone)}>
        {value}
        {small && <small className="text-[11px] font-medium text-muted-foreground">{small}</small>}
      </div>
    </div>
  )
}

export default function ProgressDetail({ row, onClose }: { row: Row; onClose: () => void }) {
  const id = row.student_id
  const profile = useQuery({
    queryKey: ['student-profile', id],
    queryFn: () => api.call('GET /students/{id}/profile', { params: { id } }),
  })
  const detail = useQuery({
    queryKey: ['student-detail', id],
    queryFn: () => api.call('GET /students/{id}/detail', { params: { id } }),
  })
  const notes = useQuery({
    queryKey: ['student-notes', id],
    queryFn: () => api.get<List<Note>>(`/api/v1/students/notes?student_id=${id}`),
  })

  const hw = row.homework_set ? Math.round((row.homework_submitted / row.homework_set) * 100) : null

  return createPortal(
    <div className="fixed inset-0 z-[90] overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-5 px-4 py-5 sm:px-7">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>
          <span className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-[14px] font-bold text-primary">
            {row.full_name.split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="text-[19px] font-bold">{row.full_name}</h2>
            <p className="text-[13px] text-muted-foreground">{row.class_name}-{row.section} · {row.admission_no}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Overall score" value={row.marks_percent == null ? '-' : `${row.marks_percent}%`} small="All papers" />
          <Stat label="Attendance" value={row.attendance_percent == null ? '-' : `${Math.round(row.attendance_percent)}%`}
            tone={row.attendance_percent != null && row.attendance_percent < 75 ? 'text-destructive' : undefined} />
          <Stat label="Homework" value={hw == null ? '-' : `${hw}%`} small={`${row.homework_submitted} / ${row.homework_set}`} />
          <Stat label="Remarks" value={`+${row.commendations} / −${row.notes_of_concern}`} small="Praise / concern" />
        </div>

        {row.risks.length > 0 && (
          <div className="rounded-xl border border-[#fca5a5] bg-[#fef2f2] px-4 py-3 text-[13.5px] text-[#b91c1c]">
            <b>Needs attention:</b> {row.risks.join(' · ')}
          </div>
        )}

        {profile.isLoading || detail.isLoading ? <Loading /> : profile.error ? <ErrorState error={profile.error} /> : profile.data && (
          <>
            <AcademicsYear
              results={profile.data.results}
              marks={detail.data?.subject_marks ?? []}
              loading={false}
              attendancePercent={profile.data.attendance.percent}
            />
            <AttendanceCalendar days={profile.data.recent_attendance} />
          </>
        )}

        <Card>
          <CardHeader title="Remarks" />
          {(notes.data?.items ?? []).length === 0 ? (
            <p className="px-5 py-6 text-center text-[13.5px] text-muted-foreground">No remarks written yet.</p>
          ) : (
            <ul className="divide-y">
              {(notes.data?.items ?? []).map((n) => (
                <li key={n.id} className="flex gap-3 px-5 py-3">
                  <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', n.is_positive ? 'bg-[#22c55e]' : 'bg-[#ef4444]')} />
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold capitalize">
                      {n.category} <span className="font-normal text-muted-foreground">· {formatDate(n.occurred_on)}{n.recorded_by ? ` · ${n.recorded_by}` : ''}</span>
                    </div>
                    <p className="text-[13.5px]">{n.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>,
    document.body,
  )
}
