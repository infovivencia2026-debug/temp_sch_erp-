import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, FormGrid, Field as FormField, Select,
  Input, Textarea, FormNotice, Table, Td, Badge, Button, Loading, ErrorState,
} from '@/components/ui'
import { useNavigate } from 'react-router-dom'
import { useCan } from '@/lib/session'
import { formatPaise, formatDate } from '@/lib/utils'

/* The money that settles before a child joins.

   This lists APPLICANTS WHO HAVE BEEN OFFERED A PLACE, not students. That is
   the whole point of it: a family agrees the staff-ward or sibling rate as
   part of deciding whether to come at all, and nobody accepts a place and then
   finds out what it costs. Waiting until they are a student means the invoice
   already exists at full price and the only remedy is a credit note.

   It listed admitted students first, which put the screen after the moment it
   is for â an offered applicant appeared nowhere on it.

   The order of work, and the screen follows it:

     1  a place is offered, and the family is told what the class costs
     2  the desk asks for the concession that was agreed
     3  the principal decides it
     4  the child is enrolled, and the bill is raised with the waiver in it
     5  they are an ordinary student, and the parent can pay

   ENROLLING IS REFUSED WHILE A CONCESSION IS WAITING. That is enforced by the
   server, not by this screen, because it is the one point in the sequence
   that cannot be recovered from.
*/

interface Pending {
  id: string
  application_no: string
  name: string
  class_sought: string
  parent_name: string
  phone: string
  offered_on: string
  fee_paise: string
  concession_kind: string
  concession_value: string
  concession_status: string
}

