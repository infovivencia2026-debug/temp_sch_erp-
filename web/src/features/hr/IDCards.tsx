import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, Button, PrintButton, Checkbox, EmptyState, FormNotice,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'

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
 *
 * The artwork is the school's. Every school already has a card designed —
 * a crest, a colour, a signature block, and on the reverse the line about
 * returning it if found — and a card drawn by the software instead of theirs is
 * a card they will not issue. So they upload the two sides as their printer
 * supplies them and the name, designation and code are laid over the front. A
 * school that uploads nothing keeps the plain card, because a plain card beats
 * no card.
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

interface Template {
  front_file_id?: string
  back_file_id?: string
}

export default function IDCards({ staff }: { staff: Employee[] }) {
  const qc = useQueryClient()
  const can = useCan()
  const [front, setFront] = useState<UploadedFile | null>(null)
  const [back, setBack] = useState<UploadedFile | null>(null)
  const [saved, setSaved] = useState('')

  const tpl = useQuery({
    queryKey: ['id-card-template'],
    queryFn: () => api.get<Template>('/api/v1/hr/id-card-template'),
    retry: false,
  })
  const saveTpl = useMutation({
    mutationFn: () =>
      api.put<Template>('/api/v1/hr/id-card-template', {
        front_file_id: front?.file_id ?? tpl.data?.front_file_id ?? '',
        back_file_id: back?.file_id ?? tpl.data?.back_file_id ?? '',
      }),
    onSuccess: () => {
      setSaved('Card artwork saved. Cards below are laid over it.')
      setFront(null)
      setBack(null)
      qc.invalidateQueries({ queryKey: ['id-card-template'] })
    },
  })

  const frontArt = tpl.data?.front_file_id
  const backArt = tpl.data?.back_file_id
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
      {can('hr.employees.write') && (
        <Card className="no-print">
          <CardHeader
            title="Your card design"
            description="Upload the front and the back as your printer supplies them. Names and codes are printed over the front; the back is printed as it is. Leave both empty to use the plain card."
            action={
              <Button
                onClick={() => saveTpl.mutate()}
                disabled={saveTpl.isPending || (!front && !back)}
              >
                Save design
              </Button>
            }
          />
          {saved && <FormNotice ok={saved} />}
          {saveTpl.error && <FormNotice error={saveTpl.error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FilePicker
                value={front}
                onChange={setFront}
                purpose="id_card_front"
                label="Front artwork"
                hint="Landscape, 86 × 54 mm. PNG or JPG."
              />
              {frontArt && !front && (
                <img
                  src={`/api/v1/files/${frontArt}`}
                  alt="Current front"
                  className="mt-2 max-h-28 rounded border object-contain"
                />
              )}
            </div>
            <div>
              <FilePicker
                value={back}
                onChange={setBack}
                purpose="id_card_back"
                label="Back artwork"
                hint="The reverse — rules, contact, signature."
              />
              {backArt && !back && (
                <img
                  src={`/api/v1/files/${backArt}`}
                  alt="Current back"
                  className="mt-2 max-h-28 rounded border object-contain"
                />
              )}
            </div>
          </div>
        </Card>
      )}

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
              style={{
                width: '86mm',
                height: '54mm',
                // The school's own card, when they have uploaded one. Cover
                // rather than contain: a card printed with white margins down
                // one side is a card somebody trims by hand.
                backgroundImage: frontArt ? `url(/api/v1/files/${frontArt})` : undefined,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
              className={cn(
                'flex flex-col justify-between break-inside-avoid rounded-lg p-3',
                frontArt ? 'border' : 'border-2 border-foreground/80 bg-card',
              )}
            >
              {/* The school's own header only when there is no artwork —
                  printing our crest on top of theirs is worse than either. */}
              {!frontArt && (
                <div className="flex items-center gap-2 border-b pb-1.5">
                  {school.data?.logo_url && (
                    <img src={school.data.logo_url} alt="" className="h-6 w-6 object-contain" />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-wide">
                    {school.data?.name ?? ''}
                  </span>
                </div>
              )}
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

      {/* The reverse, one per card, printed after the fronts so a duplex
          printer pairs them and a single-sided one can be re-fed. */}
      {chosen.length > 0 && backArt && (
        <div className="flex flex-wrap gap-3">
          {chosen.map((e) => (
            <div
              key={`${e.id}-back`}
              style={{
                width: '86mm',
                height: '54mm',
                backgroundImage: `url(/api/v1/files/${backArt})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
              className="break-inside-avoid rounded-lg border"
            />
          ))}
        </div>
      )}
    </>
  )
}
