import { useState } from 'react'
import BulkImport from '@/components/BulkImport'
import { Input } from '@/components/ui'

/* ONE MONTH AT A TIME, WHICH IS HOW A SCHOOL'S OWN RECORDS ARE FILED.

   Carrying a part-finished year across is not one upload. A school has April's
   register, then May's; April's payroll, then May's — separate sheets, closed
   at the end of each month by whoever kept them. Asking for one file covering
   five months asks them to do a merge first, by hand, and hands them a file
   they cannot check afterwards.

   So the upload takes a period, and every dated row in the file is measured
   against it. The point is not tidiness: the commonest mistake in this whole
   job is uploading the wrong month, and there is nothing in the data itself to
   notice it — May's register loads perfectly well as April's, and the mistake
   surfaces weeks later as an argument about somebody's pay. With a period, the
   dry run says which row is out and by how far, before anything is written.

   Both dates are optional. A school that genuinely has one clean file for the
   whole year clears them and uploads it in one go. */

/** The months a school is likely to be carrying across: this April backwards.
    Indian academic years run April to March, which is what makes April the
    sensible first month rather than January. */
function monthChoices(): { from: string; to: string; label: string }[] {
  const out: { from: string; to: string; label: string }[] = []
  const now = new Date()
  for (let back = 0; back < 18; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1)
    const y = d.getFullYear()
    const m = d.getMonth()
    const first = new Date(y, m, 1)
    const last = new Date(y, m + 1, 0)
    out.push({
      from: iso(first),
      to: iso(last),
      label: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    })
  }
  return out
}

function iso(d: Date): string {
  // Local, not toISOString: the school is in IST and the 1st of the month
  // becomes the 31st of the previous one when it goes through UTC.
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export default function PeriodUpload({
  entity,
  title,
  hint,
  onDone,
  /** What the period means for this sheet, in the sheet's own words. */
  periodNote,
}: {
  entity: string
  title: string
  hint: string
  onDone?: () => void
  periodNote?: string
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const months = monthChoices()

  return (
    <div className="rounded-lg border">
      <div className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-3">
        <div>
          <p className="text-[13.5px] font-medium">Which period is this file?</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {periodNote ??
              'Anything in the file outside these dates is refused, so the wrong month cannot be loaded by mistake.'}{' '}
            Leave both empty to upload a whole year at once.
          </p>
        </div>

        {/* The month buttons first, because a month is what a school is
            actually uploading. The two date boxes stay underneath for a term,
            a part-month, or a school whose year does not divide neatly. */}
        <div className="flex flex-wrap gap-1.5">
          {months.slice(0, 12).map((m) => {
            const on = from === m.from && to === m.to
            return (
              <button
                key={m.from}
                type="button"
                onClick={() => {
                  if (on) { setFrom(''); setTo('') } else { setFrom(m.from); setTo(m.to) }
                }}
                className={
                  on
                    ? 'rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-[12.5px] font-medium text-primary'
                    : 'rounded-full border px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-muted'
                }
              >
                {m.label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">From</label>
            <Input type="date" className="w-40" value={from} onChange={setFrom} srLabel="Period start" />
          </div>
          <div>
            <label className="mb-1 block text-[12px] text-muted-foreground">To</label>
            <Input type="date" className="w-40" value={to} onChange={setTo} srLabel="Period end" />
          </div>
          {(from || to) && (
            <button
              type="button"
              onClick={() => { setFrom(''); setTo('') }}
              className="pb-2 text-[12.5px] text-muted-foreground underline hover:text-foreground"
            >
              Clear
            </button>
          )}
          {from && to && from > to && (
            <p className="pb-2 text-[12.5px] text-destructive">
              The end is before the start.
            </p>
          )}
        </div>
      </div>

      <div className="p-4">
        <BulkImport
          entity={entity}
          title={title}
          hint={hint}
          onDone={onDone}
          params={{ period_from: from, period_to: to }}
        />
      </div>
    </div>
  )
}
