import { CalendarRange } from 'lucide-react'
import { useWorkingYear } from '@/lib/working-year'
import { PickerMenu } from './PickerMenu'

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
  const { year, openYears, switchable, setYear } = useWorkingYear()
  if (!switchable || !year) return null
  const options = openYears.some((y) => y.id === year.id) ? openYears : [year, ...openYears]
  return (
    <PickerMenu
      value={year.id}
      ariaLabel="Working year"
      onChange={(id) => {
        const picked = options.find((y) => y.id === id)
        setYear(picked?.is_current ? null : id)
      }}
      options={options.map((y) => ({
        value: y.id,
        label: `${y.name}${y.is_current ? ' (current)' : ''}`,
      }))}
    >
      <span
        className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-[7px] bg-surface-hover/60 px-2 text-[12.5px] text-muted-foreground"
        title="The academic year you are working in. Admissions, sections, fee structures and timetable drafts go into this year."
      >
        <CalendarRange className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 max-w-[6.5rem] truncate font-[550] text-foreground sm:max-w-[9rem]">
          {year.name}{year.is_current ? ' (current)' : ''}
        </span>
      </span>
    </PickerMenu>
  )
}

export default YearSwitch
