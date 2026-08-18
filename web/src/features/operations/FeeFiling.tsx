import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Textarea, Loading, ErrorState, FormNotice, EmptyState, PrintButton,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'
import {
  adminOpsBase, inr, toPaise, FILING_STATUS,
  type FeeFiling as Filing, type FilingLine, type FilingDocument, type VarianceRow,
} from './admin-ops-lib'

/* Fee regulatory committee filing.
 *
 * Several states require a private unaided school to file its fee structure
 * with a district or state committee, support it with accounts, and then
 * charge only what was approved. The last clause is the exposure: charging
 * above the approved figure makes the school liable to refund the difference
 * to every parent, and nobody finds out until an inspection.
 *
 * So the screen has four jobs and the fourth is the one worth opening it for:
 *
 *   Compile — from a fee structure version, not the live structure. The live
 *   structure keeps moving; what was filed must not.
 *
 *   Attach — the audited accounts, through the ordinary upload path.
 *
 *   Submit — which freezes an immutable copy. A trigger, not this screen,
 *   refuses every later change to it.
 *
 *   Compare — what the school is actually charging, taken from invoice_lines
 *   rather than from the fee book, against what the committee approved. The
 *   fee book is what the school meant to charge; the invoice is what it did,
 *   and they part company the first time somebody adds a head mid-year.
 */

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  draft: 'neutral',
  submitted: 'info',
  approved: 'success',
  approved_with_modification: 'warning',
  rejected: 'danger',
  withdrawn: 'neutral',
}

const VERDICT_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  as_approved: 'success',
  under_approved: 'neutral',
  over_approved: 'danger',
  not_filed: 'danger',
}

const VERDICT_LABEL: Record<string, string> = {
  as_approved: 'as approved',
  under_approved: 'below approved',
  over_approved: 'above approved',
  not_filed: 'never filed',
}

