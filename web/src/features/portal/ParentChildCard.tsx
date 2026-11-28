import { Link } from 'react-router-dom'
import { Atom, BookOpen, BookText, Calculator, CalendarRange, ChevronDown, ChevronRight, Dna, Dumbbell, Feather, FlaskConical, Globe, Languages, Leaf, Monitor, Music, Palette, PenLine, ScrollText, Shapes, TestTube, Users, type LucideIcon } from 'lucide-react'
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
    <img src={fileSrc(photo)} alt="" style={{ clipPath: 'circle(50%)' }} className={cn('aspect-square shrink-0 rounded-full bg-muted object-cover', box)} />
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
  const facts: [string, string][] = ([
    ['Admission no.', profile?.admission_no ?? ''],
    ['Roll no.', profile?.roll_no != null ? String(profile.roll_no) : ''],
    ['Joined', profile?.admission_date ? formatDate(profile.admission_date) : ''],
    ['Academic year', yearName],
  ] as [string, string][]).filter(([, v]) => v)
  const pill = 'inline-flex min-h-[48px] max-w-full items-center gap-1.5 rounded-full border bg-card px-4 text-[14px] font-semibold text-foreground shadow-sm hover:border-primary/40'
  return (
    /* THE CHILD (owner, 2026-11-27: "can be better"). A soft band of the
       school's colour, the round photo centred over its edge, the name, the
       class as a chip, then the facts as labelled rows so the card fills its
       height with things a parent reads. On a phone the photo sits beside the
       name and the rows follow underneath. */
    <Card className="relative flex h-full flex-col overflow-hidden">
      <span aria-hidden className="absolute inset-x-0 top-0 h-[72px] bg-gradient-to-br from-primary/25 via-primary/10 to-transparent lg:h-1/2 lg:bg-gradient-to-b" />
      <div className="relative flex flex-col lg:my-auto">
      <div className="relative flex flex-wrap items-center gap-4 p-4 pb-3 lg:flex-col lg:flex-nowrap lg:gap-3 lg:px-6 lg:pt-10 lg:text-center">
        <ChildPhoto name={name || '?'} photo={profile?.photo_file_id} />
        <div className="min-w-[min(100%,6.5em)] flex-1 text-[22px] lg:flex-none lg:text-[26px]">
          <p className="break-words text-[22px] font-extrabold leading-tight tracking-[-0.02em] lg:text-[26px]">{name || (loading ? '…' : '')}</p>
          {cls && <span className="mt-1.5 inline-flex max-w-full rounded-full bg-primary/10 px-3 py-1 text-[14px] font-semibold text-primary"><span className="truncate">Class {cls}</span></span>}
        </div>
      </div>
      {facts.length > 0 && <dl className="relative mx-4 divide-y rounded-xl border bg-muted/40 text-[15px] lg:mx-6">
        {facts.map(([k, v]) => (
          <div key={k} className="flex min-h-[44px] items-center justify-between gap-3 px-3.5 py-2">
            <dt className="shrink-0 text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate text-right font-semibold">{v}</dd>
          </div>
        ))}
      </dl>}
      <div className="relative flex flex-wrap gap-2 p-4 lg:justify-center lg:px-6 lg:pb-6">
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
  const box = 'size-20 shrink-0 rounded-full border-4 border-card shadow-[0_8px_20px_-6px_hsl(var(--primary)/0.45)] lg:size-32'
  return photo
    ? <img src={fileSrc(photo)} alt="" style={{ clipPath: 'circle(50%)' }} className={cn(box, 'aspect-square bg-muted object-cover')} />
    : <span aria-hidden className={cn(box, 'grid place-items-center bg-gradient-to-br from-primary to-primary/70 text-[28px] font-extrabold text-primary-foreground lg:text-[44px]')}>{initials(name)}</span>
}

