import { CalendarRange } from 'lucide-react'
import { useWorkingYear } from '@/lib/working-year'

/* The working-year switcher, in the shell header.

   Shown only when there is a choice to make -- two or more years not yet
   over. A school with one year sees nothing new, which is most schools for
   most of the year. A plain select rather than a menu: it is set a few times
   a year, and the name of the year in effect must be readable at a glance
   because everything on the page is about it.

   Picking the current year clears the stored choice rather than storing the
   current year's id, so that when the flag moves in April the person moves
   with it instead of being pinned to what has become last year. */
export function YearSwitch() {
  const { year, openYears, switchable, setYear, saving } = useWorkingYear()
  if (!switchable || !year) return null
  const options = openYears.some((y) => y.id === year.id) ? openYears : [year, ...openYears]
  return (
    <label
      className="flex h-8 items-center gap-1.5 rounded-[7px] bg-surface-hover/60 px-2 text-[12.5px] text-muted-foreground"
      title="The academic year you are working in. Admissions, sections, fee structures and timetable drafts go into this year."
    >
      <CalendarRange className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="sr-only">Working year</span>
      <select
        value={year.id}
        disabled={saving}
        onChange={(e) => {
          const picked = options.find((y) => y.id === e.target.value)
          setYear(picked?.is_current ? null : e.target.value)
        }}
        className="max-w-[9rem] cursor-pointer truncate bg-transparent font-[550] text-foreground outline-none"
      >
        {options.map((y) => (
          <option key={y.id} value={y.id}>
            {y.name}{y.is_current ? ' (current)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

export default YearSwitch
