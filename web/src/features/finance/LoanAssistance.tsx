import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, FileCheck2, FolderOpen, Info } from 'lucide-react'
import { api, type List, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import {
  concessionsBase, concessionsKey, inr, toPaise, useAcademicYears,
  DOC_KIND_LABEL, LENDER_KIND_LABEL, LOAN_NEXT, LOAN_STATUS_LABEL, LOAN_STATUS_TONE,
  SCHOOL_ISSUES,
  type LoanApplication, type LoanDetail, type LoanDocument, type LoanLender,
  type LoanStatus,
} from './concessions-lib'

/* Education loan assistance.

   A document and status tracker, and deliberately nothing else.

   The school is not a lender. It is not licensed to be one, it carries none of
   the liability of one, and a screen that computed an EMI or scored an
   applicant would make it look like one to a family who does not read the fine
   print. So there is no interest rate anywhere in this feature, no tenure, no
   repayment schedule, no approval by the school, and no ranking of lenders.
   The disclosure below comes from the server rather than being typed here, so
   it survives whatever renders this next.

   What it does is worth having anyway. A family applying for an education loan
   is sent back to the school office four separate times for a fee structure, a
   bonafide certificate, an admission letter and a run of fee receipts — all of
   which the school already holds, and three of which it issues itself. The
   checklist points at those rather than asking for them again.

   The sanctioned and disbursed figures are what the family reported. The lender
   tells the school nothing, and the labels say so rather than implying the
   school has a line to the bank. */

export default function LoanAssistance() {
  const can = useCan()
  const mayWrite = can('finance.fees.write')

  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const apps = useQuery({
    queryKey: [concessionsKey, 'loans', status, search],
    queryFn: () => {
      const qs = new URLSearchParams()
      if (status) qs.set('status', status)
      if (search) qs.set('q', search)
      return api.get<List<LoanApplication>>(`${concessionsBase}/loans/applications?${qs}`)
    },
  })

  if (apps.isLoading) return <Loading label="Opening the tracker…" />
  if (apps.error) return <ErrorState error={apps.error} />

  const rows = apps.data?.items ?? []
  const live = rows.filter((a) =>
    ['enquiry', 'documents_pending', 'submitted_to_lender', 'under_review'].includes(a.status),
  )
  const waitingOnPapers = rows.filter((a) => a.docs_outstanding > 0 && a.status !== 'disbursed')
  const stale = live.filter((a) => a.days_in_status > 21)

  return (
    <>
      <PageHead
        eyebrow="Concessions"
        title="Education loan assistance"
        description="Which papers a lender still wants, and where each parent's application has got to."
        width="wide"
      />
      <PageBody width="wide">
        <Card>
          <div className="flex items-start gap-3 px-5 py-4 text-[13px] text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              The school helps a parent assemble paperwork and records what the parent reports
              back. It is not the lender, does not assess or approve any application, and holds
              no interest rate or repayment schedule. Every figure below is as reported to the
              office.
            </p>
          </div>
        </Card>

        <CellGrid cols={4}>
          <Stat label="Live applications" value={live.length} icon={FolderOpen} />
          <Stat
            label="Waiting on papers"
            value={waitingOnPapers.length}
            icon={FileCheck2}
            hint={waitingOnPapers.length ? 'Some of these the school itself issues' : 'Nothing outstanding'}
          />
          <Stat
            label="Sat still over three weeks"
            value={stale.length}
            hint={stale.length ? 'Worth a telephone call' : 'All moving'}
          />
          <Stat label="Applications on file" value={rows.length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Applications"
            description="Oldest movement first, so the ones nobody has touched come to the top."
            action={
              <span className="flex flex-wrap gap-2">
                <Input value={search} onChange={setSearch} placeholder="Name or admission number" />
                <Select
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: '', label: 'Every status' },
                    ...(Object.keys(LOAN_STATUS_LABEL) as LoanStatus[]).map((k) => ({
                      value: k,
                      label: LOAN_STATUS_LABEL[k],
                    })),
                  ]}
                />
              </span>
            }
          />
          <Table
            head={['Child', 'Lender', 'Opened', { label: 'Sought', align: 'right' },
              'Papers', 'Status', 'Sat there', '']}
            empty={rows.length === 0}
            emptyLabel="No applications yet."
          >
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="font-medium">
                  {a.student_name}
                  <span className="block text-[12px] font-normal text-muted-foreground">
                    {a.admission_no}
                    {a.class_name ? ` · ${a.class_name}` : ''}
                  </span>
                </Td>
                <Td className="text-muted-foreground">
                  {a.lender_name ?? <span className="text-warning">not chosen yet</span>}
                  {a.reference_no && (
                    <span className="block font-mono text-[12px]">{a.reference_no}</span>
                  )}
                </Td>
                <Td className="text-[13px] text-muted-foreground">{a.opened_on}</Td>
                <Td className="text-right tabular-nums">
                  {a.amount_sought_paise ? inr(a.amount_sought_paise) : '—'}
                </Td>
                <Td>
                  {a.docs_outstanding > 0 ? (
                    <Badge tone="warning">
                      {a.docs_outstanding} of {a.docs_total} missing
                    </Badge>
                  ) : (
                    <Badge tone="success">all gathered</Badge>
                  )}
                </Td>
                <Td>
                  <Badge tone={LOAN_STATUS_TONE[a.status]}>{LOAN_STATUS_LABEL[a.status]}</Badge>
                </Td>
                <Td
                  className={
                    a.days_in_status > 21 ? 'text-[13px] text-warning' : 'text-[13px] text-muted-foreground'
                  }
                >
                  {a.days_in_status} days
                </Td>
                <Td>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === a.id ? null : a.id)}>
                    {open === a.id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {open && (
          /* Keyed by the application. StatusPanel inside it holds the lender,
             the reference and the sanctioned and disbursed figures the family
             reported; opening a second application reused them, so one
             family's reported amounts could be recorded against another's. */
          <ApplicationDetail key={open} applicationId={open} mayWrite={mayWrite} />
        )}

        {mayWrite && <NewApplication onCreated={setOpen} />}
        <LendersPanel mayWrite={mayWrite} />
      </PageBody>
    </>
  )
}

