import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, FormGrid, Field as FormField, Select,
  Input, Textarea, FormNotice, Table, Td, Badge, Button, Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatPaise, formatDate } from '@/lib/utils'

/* The money that settles before a child is really a student.

   Admitting raises no bill on its own, deliberately, so between "accepted"
   and "the parent can pay" there was a gap the product did not hold: what the
   class costs, the concession agreed at the desk, the principal's decision on
   it, and the demand raised once that is settled. Each of those lived on a
   different screen, or nowhere.

   This is that queue, in the order the work happens:

     1  the child is admitted and owes nothing yet
     2  the desk asks for a concession, if one was agreed
     3  the principal approves or refuses it
     4  the fee is raised, with the concession already in the lines
     5  the parent sees it, and the child is an ordinary student

   THE RAISE IS HELD WHILE A CONCESSION IS WAITING. The engine applies only
   approved concessions when it builds the invoice lines, so billing first
   charges the family in full and leaves the waiver approved and inert — and
   the only remedy then is a credit note. The rule is enforced here rather
   than written in a sentence nobody reads at the moment they press it.
*/

interface Row {
  student: Student
  concessions: {
    id: string; kind: string; status: string; percent: string
    amount_paise: string; reason: string; decision_note: string
    decided_by: string; asked_by: string; raised_on: string
  }[]
  quote?: {
    structure_id: string; structure: string; total_paise: number
    instalments: number; has_structure: boolean
  }
  // Paise come back as strings: a bigint does not survive JSON as a number.
  invoices: { invoice_no: string; net_paise: string; paid_paise: string; status: string }[]
}

