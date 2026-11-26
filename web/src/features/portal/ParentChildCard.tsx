import { Link } from 'react-router-dom'
import { BookOpen, CalendarRange, ChevronDown, Users } from 'lucide-react'
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
  const yearName = years.find((y) => y.academic_year_id === yearValue)?.academic_year ?? profile?.academic_year ?? ''
  const pill = 'inline-flex min-h-[48px] max-w-full items-center gap-1.5 rounded-full border bg-card px-4 text-[14px] font-semibold text-foreground shadow-sm hover:border-primary/40'
  return (
    /* THE CHILD (owner's approved mockup, 2026-11-26): a big photo on a band
       of the school's colour, the name large under it, class, joined and
       year, then two small pills for the year and the child. On a phone the
       photo sits beside the details. */
    <Card className="relative h-full overflow-hidden border-primary/25 bg-gradient-to-b from-primary/15 via-primary/5 to-card">
      <span aria-hidden className="absolute inset-x-0 top-0 hidden h-[120px] bg-gradient-to-br from-primary to-primary/70 lg:block" />
      <div className="relative flex flex-wrap items-center gap-4 p-4 lg:flex-col lg:flex-nowrap lg:gap-3 lg:p-6 lg:pt-7 lg:text-center">
        <ChildPhoto name={name || '?'} photo={profile?.photo_file_id} />
        <div className="min-w-0 flex-1 lg:flex-none">
          <p className="break-words text-[22px] font-extrabold leading-tight tracking-[-0.02em] lg:text-[28px]">{name || (loading ? '…' : '')}</p>
          <div className="mt-1 flex flex-col gap-0.5 text-[15px] text-muted-foreground">
            {cls && <span className="font-semibold text-primary">{cls}</span>}
            {profile?.admission_date && <span>Joined {formatDate(profile.admission_date)}</span>}
            {yearName && <span>Academic year {yearName}</span>}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 lg:justify-center">
          {years.length > 0 && (
            <PickerMenu value={yearValue} ariaLabel="Academic year" align="start"
              onChange={(id) => onYear(years.find((y) => y.academic_year_id === id)?.is_current ? '' : id)}
              options={years.map((y) => ({ value: y.academic_year_id, label: y.academic_year }))}>
              <span className={pill}><CalendarRange className="h-4 w-4 text-primary" aria-hidden />{yearName}<ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden /></span>
            </PickerMenu>
          )}
          {kids.length > 1 && (
            <PickerMenu value={activeId ?? ''} ariaLabel="Switch child" align="end" onChange={onChild}
              options={kids.map((c) => ({ value: c.student_id, label: c.full_name }))}>
              <span className={pill}><Users className="h-4 w-4 text-primary" aria-hidden />Switch child<ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden /></span>
            </PickerMenu>
          )}
        </div>
      </div>
    </Card>
  )
}

/* The child's photo, or their initials when the school has none. */
function ChildPhoto({ name, photo }: { name: string; photo?: string }) {
  const box = 'aspect-[5/6] w-24 shrink-0 rounded-2xl border-4 border-card shadow-[0_10px_24px_-6px_hsl(var(--primary)/0.45)] lg:w-[60%] lg:rounded-3xl'
  return photo
    ? <img src={fileSrc(photo)} alt="" className={cn(box, 'bg-muted object-cover')} />
    : <span aria-hidden className={cn(box, 'grid place-items-center bg-primary/10 text-[32px] font-extrabold text-primary lg:text-[64px]')}>{initials(name)}</span>
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
