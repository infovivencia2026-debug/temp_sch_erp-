import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, Button, PrintButton, Checkbox, EmptyState,
} from '@/components/ui'

/* ID cards, actually printed.
 *
 * "Staff ID card printing" was a menu entry that opened the staff list. There
 * was no printing behind it and never had been — you clicked it, got a table of
 * names, and were left to work out that the feature did not exist. That is
 * worse than the feature being absent, because somebody planned their September
 * around it.
 *
 * Printed from the browser rather than as a generated PDF: the school's card
 * stock is whatever their stationer sells, the printer is whatever is in the
 * office, and a PDF at a fixed size is a promise about paper nobody can keep.
 * The page prints what is on it — everything else is hidden by the existing
 * print stylesheet — so what you see selected is what comes out.
 *
 * Cards are laid out at 54 × 86 mm, which is the ID-1 size every lanyard holder
 * in the country is cut for.
 */

interface Employee {
  id: string
  employee_code: string
  full_name: string
  designation?: string
  department?: string
  phone?: string
  status: string
}

interface Branding {
  name?: string
  logo_url?: string
}

export default function IDCards({ staff }: { staff: Employee[] }) {
  // Nobody selected to begin with. Opening the tab and finding two hundred
  // cards queued is one misplaced click away from two hundred sheets of card.
  const [picked, setPicked] = useState<Set<string>>(new Set())

  // The school's own name on the card. Falls back to nothing rather than to a
  // placeholder: a card that says "School Name" is not one you hand to a
  // teacher.
  const school = useQuery({
    queryKey: ['institution-branding'],
    queryFn: () => api.get<Branding>('/api/v1/institution'),
    retry: false,
  })

  const toggle = (id: string) =>
    setPicked((v) => {
      const next = new Set(v)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const chosen = staff.filter((e) => picked.has(e.id))

  if (staff.length === 0) {
    return (
      <EmptyState
        title="Nobody on the staff roll yet."
        body="Add staff on the Staff list tab and their cards can be printed here."
      />
    )
  }

  return (
    <>
      <Card className="no-print">
        <CardHeader
          title="Who needs a card"
          description={
            picked.size
              ? `${picked.size} selected. They print one to a card, six to a sheet.`
              : 'Select the people whose cards you want. Nothing prints until you choose.'
          }
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setPicked(
                    picked.size === staff.length ? new Set() : new Set(staff.map((e) => e.id)),
                  )
                }
              >
                {picked.size === staff.length ? 'Clear all' : 'Select everybody'}
              </Button>
              {picked.size > 0 && <PrintButton label={`Print ${picked.size}`} />}
            </div>
          }
        />
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {staff.map((e) => (
            <div key={e.id} className="rounded-md px-2 py-1.5 hover:bg-muted/50">
              <Checkbox
                checked={picked.has(e.id)}
                onChange={() => toggle(e.id)}
                label={e.full_name}
                hint={e.employee_code}
              />
            </div>
          ))}
        </div>
      </Card>

      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {chosen.map((e) => (
            <div
              key={e.id}
              /* Fixed millimetres, not rem: this is the one place in the
                 product where the units on screen have to be the units on the
                 paper. */
              style={{ width: '86mm', height: '54mm' }}
              className="flex flex-col justify-between break-inside-avoid rounded-lg border-2 border-foreground/80 bg-card p-3"
            >
              <div className="flex items-center gap-2 border-b pb-1.5">
                {school.data?.logo_url && (
                  <img src={school.data.logo_url} alt="" className="h-6 w-6 object-contain" />
                )}
                <span className="text-[11px] font-semibold uppercase tracking-wide">
                  {school.data?.name ?? ''}
                </span>
              </div>
              <div>
                <p className="text-[15px] font-bold leading-tight">{e.full_name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {e.designation ?? 'Staff'}
                  {e.department ? ` · ${e.department}` : ''}
                </p>
              </div>
              <div className="flex items-end justify-between">
                <span className="font-mono text-[12px] font-semibold">{e.employee_code}</span>
                {e.phone && <span className="text-[10px] text-muted-foreground">{e.phone}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
