import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BadgeCheck, GraduationCap, Upload, Wallet } from 'lucide-react'
import { api, type List, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Checkbox, Field, FormGrid, FormNotice, Input, Select,
  Textarea, Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { SchemeEditor } from './GovernmentClaims'
import {
  concessionsBase, concessionsKey, inr, toPaise, useSchemes, useAcademicYears,
  AWARD_EXCEPTION, AWARD_STAGE_LABEL,
  type ImportResult, type ScholarshipAward, type ScholarshipImport,
  type DisbursementLine, type ImportReject,
} from './concessions-lib'

/* NSP scholarship reconciliation.

   The National Scholarship Portal pays the student, not the school. The
   school's duties are two: verify the applications on the portal, and — the
   part nobody owns — notice when a sanctioned scholarship never arrives.

   So this screen is the school's own record of what it expects, reconciled
   against the disbursement list the portal publishes. The reconciliation is the
   four ways the two disagree, and they are the first thing on the page:

     sanctioned and never credited    the case that matters, and the reason for
                                      the whole screen
     credited to somebody unknown     a row for a child this school has no
                                      record of applying
     credited, student has left       money reaching a child off the roll
     amount differs                   the portal paid other than the sanction

   Two things this screen deliberately does not do.

   It never shows a bank account number. Where a credit was expected is shown
   as the last four digits, masked by the server; the full number lives in the
   student bank register, behind the finance export permission and an audited
   reveal. This screen has no business with it.

   It does not pretend to talk to NSP. There is no API and no credential. The
   school downloads the portal's disbursement list and uploads the file here.

   Social category is on this screen, and on no other in this feature. An NSP
   pre-matric scholarship for SC students is granted on exactly that field and a
   clerk verifying an application has to see it. It is not on the claims screen,
   not on the loan screen, and not on any dashboard. */

export default function ScholarshipReconciliation() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('finance.fees.write')

  const [schemeId, setSchemeId] = useState('')
  const [stage, setStage] = useState('')
  const [search, setSearch] = useState('')

  const invalidate = () => qc.invalidateQueries({ queryKey: [concessionsKey] })
  /* One mutation per table rather than one per row: the rows are plain <tr>s so
     <Table> can name their cells for a phone, and a plain row cannot hold a
     hook. `variables` says which award is in flight, so only that row's button
     goes down and only that row shows the result. */
  const verify = useMutation({
    mutationFn: (id: string) => api.post(`${concessionsBase}/scholarships/${id}/verify`, {}),
    onSuccess: invalidate,
  })
  const credit = useMutation({
    mutationFn: (id: string) =>
      api.post<{ receipt_no: string; amount_paise: number }>(
        `${concessionsBase}/scholarships/${id}/fee-credit`,
        {},
      ),
    onSuccess: invalidate,
  })

  const awards = useQuery({
    queryKey: [concessionsKey, 'awards', schemeId, stage, search],
    queryFn: () => {
      const qs = new URLSearchParams()
      if (schemeId) qs.set('scheme_id', schemeId)
      if (stage) qs.set('stage', stage)
      if (search) qs.set('q', search)
      return api.get<List<ScholarshipAward>>(`${concessionsBase}/scholarships?${qs}`)
    },
  })
  const schemes = useSchemes('student')

  if (awards.isLoading) return <Loading label="Opening the scholarship register…" />
  if (awards.error) return <ErrorState error={awards.error} />

  const rows = awards.data?.items ?? []
  const stuck = rows.filter((a) => a.exception === 'sanctioned_not_credited')
  const left = rows.filter((a) => a.exception === 'student_left')
  const credited = rows.reduce((n, a) => n + a.credited_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Concessions"
        title="Scholarship reconciliation"
        description="What the portal said each child would get, against what actually reached their account."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat
            label="Sanctioned, never credited"
            value={stuck.length}
            icon={AlertTriangle}
            hint={
              stuck.length
                ? `${inr(stuck.reduce((n, a) => n + (a.sanctioned_paise ?? 0), 0))} owed to children`
                : 'Nothing stuck'
            }
          />
          <Stat
            label="Credited to a child who has left"
            value={left.length}
            hint={left.length ? 'Needs somebody to look' : 'None'}
          />
          <Stat label="Credited this year" value={inr(credited)} icon={Wallet} />
          <Stat
            label="Applications on file"
            value={rows.length}
            icon={GraduationCap}
            hint={`${rows.filter((a) => a.stage === 'applied').length} still waiting on the school`}
          />
        </CellGrid>

        {stuck.length > 0 && (
          <Card>
            <CardHeader
              title="Money the portal owes children of this school"
              description="Sanctioned, and nothing has reached the account. Nobody chases these because everybody assumes the portal has it in hand."
            />
            <Table
              head={['Child', 'Scheme', 'Application', { label: 'Sanctioned', align: 'right' }, 'Where it should land']}
              empty={false}
            >
              {stuck.map((a) => (
                <tr key={a.id}>
                  <Td className="font-medium">
                    {a.student_name}
                    <span className="block text-[12px] font-normal text-muted-foreground">
                      {a.admission_no}
                      {a.class_name ? ` · ${a.class_name}` : ''}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{a.scheme_name}</Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">
                    {a.application_ref ?? '—'}
                  </Td>
                  <Td className="text-right font-medium tabular-nums">
                    {inr(a.sanctioned_paise ?? 0)}
                  </Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">
                    {a.account_masked ?? (
                      <span className="font-sans text-warning">no account registered</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="The register"
            description="Every application the school knows about, and where it has got to."
            action={
              <span className="flex flex-wrap gap-2">
                <Input value={search} onChange={setSearch} placeholder="Name, admission or application no" />
                <Select
                  value={schemeId}
                  onChange={setSchemeId}
                  options={(schemes.data?.items ?? []).map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                  placeholder="Every scheme"
                />
                <Select
                  value={stage}
                  onChange={setStage}
                  options={[
                    { value: '', label: 'Every stage' },
                    { value: 'applied', label: 'Applied' },
                    { value: 'school_verified', label: 'Verified by the school' },
                    { value: 'school_rejected', label: 'School refused' },
                    { value: 'sanctioned', label: 'Sanctioned' },
                    { value: 'credited', label: 'Credited' },
                    { value: 'not_credited', label: 'Not credited' },
                    { value: 'withdrawn', label: 'Withdrawn' },
                  ]}
                />
              </span>
            }
          />
          <Table
            head={[
              'Child', 'Category', 'Scheme', 'Stage',
              { label: 'Sanctioned', align: 'right' },
              { label: 'Credited', align: 'right' },
              'Account', 'Needs a look', '',
            ]}
            empty={rows.length === 0}
            emptyLabel="No applications recorded yet."
          >
            {rows.map((a) =>
              awardRows({
                award: a,
                mayWrite,
                verifying: verify.isPending && verify.variables === a.id,
                crediting: credit.isPending && credit.variables === a.id,
                error: verify.variables === a.id ? verify.error
                  : credit.variables === a.id ? credit.error : null,
                credited: credit.variables === a.id ? credit.data : undefined,
                onVerify: () => verify.mutate(a.id),
                onCredit: () => credit.mutate(a.id),
              }),
            )}
          </Table>
        </Card>

        <ImportPanel mayWrite={mayWrite} />
        {mayWrite && <NewAward />}
      </PageBody>
    </>
  )
}

// --- one application ---------------------------------------------------------

/* An application's two rows, as an array rather than a component.

   <Table> names each cell after its column so a row can stack into a labelled
   card on a phone, and it does that by walking the elements handed to it: a
   component element hides its rows behind a render that has not happened, so
   the walk labels nothing and this nine-column table collapsed into bare
   values under 640px. See labelCells in components/ui.tsx.

   The verify and fee-credit mutations moved up to the table for the same
   reason — a plain row cannot hold a hook — and are scoped back to this row by
   the caller through `variables`. */
function awardRows({
  award, mayWrite, verifying, crediting, error, credited, onVerify, onCredit,
}: {
  award: ScholarshipAward
  mayWrite: boolean
  verifying: boolean
  crediting: boolean
  error: unknown
  credited?: { receipt_no: string; amount_paise: number }
  onVerify: () => void
  onCredit: () => void
}) {
  const ex = award.exception ? AWARD_EXCEPTION[award.exception] : undefined

  return [
    <tr key={award.id}>
      <Td className="font-medium">
        {award.student_name}
        <span className="block text-[12px] font-normal text-muted-foreground">
          {award.admission_no}
          {award.class_name ? ` · ${award.class_name}` : ''}
          {award.student_status !== 'active' && ` · ${award.student_status}`}
        </span>
      </Td>
      {/* Category is here because the eligibility is decided on it. It is
          shown as the portal writes it and nowhere else in this feature. */}
      <Td className="uppercase text-muted-foreground">{award.category ?? '—'}</Td>
      <Td className="text-muted-foreground">
        {award.scheme_name}
        {award.application_ref && (
          <span className="block font-mono text-[12px]">{award.application_ref}</span>
        )}
      </Td>
      <Td className="text-[13px]">{AWARD_STAGE_LABEL[award.stage]}</Td>
      <Td className="text-right tabular-nums">
        {award.sanctioned_paise == null ? '—' : inr(award.sanctioned_paise)}
      </Td>
      <Td className="text-right tabular-nums">
        {award.credited_paise ? inr(award.credited_paise) : '—'}
        {award.credited_on && (
          <span className="block text-[12px] font-normal text-muted-foreground">
            {award.credited_on}
          </span>
        )}
      </Td>
      <Td className="font-mono text-[12px] text-muted-foreground">
        {award.account_masked ?? '—'}
        {award.has_account && !award.is_aadhaar_seeded && (
          <span className="block font-sans">
            <Badge tone="warning">not seeded</Badge>
          </span>
        )}
      </Td>
      <Td>{ex ? <Badge tone={ex.tone}>{ex.label}</Badge> : <span className="text-muted-foreground">—</span>}</Td>
      <Td>
        <span className="flex flex-wrap gap-1.5">
          {mayWrite && (award.stage === 'applied' || award.stage === 'school_rejected') && (
            <ConfirmButton
              confirmLabel="Verify"
              question="The portal relies on this; your name is recorded against it."
              onConfirm={onVerify}
              disabled={verifying}
            >
              <BadgeCheck className="h-3.5 w-3.5" /> Verify
            </ConfirmButton>
          )}
          {mayWrite && award.offsets_fees && award.stage === 'credited' && !award.fee_credited && (
            <ConfirmButton
              confirmLabel="Post it"
              question="A receipt is raised against this child's oldest outstanding dues."
              onConfirm={onCredit}
              disabled={crediting}
            >
              Post to fees
            </ConfirmButton>
          )}
          {award.fee_credited && <Badge tone="success">on the fee ledger</Badge>}
        </span>
      </Td>
    </tr>,
    ex || error || credited ? (
      <tr key={`${award.id}:why`}>
        <Td colSpan={9}>
          {ex && !error && !credited && (
            <p className="text-[13px] text-muted-foreground">{ex.why}</p>
          )}
          <FormNotice
            error={error ?? undefined}
            ok={
              credited
                ? `Receipt ${credited.receipt_no} for ${inr(credited.amount_paise)} posted against this child's dues.`
                : undefined
            }
          />
        </Td>
      </tr>
    ) : null,
  ]
}

// --- importing the portal's list ---------------------------------------------

function ImportPanel({ mayWrite }: { mayWrite: boolean }) {
  const qc = useQueryClient()
  const schemes = useSchemes('student')
  const years = useAcademicYears()

  const [schemeId, setSchemeId] = useState('')
  const [yearId, setYearId] = useState('')
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('')
  const [openImport, setOpenImport] = useState<string | null>(null)

  const history = useQuery({
    queryKey: [concessionsKey, 'imports'],
    queryFn: () => api.get<List<ScholarshipImport>>(`${concessionsBase}/scholarships/imports`),
  })

  const run = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      const { uploadDisbursements } = await import('./concessions-lib')
      return uploadDisbursements(schemeId, yearId, filename || 'disbursements.csv', csv)
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: [concessionsKey] })
      setOpenImport(r.import_id)
    },
  })

  const r = run.data

  return (
    <Card>
      <CardHeader
        title="Import the portal's disbursement list"
        description="A file, because that is what exists. There is no NSP API and nothing here pretends there is — download the list from the portal and upload it."
      />

      {mayWrite && (
        <div className="space-y-5 px-5 py-5">
          <FormGrid>
            <Field label="Scheme" required>
              <Select
                value={schemeId}
                onChange={setSchemeId}
                options={(schemes.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
                placeholder="Choose the scheme"
              />
            </Field>
            <Field label="Academic year" required>
              <Select
                value={yearId}
                onChange={setYearId}
                options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
                placeholder="Choose the year"
              />
            </Field>
          </FormGrid>

          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed py-8 text-center transition-colors hover:bg-accent/40 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
            <Upload className="h-5 w-5 text-muted-foreground" />
            <span className="text-[14px] font-medium">
              {filename || 'Click to choose the disbursement CSV'}
            </span>
            <span className="text-[13px] text-muted-foreground">
              An amount column, and either an application id or an admission number. Column
              names are matched loosely; the rows above the table are ignored.
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                setFilename(f.name)
                const reader = new FileReader()
                reader.onload = () => setCsv(String(reader.result ?? ''))
                reader.readAsText(f)
              }}
            />
          </label>

          <p className="text-[13px] text-muted-foreground">
            If the file carries account numbers, only the last four digits are kept. The full
            number belongs in the student bank register, where revealing one is recorded.
          </p>

          <Button
            disabled={!csv || !schemeId || !yearId || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? 'Reconciling…' : 'Import and reconcile'}
          </Button>
          <FormNotice error={run.error} />

          {r && (
            <div className="rounded-md border px-4 py-3 text-[13px]">
              <p>
                <span className="font-medium">{r.row_count}</span> row(s) read ·{' '}
                <span className="font-medium text-success">{r.matched_count}</span> matched ·{' '}
                <span className="font-medium text-warning">{r.unmatched_count}</span> unmatched ·{' '}
                <span className="font-medium">{r.rejected_count}</span> rejected ·{' '}
                <span className="font-medium tabular-nums">{inr(r.credited_paise)}</span> credited
              </p>
              {Object.keys(r.exceptions).length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {Object.entries(r.exceptions).map(([k, n]) => (
                    <li key={k}>
                      <span className="font-medium">{n}</span>{' '}
                      {AWARD_EXCEPTION[k]?.label ?? k} — {AWARD_EXCEPTION[k]?.why ?? ''}
                    </li>
                  ))}
                </ul>
              )}
              <RejectList rejects={r.rejects} />
            </div>
          )}
        </div>
      )}

      {/* "Nothing imported yet" is a claim about the school's history, and it
          was what a failed request said. */}
      {history.error && <ErrorState error={history.error} />}
      <Table
        head={['File', 'Scheme', 'When', 'Read', 'Matched', 'Unmatched', 'Rejected',
          { label: 'Credited', align: 'right' }, '']}
        empty={(history.data?.items ?? []).length === 0 && !history.error}
        emptyLabel="Nothing imported yet."
      >
        {(history.data?.items ?? []).map((i) => (
          <tr key={i.id}>
            <Td className="font-medium">{i.filename ?? '—'}</Td>
            <Td className="text-muted-foreground">
              {i.scheme_name}
              <span className="block text-[12px]">{i.academic_year}</span>
            </Td>
            <Td className="text-[13px] text-muted-foreground">
              {i.imported_at.slice(0, 16).replace('T', ' ')}
              {i.imported_by && <span className="block text-[12px]">{i.imported_by}</span>}
            </Td>
            <Td>{i.row_count}</Td>
            <Td className="text-success">{i.matched_count}</Td>
            <Td className={i.unmatched_count ? 'text-warning' : undefined}>{i.unmatched_count}</Td>
            <Td>{i.rejected_count}</Td>
            <Td className="text-right tabular-nums">{inr(i.credited_paise)}</Td>
            <Td>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpenImport(openImport === i.id ? null : i.id)}
              >
                {openImport === i.id ? 'Close' : 'Open'}
              </Button>
            </Td>
          </tr>
        ))}
      </Table>

      {openImport && <ImportDetail importId={openImport} mayWrite={mayWrite} />}
    </Card>
  )
}

function RejectList({ rejects }: { rejects: ImportReject[] }) {
  if (!rejects.length) return null
  return (
    <div className="mt-2">
      <p className="font-medium text-warning">{rejects.length} row(s) the parser refused:</p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {rejects.slice(0, 10).map((rj) => (
          <li key={rj.line}>
            line {rj.line}: {rj.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ImportDetail({ importId, mayWrite }: { importId: string; mayWrite: boolean }) {
  const qc = useQueryClient()
  /* The paste boxes and the match call live here, not in each row: the rows are
     plain <tr>s so <Table> can label their cells for a phone, and a plain row
     holds neither state nor a hook. Keyed by line id, so a box belongs to the
     line it was typed against. */
  const [pasted, setPasted] = useState<Record<string, string>>({})
  const match = useMutation({
    mutationFn: (v: { lineId: string; awardId: string }) =>
      api.post(`${concessionsBase}/scholarships/lines/${v.lineId}/match`, { award_id: v.awardId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [concessionsKey] }),
  })

  const q = useQuery({
    queryKey: [concessionsKey, 'import', importId],
    queryFn: () =>
      api.get<{
        import: ScholarshipImport
        lines: DisbursementLine[]
        rejects: ImportReject[]
      }>(`${concessionsBase}/scholarships/imports/${importId}`),
  })

  if (q.isLoading) return <Loading label="Opening the file…" />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data
  if (!d) return null

  return (
    <>
      <CardHeader
        title={`Rows in ${d.import.filename ?? 'the file'}`}
        description="Rows needing a person first. The ones that reconciled are below them."
      />
      <Table
        head={['Line', 'As the file gave it', 'Matched to', { label: 'Amount', align: 'right' },
          'Credited', 'Account', 'Needs a look', '']}
        empty={d.lines.length === 0}
        emptyLabel="The file had no readable rows."
      >
        {d.lines.map((l) =>
          disbursementRow({
            line: l,
            mayWrite,
            awardId: pasted[l.id] ?? '',
            onAwardId: (v) => setPasted({ ...pasted, [l.id]: v }),
            matching: match.isPending && match.variables?.lineId === l.id,
            onMatch: () => match.mutate({ lineId: l.id, awardId: pasted[l.id] ?? '' }),
          }),
        )}
      </Table>
      {d.rejects.length > 0 && (
        <div className="border-t px-5 py-4 text-[13px]">
          <RejectList rejects={d.rejects} />
        </div>
      )}
    </>
  )
}

/* One line of the portal's file. A plain <tr>, for the reason on awardRows. */
function disbursementRow({
  line, mayWrite, awardId, onAwardId, matching, onMatch,
}: {
  line: DisbursementLine
  mayWrite: boolean
  awardId: string
  onAwardId: (v: string) => void
  matching: boolean
  onMatch: () => void
}) {
  const ex = line.exception ? AWARD_EXCEPTION[line.exception] : undefined

  return (
    <tr key={line.id}>
      <Td className="text-muted-foreground">{line.line_no}</Td>
      <Td>
        {line.student_name_given ?? '—'}
        <span className="block font-mono text-[12px] text-muted-foreground">
          {line.application_ref ?? line.admission_no_given ?? ''}
        </span>
      </Td>
      <Td>
        {line.student_name ? (
          <>
            {line.student_name}
            <span className="block text-[12px] text-muted-foreground">
              {line.admission_no} · matched on {line.match_kind.replace('_', ' ')}
            </span>
          </>
        ) : mayWrite ? (
          <span className="flex gap-1.5">
            <Input
              value={awardId}
              onChange={onAwardId}
              placeholder="Paste the application id"
              className="w-52"
              srLabel={`Application id to match line ${line.line_no} against`}
            />
            <Button size="sm" variant="ghost" disabled={!awardId.trim() || matching}
              onClick={onMatch}>
              Match
            </Button>
          </span>
        ) : (
          <span className="text-warning">unmatched</span>
        )}
      </Td>
      <Td className="text-right tabular-nums">{inr(line.amount_paise)}</Td>
      <Td className="text-muted-foreground">{line.credited_on ?? '—'}</Td>
      <Td className="font-mono text-[12px] text-muted-foreground">
        {line.account_last4 ? `••••${line.account_last4}` : '—'}
      </Td>
      <Td>{ex ? <Badge tone={ex.tone}>{ex.label}</Badge> : <span className="text-muted-foreground">—</span>}</Td>
      <Td className="text-[12px] text-muted-foreground">{line.bank_reference ?? ''}</Td>
    </tr>
  )
}

// --- recording an application ------------------------------------------------

function NewAward() {
  const qc = useQueryClient()
  const schemes = useSchemes('student')
  const years = useAcademicYears()

  const [studentQuery, setStudentQuery] = useState('')
  const [studentId, setStudentId] = useState('')
  const [schemeId, setSchemeId] = useState('')
  const [yearId, setYearId] = useState('')
  const [ref, setRef] = useState('')
  const [expected, setExpected] = useState('')
  const [offsets, setOffsets] = useState(false)
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
      api.post(`${concessionsBase}/scholarships`, {
        scheme_id: schemeId,
        student_id: studentId,
        academic_year_id: yearId,
        application_ref: ref,
        stage: 'applied',
        expected_paise: expected ? toPaise(expected) : null,
        offsets_fees: offsets,
        notes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [concessionsKey] })
      setRef('')
      setExpected('')
      setNotes('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Record an application"
        description="What the parent told the school they applied for. The portal is the authority on the outcome; this is the expectation the reconciliation compares against."
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
          <Field label="Scheme" required>
            <Select
              value={schemeId}
              onChange={setSchemeId}
              options={(schemes.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
              placeholder="Choose the scheme"
            />
          </Field>
          <Field label="Academic year" required>
            <Select
              value={yearId}
              onChange={setYearId}
              options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
              placeholder="Choose the year"
            />
          </Field>
          <Field label="Application reference" hint="From the portal's acknowledgement slip.">
            <Input value={ref} onChange={setRef} />
          </Field>
          <Field label="Expected amount (₹)" hint="What the parent believes the scheme pays.">
            <Input value={expected} onChange={setExpected} />
          </Field>
          <Field label="Notes" wide>
            <Textarea value={notes} onChange={setNotes} />
          </Field>
        </FormGrid>

        <Checkbox
          checked={offsets}
          onChange={setOffsets}
          label="This scheme is meant to discharge the school's fee"
          hint="Only tick this where the scheme pays fees rather than reaching the parent as cash. It lets the credit be posted against the child's dues once it arrives."
        />

        <Button
          disabled={save.isPending || !studentId || !schemeId || !yearId}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Record the application'}
        </Button>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Recorded.' : undefined} />
      </div>
      <SchemeEditor paidTo="student" />
    </Card>
  )
}
