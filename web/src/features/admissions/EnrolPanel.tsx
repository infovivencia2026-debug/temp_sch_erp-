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
  Badge, Button, Card, CardHeader, FormNotice, Input, Loading, Select, Table, Td,
} from '@/components/ui'

interface FeeLine {
  head: string
  description?: string
  amount_paise: number
  is_refundable: boolean
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

  const [sectionId, setSectionId] = useState('')
  const [concession, setConcession] = useState('')
  const [why, setWhy] = useState('')
  const [done, setDone] = useState<{ admission_no: string } | null>(null)

  const fees = useQuery({
    queryKey: ['admission-fees', applicationId],
    queryFn: () => api.get<Fees>(
      `/api/v1/admissions/workflow/applications/${applicationId}/fees`),
  })

  const f = fees.data
  const waived = Math.round(Number(concession || 0) * 100)
  /* Never below zero, and never more than the bill. A waiver larger than the
     fee would otherwise read as the school owing the family money. */
  const due = Math.max(0, (f?.total_paise ?? 0) -
    (mayPrice ? Math.min(waived, f?.total_paise ?? 0) : 0))

  const enrol = useMutation({
    mutationFn: () => api.post<{ admission_no: string; student_id: string }>(
      `/api/v1/admissions/workflow/applications/${applicationId}/enrol`,
      {
        section_id: sectionId,
        fee_structure_id: f?.fee_structure_id || undefined,
        concession_paise: mayPrice && waived > 0
          ? Math.min(waived, f?.total_paise ?? 0) : undefined,
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
          {due > 0 && (
            <div className="text-[14px] text-muted-foreground">
              &#8377;{rupees(due)} is now outstanding. Take the payment at the fee
              counter, which issues the receipt.
            </div>
          )}
        </div>
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
        <Loading />
      ) : !f?.priced ? (
        <div className="border-b px-5 py-4 text-[14px] text-muted-foreground">
          No fee structure is priced for {f?.class_name ?? 'this class'}, so no invoice
          will be raised. The child is still admitted; bill them with the term run.
        </div>
      ) : (
        <>
          <Table head={['Fee head', { label: 'Amount', align: 'right' }]}>
            {f.lines.map((l, i) => (
              <tr key={`${l.head}-${i}`}>
                <Td>
                  {l.head}
                  {l.is_refundable && (
                    <span className="ml-2">
                      <Badge tone="neutral">refundable</Badge>
                    </span>
                  )}
                </Td>
                <Td className="num text-right">&#8377;{rupees(l.amount_paise)}</Td>
              </tr>
            ))}
            <tr>
              <Td className="font-medium">
                {f.fee_structure_name ?? 'Total'} &middot; instalment {f.instalment_no}
              </Td>
              <Td className="num text-right font-medium">
                &#8377;{rupees(f.total_paise)}
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