// --- one application ---------------------------------------------------------

function ApplicationDetail({
  applicationId, mayWrite,
}: { applicationId: string; mayWrite: boolean }) {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: [concessionsKey] })

  const q = useQuery({
    queryKey: [concessionsKey, 'loan', applicationId],
    queryFn: () => api.get<LoanDetail>(`${concessionsBase}/loans/applications/${applicationId}`),
  })

  if (q.isLoading) return <Loading label="Opening the application…" />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data
  if (!d) return null
  const a = d.application

  return (
    <Card>
      <CardHeader
        title={`${a.student_name} — ${a.lender_name ?? 'no lender chosen'}`}
        description={`Opened ${a.opened_on} · ${LOAN_STATUS_LABEL[a.status]} for ${a.days_in_status} days${a.assisted_by ? ` · helped by ${a.assisted_by}` : ''}`}
      />

      <div className="space-y-4 px-5 py-4">
        <p className="text-[13px] text-muted-foreground">{d.disclosure}</p>

        {(a.sanctioned_amount_paise || a.disbursed_amount_paise) && (
          <div className="rounded-md border px-4 py-3 text-[13px]">
            {a.sanctioned_amount_paise != null && (
              <p>
                Sanctioned, as reported by the parent:{' '}
                <span className="font-medium tabular-nums">{inr(a.sanctioned_amount_paise)}</span>
              </p>
            )}
            {a.disbursed_amount_paise != null && (
              <p>
                Disbursed, as reported:{' '}
                <span className="font-medium tabular-nums">{inr(a.disbursed_amount_paise)}</span>
              </p>
            )}
            {a.outcome_reported_on && (
              <p className="text-muted-foreground">Reported on {a.outcome_reported_on}</p>
            )}
          </div>
        )}

        {a.declined_reason && (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
            Declined: {a.declined_reason}
          </div>
        )}
      </div>

      <CardHeader
        title="What the lender wants"
        description="Missing first. The ones marked as issued by the school are already in the office — a parent should not be sent away for those."
      />
      <Table
        head={['Document', 'Status', 'Provided', 'Where it is', '']}
        empty={d.documents.length === 0}
        emptyLabel="No checklist on this application."
      >
        {d.documents.map((doc) => (
          <DocumentRow
            key={doc.id}
            applicationId={applicationId}
            doc={doc}
            mayWrite={mayWrite}
            onDone={invalidate}
          />
        ))}
      </Table>

      {mayWrite && a.status !== 'disbursed' && (
        <StatusPanel application={a} onDone={invalidate} />
      )}

      <CardHeader title="What has happened" description="So a parent can be told, rather than only where it stands." />
      <Table head={['When', 'Moved to', 'From', 'Note', 'By']} empty={d.events.length === 0}>
        {d.events.map((ev, i) => (
          <tr key={`${ev.happened_at}-${i}`}>
            <Td className="text-[13px] text-muted-foreground">
              {ev.happened_at.slice(0, 16).replace('T', ' ')}
            </Td>
            <Td className="font-medium">
              {LOAN_STATUS_LABEL[ev.to_status as LoanStatus] ?? ev.to_status}
            </Td>
            <Td className="text-muted-foreground">
              {ev.from_status
                ? (LOAN_STATUS_LABEL[ev.from_status as LoanStatus] ?? ev.from_status)
                : '—'}
            </Td>
            <Td className="text-[13px]">{ev.note ?? '—'}</Td>
            <Td className="text-muted-foreground">{ev.actor ?? '—'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function DocumentRow({
  applicationId, doc, mayWrite, onDone,
}: { applicationId: string; doc: LoanDocument; mayWrite: boolean; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)

  const save = useMutation({
    mutationFn: (patch: Partial<LoanDocument>) =>
      api.post(`${concessionsBase}/loans/applications/${applicationId}/documents`, {
        id: doc.id,
        doc_kind: doc.doc_kind,
        label: doc.label ?? '',
        status: patch.status ?? doc.status,
        waived_reason: patch.status === 'waived' ? reason : (doc.waived_reason ?? ''),
        student_document_id: doc.student_document_id ?? '',
        issued_certificate_id: doc.issued_certificate_id ?? '',
        provided_on: doc.provided_on ?? '',
        notes: doc.notes ?? '',
      }),
    onSuccess: () => {
      setAsking(false)
      onDone()
    },
  })

  const tone =
    doc.status === 'required' ? 'warning' : doc.status === 'waived' ? 'neutral' : 'success'

  return (
    <>
      <tr>
        <Td className="font-medium">
          {doc.label || DOC_KIND_LABEL[doc.doc_kind] || doc.doc_kind}
          {SCHOOL_ISSUES.has(doc.doc_kind) && (
            <span className="block text-[12px] font-normal text-muted-foreground">
              the school issues this
            </span>
          )}
        </Td>
        <Td>
          <Badge tone={tone}>{doc.status}</Badge>
        </Td>
        <Td className="text-[13px] text-muted-foreground">{doc.provided_on ?? '—'}</Td>
        <Td className="text-[13px] text-muted-foreground">
          {doc.certificate_serial
            ? `certificate ${doc.certificate_serial}`
            : doc.student_document_id
              ? 'on the student file'
              : doc.waived_reason
                ? `waived: ${doc.waived_reason}`
                : '—'}
        </Td>
        <Td>
          {mayWrite && (
            <span className="flex flex-wrap gap-1.5">
              {doc.status === 'required' && (
                <>
                  <Button size="sm" variant="ghost" disabled={save.isPending}
                    onClick={() => save.mutate({ status: 'provided' })}>
                    Got it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
                    Not needed
                  </Button>
                </>
              )}
              {doc.status === 'provided' && (
                <Button size="sm" variant="ghost" disabled={save.isPending}
                  onClick={() => save.mutate({ status: 'submitted' })}>
                  Given to the lender
                </Button>
              )}
              {doc.status === 'submitted' && (
                <Button size="sm" variant="ghost" disabled={save.isPending}
                  onClick={() => save.mutate({ status: 'verified' })}>
                  Lender accepted it
                </Button>
              )}
            </span>
          )}
        </Td>
      </tr>
      {(asking || save.error) && (
        <tr>
          <Td colSpan={5}>
            {asking && (
              <span className="flex flex-wrap items-center gap-2">
                <Input
                  value={reason}
                  onChange={setReason}
                  placeholder="Why is this one not needed?"
                  className="w-80"
                />
                <Button size="sm" disabled={!reason || save.isPending}
                  onClick={() => save.mutate({ status: 'waived' })}>
                  Waive it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                  Cancel
                </Button>
              </span>
            )}
            <FormNotice error={save.error} />
          </Td>
        </tr>
      )}
    </>
  )
}

function StatusPanel({
  application, onDone,
}: { application: LoanApplication; onDone: () => void }) {
  const lenders = useQuery({
    queryKey: [concessionsKey, 'lenders'],
    queryFn: () => api.get<List<LoanLender>>(`${concessionsBase}/loans/lenders?active=true`),
  })

  const [next, setNext] = useState('')
  const [note, setNote] = useState('')
  const [lenderId, setLenderId] = useState(application.lender_id ?? '')
  const [ref, setRef] = useState('')
  const [sanctioned, setSanctioned] = useState('')
  const [disbursed, setDisbursed] = useState('')
  const [declined, setDeclined] = useState('')
  const [reportedOn, setReportedOn] = useState('')

  const run = useMutation({
    mutationFn: () =>
      api.post(`${concessionsBase}/loans/applications/${application.id}/status`, {
        status: next,
        note,
        lender_id: lenderId,
        reference_no: ref,
        sanctioned_amount_paise: sanctioned ? toPaise(sanctioned) : null,
        disbursed_amount_paise: disbursed ? toPaise(disbursed) : null,
        declined_reason: declined,
        outcome_reported_on: reportedOn,
      }),
    onSuccess: () => {
      setNote('')
      setNext('')
      onDone()
    },
  })

  const options = LOAN_NEXT[application.status] ?? []

  return (
    <div className="space-y-5 border-t px-5 py-5">
      <div>
        <h4 className="text-[14px] font-semibold">Move it on</h4>
        <p className="mt-1 text-[13px] text-muted-foreground">
          The ladder only goes forward — a parent told &ldquo;under review&rdquo; after being
          told &ldquo;declined&rdquo; has been told nothing. A declined application can be
          reopened to gather more papers, because parents do try again.
        </p>
      </div>
      {options.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          This application is finished; nothing follows the money reaching the parent.
        </p>
      ) : (
        <>
          <FormGrid>
            <Field label="Move to" required>
              <Select
                value={next}
                onChange={setNext}
                options={options.map((o) => ({ value: o, label: LOAN_STATUS_LABEL[o] }))}
                placeholder="Choose"
              />
            </Field>
            <Field label="Lender" hint="Needed before anything can be with a lender.">
              <Select
                value={lenderId}
                onChange={setLenderId}
                options={(lenders.data?.items ?? []).map((l) => ({
                  value: l.id,
                  label: l.branch ? `${l.name} — ${l.branch}` : l.name,
                }))}
                placeholder="Choose the lender"
              />
            </Field>
            {next === 'submitted_to_lender' && (
              <Field label="Lender's application number">
                <Input value={ref} onChange={setRef} />
              </Field>
            )}
            {next === 'sanctioned' && (
              <Field label="Sanctioned, as the parent reported (₹)" required>
                <Input value={sanctioned} onChange={setSanctioned} />
              </Field>
            )}
            {next === 'disbursed' && (
              <Field label="Disbursed, as the parent reported (₹)" required>
                <Input value={disbursed} onChange={setDisbursed} />
              </Field>
            )}
            {next === 'declined' && (
              <Field label="Reason the parent was given" required wide>
                <Input value={declined} onChange={setDeclined} />
              </Field>
            )}
            {(next === 'sanctioned' || next === 'disbursed' || next === 'declined') && (
              <Field label="Reported to the office on">
                <Input value={reportedOn} onChange={setReportedOn} type="date" />
              </Field>
            )}
            <Field label="Note" wide>
              <Textarea value={note} onChange={setNote} />
            </Field>
          </FormGrid>
          <Button disabled={!next || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Recording…' : 'Record the move'}
          </Button>
          <FormNotice error={run.error} />
        </>
      )}
    </div>
  )
}

// --- opening one -------------------------------------------------------------

function NewApplication({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const years = useAcademicYears()
  const lenders = useQuery({
    queryKey: [concessionsKey, 'lenders'],
    queryFn: () => api.get<List<LoanLender>>(`${concessionsBase}/loans/lenders?active=true`),
  })

  const [studentQuery, setStudentQuery] = useState('')
  const [studentId, setStudentId] = useState('')
  const [lenderId, setLenderId] = useState('')
  const [yearId, setYearId] = useState('')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')

  const students = useQuery({
    queryKey: ['students', 'picker', studentQuery],
    queryFn: () =>
      api.get<Page<Student>>(
        `/api/v1/students?limit=20${studentQuery ? `&q=${encodeURIComponent(studentQuery)}` : ''}`,
      ),
    enabled: studentQuery.length > 1,
  })

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${concessionsBase}/loans/applications`, {
        student_id: studentId,
        lender_id: lenderId,
        academic_year_id: yearId,
        amount_sought_paise: amount ? toPaise(amount) : null,
        notes,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: [concessionsKey] })
      setAmount('')
      setNotes('')
      onCreated(r.id)
    },
  })

  return (
    <Card>
      <CardHeader
        title="Open an application"
        description="The standard document checklist is issued with it, so the office has a list to work from rather than remembering."
      />
      <div className="space-y-5 px-5 py-5">
        <FormGrid>
          <Field label="Find the child" required>
            <Input value={studentQuery} onChange={setStudentQuery} placeholder="Name or admission number" />
          </Field>
          <Field label="Child">
            <Select
              value={studentId}
              onChange={setStudentId}
              options={(students.data?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.full_name} — ${s.admission_no}`,
              }))}
              placeholder={studentQuery.length > 1 ? 'Choose the child' : 'Search first'}
            />
          </Field>
          <Field label="Lender" hint="Leave blank if the parent has not chosen one yet.">
            <Select
              value={lenderId}
              onChange={setLenderId}
              options={(lenders.data?.items ?? []).map((l) => ({
                value: l.id,
                label: l.branch ? `${l.name} — ${l.branch}` : l.name,
              }))}
              placeholder="Not chosen yet"
            />
          </Field>
          <Field label="Academic year">
            <Select
              value={yearId}
              onChange={setYearId}
              options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
              placeholder="Choose the year"
            />
          </Field>
          <Field
            label="Amount the parent is seeking (₹)"
            hint="What the parent says they need. Not an assessment and not an offer."
          >
            <Input value={amount} onChange={setAmount} />
          </Field>
          <Field label="Notes" wide>
            <Textarea value={notes} onChange={setNotes} />
          </Field>
        </FormGrid>
        <Button disabled={save.isPending || !studentId} onClick={() => save.mutate()}>
          {save.isPending ? 'Opening…' : 'Open the application'}
        </Button>
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}

// --- the lender list ---------------------------------------------------------

function LendersPanel({ mayWrite }: { mayWrite: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('public_sector_bank')
  const [branch, setBranch] = useState('')
  const [contact, setContact] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')

  const lenders = useQuery({
    queryKey: [concessionsKey, 'lenders'],
    queryFn: () => api.get<List<LoanLender>>(`${concessionsBase}/loans/lenders`),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post(`${concessionsBase}/loans/lenders`, {
        name, lender_kind: kind, branch,
        contact_name: contact, contact_phone: phone, contact_email: email,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [concessionsKey] })
      setName('')
      setBranch('')
      setContact('')
      setPhone('')
      setEmail('')
      setOpen(false)
    },
  })

  return (
    <Card>
      <CardHeader
        title="Lenders the school has dealt with"
        description="A contact list, in the order a parent would find useful. No rates and no ranking — the school is not recommending a product."
        action={
          mayWrite && !open ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <Building2 className="h-3.5 w-3.5" /> Add a lender
            </Button>
          ) : undefined
        }
      />
      <Table
        head={['Lender', 'Kind', 'Who to ask for', 'Live applications', '']}
        empty={(lenders.data?.items ?? []).length === 0}
        emptyLabel="No lenders on the list yet."
      >
        {(lenders.data?.items ?? []).map((l) => (
          <tr key={l.id}>
            <Td className="font-medium">
              {l.name}
              {l.branch && (
                <span className="block text-[12px] font-normal text-muted-foreground">
                  {l.branch}
                </span>
              )}
            </Td>
            <Td className="text-muted-foreground">{LENDER_KIND_LABEL[l.lender_kind] ?? l.lender_kind}</Td>
            <Td className="text-[13px] text-muted-foreground">
              {l.contact_name ?? '—'}
              {(l.contact_phone || l.contact_email) && (
                <span className="block text-[12px]">
                  {[l.contact_phone, l.contact_email].filter(Boolean).join(' · ')}
                </span>
              )}
            </Td>
            <Td>{l.open_count}</Td>
            <Td>{!l.is_active && <Badge tone="neutral">no longer used</Badge>}</Td>
          </tr>
        ))}
      </Table>

      {open && (
        <div className="space-y-5 border-t px-5 py-5">
          <FormGrid>
            <Field label="Name" required>
              <Input value={name} onChange={setName} placeholder="State Bank of India" />
            </Field>
            <Field label="Kind">
              <Select
                value={kind}
                onChange={setKind}
                options={Object.entries(LENDER_KIND_LABEL).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Field>
            <Field label="Branch">
              <Input value={branch} onChange={setBranch} />
            </Field>
            <Field label="Who to ask for">
              <Input value={contact} onChange={setContact} />
            </Field>
            <Field label="Telephone">
              <Input value={phone} onChange={setPhone} />
            </Field>
            <Field label="Email">
              <Input value={email} onChange={setEmail} type="email" />
            </Field>
          </FormGrid>
          <span className="flex gap-2">
            <Button disabled={save.isPending || !name} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Add the lender'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </span>
          <FormNotice error={save.error} />
        </div>
      )}
    </Card>
  )
}
