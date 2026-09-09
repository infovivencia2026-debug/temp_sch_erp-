import { Building2, CalendarRange, ChevronDown, Clock, Landmark } from 'lucide-react'
import { Dropdown } from '@/components/ui'
import { useApp } from '@/hooks/useAppState'

/* ---------------------------------------------------------------------------
   SCOPE ON A PHONE

   Institution, campus, academic year and term decide which records the whole
   application is showing. Every shell put them in the top bar behind a 2xl or
   xl breakpoint, and neither mobile drawer carried them — so on a phone the
   scope was frozen at whatever it happened to be, with no way to see it or
   change it.

   One component, mounted in both drawers.
   --------------------------------------------------------------------------- */

export function MobileScopeBar({ withPeriod = false }: { withPeriod?: boolean }) {
  const app = useApp()

  const rows: { icon: typeof Landmark; label: string; value: string; options: string[]; onChange: (v: string) => void }[] = [
    { icon: Landmark, label: 'Institution', value: app.institution, options: app.institutions, onChange: app.setInstitution },
    { icon: CalendarRange, label: 'Year', value: app.year, options: app.years, onChange: app.setYear },
  ]
  if (withPeriod) {
    rows.push({ icon: Clock, label: 'Term', value: app.period, options: app.periods, onChange: app.setPeriod })
  }

  return (
    <div className="border-b px-2 py-2 lg:hidden">
      <p className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider muted">Scope</p>
      <div className="grid gap-1">
        {rows.map((r) => (
          <Dropdown
            key={r.label}
            align="left"
            className="w-full"
            trigger={
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-accent">
                <r.icon className="h-4 w-4 shrink-0 muted" />
                <span className="min-w-0 flex-1 truncate">{r.value}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 muted" />
              </button>
            }
            items={r.options.map((o) => ({
              label: (o === r.value ? '✓ ' : '') + o,
              onClick: () => r.onChange(o),
            }))}
          />
        ))}
      </div>
    </div>
  )
}