export default function FeeFiling() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('finance.fees.write')

  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const list = useQuery({
    queryKey: ['admin-ops', 'fee-filings'],
    queryFn: () => api.get<List<Filing>>(`${adminOpsBase}/fee-filings`),
  })

  const done = (m: string) => {
    setNote(m)
    qc.invalidateQueries({ queryKey: ['admin-ops', 'fee-filings'] })
  }

  const items = list.data?.items ?? []
  const live = items.filter((f) => f.status === 'submitted')
  const decided = items.filter(
    (f) => f.status === 'approved' || f.status === 'approved_with_modification',
  )

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Fee regulatory committee filing"
        description="The fee structure put to the district or state committee, the accounts filed with it, the committee's decision, and a check on whether the school is charging what was approved."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Filings" value={items.length} />
          <Stat label="Awaiting a decision" value={live.length} />
          <Stat label="Approved" value={decided.length} />
          <Stat
            label="Approved value"
            value={inr(decided.reduce((n, f) => n + (f.approved_total_paise ?? 0), 0))}
            hint="Across all approved filings"
          />
        </CellGrid>

        <FormNotice ok={note} />

        <Card>
          <CardHeader
            title="Filings"
            description="One live filing per academic year. Refiling after a rejection is the normal path."
            action={mayWrite ? (
              <Button size="sm" onClick={() => setOpen(open === 'new' ? null : 'new')}>
                {open === 'new' ? 'Cancel' : 'Compile a filing'}
              </Button>
            ) : undefined}
          />
          {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
            <Table
              head={['No.', 'Committee', 'Year', 'Filed on', 'Proposed', 'Approved', 'Status', '']}
              empty={!items.length}
              emptyLabel="Nothing filed yet."
            >
              {items.map((f) => (
                <tr key={f.id}>
                  <Td className="font-mono text-[12px]">{f.filing_no}</Td>
                  <Td>
                    {f.committee_name}
                    <span className="block text-[12px] text-muted-foreground">
                      {f.committee_level}{f.state ? ` — ${f.state}` : ''}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{f.academic_year ?? '—'}</Td>
                  <Td className="text-muted-foreground">{f.submitted_on ?? '—'}</Td>
                  <Td className="tabular-nums">{inr(f.proposed_total_paise)}</Td>
                  <Td className="tabular-nums">
                    {f.approved_total_paise === undefined || f.approved_total_paise === null
                      ? '—'
                      : inr(f.approved_total_paise)}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[f.status] ?? 'neutral'}>
                      {FILING_STATUS[f.status] ?? f.status}
                    </Badge>
                    <span className="block text-[12px] text-muted-foreground">
                      {f.line_count} line{f.line_count === 1 ? '' : 's'}, {f.document_count} doc
                      {f.document_count === 1 ? '' : 's'}
                    </span>
                  </Td>
                  <Td>
                    <Button size="sm" variant="secondary"
                      onClick={() => setOpen(open === f.id ? null : f.id)}>
                      {open === f.id ? 'Close' : 'Open'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {open === 'new' && mayWrite && (
          <CompileForm onSaved={(m) => { setOpen(null); done(m) }} />
        )}
        {open && open !== 'new' && (
          <FilingDetail id={open} mayWrite={mayWrite} onDone={done} />
        )}
      </PageBody>
    </>
  )
}

interface StructureVersion {
  id: string
  version_no: number
  status: string
  effective_from: string
}

interface VersionedStructure {
  id: string
  name: string
  class_name?: string
  active_version_id?: string
  active_version_no?: number
}

function CompileForm({ onSaved }: { onSaved: (m: string) => void }) {
  const [structureID, setStructureID] = useState('')
  const [versionID, setVersionID] = useState('')
  const [committee, setCommittee] = useState('')
  const [level, setLevel] = useState('district')
  const [state, setState] = useState('')
  const [yearID, setYearID] = useState('')

  const structures = useQuery({
    queryKey: ['fee-engine', 'structures'],
    queryFn: () => api.get<List<VersionedStructure>>('/api/v1/finance/fee-engine/structures'),
  })

  const versions = useQuery({
    queryKey: ['fee-engine', 'versions', structureID],
    enabled: !!structureID,
    queryFn: () => api.get<{ items: StructureVersion[] }>(
      `/api/v1/finance/fee-engine/structures/${structureID}/versions`),
  })

  const years = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => api.get<List<{ id: string; name: string; is_current: boolean }>>(
      '/api/v1/academics/years'),
  })

  const save = useMutation({
    mutationFn: () => api.post<{ filing_no?: string; lines?: number }>(`${adminOpsBase}/fee-filings`, {
      committee_name: committee.trim(),
      committee_level: level,
      state: state.trim(),
      academic_year_id: yearID,
      fee_structure_version_id: versionID,
    }),
    onSuccess: (r: { filing_no?: string; lines?: number }) =>
      onSaved(`${r.filing_no} compiled from ${r.lines ?? 0} fee lines. Attach the accounts, then file it.`),
  })

  return (
    <Card>
      <CardHeader
        title="Compile a filing"
        description="From a fee structure version, so what was filed stays retrievable after the live fee book moves on."
      />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Committee</span>
          <Input value={committee} onChange={setCommittee}
            placeholder="District Fee Regulatory Committee, Pune" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Level</span>
          <Select value={level} onChange={setLevel} options={[
            { value: 'district', label: 'District' },
            { value: 'division', label: 'Division' },
            { value: 'state', label: 'State' },
          ]} />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">State</span>
          <Input value={state} onChange={setState} placeholder="Maharashtra" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Academic year — the variance check needs it</span>
          <Select value={yearID} onChange={setYearID} options={[
            { value: '', label: 'Choose a year…' },
            ...(years.data?.items ?? []).map((y) => ({
              value: y.id, label: y.is_current ? `${y.name} (current)` : y.name,
            })),
          ]} />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Fee structure</span>
          <Select value={structureID} onChange={(v) => { setStructureID(v); setVersionID('') }}
            options={[
              { value: '', label: 'Choose a structure…' },
              ...(structures.data?.items ?? []).map((s) => ({
                value: s.id, label: s.class_name ? `${s.name} — ${s.class_name}` : s.name,
              })),
            ]} />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Version being filed</span>
          <Select value={versionID} onChange={setVersionID} options={[
            { value: '', label: structureID ? 'Choose a version…' : 'Pick a structure first' },
            ...(versions.data?.items ?? []).map((v) => ({
              value: v.id,
              label: `v${v.version_no} — ${v.status} — from ${v.effective_from}`,
            })),
          ]} />
        </label>
      </div>
      <div className="border-t px-5 py-4">
        <FormNotice error={save.error} />
        <Button disabled={!committee.trim() || !versionID || !yearID || save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? 'Compiling…' : 'Compile'}
        </Button>
        <p className="mt-2 text-[12px] text-muted-foreground">
          The amounts are copied from the version, not referenced — so a later revision cannot
          quietly change what this filing says was proposed.
        </p>
      </div>
    </Card>
  )
}

