import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Card, CardHeader, Button, Loading, ErrorState } from '@/components/ui'
import { AcademicsYear, AttendanceCalendar } from '@/features/shared/StudentYearTabs'
import { formatDate, cn } from '@/lib/utils'

/* ONE CHILD'S PROGRESS, NOT THEIR WHOLE RECORD.

   The owner asked that "Profile" on Student progress open the child's
   progress -- overall figures, every subject with its trend, the attendance
   calendar, and the remarks written about them -- rather than leaving for
   Student 360, which is the office's file on the child. It opens over the
   roster and Back returns to it.

   ONLY THEIR OWN SUBJECT, UNLESS THEY ARE THE CLASS TEACHER (owner,
   2026-10-16: "progress should show only their subject... class teacher
   can see their assigned classes, all subjects"). Every subject's marks came
   from the detail endpoint regardless of who was looking, so a subject
   teacher opening a child's Progress read Maths and Science marks they had
   no reason to see. fullClass (from the section picker's own "my class" flag)
   and mySubjects (that teacher's own subjects in this section) narrow it;
   a class teacher of the section passes fullClass=true and sees all of it,
   the same as before. */

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

interface Detail {
  homework: { id: string; title: string; subject: string; assigned_on: string; due_on?: string; submitted: boolean; submitted_at?: string; marks?: string; max_marks?: number }[]
  papers: { exam: string; subject: string; exam_date?: string; max_marks: number; obtained?: number; absent: boolean }[]
}

/* A tile that opens something is drawn as a button, in the school colour,
   with an arrow, so nobody has to guess it can be pressed (owner,
   2026-10-19: "make clickable homework and highlight that"). */
function Stat({ label, value, small, tone, onClick, active }: { label: string; value: string; small?: string; tone?: string; onClick?: () => void; active?: boolean }) {
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-expanded={active}
        className={cn('flex flex-col gap-1.5 rounded-[10px] border-2 bg-primary/5 px-5 py-4 text-left transition-colors hover:bg-primary/10',
          active ? 'border-primary' : 'border-primary/40')}>
        <span className="flex items-center justify-between text-[11.5px] font-semibold uppercase tracking-[0.04em] text-primary">
          {label}<ChevronRight className={cn('h-4 w-4 transition-transform', active && 'rotate-90')} />
        </span>
        <div className={cn('flex flex-wrap items-baseline gap-x-1.5 text-[22px] font-bold', tone)}>
          {value}
          {small && <small className="text-[11px] font-medium text-muted-foreground">{small}</small>}
        </div>
        {active && <span className="text-[11.5px] font-medium text-primary">Click again to go back</span>}
      </button>
    )
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border bg-card px-5 py-4">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{label}</span>
      <div className={cn('flex flex-wrap items-baseline gap-x-1.5 text-[22px] font-bold', tone)}>
        {value}
        {small && <small className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">{small}</small>}
      </div>
    </div>
  )
}