/* The child's subjects as cards, each opening its Subject page. */
export function SubjectCards({ subjects, hrefFor, note }: {
  subjects: ChildSubject[]
  hrefFor: (s: ChildSubject) => string
  note?: (s: ChildSubject) => string | undefined
}) {
  if (!subjects.length) return <p className="text-[15px] text-muted-foreground">No subjects set for this class yet.</p>
  const icons = subjectIcons(subjects.map((s) => s.subject))
  return (
    <>
    {/* PHONE (owner, 2026-11-27, option B): one box, a row per subject. */}
    <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm sm:hidden">
      {subjects.map((s, i) => {
        const tint = SUBJECT_TINTS[i % SUBJECT_TINTS.length]
        const sub = note?.(s) ?? s.teacher ?? ''
        return (
          <li key={s.class_subject_id}>
            <Link to={hrefFor(s)} className="flex min-h-[56px] items-center gap-3 px-3 py-2 active:bg-muted/60">
              <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', tint.chip)}>{(() => { const I = icons[i]; return <I className="h-4 w-4" strokeWidth={1.9} aria-hidden /> })()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold leading-snug">{s.subject}</span>
                {sub && <span className="block truncate text-[13px] text-muted-foreground">{sub}</span>}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        )
      })}
    </ul>
    <ul className="hidden gap-3 sm:grid sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {subjects.map((s, i) => {
        /* Each subject its own tint so the row reads at a glance (owner, 2026-11-27: "subjects look pale"). */
        const tint = SUBJECT_TINTS[i % SUBJECT_TINTS.length]
        return (
          <li key={s.class_subject_id} className="min-w-0">
            <Link to={hrefFor(s)}
              className={cn('relative flex h-full min-h-[92px] flex-col gap-1.5 overflow-hidden rounded-xl border bg-card p-2.5 sm:p-3 shadow-sm transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-1 hover:shadow-[0_12px_28px_-10px_hsl(var(--foreground)/0.3)] motion-reduce:transition-none motion-reduce:hover:translate-y-0', tint.border)}>
              <span className={cn('grid size-8 place-items-center rounded-lg', tint.chip)}>{(() => { const I = icons[i]; return <I className="h-4 w-4" strokeWidth={1.9} aria-hidden /> })()}</span>
              <span className="line-clamp-2 break-words text-[14px] font-bold leading-snug sm:text-[15px]">{s.subject}</span>
              <span className="truncate text-[12px] text-muted-foreground">{note?.(s) ?? s.teacher ?? ''}</span>
            </Link>
          </li>
        )
      })}
    </ul>
    </>
  )
}

const SUBJECT_TINTS = [
  { chip: 'bg-primary/10 text-primary', border: 'hover:border-primary/50' },
  { chip: 'bg-success/15 text-success', border: 'hover:border-success/50' },
  { chip: 'bg-warning/15 text-warning', border: 'hover:border-warning/50' },
  { chip: 'bg-info/15 text-info', border: 'hover:border-info/50' },
  { chip: 'bg-destructive/10 text-destructive', border: 'hover:border-destructive/50' },
] as const

/* A different icon for every subject (owner, 2026-11-27). Known names get a
   fitting icon; the rest take the next unused one, so no two repeat. */
const NAMED: [RegExp, LucideIcon][] = [
  [/math/i, Calculator], [/english/i, BookText], [/hindi/i, Languages], [/telugu|tamil|kannada|marathi|urdu/i, ScrollText],
  [/sanskrit|french/i, Feather], [/physics/i, Atom], [/chem/i, TestTube], [/bio/i, Dna], [/science/i, FlaskConical],
  [/social|history|geog|civics/i, Globe], [/evs|environment/i, Leaf], [/computer|ict|coding/i, Monitor],
  [/music/i, Music], [/art|draw|craft/i, Palette], [/physical|sport|games|yoga|^pe$/i, Dumbbell],
]
const SPARE: LucideIcon[] = [Shapes, PenLine, BookOpen, Feather, ScrollText, Globe, Leaf, Palette, Music, Atom]
function subjectIcons(names: string[]): LucideIcon[] {
  const used = new Set<LucideIcon>()
  const out = names.map((n) => { const hit = NAMED.find(([re, ic]) => re.test(n) && !used.has(ic))?.[1]; if (hit) used.add(hit); return hit })
  return out.map((ic) => { if (ic) return ic; const s = SPARE.find((x) => !used.has(x)) ?? BookOpen; used.add(s); return s })
}
