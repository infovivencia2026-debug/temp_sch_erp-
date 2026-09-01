import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, FormGrid, Field as FormField, Select, FormNotice,
  Table, Td, Badge, Button, Input, Loading, EmptyState,
} from '@/components/ui'
import { Field } from '@/components/RecordShell'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { formatPaise, formatDate } from '@/lib/utils'

/* The depth behind Student 360's tabs.

   Kept out of StudentProfile.tsx, which was already the longest screen in the
   product before any of this. Every component here is a pure view over one
   slice of GET /students/{id}/detail; none of them fetch, so the seven tabs
   share one round trip rather than firing a query each as somebody clicks. */

export interface Detail {
  subject_marks: { exam: string; subject: string; marks?: string; max?: string; grade?: string; absent: boolean; on?: string; approved?: boolean }[]
  fee_heads: { head: string; charged_paise?: string; paid_paise?: string }[]
  payments: { receipt_no: string; paid_on: string; amount_paise: string; mode: string; reference: string; status: string }[]
  documents: { id: string; doc_type: string; file_id: string; uploaded_on: string; verified: boolean; verified_by: string; notes: string; filename: string; content_type: string }[]
  leave: { from: string; to: string; type: string; reason: string; status: string; applied_by: string; decision_note: string; days: string }[]
  enrolment_history: { year: string; class: string; section: string; roll_no?: string; status: string; from: string; remarks: string; promoted: boolean }[]
  transport_crew: { route: string; vehicle: string; driver: string; driver_phone: string; attendant: string; attendant_phone: string }[]
  activities: { id: string; name: string; category: string; schedule: string; fee_paise: string; status: string; enrolled_on: string; invoice_status: string; invoice_no: string; due_paise: string }[]
  class_id?: string
  co_scholastic: { area_id: string; area: string; grade: string; remark: string; term: string; graded_by: string; graded_on: string }[]
}

/* MARKS BY SUBJECT.

   The Results table gave the aggregate — percentage, grade, rank — which is
   what a certificate carries and not what a parent asks about. "How is she
   doing in Maths" was unanswerable on the child's own record; somebody had to
   open the exam module and find the section again.

   Grouped by exam, newest first: a mark means nothing without the paper it
   came from. */
