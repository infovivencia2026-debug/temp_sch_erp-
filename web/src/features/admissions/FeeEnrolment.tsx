import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, FormGrid, Field as FormField, Select,
  Input, Textarea, FormNotice, Table, Td, Badge, Button, Loading, ErrorState,
} from '@/components/ui'
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

interface Section {
  id: string
  name: string
  class_name: string
  enrolled: number
  capacity: number
}

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
  enrolment_approved: boolean
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
  const can = useCan()
  /* Approving a JOINING, as distinct from approving the waiver.

     The gate that requires this was built with no screen to open it: turning
     it on blocked every enrolment at the school with no way through, which is
     the same fault as a button that asks and then refuses, only worse because
     it stops work rather than wasting a click. The switch and the screen have
     to ship together. */
  const mayApprove = can('admissions.approve')
  const mayEnrol = can('students.write')
  const [note, setNote] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [noInvoice, setNoInvoice] = useState(false)
  const [routeId, setRouteId] = useState('')
  const [pickupStopId, setPickupStopId] = useState('')

  /* The bus is settled here too, with the section and the fee.

     Billing a family for transport and seating the child on a bus were two
     screens: the desk named 'transport' so the head appeared on the invoice,
     and somebody in the transport office had to find the student again later
     and allocate a stop. The ordinary outcome was a paid transport bill and
     no seat -- the family believes it is arranged, the office believes it is
     arranged, and the first anyone knows is a child waiting at a stop the
     driver has no reason to call at. Asked once, at the moment the money is
     agreed, because that is when the parent is being asked anyway. */
  const routes = useQuery({
    queryKey: ['transport-routes', 'for-admission'],
    queryFn: () => api.get<List<{ id: string; name: string; code?: string }>>(
      '/api/v1/ops/transport/routes'),
  })
  const stops = useQuery({
    enabled: routeId !== '',
    queryKey: ['route-stops', 'for-admission', routeId],
    queryFn: () => api.get<List<{ id: string; name: string; pickup_time?: string }>>(
      `/api/v1/ops/transport/routes/${routeId}/stops`),
  })

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  const enrol = useMutation({
    mutationFn: () => api.post<{
      admission_no?: string
      invoice_no?: string
      net_paise?: number
    }>(
      `/api/v1/admissions/workflow/applications/${row.id}/enrol`,
      {
        section_id: sectionId,
        no_invoice: noInvoice,
        /* Naming the service is what puts the transport head on the bill, so
           a child who walks is never quoted a bus. */
        ...(routeId && pickupStopId
          ? {
              services: ['transport'],
              transport: { route_id: routeId, pickup_stop_id: pickupStopId },
            }
          : {}),
      }),
    onSuccess: () => onChanged(),
  })

  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      api.post(`/api/v1/admissions/workflow/pending-admissions/${row.id}/decide`,
        { approved, note }),
    onSuccess: () => { setNote(''); onChanged() },
  })
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

      {mayApprove && !row.enrolment_approved && (
        <div className="border-b bg-muted/20 p-4">
          <p className="eyebrow mb-2">The principal's decision on this joining</p>
          <p className="mb-3 text-[13px] text-muted-foreground">
            {row.name} would join {row.class_sought} and be billed{' '}
            {Number(row.fee_paise) > 0 ? formatPaise(Number(row.fee_paise)) : 'nothing yet'}
            {row.concession_status === 'approved'
              ? `, less an approved ${row.concession_kind.replace('_', ' ')} concession of ${row.concession_value}.`
              : row.concession_status === 'pending'
                ? '. A concession is still waiting on you below.'
                : '. No concession has been asked for.'}
          </p>
          <FormField label="Note"
            hint="What the desk should tell the family, if you are sending it back">
            <Input value={note} onChange={setNote} />
          </FormField>
          <FormNotice error={decide.error} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              Approve the joining
            </Button>
            {/* Sending back is not rejecting the child: the commonest answer
                is "not until the fee is settled", which is a delay. The note
                is required for it, because the desk has to tell the family
                something and the person who answers the telephone did not
                make the decision. */}
            <Button variant="secondary" disabled={decide.isPending || !note.trim()}
              onClick={() => decide.mutate(false)}>
              Send back to the desk
            </Button>
            {decide.isSuccess && (
              <span className="text-[12.5px] text-success">Recorded.</span>
            )}
          </div>
        </div>
      )}

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
                /* The discount for paying the whole year at once. Unlike the
                   others it is about HOW the family pays rather than who they
                   are, and it is the commonest one an Indian school gives. */
                { value: 'full_payment', label: 'Paying all terms in one instalment' },
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
            {/* ENROLLING HAPPENS HERE, not on another page.

                This ended in a button to Application Forms, because that is
                where the enrol form lives. But whoever is reading this has
                just settled the fee for this child and wants to admit them:
                sending them to a second screen to find the same applicant in
                a list and open it again is three steps to reach one button,
                and it throws away the place they were in. The form is small
                -- a section, and whether to bill now. It belongs here. */}
            {mayEnrol && (enrol.data ? (
              <div className="mt-2 space-y-1 rounded-lg border border-success/40 bg-success/5 p-3 text-[13px]">
                <p className="font-medium text-success">
                  {row.name} has joined{enrol.data.admission_no ? ` as ${enrol.data.admission_no}` : ''}.
                </p>
                {/* THE AMOUNT, HERE, WITHOUT LOOKING IT UP. The parent is
                    standing at the desk when this happens and the first thing
                    they ask is what they owe. Sending the clerk to Student 360
                    to find out is a question the screen could have answered. */}
                {enrol.data.invoice_no ? (
                  <p>
                    Billed <span className="font-medium tabular-nums">
                      {formatPaise(Number(enrol.data.net_paise))}
                    </span> on {enrol.data.invoice_no}
                    {row.concession_status === 'approved'
                      ? ', with the approved concession already taken off.'
                      : '.'}
                  </p>
                ) : (
                  <p>No bill was raised. This child is billed with the class.</p>
                )}
                <p className="text-muted-foreground">
                  Their full record is in Student 360.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-3 rounded-lg border p-3">
                <FormField label="Which section" required
                  hint="The one thing left to decide. The rest comes from the application.">
                  <Select
                    value={sectionId}
                    onChange={setSectionId}
                    placeholder="Choose a section"
                    options={(sections.data?.items ?? [])
                      .filter((x) => !row.class_sought || x.class_name === row.class_sought)
                      .map((x) => ({
                        value: x.id,
                        /* "12/40" is a thing you have to be told once. It is
                           seats -- how many children are in the room and how
                           many it holds -- and spelling that out costs four
                           words on a line that has the space. */
                        label: `${x.class_name}-${x.name} Â· ${x.enrolled} of ${x.capacity} seats filled`
                          + (x.enrolled >= x.capacity ? ' Â· FULL' : ''),
                      }))}
                  />
                </FormField>
                {/* Some schools bill a whole class in one run at the start of
                    term. Raising here as well would bill those families twice. */}
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={noInvoice}
                    onChange={(e) => setNoInvoice(e.target.checked)} />
                  Do not raise the bill now — we bill the whole class together
                </label>
                <FormField label="Bus route"
                  hint="Leave this alone for a child who walks or comes by car.">
                  <Select
                    value={routeId}
                    onChange={(v) => { setRouteId(v); setPickupStopId('') }}
                    placeholder="Walks or own transport"
                    options={(routes.data?.items ?? []).map((r) => ({
                      value: r.id,
                      label: r.code ? `${r.name} (${r.code})` : r.name,
                    }))}
                  />
                </FormField>
                {routeId && (
                  /* A route without a stop is a bill without a seat, so the
                     Enrol button below stays disabled until this is answered. */
                  <FormField label="Boards at" required>
                    <Select
                      value={pickupStopId}
                      onChange={setPickupStopId}
                      placeholder={stops.isFetching ? 'Loadingâ¦' : 'Choose the stop'}
                      options={(stops.data?.items ?? []).map((st) => ({
                        value: st.id,
                        label: st.pickup_time ? `${st.name} Â· ${st.pickup_time}` : st.name,
                      }))}
                    />
                  </FormField>
                )}
                {/* THE PRINCIPAL SIGNS OFF EVERY JOINING, so this cannot be
                    a button that asks and then refuses. The server enforces
                    it; saying it here is what stops somebody filling the whole
                    form first. */}
                {!row.enrolment_approved && (
                  <p className="text-[13px] text-warning">
                    Waiting on the principal. Every new joining is approved
                    before the child is admitted and the fee is raised.
                  </p>
                )}
                <FormNotice error={enrol.error} />
                <Button disabled={!row.enrolment_approved || !sectionId
                  || (!!routeId && !pickupStopId) || enrol.isPending}
                  onClick={() => enrol.mutate()}>
                  {enrol.isPending ? 'Enrolling…' : `Enrol ${row.name}`}
                </Button>
              </div>
            ))}
          </>
        )}
        <p className="mt-2 text-[12px] text-muted-foreground">
          Offered {formatDate(row.offered_on)}.
        </p>
      </div>
    </Card>
  )
}