function FilingDetail({ id, mayWrite, onDone }: {
  id: string; mayWrite: boolean; onDone: (m: string) => void
}) {
  const [tab, setTab] = useState<'filing' | 'variance'>('filing')
  const [docType, setDocType] = useState('audited_accounts')
  const [fileID, setFileID] = useState('')
  const [ackNo, setAckNo] = useState('')
  const [decision, setDecision] = useState('approved')
  const [decisionNote, setDecisionNote] = useState('')
  const [approvedAmt, setApprovedAmt] = useState<Record<string, string>>({})

  const detail = useQuery({
    queryKey: ['admin-ops', 'fee-filings', id],
    queryFn: () => api.get<{
      filing: Filing; lines: FilingLine[]; documents: FilingDocument[]
      decision_note?: string; notes?: string; filed_snapshot: unknown
    }>(`${adminOpsBase}/fee-filings/${id}`),
  })

  const attach = useMutation({
    mutationFn: () => api.post(`${adminOpsBase}/fee-filings/${id}/documents`,
      { file_id: fileID.trim(), doc_type: docType }),
    onSuccess: () => { setFileID(''); onDone('Document attached.') },
  })

  const submit = useMutation({
    mutationFn: () => api.post(`${adminOpsBase}/fee-filings/${id}/submit`,
      { acknowledgement_no: ackNo.trim() }),
    onSuccess: () => onDone('Filed. An immutable copy of exactly what was submitted is now stored.'),
  })

  const decide = useMutation({
    mutationFn: () => api.post(`${adminOpsBase}/fee-filings/${id}/decide`, {
      decision,
      note: decisionNote.trim(),
      approved_lines: Object.entries(approvedAmt)
        .filter(([, v]) => v.trim() !== '')
        .map(([line_id, v]) => ({ line_id, approved_paise: toPaise(v) })),
    }),
    onSuccess: () => onDone("Decision recorded. The variance check now has something to compare against."),
  })

  if (detail.isLoading) return <Card><Loading /></Card>
  if (detail.error) return <Card><ErrorState error={detail.error} /></Card>

  const f = detail.data!.filing
  const lines = detail.data!.lines
  const docs = detail.data!.documents
  const isDraft = f.status === 'draft'
  const awaiting = f.status === 'submitted'

  return (
    <>
      <div className="flex gap-2">
        <Button size="sm" variant={tab === 'filing' ? 'primary' : 'secondary'}
          onClick={() => setTab('filing')}>The filing</Button>
        <Button size="sm" variant={tab === 'variance' ? 'primary' : 'secondary'}
          onClick={() => setTab('variance')}>What we are charging</Button>
        <PrintButton label="Print" />
      </div>

      {tab === 'variance' ? <VariancePanel id={id} /> : (
        <>
          <Card>
            <CardHeader
              title={`${f.filing_no} — ${f.committee_name}`}
              description={f.fee_structure
                ? `Filed from ${f.fee_structure}, version ${f.version_no}. ${FILING_STATUS[f.status] ?? f.status}.`
                : FILING_STATUS[f.status] ?? f.status}
            />
            <Table head={['Class', 'Fee head', 'Instalment', 'Proposed', 'Approved', 'Committee note']}
              empty={!lines.length}>
              {lines.map((l) => (
                <tr key={l.id}>
                  <Td>{l.class ?? <span className="text-muted-foreground">all classes</span>}</Td>
                  <Td className="font-medium">{l.fee_head}</Td>
                  <Td className="tabular-nums text-muted-foreground">{l.instalment_no}</Td>
                  <Td className="tabular-nums">{inr(l.proposed_paise)}</Td>
                  <Td className="tabular-nums">
                    {awaiting && mayWrite ? (
                      <Input value={approvedAmt[l.id] ?? ''} placeholder="as filed"
                        onChange={(v) => setApprovedAmt((a) => ({ ...a, [l.id]: v }))} />
                    ) : l.approved_paise === undefined || l.approved_paise === null ? (
                      '—'
                    ) : (
                      <span className={cn(l.approved_paise < l.proposed_paise && 'text-warning')}>
                        {inr(l.approved_paise)}
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground text-[12px]">{l.modification_note ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card>
            <CardHeader
              title="Supporting accounts"
              description="Uploaded through the ordinary file path, then named here. Every committee asks for these and a filing without them stops at the counter."
            />
            <Table head={['Document', 'File', 'Attached', 'By']} empty={!docs.length}
              emptyLabel="Nothing attached yet.">
              {docs.map((d) => (
                <tr key={d.id}>
                  <Td className="font-medium">{d.doc_type.replace(/_/g, ' ')}</Td>
                  <Td className="text-muted-foreground">{d.original_name}</Td>
                  <Td className="text-muted-foreground">{d.attached_on}</Td>
                  <Td className="text-muted-foreground">{d.attached_by ?? '—'}</Td>
                </tr>
              ))}
            </Table>
            {isDraft && mayWrite && (
              <div className="grid gap-3 border-t p-5 sm:grid-cols-[1fr_1fr_auto]">
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">What it is</span>
                  <Select value={docType} onChange={setDocType} options={[
                    { value: 'audited_accounts', label: 'Audited accounts' },
                    { value: 'balance_sheet', label: 'Balance sheet' },
                    { value: 'income_expenditure', label: 'Income and expenditure' },
                    { value: 'salary_statement', label: 'Salary statement' },
                    { value: 'fee_proposal', label: 'Fee proposal' },
                    { value: 'other', label: 'Other' },
                  ]} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Uploaded file id</span>
                  <Input value={fileID} onChange={setFileID} placeholder="From the upload step" />
                </label>
                <div className="flex items-end">
                  <Button size="sm" disabled={!fileID.trim() || attach.isPending}
                    onClick={() => attach.mutate()}>Attach</Button>
                </div>
                <div className="sm:col-span-3">
                  <FormNotice error={attach.error} />
                </div>
              </div>
            )}
          </Card>

          {isDraft && mayWrite && (
            <Card>
              <CardHeader
                title="File it"
                description="Submitting freezes an immutable copy. After this, what was filed cannot be changed — only the committee's reply can be recorded."
              />
              <div className="space-y-3 p-5">
                <FormNotice error={submit.error} />
                <label className="flex max-w-sm flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Acknowledgement number, if given</span>
                  <Input value={ackNo} onChange={setAckNo} />
                </label>
                <Button disabled={submit.isPending || !docs.length} onClick={() => submit.mutate()}>
                  {submit.isPending ? 'Filing…' : 'File with the committee'}
                </Button>
                {!docs.length && (
                  <p className="text-[12px] text-muted-foreground">
                    Attach the supporting accounts first.
                  </p>
                )}
              </div>
            </Card>
          )}

          {awaiting && mayWrite && (
            <Card>
              <CardHeader
                title="Record the decision"
                description="Fill in the approved column above only where the committee changed something. Anything left blank is taken as approved as filed."
              />
              <div className="space-y-3 p-5">
                <FormNotice error={decide.error} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    <span className="text-muted-foreground">Outcome</span>
                    <Select value={decision} onChange={setDecision} options={[
                      { value: 'approved', label: 'Approved as filed' },
                      { value: 'approved_with_modification', label: 'Approved with modification' },
                      { value: 'rejected', label: 'Rejected' },
                      { value: 'withdrawn', label: 'Withdrawn by the school' },
                    ]} />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    <span className="text-muted-foreground">Acknowledgement number</span>
                    <Input value={ackNo} onChange={setAckNo} />
                  </label>
                </div>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">
                    What the committee said — required for a modification or a rejection
                  </span>
                  <Textarea value={decisionNote} onChange={setDecisionNote} rows={2} />
                </label>
                <Button disabled={decide.isPending} onClick={() => decide.mutate()}>
                  {decide.isPending ? 'Recording…' : 'Record the decision'}
                </Button>
              </div>
            </Card>
          )}

          {detail.data!.decision_note && (
            <Card>
              <CardHeader title="The committee's decision" />
              <div className="px-5 py-4 text-[13px]">
                {detail.data!.decision_note}
                {f.decided_on && (
                  <span className="block text-[12px] text-muted-foreground">
                    Decided {f.decided_on}
                  </span>
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  )
}

function VariancePanel({ id }: { id: string }) {
  const v = useQuery({
    queryKey: ['admin-ops', 'fee-filings', id, 'variance'],
    queryFn: () => api.get<{
      filing: { filing_no: string; status: string; academic_year?: string }
      rows: VarianceRow[]
      over_approved: number
      never_filed: number
      exposure_paise: number
      summary: string
      basis: string
    }>(`${adminOpsBase}/fee-filings/${id}/variance`),
  })

  if (v.isLoading) return <Card><Loading /></Card>
  if (v.error) return <Card><ErrorState error={v.error} /></Card>

  const d = v.data!
  const problems = d.rows.filter(
    (r) => r.verdict === 'over_approved' || r.verdict === 'not_filed',
  )

  return (
    <>
      <CellGrid cols={3}>
        <Stat label="Above the approved fee" value={d.over_approved} />
        <Stat label="Never put to the committee" value={d.never_filed} />
        <Stat label="Refund exposure" value={inr(d.exposure_paise)}
          hint={d.exposure_paise ? 'If refunds are ordered' : 'Nothing at risk'} />
      </CellGrid>

      <Card>
        <CardHeader
          title="Approved against actually charged"
          description={d.summary}
        />
        {!d.rows.length ? (
          <EmptyState
            title="Nothing billed for this year yet"
            body="Once invoices are raised, this compares every fee head against what the committee allowed."
          />
        ) : (
          <Table
            head={['Class', 'Fee head', 'Inst.', 'Approved', 'Charged', 'Students', 'Difference', 'Exposure', '']}
          >
            {[...d.rows]
              .sort((a, b) => b.exposure_paise - a.exposure_paise)
              .map((r, i) => (
                <tr key={i}>
                  <Td>{r.class ?? <span className="text-muted-foreground">unassigned</span>}</Td>
                  <Td className="font-medium">{r.fee_head}</Td>
                  <Td className="tabular-nums text-muted-foreground">{r.instalment_no}</Td>
                  <Td className="tabular-nums">
                    {r.approved_paise === undefined || r.approved_paise === null
                      ? <span className="text-destructive">not filed</span>
                      : inr(r.approved_paise)}
                  </Td>
                  <Td className="tabular-nums">{inr(r.charged_paise)}</Td>
                  <Td className="tabular-nums text-muted-foreground">{r.students}</Td>
                  <Td className={cn('tabular-nums', r.variance_paise > 0 && 'font-medium text-destructive')}>
                    {r.variance_paise === 0 ? '—' : inr(r.variance_paise)}
                  </Td>
                  <Td className={cn('tabular-nums', r.exposure_paise > 0 && 'font-medium text-destructive')}>
                    {r.exposure_paise === 0 ? '—' : inr(r.exposure_paise)}
                  </Td>
                  <Td>
                    <Badge tone={VERDICT_TONE[r.verdict] ?? 'neutral'}>
                      {VERDICT_LABEL[r.verdict] ?? r.verdict}
                    </Badge>
                  </Td>
                </tr>
              ))}
          </Table>
        )}
        <div className="border-t px-5 py-4 text-[12px] text-muted-foreground">{d.basis}</div>
      </Card>

      {problems.length > 0 && (
        <Card>
          <CardHeader
            title="What to do about it"
            description="Each of these is a refund the school could be ordered to make, per student, for the year."
          />
          <div className="space-y-2 px-5 py-4 text-[13px]">
            {d.over_approved > 0 && (
              <p>
                <strong>{d.over_approved} head{d.over_approved === 1 ? '' : 's'} billed above the
                approved amount.</strong> Either correct the fee structure and re-raise, or go back
                to the committee with a revised proposal before the year closes.
              </p>
            )}
            {d.never_filed > 0 && (
              <p>
                <strong>{d.never_filed} head{d.never_filed === 1 ? '' : 's'} being charged were
                never put to the committee.</strong> This is the easiest exposure to acquire — a
                head added mid-year by somebody who did not know a filing existed — and the whole
                amount is at risk, not just a difference.
              </p>
            )}
          </div>
        </Card>
      )}
    </>
  )
}
