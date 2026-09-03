/* Taking the seat: what it costs, and the step that makes the child a student.
 *
 * The money is not taken here. The fee counter does that, and a second place to
 * record a payment is a second place for the day's cash to disagree with the
 * ledger. What this does is open the account — the admission number, the
 * section, and the first invoice raised from the class's own price list — and
 * then hand over.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan } from '@/lib/session'
import {
  Badge, Button, Card, CardHeader, Checkbox, FormNotice, Input, SkeletonTable, Select,
  Table, Td,
} from '@/components/ui'

interface FeeLine {
  head: string
  description?: string
  amount_paise: number
  is_refundable: boolean
  /* 'transport' or 'hostel' where the fee is for a service the family opts
     into rather than for being enrolled. */
  service?: string
}
interface Fees {
  fee_structure_id?: string
  fee_structure_name?: string
  class_name?: string
  instalment_no: number
  lines: FeeLine[]
  total_paise: number
  priced: boolean
}

/* The same list the fee counter offers, because it is the same payment. */
const MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'neft', label: 'NEFT / IMPS' },
  { value: 'netbanking', label: 'Net banking' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'dd', label: 'Demand draft' },
]

const rupees = (p: number) =>
  (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })

export default function EnrolPanel({
  applicationId,
  classSought,
  sections,
  onDone,
}: {
  applicationId: string
  classSought?: string
  sections: { id: string; label: string }[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const can = useCan()
  /* Setting a price is finance's, not the front desk's. */
  const mayPrice = can('finance.fees.write')

  /* Taking the money is a different right from enrolling. Where one person
     does both — a small school whose admissions desk is the cash counter — the
     payment step appears here; where they are two people, it does not. */
  const mayTakeMoney = can('finance.payments.write')

  const [sectionId, setSectionId] = useState('')
  const [services, setServices] = useState<string[]>([])
  const [concession, setConcession] = useState('')
  const [why, setWhy] = useState('')
  const [done, setDone] = useState<{ admission_no: string; student_id: string } | null>(null)

  const [mode, setMode] = useState('cash')
  const [paid, setPaid] = useState('')
  const [reference, setReference] = useState('')
  const [bank, setBank] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [receipt, setReceipt] = useState('')

  const fees = useQuery({
    queryKey: ['admission-fees', applicationId],
    queryFn: () => api.get<Fees>(
      `/api/v1/admissions/workflow/applications/${applicationId}/fees`),
  })

  const f = fees.data
  /* Optional lines are quoted, not charged, until they are ticked. */
  const optional = (f?.lines ?? []).filter((l) => l.service)
  const optedTotal = optional
    .filter((l) => services.includes(l.service!))
    .reduce((n, l) => n + l.amount_paise, 0)

  const waived = Math.round(Number(concession || 0) * 100)
  /* Never below zero, and never more than the bill. A waiver larger than the
     fee would otherwise read as the school owing the family money. */
  const billed = (f?.total_paise ?? 0) + optedTotal
  const due = Math.max(0, billed - (mayPrice ? Math.min(waived, billed) : 0))

  const enrol = useMutation({
    mutationFn: () => api.post<{ admission_no: string; student_id: string }>(
      `/api/v1/admissions/workflow/applications/${applicationId}/enrol`,
      {
        section_id: sectionId,
        fee_structure_id: f?.fee_structure_id || undefined,
        services: services.length ? services : undefined,
        concession_paise: mayPrice && waived > 0
          ? Math.min(waived, billed) : undefined,
        concession_reason: mayPrice && waived > 0 ? (why.trim() || undefined) : undefined,
      },
    ),
    onSuccess: (r) => {
      setDone(r)
      qc.invalidateQueries({ queryKey: ['merit'] })
      qc.invalidateQueries({ queryKey: ['seats'] })
      qc.invalidateQueries({ queryKey: ['funnel'] })
    },
  })

  const collect = useMutation({
    mutationFn: () => api.post<{ payment_id: string; receipt_no: string }>(
      '/api/v1/fees/payments',
      {
        student_id: done!.student_id,
        // Rupees in the box, paise on the wire: the API never sees a decimal.
        amount_paise: Math.round(parseFloat(paid || '0') * 100),
        mode,
        reference_no: reference || undefined,
        bank_name: bank || undefined,
        cheque_date: chequeDate || undefined,
      },
    ),
    onSuccess: (r) => setReceipt(r.receipt_no),
  })

  const needsInstrument = mode === 'cheque' || mode === 'dd'

  if (done) {
    return (
      <Card>
        <CardHeader
          title="Enrolled"
          description="The student record, the enrolment, the guardian link and the first invoice are all in place."
          action={<Button variant="ghost" onClick={onDone}>Close</Button>}
        />
        <div className="flex flex-wrap items-center gap-4 p-5">
          <div>
            <p className="text-[13px] text-muted-foreground">Admission number</p>
            <p className="font-mono text-[20px] font-medium">{done.admission_no}</p>
          </div>
          {due > 0 && !mayTakeMoney && (
            <div className="text-[14px] text-muted-foreground">
              &#8377;{rupees(due)} is now outstanding. Take the payment at the fee
              counter, which issues the receipt.
            </div>
          )}
        </div>

        {/* The receipt, once it exists.

            Shown rather than announced and dismissed: this number is read back
            across the counter and written on the parent's copy, and a toast
            that has already faded is no use to the person holding the cash. */}
        {receipt ? (
          <div className="border-t p-5">
            <p className="text-[13px] text-muted-foreground">Receipt issued</p>
            <p className="font-mono text-[20px] font-medium">{receipt}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              &#8377;{rupees(Math.round(parseFloat(paid || '0') * 100))} taken by{' '}
              {MODES.find((m) => m.value === mode)?.label.toLowerCase()}. The full
              receipt, with every fee head on it, is on the fee counter.
            </p>
          </div>
        ) : due > 0 && mayTakeMoney ? (
          <div className="border-t p-5">
            <p className="eyebrow mb-3">Take the payment</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Amount (&#8377;)</span>
                <div className="w-32"><Input value={paid} onChange={setPaid} /></div>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">How</span>
                <div className="w-44">
                  <Select value={mode} onChange={setMode} options={MODES} />
                </div>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">
                  {needsInstrument ? 'Cheque / DD number' : 'Reference'}
                </span>
                <div className="w-44"><Input value={reference} onChange={setReference} /></div>
              </label>
              {needsInstrument && (
                <>
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    <span className="text-muted-foreground">Bank</span>
                    <div className="w-44"><Input value={bank} onChange={setBank} /></div>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    <span className="text-muted-foreground">Instrument date</span>
                    <div className="w-40">
                      <Input type="date" value={chequeDate} onChange={setChequeDate} />
                    </div>
                  </label>
                </>
              )}
              <Button
                disabled={!(parseFloat(paid || '0') > 0) || collect.isPending}
                onClick={() => collect.mutate()}
              >
                {collect.isPending ? 'Recording…' : 'Record payment'}
              </Button>
              <Button variant="ghost" onClick={() => setPaid(rupees(due))}>
                Pay all &#8377;{rupees(due)}
              </Button>
            </div>
            <FormNotice error={collect.error} />
            <p className="mt-3 text-[12.5px] text-muted-foreground">
              Recorded against the same receipt series as the fee counter, so the
              day&rsquo;s collection reconciles as one.
            </p>
          </div>
        ) : null}
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Enrol applicant"
        description="Creates the student record, the enrolment, the guardian link and the first invoice in one step."
        action={<Button variant="ghost" onClick={onDone}>Cancel</Button>}
      />

      <div className="flex flex-wrap items-end gap-4 border-b p-5">
        <label>
          <span className="text-[13px] text-muted-foreground">
            Section{classSought ? ` in ${classSought}` : ''}
          </span>
          <div className="mt-1 w-56">
            <Select
              value={sectionId}
              onChange={setSectionId}
              placeholder="Select section"
              options={sections.map((x) => ({ value: x.id, label: x.label }))}
            />
          </div>
        </label>
        <div>
          <p className="text-[13px] text-muted-foreground">Admission number</p>
          <p className="mt-2 text-[14px]">
            Allocated on save
            {/* Not editable on purpose: the series is gapless, and a typed
                number is how a school ends up with two children sharing one
                or a hole an auditor asks about. */}
            <span className="ml-1.5 text-[12px] text-muted-foreground">
              (gapless series)
            </span>
          </p>
        </div>
      </div>

      {fees.isLoading ? (
        <SkeletonTable columns={2} />
      ) : !f?.priced ? (
        <div className="border-b px-5 py-4 text-[14px] text-muted-foreground">
          No fee structure is priced for {f?.class_name ?? 'this class'}, so no invoice
          will be raised. The child is still admitted; bill them with the term run.
        </div>
      ) : (
        <>
          <Table head={['Fee head', { label: 'Amount', align: 'right' }]}>
            {f.lines.map((l, i) => {
              const opted = !l.service || services.includes(l.service)
              return (
                <tr key={`${l.head}-${i}`} className={opted ? '' : 'text-muted-foreground'}>
                  <Td>
                    {l.service ? (
                      <Checkbox
                        checked={services.includes(l.service)}
                        onChange={(v) => setServices((xs) =>
                          v ? [...xs, l.service!] : xs.filter((x) => x !== l.service))}
                        label={l.head}
                        hint={l.service === 'transport'
                          ? 'Only if the child travels by school bus'
                          : 'Only if the child boards'}
                      />
                    ) : (
                      <>
                        {l.head}
                        {l.is_refundable && (
                          <span className="ml-2">
                            <Badge tone="neutral">refundable</Badge>
                          </span>
                        )}
                      </>
                    )}
                  </Td>
                  <Td className="num text-right">
                    &#8377;{rupees(l.amount_paise)}
                    {!opted && (
                      <span className="ml-1.5 text-[12px]">not taken</span>
                    )}
                  </Td>
                </tr>
              )
            })}
            <tr>
              <Td className="font-medium">
                {f.fee_structure_name ?? 'Total'} &middot; instalment {f.instalment_no}
              </Td>
              <Td className="num text-right font-medium">
                &#8377;{rupees(billed)}
              </Td>
            </tr>
          </Table>

          <div className="flex flex-wrap items-end gap-4 border-t p-5">
            {/* Whoever collects the money does not set it.

                The desk enrolling the child holds students.write; deciding
                what a family pays needs fees.write, and the two are held by
                different people on purpose. An officer who can waive a fee at
                the counter can waive one for a friend, or collect the full
                amount against a reduced invoice and keep the difference.

                So the control is not shown to somebody who cannot use it —
                offering it and refusing on submit is worse than not offering
                it, because it reads as the product being broken rather than as
                the rule it is. */}
            {mayPrice ? (
              <>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Concession (&#8377;)</span>
                  <Input value={concession} onChange={setConcession} placeholder="0" />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Reason</span>
                  <Input value={why} onChange={setWhy} placeholder="RTE, sibling, scholarship…" />
                </label>
              </>
            ) : (
              <p className="max-w-md text-[13px] text-muted-foreground">
                The fee is set by accounts and cannot be changed here. If this family
                is owed a concession &mdash; RTE, a sibling, a staff ward &mdash; enrol
                them and ask accounts to record it; the invoice is adjusted without
                the admission waiting.
              </p>
            )}
            <div className="ml-auto text-right">
              <p className="text-[13px] text-muted-foreground">Due now</p>
              <p className="num text-[22px] font-medium">&#8377;{rupees(due)}</p>
            </div>
          </div>
        </>
      )}

      <FormNotice error={enrol.error} />

      <div className="flex flex-wrap items-center gap-2 border-t px-5 py-4">
        <Button
          disabled={!sectionId || enrol.isPending}
          onClick={() => enrol.mutate()}
        >
          {enrol.isPending ? 'Enrolling…' : 'Complete enrolment'}
        </Button>
        <span className="text-[13px] text-muted-foreground">
          The payment is taken at the fee counter, which issues the receipt.
        </span>
      </div>
    </Card>
  )
}