export default function FeeEnrolment() {
  const qc = useQueryClient()
  const can = useCan()
  const mayAsk = can('students.write') || can('admissions.admissions.write')

  const [openID, setOpenID] = useState<string | null>(null)

  /* Children admitted this year, newest first — the queue this screen is
     about. Not "everybody", because a school of nine hundred does not need
     its whole roll on a page about what has just been admitted. */
  const roll = useQuery({
    queryKey: ['fee-enrolment-roll'],
    queryFn: () => api.get<Page<Student>>('/api/v1/students?status=active&new_this_year=1&limit=200'),
  })

  const rows = roll.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title="Fee & enrolment"
        description="Children admitted this year and the money that settles before they are ordinary students: what the class costs, the concession agreed at the desk, and the demand raised once the principal has decided."
      />
      <PageBody>
        {roll.isLoading ? <Loading /> : roll.error ? <ErrorState error={roll.error} /> : (
          <Card>
            <CardHeader
              title={`${rows.length} admitted this year`}
              description="Open a child to quote the fee, ask for a concession, and raise the bill."
            />
            <Table
              head={['Student', 'Class', 'Admission no.', 'Admitted', '']}
              empty={!rows.length}
              emptyLabel="Nobody has been admitted this year yet."
            >
              {rows.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.full_name}</Td>
                  <Td>{s.class_name ? `${s.class_name}-${s.section_name}` : '—'}</Td>
                  <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                  <Td className="text-muted-foreground">{formatDate(s.admission_date)}</Td>
                  <Td>
                    <Button size="sm" variant="secondary"
                      onClick={() => setOpenID(openID === s.id ? null : s.id)}>
                      {openID === s.id ? 'Close' : 'Fee'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {openID && (
          <ChildFee
            studentID={openID}
            mayAsk={mayAsk}
            onChanged={() => qc.invalidateQueries({ queryKey: ['fee-enrolment-roll'] })}
          />
        )}
      </PageBody>
    </>
  )
}

function ChildFee({ studentID, mayAsk, onChanged }: {
  studentID: string
  mayAsk: boolean
  onChanged: () => void
}) {
  const [asking, setAsking] = useState(false)
  const [kind, setKind] = useState('staff_ward')
  const [mode, setMode] = useState<'percent' | 'amount'>('percent')
  const [percent, setPercent] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  const detail = useQuery({
    queryKey: ['student-detail', studentID],
    queryFn: () => api.get<Row & { class_id?: string }>(
      `/api/v1/students/${studentID}/detail`),
  })
  const classID = (detail.data as { class_id?: string } | undefined)?.class_id

  const quote = useQuery({
    queryKey: ['admission-fee', classID],
    enabled: !!classID,
    queryFn: () => api.get<NonNullable<Row['quote']>>(
      `/api/v1/students/fee-preview?class_id=${classID}`),
  })

  const concessions = detail.data?.concessions ?? []
  const pending = concessions.filter((c) => c.status === 'pending')
  const invoices = detail.data?.invoices ?? []

  const ask = useMutation({
    mutationFn: () => api.post('/api/v1/fees/concessions', {
      student_id: studentID,
      kind,
      percent: mode === 'percent' ? percent : '',
      amount_paise: mode === 'amount' ? Math.round(Number(amount) * 100) : undefined,
      reason,
    }),
    onSuccess: () => {
      setAsking(false); setPercent(''); setAmount(''); setReason('')
      detail.refetch(); onChanged()
    },
  })

  const raise = useMutation({
    mutationFn: () => api.post<{ created: number }>('/api/v1/fees/invoices/generate', {
      fee_structure_id: quote.data?.structure_id,
      instalment_no: 1,
      student_id: studentID,
    }),
    onSuccess: () => { detail.refetch(); onChanged() },
  })

  const q = quote.data
  const value = (c: Row['concessions'][number]) =>
    c.percent ? `${c.percent}%` : formatPaise(Number(c.amount_paise || 0))

  return (
    <Card>
      <CardHeader
        title="What this child owes"
        description={q?.has_structure
          ? `${q.structure} — ${formatPaise(q.total_paise)} for the year, ${q.instalments} instalment${q.instalments === 1 ? '' : 's'}.`
          : 'No fee structure covers this class yet, so nothing can be quoted or raised.'}
      />

      <Table
        head={['Asked for', 'Why', 'How much', 'Answer', 'Notes']}
        empty={!concessions.length}
        emptyLabel="No concession has been asked for."
      >
        {concessions.map((c) => (
          <tr key={c.id}>
            <Td className="text-muted-foreground">
              {formatDate(c.raised_on)}
              {c.asked_by && <span className="block text-[12px]">by {c.asked_by}</span>}
            </Td>
            <Td>{c.kind.replace('_', ' ')}</Td>
            <Td className="tabular-nums">{value(c)}</Td>
            <Td>
              {/* A refusal is kept and shown beside the approvals. A table of
                  approvals alone reads as a school that approves everything. */}
              <Badge tone={c.status === 'approved' ? 'success'
                : c.status === 'rejected' ? 'danger' : 'warning'}>
                {c.status}
              </Badge>
              {c.decided_by && (
                <span className="block text-[12px] text-muted-foreground">{c.decided_by}</span>
              )}
            </Td>
            <Td className="text-muted-foreground">{c.decision_note || c.reason || '—'}</Td>
          </tr>
        ))}
      </Table>

      {invoices.length > 0 && (
        <Table head={['Invoice', 'Amount', 'Paid', 'Status']} empty={false}>
          {invoices.map((i) => (
            <tr key={i.invoice_no}>
              <Td className="font-mono text-[12px]">{i.invoice_no}</Td>
              <Td className="tabular-nums">{formatPaise(Number(i.net_paise))}</Td>
              <Td className="tabular-nums">{formatPaise(Number(i.paid_paise))}</Td>
              <Td>{i.status}</Td>
            </tr>
          ))}
        </Table>
      )}

      {mayAsk && (
        <div className="space-y-3 border-t p-4">
          {asking ? (
            <>
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
              <FormNotice error={ask.error} />
              <div className="flex items-center gap-2">
                <Button
                  disabled={ask.isPending || !reason.trim()
                    || (mode === 'percent' ? !percent : !amount)}
                  onClick={() => ask.mutate()}
                >
                  {ask.isPending ? 'Sending…' : 'Send for approval'}
                </Button>
                <Button variant="secondary" onClick={() => setAsking(false)}>Cancel</Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
                Ask for a concession
              </Button>
              <Button
                size="sm"
                /* HELD WHILE ANYTHING IS WAITING. Billing now charges the
                   family in full and leaves the waiver approved and inert an
                   hour later, and the only remedy then is a credit note. */
                disabled={raise.isPending || pending.length > 0 || !q?.has_structure}
                onClick={() => raise.mutate()}
              >
                {raise.isPending ? 'Raising…' : 'Raise the fee'}
              </Button>
              {pending.length > 0 && (
                <span className="text-[12.5px] text-warning">
                  Waiting on the principal. Raising now would charge the full
                  amount, and the concession could not be applied afterwards.
                </span>
              )}
              {raise.isSuccess && (
                <span className="text-[12.5px] text-success">
                  {raise.data.created > 0
                    ? 'Raised. The family can see it and pay in the app.'
                    : 'Already raised for this instalment.'}
                </span>
              )}
              {raise.isError && (
                <span className="text-[12.5px] text-destructive">
                  {raise.error instanceof Error ? raise.error.message : 'Could not raise it'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
