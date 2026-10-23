import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, Button, PrintButton, Checkbox, EmptyState, FormNotice,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { useCan, useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Barcode } from '@/lib/barcode'

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
    queryFn: () => api.get<Branding>('/api/v1/setup/institution'),
    retry: false,
  })
  /* The name the school brands itself by (display_name), the same one the
     letterhead carries, rather than the registered name. */
  const inst = useSession().institution
  const schoolName = inst?.display_name || inst?.name || school.data?.name || ''
  const logoURL = inst?.logo_key ? `/api/v1/files/${inst.logo_key}?inline=1` : school.data?.logo_url

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
          {/* Padded, each picker in its own tile (owner: margins and boxes). */}
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <div className="rounded-xl border bg-muted/20 p-4">
              <FilePicker
                value={front}
                onChange={setFront}
                purpose="id_card_front"
                label="Front artwork"
                hint="Landscape, 86 × 54 mm. PNG or JPG."
              />
              {frontArt && !front && (
                <img
                  src={`/api/v1/files/${frontArt}?inline=1`}
                  alt="Current front"
                  className="mt-2 max-h-28 rounded border object-contain"
                />
              )}
            </div>
            <div className="rounded-xl border bg-muted/20 p-4">
              <FilePicker
                value={back}
                onChange={setBack}
                purpose="id_card_back"
                label="Back artwork"
                hint="The reverse, rules, contact, signature."
              />
              {backArt && !back && (
                <img
                  src={`/api/v1/files/${backArt}?inline=1`}
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
              {picked.size > 0 && <PrintButton label={`Print ${picked.size}`} title="Staff ID cards" subtitle={`${picked.size} card${picked.size === 1 ? '' : 's'}`} sourceSelector="#staff-id-cards" />}
            </div>
          }
        />
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {staff.map((e) => (
            <div key={e.id} className={'rounded-xl border px-3.5 py-2.5 transition-colors hover:bg-muted/40 ' + (picked.has(e.id) ? 'border-primary/50 bg-primary/5' : 'bg-card')}>
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
        <div id="staff-id-cards" className="flex flex-wrap gap-3">
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
                  {logoURL && (
                    <img src={logoURL} alt="" className="h-6 w-6 object-contain" />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-wide">
                    {schoolName}
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
              <div className="flex items-end justify-between gap-2">
                <span className="font-mono text-[12px] font-semibold">{e.employee_code}</span>
                {e.phone && <span className="text-[10px] text-muted-foreground">{e.phone}</span>}
              </div>
              {/* A Code 128 of the staff number: the gate reader and the
                  library scanner read the same code the card shows. */}
              <Barcode value={e.employee_code} height={18} label={false} className="mt-1 h-5 w-full" />
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