export function SubjectMarks({ rows, loading }: {
  rows: Detail['subject_marks']
  loading: boolean
}) {
  const byExam = new Map<string, Detail['subject_marks']>()
  for (const r of rows) {
    const list = byExam.get(r.exam) ?? []
    list.push(r)
    byExam.set(r.exam, list)
  }
  if (loading) return <Card><Loading /></Card>
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader title="Subject by subject" />
        <div className="p-6">
          <EmptyState
            title="No marks entered yet"
            body="Marks appear here as soon as a subject teacher enters them, whether or not they have been signed off."
          />
        </div>
      </Card>
    )
  }
  return (
    <>
      {[...byExam.entries()].map(([exam, list]) => {
        const got = list.reduce((a, x) => a + Number(x.marks ?? 0), 0)
        const max = list.reduce((a, x) => a + Number(x.max ?? 0), 0)
        return (
          <Card key={exam}>
            <CardHeader
              title={exam}
              description={max > 0
                ? `${got} of ${max} · ${((got / max) * 100).toFixed(1)}%`
                : undefined}
            />
            <Table head={['Subject', 'Marks', 'Out of', 'Grade', 'Standing']} empty={false}>
              {list.map((x, i) => (
                <tr key={`${x.subject}-${i}`}>
                  <Td className="font-medium">{x.subject}</Td>
                  <Td className="tabular-nums">
                    {x.absent ? <Badge tone="warning">absent</Badge> : (x.marks ?? '—')}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{x.max ?? '—'}</Td>
                  <Td>{x.grade ? <Badge tone="primary">{x.grade}</Badge> : '—'}</Td>
                  {/* SAID, NOT HIDDEN. A mark nobody has signed off can still
                      change, and a teacher reading their own section needs the
                      figure they typed this morning — but anyone quoting it to
                      a parent should know which kind it is. */}
                  <Td>
                    {x.approved
                      ? <Badge tone="success">signed off</Badge>
                      : <Badge tone="warning">provisional</Badge>}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )
      })}
    </>
  )
}

/* THE BILL AS A FAMILY READS IT.

   Invoices are how a school raises money; "tuition, transport, exam" is how a
   parent understands it. Paid is apportioned across an invoice's heads in
   proportion to what each is worth — a payment lands on an invoice, not on a
   head, and there is no honest way to say which head a part-payment settled.
   The screen says so rather than leaving somebody to work it out. */
export function FeeLedger({ heads }: { heads: Detail['fee_heads'] }) {
  if (heads.length === 0) return null
  return (
    <Card>
      <CardHeader
        title="What the fees are for"
        description="Paid is spread across an invoice's heads in proportion — a payment settles a bill, not a particular line of it."
      />
      <Table head={['Fee head', 'Charged', 'Paid', 'Balance', 'Status']} empty={false}>
        {heads.map((h) => {
          const charged = Number(h.charged_paise ?? 0)
          const paid = Number(h.paid_paise ?? 0)
          const due = charged - paid
          return (
            <tr key={h.head}>
              <Td className="font-medium">{h.head}</Td>
              <Td className="tabular-nums">{formatPaise(charged)}</Td>
              <Td className="tabular-nums">{formatPaise(paid)}</Td>
              <Td className="tabular-nums">{formatPaise(due)}</Td>
              <Td>
                <Badge tone={due <= 0 ? 'success' : paid > 0 ? 'warning' : 'neutral'}>
                  {due <= 0 ? 'paid' : paid > 0 ? 'part paid' : 'unpaid'}
                </Badge>
              </Td>
            </tr>
          )
        })}
      </Table>
    </Card>
  )
}

/* HOW THE MONEY ARRIVED.

   The mode and the reference are exactly what a family quotes when they say
   they have already paid, and neither was anywhere on this record — so the
   office had to open the fee module and search the child again to check a
   transaction id a parent was reading down the telephone. */
export function Receipts({ rows }: { rows: Detail['payments'] }) {
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader title="Receipts" description="Every payment received for this child." />
      <Table head={['Receipt', 'Date', 'Amount', 'How', 'Reference', '']} empty={false}>
        {rows.map((x, i) => (
          <tr key={`${x.receipt_no}-${i}`}>
            <Td className="font-mono text-[12px]">{x.receipt_no || '—'}</Td>
            <Td className="text-muted-foreground">{formatDate(x.paid_on)}</Td>
            <Td className="tabular-nums">{formatPaise(Number(x.amount_paise))}</Td>
            <Td>{x.mode}</Td>
            <Td className="font-mono text-[12px] text-muted-foreground">{x.reference || '—'}</Td>
            <Td>{x.status !== 'success' && <Badge tone="danger">{x.status}</Badge>}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

/* The papers a school asks for, as suggestions rather than a fixed list.

   Schools ask for different things, and a dropdown of six that does not
   include "caste certificate" is a dropdown somebody works around by
   mislabelling something else — which is worse than free text, because it
   looks tidy and is wrong. */
const DOC_SUGGESTIONS = [
  'Birth certificate', 'Aadhaar card', 'Transfer certificate',
  'Previous report card', 'Caste certificate', 'Income certificate',
  'Medical fitness certificate', 'Passport photograph',
]

/* WHAT THE FAMILY HANDED IN.

   student_documents has held the birth certificate and the Aadhaar scan since
   the baseline and appeared on no screen anywhere, so the question this tab is
   actually opened for — "have we got their birth certificate" — could not be
   answered from the child's own record. */
export function StudentDocuments({ studentID, rows, mayEdit, onChanged }: {
  studentID: string
  rows: Detail['documents']
  mayEdit: boolean
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState('')
  const [file, setFile] = useState<UploadedFile | null>(null)
  const [notes, setNotes] = useState('')

  const save = useMutation({
    mutationFn: () => api.post(`/api/v1/students/${studentID}/documents`, {
      doc_type: kind, file_id: file?.file_id, notes,
    }),
    onSuccess: () => {
      setAdding(false)
      setKind('')
      setFile(null)
      setNotes('')
      onChanged()
    },
  })
  const verify = useMutation({
    mutationFn: (v: { id: string; verified: boolean }) =>
      api.post(`/api/v1/students/${studentID}/documents/${v.id}/verify`,
        { verified: v.verified }),
    onSuccess: onChanged,
  })
  const remove = useMutation({
    mutationFn: (docID: string) =>
      api.del(`/api/v1/students/${studentID}/documents/${docID}`),
    onSuccess: onChanged,
  })

  return (
    <Card>
      <CardHeader
        title="Documents on file"
        description="What the family handed in — the scans the office holds for this child."
        action={mayEdit ? (
          <Button size="sm" variant={adding ? 'secondary' : 'primary'}
            onClick={() => setAdding(!adding)}>
            {adding ? 'Close' : 'Add a document'}
          </Button>
        ) : undefined}
      />
      {adding && mayEdit && (
        <div className="space-y-3 border-b bg-muted/20 p-4">
          <FormGrid>
            <FormField label="What is it" required>
              <Select
                value={DOC_SUGGESTIONS.includes(kind) ? kind : ''}
                onChange={setKind}
                placeholder="Choose one, or type your own beside it"
                options={DOC_SUGGESTIONS.map((d) => ({ value: d, label: d }))}
              />
            </FormField>
            <FormField label="Or something else">
              <Input value={kind} onChange={setKind} placeholder="e.g. Migration certificate" />
            </FormField>
          </FormGrid>
          <FilePicker
            value={file}
            onChange={setFile}
            purpose="student_document"
            label={file ? 'Choose a different file' : 'Choose the scan'}
            hint="A PDF or a photograph of the document."
          />
          <FormField label="Note" hint="Optional — anything the office should know about this copy">
            <Input value={notes} onChange={setNotes} />
          </FormField>
          <FormNotice error={save.error} />
          <Button
            disabled={!kind.trim() || !file || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Add it'}
          </Button>
        </div>
      )}
      <Table
        head={['Document', 'Added', 'Checked', 'Note', '']}
        empty={!rows.length}
        emptyLabel="Nothing on file for this child."
      >
        {rows.map((d) => (
          <tr key={d.id}>
            <Td className="font-medium">
              {d.doc_type}
              {d.filename && (
                <span className="block text-[12px] font-normal text-muted-foreground">
                  {d.filename}
                </span>
              )}
            </Td>
            <Td className="text-muted-foreground">{formatDate(d.uploaded_on)}</Td>
            <Td>
              {/* Checked is a PERSON saying they looked at it, so it names the
                  person. A green tick nobody is accountable for is what makes
                  an inspection go badly. */}
              {d.verified
                ? <Badge tone="success">{d.verified_by ? `by ${d.verified_by}` : 'checked'}</Badge>
                : <Badge tone="warning">not checked</Badge>}
            </Td>
            <Td className="text-muted-foreground">{d.notes || '—'}</Td>
            <Td>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`/api/v1/files/${d.file_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] text-primary"
                >
                  View
                </a>
                {mayEdit && (
                  <>
                    <Button size="sm" variant="ghost"
                      disabled={verify.isPending}
                      onClick={() => verify.mutate({ id: d.id, verified: !d.verified })}>
                      {d.verified ? 'Un-check' : 'Mark checked'}
                    </Button>
                    <Button size="sm" variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(d.id)}>
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

/* LEAVE THE FAMILY ASKED FOR.

   Distinct from an absence, and the distinction is the point. A child marked
   absent is one the register did not find; a child on approved leave is one
   the school agreed could be away. A parent looking at 88% wants to know which
   of the twelve days were which. */
export function LeaveHistory({ rows }: { rows: Detail['leave'] }) {
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader title="Leave asked for" description="What the family applied for, and what the school said." />
      <Table head={['Days', 'Kind', 'Reason', 'Asked by', 'Answer']} empty={false}>
        {rows.map((l, i) => (
          <tr key={`${l.from}-${i}`}>
            <Td>
              {formatDate(l.from)}
              {l.to && l.to !== l.from ? ` — ${formatDate(l.to)}` : ''}
              <span className="block text-[12px] text-muted-foreground">
                {l.days} day{l.days === '1' ? '' : 's'}
              </span>
            </Td>
            <Td>{l.type || '—'}</Td>
            <Td className="text-muted-foreground">{l.reason || '—'}</Td>
            <Td className="text-muted-foreground">{l.applied_by || '—'}</Td>
            <Td>
              <Badge tone={l.status === 'approved' ? 'success'
                : l.status === 'rejected' ? 'danger' : 'warning'}>
                {l.status}
              </Badge>
              {l.decision_note && (
                <span className="block text-[12px] text-muted-foreground">{l.decision_note}</span>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

/* WHO IS ON THE BUS.

   The question at four o'clock when a bus is late and nobody can find the
   child. Both names were one join away from a table this record already read,
   and the front desk was sending parents to the transport module for a phone
   number. */
export function TransportCrew({ rows }: { rows: Detail['transport_crew'] }) {
  const withCrew = rows.filter((r) => r.driver || r.attendant)
  if (withCrew.length === 0) return null
  return (
    <Card>
      <CardHeader title="Who is on the bus" description="For the afternoon a bus is late." />
      <dl className="divide-y text-[14px]">
        {withCrew.map((c, i) => (
          <div key={i}>
            <Field k="Route" v={[c.route, c.vehicle].filter(Boolean).join(' · ')} />
            <Field k="Driver" v={c.driver} />
            <Field k="Driver phone" v={c.driver_phone} />
            <Field k="Attendant" v={c.attendant} />
            <Field k="Attendant phone" v={c.attendant_phone} />
          </div>
        ))}
      </dl>
    </Card>
  )
}

/* CLUBS, COACHING AND ELECTIVES — and what each one cost.

   The half of school life the product did not hold. The register was a
   notebook in the coordinator's bag and the money was cash against a list, so
   the child's record said nothing about the thing they spend four hours a week
   doing, and the school collected the fee by asking.

   Enrolling in a paid activity raises a real invoice, so the fee status here
   is the actual bill — not a flag somebody has to keep in step with the
   ledger. "Paid" means the finance module says paid. */
export function Activities({ studentID, rows, catalogue, mayEdit, onChanged }: {
  studentID: string
  rows: Detail['activities']
  catalogue: { id: string; name: string; category: string; schedule?: string; fee_paise: number; capacity: number; enrolled: number; is_active: boolean }[]
  mayEdit: boolean
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState('')
  const [waive, setWaive] = useState(false)

  const join = useMutation({
    mutationFn: () => api.post(`/api/v1/students/${studentID}/activities`,
      { activity_id: pick, waive_fee: waive }),
    onSuccess: () => { setAdding(false); setPick(''); setWaive(false); onChanged() },
  })
  const leave = useMutation({
    mutationFn: (enrolID: string) =>
      api.post(`/api/v1/students/${studentID}/activities/${enrolID}/leave`, {}),
    onSuccess: onChanged,
  })

  // Already in it, or wound up — neither belongs in a list of things to join.
  const live = new Set(rows.filter((x) => x.status === 'enrolled').map((x) => x.name))
  const joinable = catalogue.filter((a) => a.is_active && !live.has(a.name))
  const chosen = catalogue.find((a) => a.id === pick)

  return (
    <Card>
      <CardHeader
        title="Activities and electives"
        description="Clubs and coaching this child is enrolled in. A paid activity raises a bill the family can pay on their own fees page."
        action={mayEdit ? (
          <Button size="sm" variant={adding ? 'secondary' : 'primary'}
            onClick={() => setAdding(!adding)}>
            {adding ? 'Close' : 'Enrol in an activity'}
          </Button>
        ) : undefined}
      />
      {adding && mayEdit && (
        <div className="space-y-3 border-b bg-muted/20 p-4">
          {catalogue.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No activities have been set up yet — add them under Academics → Activities.
            </p>
          ) : (
            <>
              <FormField label="Which activity" required>
                <Select
                  value={pick}
                  onChange={setPick}
                  placeholder="Choose one"
                  options={joinable.map((a) => ({
                    value: a.id,
                    label: `${a.name} — ${a.category}`
                      + (a.fee_paise ? ` · ${formatPaise(a.fee_paise)}` : ' · free')
                      + (a.capacity ? ` · ${a.enrolled}/${a.capacity}` : ''),
                  }))}
                />
              </FormField>
              {chosen && chosen.fee_paise > 0 && (
                <div className="rounded-lg border bg-background p-3 text-[13px]">
                  <p>
                    This raises a bill for{' '}
                    <span className="font-medium">{formatPaise(chosen.fee_paise)}</span>,
                    due in a fortnight. The family is told, and can pay it on their
                    own fees page.
                  </p>
                  {/* A school that lets a child in free needs to say so at the
                      moment of enrolling, not correct a bill afterwards. */}
                  <label className="mt-2 flex items-center gap-2">
                    <input type="checkbox" checked={waive}
                      onChange={(e) => setWaive(e.target.checked)} />
                    Waive the fee for this child — raise no bill
                  </label>
                </div>
              )}
              <FormNotice error={join.error} />
              <Button disabled={!pick || join.isPending} onClick={() => join.mutate()}>
                {join.isPending ? 'Enrolling…' : 'Enrol'}
              </Button>
            </>
          )}
        </div>
      )}
      <Table
        head={['Activity', 'Category', 'Schedule', 'Fee', 'Status', '']}
        empty={!rows.length}
        emptyLabel="Not enrolled in any activity."
      >
        {rows.map((a) => {
          const fee = Number(a.fee_paise ?? 0)
          const due = Number(a.due_paise ?? 0)
          return (
            <tr key={a.id}>
              <Td className="font-medium">{a.name}</Td>
              <Td className="text-muted-foreground">{a.category}</Td>
              <Td className="text-muted-foreground">{a.schedule || '—'}</Td>
              <Td className="tabular-nums">{fee > 0 ? formatPaise(fee) : 'free'}</Td>
              <Td>
                {/* The fee status is the INVOICE's status, not a flag kept in
                    step by hand. "Paid" here means finance says paid. */}
                {a.status !== 'enrolled' ? (
                  <Badge tone="neutral">left</Badge>
                ) : fee === 0 ? (
                  <Badge tone="success">enrolled</Badge>
                ) : a.invoice_status === 'paid' || due <= 0 ? (
                  <Badge tone="success">paid</Badge>
                ) : a.invoice_status === 'cancelled' ? (
                  <Badge tone="neutral">cancelled</Badge>
                ) : (
                  <Badge tone="warning">{formatPaise(due)} due</Badge>
                )}
                {a.invoice_no && (
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    {a.invoice_no}
                  </span>
                )}
              </Td>
              <Td>
                {mayEdit && a.status === 'enrolled' && (
                  <Button size="sm" variant="ghost" disabled={leave.isPending}
                    onClick={() => leave.mutate(a.id)}>
                    Leave
                  </Button>
                )}
              </Td>
            </tr>
          )
        })}
      </Table>
    </Card>
  )
}

/* Art, games and discipline — the half of a report card with no marks.

   Every board asks for it and the product had nowhere to put it, so a school
   graded these on paper, typed them into the card at the end of term, and kept
   no record: ask what a child got for Discipline last year and the answer was
   in a cupboard.

   EVERY AREA IS LISTED, graded or not. A table showing only what has been
   filled in is a table nobody can add to, and the ungraded areas are exactly
   the ones somebody has come here to deal with.

   The grade is free text against whatever the school grades in — A/B/C,
   Excellent, 5 — because co-scholastic assessment is not arithmetic, and a
   number invites somebody to average it into a percentage. */
export function CoScholastic({ studentID, rows, mayEdit, onChanged }: {
  studentID: string
  rows: { area_id: string; area: string; grade: string; remark: string; term: string; graded_by: string; graded_on: string }[]
  mayEdit: boolean
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [grade, setGrade] = useState('')
  const [remark, setRemark] = useState('')

  const save = useMutation({
    mutationFn: (v: { area_id: string; grade: string; remark: string }) =>
      api.post(`/api/v1/students/${studentID}/co-scholastic`, v),
    onSuccess: () => { setEditing(null); onChanged() },
  })

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader title="Art, games and discipline" />
        <div className="p-6">
          <EmptyState
            title="No areas set up"
            body="Add the areas this school grades under Academics — work education, art, physical education, discipline."
          />
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Art, games and discipline"
        description="Graded, not marked. These do not count towards any percentage."
      />
      <Table head={['Area', 'Grade', 'Remark', 'Graded by', '']} empty={false}>
        {rows.map((r) => (
          <tr key={r.area_id}>
            <Td className="font-medium">{r.area}</Td>
            <Td>
              {editing === r.area_id ? (
                <Input className="w-24" value={grade} onChange={setGrade} placeholder="A" />
              ) : r.grade ? (
                <Badge tone="primary">{r.grade}</Badge>
              ) : (
                <span className="text-muted-foreground">not graded</span>
              )}
            </Td>
            <Td className="text-muted-foreground">
              {editing === r.area_id ? (
                <Input value={remark} onChange={setRemark} placeholder="Optional" />
              ) : (r.remark || '—')}
            </Td>
            <Td className="text-muted-foreground">
              {r.graded_by || '—'}
              {r.graded_on && (
                <span className="block text-[12px]">{formatDate(r.graded_on)}</span>
              )}
            </Td>
            <Td>
              {mayEdit && (editing === r.area_id ? (
                <span className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={save.isPending}
                    onClick={() => save.mutate({ area_id: r.area_id, grade, remark })}>
                    Save
                  </Button>
                  {/* An empty grade removes it, which is how one entered
                      against the wrong child is taken back. There is no other
                      control for that, and a wrong grade nobody can delete is
                      one somebody works around by writing a second. */}
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost"
                  onClick={() => {
                    setEditing(r.area_id)
                    setGrade(r.grade)
                    setRemark(r.remark)
                  }}>
                  {r.grade ? 'Change' : 'Grade'}
                </Button>
              ))}
            </Td>
          </tr>
        ))}
      </Table>
      <FormNotice error={save.error} />
    </Card>
  )
}
