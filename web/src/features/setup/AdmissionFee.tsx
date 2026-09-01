import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  FormGrid, Field as FormField, Select, Input, Textarea, FormNotice, Button,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* What the class costs, and the concession agreed at the desk.

   Admitting a child raises no invoice — deliberately, because a school that
   billed on admission would bill a November arrival for the whole year, and
   would bill before the year's structure exists. The demand is raised as its
   own act.

   That is right, and it left the clerk with nothing to say. A parent sitting
   at the desk asks what it will cost, which is the one question every
   admission conversation contains, and the office had to open the finance
   module and read the structure out — so they quoted from memory or from a
   printed sheet that went out of date in April.

   The concession belongs here for the same reason. A staff-ward or sibling
   rate is AGREED at admission, in front of the person admitting the child.
   Sending the family to the accounts office to have it typed in again is how
   it ends up on a sticky note and is discovered in November.

   RAISING IS NOT APPROVING. This writes a pending row. The decision is still
   the principal's, and an admissions clerk cannot approve their own request —
   the two permissions are the whole safeguard and they stay separate.
*/

interface Quote {
  structure: string
  heads: { head: string; paise: number; instalment: number }[]
  total_paise: number
  instalments: number
  has_structure: boolean
  note: string
}

export default function AdmissionFee({ classID, studentID, studentName }: {
  classID?: string
  /** Absent while the form is still being filled in: there is no child to
      grant anything to until they are admitted, so the quote shows and the
      concession waits. */
  studentID?: string
  studentName?: string
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('staff_ward')
  const [mode, setMode] = useState<'percent' | 'amount'>('percent')
  const [percent, setPercent] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  const quote = useQuery({
    queryKey: ['admission-fee', classID],
    enabled: !!classID,
    queryFn: () => api.get<Quote>(`/api/v1/students/fee-preview?class_id=${classID}`),
  })

  const grant = useMutation({
    mutationFn: () => api.post('/api/v1/fees/concessions', {
      student_id: studentID,
      kind,
      percent: mode === 'percent' ? percent : '',
      // Rupees on the screen, paise in the database.
      amount_paise: mode === 'amount' ? Math.round(Number(amount) * 100) : undefined,
      reason,
    }),
    onSuccess: () => { setOpen(false); setPercent(''); setAmount(''); setReason('') },
  })

  if (!classID) return null
  const q = quote.data
  if (quote.isLoading) return null

  if (!q?.has_structure) {
    return (
      <div className="rounded-lg border bg-muted/30 p-3 text-[12.5px] text-muted-foreground">
        No fee structure has been set for this class yet, so there is nothing to
        quote. Build one under Accounts → Fees → Class &amp; transport fee setup.
      </div>
    )
  }

  // Grouped by instalment: "₹13,500 a year" and "₹4,500 in July" are different
  // answers to the question a family is actually asking.
  const byInstalment = new Map<number, typeof q.heads>()
  for (const h of q.heads) {
    const list = byInstalment.get(h.instalment) ?? []
    list.push(h)
    byInstalment.set(h.instalment, list)
  }

  const afterConcession = mode === 'percent' && Number(percent) > 0
    ? q.total_paise - Math.round(q.total_paise * Number(percent) / 100)
    : mode === 'amount' && Number(amount) > 0
      ? Math.max(0, q.total_paise - Math.round(Number(amount) * 100))
      : null

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium">
          {q.structure} — {formatPaise(q.total_paise)} for the year
        </p>
        <p className="text-[12px] text-muted-foreground">
          {q.instalments} instalment{q.instalments === 1 ? '' : 's'}
        </p>
      </div>

      <table className="mt-2 w-full text-[12.5px]">
        <tbody>
          {[...byInstalment.entries()].sort((a, b) => a[0] - b[0]).map(([n, list]) => (
            <tr key={n} className="border-t align-top">
              <td className="py-1 pr-3 text-muted-foreground">Instalment {n}</td>
              <td className="py-1">
                {list.map((h) => (
                  <span key={h.head} className="mr-3 inline-block">
                    {h.head} <span className="tabular-nums">{formatPaise(h.paise)}</span>
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-[12px] text-muted-foreground">{q.note}</p>

      {/* The concession waits for a child to exist. Offering the form before
          the admission is saved would be a form that cannot be submitted. */}
      {studentID ? (
        open ? (
          <div className="mt-3 space-y-3 rounded-lg border bg-background p-3">
            <FormGrid>
              <FormField label="Why" required>
                <Select value={kind} onChange={setKind} options={[
                  { value: 'staff_ward', label: "Staff member's child" },
                  { value: 'sibling', label: 'Sibling already here' },
                  { value: 'scholarship', label: 'Scholarship' },
                  { value: 'merit', label: 'Merit' },
                  { value: 'rte', label: 'RTE' },
                  { value: 'other', label: 'Other' },
                ]} />
              </FormField>
              <FormField label="How much">
                <Select value={mode} onChange={(v) => setMode(v as 'percent' | 'amount')}
                  options={[
                    { value: 'percent', label: 'A percentage of the fee' },
                    { value: 'amount', label: 'A fixed amount off' },
                  ]} />
              </FormField>
              {mode === 'percent' ? (
                <FormField label="Percent" required>
                  <Input type="number" value={percent} onChange={setPercent} placeholder="50" />
                </FormField>
              ) : (
                <FormField label="Amount (₹)" required>
                  <Input type="number" value={amount} onChange={setAmount} placeholder="2000" />
                </FormField>
              )}
            </FormGrid>
            <FormField label="Reason" required
              hint="What was agreed, and with whom. The principal reads this before approving.">
              <Textarea rows={2} value={reason} onChange={setReason} />
            </FormField>
            {afterConcession !== null && (
              <p className="text-[12.5px]">
                {studentName ?? 'This child'} would be billed{' '}
                <span className="font-medium tabular-nums">{formatPaise(afterConcession)}</span>{' '}
                for the year instead of {formatPaise(q.total_paise)}.
              </p>
            )}
            {/* Said plainly, because a clerk who believes they have granted it
                will tell the family so. */}
            <p className="text-[12px] text-muted-foreground">
              This is a request. It applies when the principal approves it, and
              only to demands raised after that.
            </p>
            <FormNotice error={grant.error} />
            <div className="flex items-center gap-2">
              <Button
                disabled={grant.isPending || !reason.trim()
                  || (mode === 'percent' ? !percent : !amount)}
                onClick={() => grant.mutate()}
              >
                {grant.isPending ? 'Saving…' : 'Ask for this concession'}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Set a concession
            </Button>
            {grant.isSuccess && (
              <span className="text-[12.5px] text-success">
                Asked for. It appears on the principal&rsquo;s approvals.
              </span>
            )}
          </div>
        )
      ) : (
        <p className="mt-2 text-[12px] text-muted-foreground">
          A concession can be set once the child is admitted.
        </p>
      )}
    </div>
  )
}
