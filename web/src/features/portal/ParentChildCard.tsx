import { Link } from 'react-router-dom'
import { Atom, BookOpen, BookText, Calculator, ChevronDown, ChevronRight, Dna, Dumbbell, Feather, FlaskConical, Globe, Languages, Leaf, Monitor, Music, Palette, PenLine, ScrollText, Shapes, TestTube, type LucideIcon } from 'lucide-react'
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

export function ParentChildCard({ profile, kids, activeId, onChild, year, onYear, loading, stats }: {
  profile?: ChildProfile
  kids: { student_id: string; full_name: string }[]
  activeId: string | null
  onChild: (id: string) => void
  year: string
  onYear: (id: string) => void
  loading?: boolean
  /** Wide screens (owner, 2026-11-28, design A): quick figures under the facts. */
  stats?: [string, string | number][]
}) {
  const kid = kids.find((k) => k.student_id === activeId)
  const name = profile?.full_name ?? kid?.full_name ?? ''
  /* "Class 4 · A", "Grade 2 · HITHA": the class's own name (adding "Class" only
     to a bare number, so it never reads "Class Class 4"), then the section. */
  const clsName = profile?.class_name ? (/^\d/.test(profile.class_name.trim()) ? `Class ${profile.class_name.trim()}` : profile.class_name.trim()) : ''
  const cls = clsName ? `${clsName}${profile?.section_name ? ` · ${profile.section_name}` : ''}` : null
  const years = profile?.years ?? []
  const yearValue = year && years.some((y) => y.academic_year_id === year) ? year : (profile?.academic_year_id ?? '')
  const yearName = years.find((y) => y.academic_year_id === yearValue)?.academic_year ?? profile?.academic_year ?? ''
  const facts: [string, string][] = ([
    ['Admission no.', profile?.admission_no ?? ''],
    ['Roll no.', profile?.roll_no != null ? String(profile.roll_no) : ''],
    ['Joined', profile?.admission_date ? formatDate(profile.admission_date) : ''],
  ] as [string, string][]).filter(([, v]) => v)
  const tile = 'child-tile flex min-h-[58px] w-full min-w-0 flex-col justify-center bg-white/15 px-3 py-2 text-left'
  const nameLine = (
    <span className="flex min-w-0 items-center gap-1.5 lg:justify-center">
      <span className="min-w-0 break-words text-[22px] font-extrabold leading-tight tracking-[-0.02em] lg:text-[24px]">{name || (loading ? '…' : '')}</span>
      {kids.length > 1 && <ChevronDown className="size-5 shrink-0 opacity-90" aria-hidden />}
    </span>
  )
  return (
    /* THE CHILD (owner, 2026-11-28, from the approved preview): a card in the
       school's colour. Tap the child's name to switch child (families of two
       or more); the academic year is its own tile with a drop-down, current
       year by default. Admission no., roll no. and joined date as tiles. */
    <div className="child-card relative isolate flex h-full flex-col overflow-hidden rounded-2xl p-4 text-primary-foreground shadow-md sm:p-5 lg:justify-center lg:p-7">
      <div className="relative flex min-w-0 items-center gap-4 lg:flex-col lg:gap-3 lg:text-center">
        <ChildPhoto name={name || '?'} photo={profile?.photo_file_id} />
        <div className="min-w-0 flex-1">
          {kids.length > 1 ? (
            <PickerMenu value={activeId ?? ''} ariaLabel="Switch child" align="start" onChange={onChild}
              options={kids.map((c) => ({ value: c.student_id, label: c.full_name }))}>
              {nameLine}
            </PickerMenu>
          ) : nameLine}
          {cls && <p className="mt-0.5 text-[14px] font-medium opacity-90 lg:mt-2 lg:inline-block lg:rounded-full lg:bg-white/20 lg:px-3 lg:py-1 lg:text-[13px] lg:font-semibold">{cls}</p>}
        </div>
      </div>
      <div className="relative mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,9.5rem),1fr))] gap-2">
        {facts.map(([k, v]) => (
          <div key={k} className={tile}>
            <span className="text-[12px] font-medium opacity-80">{k}</span>
            <span className="break-words text-[16px] font-bold">{v}</span>
          </div>
        ))}
        {years.length > 0 ? (
          <div className="flex min-w-0 [&>.picker]:flex [&>.picker]:w-full [&>.picker>button]:w-full">
          <PickerMenu value={yearValue} ariaLabel="Academic year" align="end"
            onChange={(id) => onYear(years.find((y) => y.academic_year_id === id)?.is_current ? '' : id)}
            options={years.map((y) => ({ value: y.academic_year_id, label: y.academic_year }))}>
            <span className={cn(tile, 'w-full')}>
              <span className="text-[12px] font-medium opacity-80">Academic year</span>
              <span className="flex items-center justify-between gap-1 text-[16px] font-bold"><span className="break-words">{yearName}</span><ChevronDown className="size-4 shrink-0" aria-hidden /></span>
            </span>
          </PickerMenu>
          </div>
        ) : yearName ? (
          <div className={tile}><span className="text-[12px] font-medium opacity-80">Academic year</span><span className="truncate text-[16px] font-bold">{yearName}</span></div>
        ) : null}
      </div>
      {stats && stats.length > 0 && (
        <div className="relative mt-auto hidden gap-2 pt-5 lg:grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {stats.map(([k, v]) => (
            <div key={k} className="bg-card px-2 py-2.5 text-center text-foreground" style={{ borderRadius: 14 }}>
              <span className="block text-[20px] font-extrabold tabular-nums text-primary">{v}</span>
              <span className="block text-[11px] text-muted-foreground">{k}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* The child's photo, or their initials when the school has none. */
function ChildPhoto({ name, photo }: { name: string; photo?: string }) {
  /* Passport size (owner, 2026-11-28): taller than wide, a thin white edge. */
  const box = 'child-photo h-[108px] w-[84px] shrink-0 overflow-hidden rounded-xl lg:h-[170px] lg:w-[132px]'
  return photo
    ? <img src={fileSrc(photo)} alt="" className={cn(box, 'bg-muted object-cover object-[50%_20%]')} />
    : <span aria-hidden className={cn(box, 'grid place-items-center bg-gradient-to-br from-white to-primary/15 text-[30px] font-extrabold text-primary lg:text-[44px]')}>{initials(name)}</span>
}

/* The child's subjects as cards, each opening its Subject page. */
export function SubjectCards({ subjects, hrefFor, note, stats }: {
  subjects: ChildSubject[]
  hrefFor: (s: ChildSubject) => string
  note?: (s: ChildSubject) => string | undefined
  /** Wide screens (owner, 2026-11-28, design A): today's homework, notes and latest marks on each card. */
  stats?: (s: ChildSubject) => { homework: number | string; notes: number | string; marks: string }
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
            <Link to={hrefFor(s)} className="flex min-h-[56px] select-none items-center gap-3 px-3 py-2 [-webkit-touch-callout:none]">
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
    <ul className={cn('hidden gap-3 sm:grid', stats ? 'sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]' : 'sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6')}>
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
              {stats && (() => { const v = stats(s); return (
                <span className="mt-auto grid gap-1.5 pt-1.5" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                  {([['Homework', 'today', v.homework], ['Notes', 'total', v.notes], ['Marks', 'latest', v.marks]] as const).map(([k, sub, n]) => (
                    <span key={k} className="min-w-0 rounded-lg bg-muted/60 px-1 py-1.5 text-center">
                      <span className="block text-[15px] font-bold tabular-nums">{n}</span>
                      <span className="block whitespace-nowrap text-[11px] font-semibold leading-tight text-foreground/80">{k}</span>
                      <span className="block whitespace-nowrap text-[10px] leading-tight text-muted-foreground">{sub}</span>
                    </span>
                  ))}
                </span>
              ) })()}
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