export default function ProgressDetail({ row, onClose, fullClass, mySubjects }: {
  row: Row
  onClose: () => void
  /** True for a class teacher's own section: every subject shows, as before. */
  fullClass: boolean
  /** This teacher's own subjects in the section the roster was filtered to. */
  mySubjects: string[]
}) {
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
  const [panel, setPanel] = useState<'' | 'homework' | 'marks'>('')
  const [hwFilter, setHwFilter] = useState<'all' | 'done' | 'pending'>('all')
  const more = useQuery({
    queryKey: ['progress-student', id],
    queryFn: () => api.get<Detail>(`/api/v1/teaching/progress/student?student_id=${id}`),
  })
  const hwList = (more.data?.homework ?? []).filter((h) => hwFilter === 'all' || (hwFilter === 'done' ? h.submitted : !h.submitted))
  const papers = more.data?.papers ?? []
  const latest = papers.find((p) => p.obtained != null && !p.absent)
  const mine = new Set(mySubjects)
  const subjectMarks = fullClass ? (detail.data?.subject_marks ?? []) : (detail.data?.subject_marks ?? []).filter((m) => mine.has(m.subject))

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
          <Stat label="Overall score" value={row.marks_percent == null ? '-' : `${row.marks_percent}%`}
            small={latest ? `${latest.exam} · ${latest.subject} ${latest.obtained}/${latest.max_marks}` : papers.length ? `${papers.length} papers` : 'No marks yet'}
            onClick={() => setPanel((p) => (p === 'marks' ? '' : 'marks'))} active={panel === 'marks'} />
          <Stat label="Attendance" value={row.attendance_percent == null ? '-' : `${Math.round(row.attendance_percent)}%`}
            tone={row.attendance_percent != null && row.attendance_percent < 75 ? 'text-destructive' : undefined} />
          <Stat label="Homework" value={hw == null ? '-' : `${hw}%`} small={`${row.homework_submitted} / ${row.homework_set} handed in`}
            onClick={() => setPanel((p) => (p === 'homework' ? '' : 'homework'))} active={panel === 'homework'} />
          <Stat label="Remarks" value={`+${row.commendations} / −${row.notes_of_concern}`} small="Praise / concern" />
        </div>

        {panel === 'homework' && (
          <Card>
            <CardHeader title="Homework" description="Every piece set for this class in your subjects." action={
              <div className="flex gap-1 rounded-full bg-muted p-1">
                {([['all', 'All'], ['done', 'Submitted'], ['pending', 'Not submitted']] as const).map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setHwFilter(v)}
                    className={cn('rounded-full px-3 py-1 text-[12.5px] font-medium', hwFilter === v ? 'bg-card shadow-sm' : 'text-muted-foreground')}>{l}</button>
                ))}
              </div>} />
            {more.isLoading ? <Loading /> : hwList.length === 0 ? (
              <p className="px-5 py-6 text-center text-[13.5px] text-muted-foreground">Nothing here.</p>
            ) : (
              <ul className="divide-y">
                {hwList.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-semibold">{h.title}</div>
                      <div className="text-[12px] text-muted-foreground">{h.subject} · set {formatDate(h.assigned_on)}{h.due_on ? ` · due ${formatDate(h.due_on)}` : ''}</div>
                    </div>
                    <span className={cn('rounded-full px-2.5 py-1 text-[12px] font-semibold',
                      h.submitted ? 'bg-[hsl(var(--sys-success)/0.12)] text-[hsl(var(--sys-success))]' : 'bg-[hsl(var(--sys-danger)/0.12)] text-[hsl(var(--sys-danger))]')}>
                      {h.submitted ? `Submitted${h.submitted_at ? ' ' + formatDate(h.submitted_at) : ''}` : 'Not submitted'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {panel === 'marks' && (
          <Card>
            <CardHeader title="Marks" description="Each paper, with what it was out of." />
            {more.isLoading ? <Loading /> : papers.length === 0 ? (
              <p className="px-5 py-6 text-center text-[13.5px] text-muted-foreground">No marks entered yet.</p>
            ) : (
              <ul className="divide-y">
                {papers.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 px-5 py-3">
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-semibold">{p.exam} · {p.subject}</div>
                      {p.exam_date && <div className="text-[12px] text-muted-foreground">{formatDate(p.exam_date)}</div>}
                    </div>
                    <span className="text-[15px] font-bold tabular-nums">
                      {p.absent ? 'Absent' : p.obtained == null ? '-' : `${p.obtained} / ${p.max_marks}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {profile.isLoading || detail.isLoading ? <Loading /> : profile.error ? <ErrorState error={profile.error} /> : profile.data && (
          <>
            <AcademicsYear
              results={profile.data.results}
              marks={subjectMarks}
              loading={false}
              attendancePercent={profile.data.attendance.percent}
              figures={false}
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
                  <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', n.is_positive ? 'bg-[hsl(var(--sys-success))]' : 'bg-[hsl(var(--sys-danger))]')} />
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