export default function FeeEnrolment() {
  const qc = useQueryClient()
  const can = useCan()
  const mayAsk = can('admissions.write') || can('finance.fees.write')

  const [openID, setOpenID] = useState<string | null>(null)

  const queue = useQuery({
    queryKey: ['pending-admissions'],
    queryFn: () => api.get<List<Pending>>('/api/v1/admissions/workflow/pending-admissions'),
  })

  const rows = queue.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title="Fee & enrolment"
        description="Applicants who have been offered a place, and the money that settles before they join: what the class costs, the concession agreed at the desk, and the principal's decision on it."
      />
      <PageBody>
        {queue.isLoading ? <Loading /> : queue.error ? <ErrorState error={queue.error} /> : (
          <Card>
            <CardHeader
              title={rows.length === 1 ? '1 offer waiting' : `${rows.length} offers waiting`}
              description="A place is offered and the child has not joined yet. Settle the fee here."
            />
            <Table
              head={['Applicant', 'Class', 'Parent', 'Fee', 'Concession', '']}
              empty={!rows.length}
              emptyLabel="No offer is waiting. Offer a place from Applications and it appears here."
            >
              {rows.map((a) => (
                <tr key={a.id}>
                  <Td className="font-medium">
                    {a.name}
                    <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                      {a.application_no}
                    </span>
                  </Td>
                  <Td>{a.class_sought || '—'}</Td>
                  <Td className="text-muted-foreground">
                    {a.parent_name || '—'}
                    {a.phone && <span className="block text-[12px]">{a.phone}</span>}
                  </Td>
                  <Td className="tabular-nums">
                    {Number(a.fee_paise) > 0
                      ? formatPaise(Number(a.fee_paise))
                      : <span className="text-warning">no priced structure</span>}
                  </Td>
                  <Td>
                    {a.concession_status ? (
                      <>
                        <Badge tone={a.concession_status === 'approved' ? 'success'
                          : a.concession_status === 'rejected' ? 'danger' : 'warning'}>
                          {a.concession_status}
                        </Badge>
                        <span className="block text-[12px] text-muted-foreground">
                          {a.concession_kind.replace('_', ' ')} {a.concession_value}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">none asked for</span>
                    )}
                  </Td>
                  <Td>
                    <Button size="sm" variant="secondary"
                      onClick={() => setOpenID(openID === a.id ? null : a.id)}>
                      {openID === a.id ? 'Close' : 'Fee'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {openID && (
          <ApplicantFee
            row={rows.find((x) => x.id === openID)!}
            mayAsk={mayAsk}
            onChanged={() => qc.invalidateQueries({ queryKey: ['pending-admissions'] })}
          />
        )}
      </PageBody>
    </>
  )
}

function ApplicantFee({ row, mayAsk, onChanged }: {
  row: Pending
  mayAsk: boolean
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const [kind, setKind] = useState('staff_ward')
  const [mode, setMode] = useState<'percent' | 'amount'>('percent')
  const [percent, setPercent] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  const ask = useMutation({
    mutationFn: () => api.post('/api/v1/fees/concessions', {
      /* Against the APPLICATION, not a student: there is no student until the
         child is enrolled, and waiting until then is what put the invoice out
         at full price. Acceptance carries this onto the new student before the
         bill is built. */
      application_id: row.id,
      kind,
      percent: mode === 'percent' ? percent : '',
      amount_paise: mode === 'amount' ? Math.round(Number(amount) * 100) : undefined,
      reason,
    }),
    onSuccess: () => { setPercent(''); setAmount(''); setReason(''); onChanged() },
  })

  const fee = Number(row.fee_paise)
  const after = mode === 'percent' && Number(percent) > 0
    ? fee - Math.round(fee * Number(percent) / 100)
    : mode === 'amount' && Number(amount) > 0
      ? Math.max(0, fee - Math.round(Number(amount) * 100))
      : null

  return (
    <Card>
      <CardHeader
        title={`${row.name} · ${row.application_no}`}
        description={fee > 0
          ? `${row.class_sought} costs ${formatPaise(fee)} for the year.`
          : 'No priced fee structure covers this class, so nothing can be quoted or billed.'}
      />

      {row.concession_status ? (
        <div className="border-b px-5 py-4 text-[13px]">
          A {row.concession_kind.replace('_', ' ')} concession of{' '}
          <span className="font-medium">{row.concession_value}</span> is{' '}
          <span className="font-medium">{row.concession_status}</span>.
          {row.concession_status === 'pending' && (
            /* Said here as well as enforced on the server, because the person
               who enrols is often not the person who asked. */
            <span className="block text-warning">
              The child cannot be enrolled until the principal decides it.
            </span>
          )}
          {row.concession_status === 'approved' && (
            <span className="block text-success">
              Enrol from Applications and the bill is raised with this already
              taken off.
            </span>
          )}
        </div>
      ) : mayAsk ? (
        <div className="space-y-3 border-b p-4">
          <p className="eyebrow">Ask for a concession</p>
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
            hint="What was agreed, and with whom. The principal reads this before deciding.">
            <Textarea rows={2} value={reason} onChange={setReason} />
          </FormField>
          {after !== null && (
            <p className="text-[12.5px]">
              {row.name} would be billed{' '}
              <span className="font-medium tabular-nums">{formatPaise(after)}</span>{' '}
              instead of {formatPaise(fee)}.
            </p>
          )}
          <FormNotice error={ask.error} />
          <Button
            disabled={ask.isPending || !reason.trim()
              || (mode === 'percent' ? !percent : !amount)}
            onClick={() => ask.mutate()}
          >
            {ask.isPending ? 'Sending...' : 'Send for approval'}
          </Button>
        </div>
      ) : null}

      {/* WHAT TO DO WHEN THERE IS NO CONCESSION, said as loudly as the form.

          Most admissions have none, and for those this screen showed a form
          asking for one and a grey footnote about where to enrol. So the
          common case read as the incomplete one: nothing on the page said
          "there is nothing to settle here, go ahead". */}
      <div className="border-t px-5 py-4">
        {row.concession_status === 'pending' ? (
          <p className="text-[13px] text-warning">
            Waiting on the principal. This child cannot be enrolled until it is
            decided — enrolling now would bill the family in full and the
            waiver could not be applied afterwards.
          </p>
        ) : (
          <>
            <p className="text-[13px]">
              {row.concession_status === 'approved'
                ? 'The concession is approved. Enrol from Applications and the bill is raised with it already taken off.'
                : 'No concession has been asked for, so nothing is holding this up. Enrol from Applications whenever the family is ready.'}
            </p>
            {/* NAVIGATE, DO NOT RELOAD.

                A plain href tears the whole application down and builds it
                again: the tab strip, the session, every cached query. Inside a
                single-page app that is a two-second white flash where a click
                should have been instant, and it looked like the button had
                failed and started over.

                And it said "Open Applications", which is not the name of
                anything in the sidebar. The menu item is Application Forms, so
                that is what it is called here. */}
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => navigate('/admissions/applications/application_forms')}
            >
              Enrol {row.name} from Application Forms
            </Button>
          </>
        )}
        <p className="mt-2 text-[12px] text-muted-foreground">
          Offered {formatDate(row.offered_on)}.
        </p>
      </div>
    </Card>
  )
}
