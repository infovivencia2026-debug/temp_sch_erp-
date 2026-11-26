import { Link } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { Card } from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'
import { formatDate, cn } from '@/lib/utils'
import { fileSrc, initials, type ChildProfile, type ChildSubject } from './parent-child'

/* THE CHILD, ON THE PARENT HOME (owner, 2026-11-26).

   One large card: the child's photo (or initials), name, class and section,
   the date they joined, and the academic year. The child switcher (only for a
   family of two or more) and the academic-year picker sit inside it. */
export function ChildAvatar({ name, photo, size = 'lg' }: { name: string; photo?: string; size?: 'lg' | 'md' | 'sm' }) {
  const box = size === 'lg' ? 'h-16 w-16 text-[22px] sm:h-20 sm:w-20 sm:text-[26px]' : size === 'md' ? 'h-12 w-12 text-[17px]' : 'h-10 w-10 text-[14px]'
  return photo ? (
    <img src={fileSrc(photo)} alt="" className={cn('shrink-0 rounded-full border bg-muted object-cover', box)} />
  ) : (
    <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-full bg-primary/10 font-bold text-primary', box)}>{initials(name)}</span>
  )
}

export function ParentChildCard({ profile, kids, activeId, onChild, year, onYear, loading }: {
  profile?: ChildProfile
  kids: { student_id: string; full_name: string }[]
  activeId: string | null
  onChild: (id: string) => void
  year: string
  onYear: (id: string) => void
  loading?: boolean
}) {
  const kid = kids.find((k) => k.student_id === activeId)
  const name = profile?.full_name ?? kid?.full_name ?? ''
  const cls = profile?.class_name ? `${profile.class_name}${profile.section_name ? ` - ${profile.section_name}` : ''}` : null
  const years = profile?.years ?? []
  const yearValue = year && years.some((y) => y.academic_year_id === year) ? year : (profile?.academic_year_id ?? '')
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-4">
        <ChildAvatar name={name || '?'} photo={profile?.photo_file_id} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[20px] font-bold leading-tight sm:text-[24px]">{name || (loading ? '…' : '')}</p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[15px] text-muted-foreground">
            {cls && <span>{cls}</span>}
            {profile?.admission_date && <span>Joined {formatDate(profile.admission_date)}</span>}
            {profile?.academic_year && <span>Academic year {profile.academic_year}</span>}
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-3 sm:w-auto">
          {kids.length > 1 && (
            <div className="min-w-0 flex-1 sm:flex-none">
              <p className="mb-1 text-[13px] text-muted-foreground">Child</p>
              <PickerMenu value={activeId ?? ''} ariaLabel="Child" align="start" onChange={onChild}
                className="min-h-[48px] w-full"
                options={kids.map((c) => ({ value: c.student_id, label: c.full_name }))} />
            </div>
          )}
          {years.length > 0 && (
            <div className="min-w-0 flex-1 sm:flex-none">
              <p className="mb-1 text-[13px] text-muted-foreground">Academic year</p>
              <PickerMenu value={yearValue} ariaLabel="Academic year" align="end"
                className="min-h-[48px] w-full"
                onChange={(id) => onYear(years.find((y) => y.academic_year_id === id)?.is_current ? '' : id)}
                options={years.map((y) => ({ value: y.academic_year_id, label: y.academic_year }))} />
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

/* The child's subjects as cards, each opening its Subject page. */
export function SubjectCards({ subjects, hrefFor, note }: {
  subjects: ChildSubject[]
  hrefFor: (s: ChildSubject) => string
  note?: (s: ChildSubject) => string | undefined
}) {
  if (!subjects.length) return <p className="text-[15px] text-muted-foreground">No subjects set for this class yet.</p>
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
      {subjects.map((s) => (
        <li key={s.class_subject_id} className="min-w-0">
          <Link to={hrefFor(s)}
            className="flex h-full min-h-[96px] flex-col gap-1.5 rounded-xl border bg-card p-4 shadow-sm transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-md">
            <BookOpen className="h-5 w-5 text-primary" strokeWidth={1.8} aria-hidden />
            <span className="line-clamp-2 text-[16px] font-semibold leading-snug">{s.subject}</span>
            <span className="truncate text-[13px] text-muted-foreground">{note?.(s) ?? s.teacher ?? ''}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
