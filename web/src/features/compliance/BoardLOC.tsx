import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, Lock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Loading,
  ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

/* The List of Candidates, and the reason it is worth a screen.

   The export is one button. What the page is actually for is the refusal list:
   which candidates the board will bounce, and why, while there is still time to
   fix them. So the validation report is the largest thing here and the export
   sits next to it, not the other way round. */

interface Submission {
  id: string
  academic_year_id: string
  board: string
  exam_name: string
  stage?: string
  title: string
  fee_per_candidate_paise: number
  status: string
  candidate_count: number
  blocker_count: number
  warning_count: number
  validated_at?: string
  filed_at?: string
  filed_by?: string
  board_ack_no?: string
  notes?: string
  created_at: string
}

interface Candidate {
  id: string
  serial_no: number
  candidate_name?: string
  admission_no?: string
  class_label?: string
  date_of_birth?: string
  father_name?: string
  mother_name?: string
  group_code?: string
  subjects: string[]
  fee_paid_paise: number
  has_photo: boolean
  has_signature: boolean
  registration_no?: string
  hall_ticket_no?: string
}

interface Issue {
  registration_id?: string
  candidate_name?: string
  admission_no?: string
  severity: string
  code: string
  field?: string
  message: string
}

interface Detail {
  submission: Submission
  candidates: Candidate[]
  issues: Issue[]
  frozen: boolean
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'warning',
  filed: 'success',
  cancelled: 'neutral',
}

const STAGES = [
  { value: '', label: 'Any stage' },
  { value: 'ssc', label: 'SSC (Class X)' },
  { value: 'inter_first_year', label: 'Intermediate first year' },
  { value: 'inter_second_year', label: 'Intermediate second year' },
]

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export default function BoardLOC() {
  const qc = useQueryClient()
  /* Reading an LOC is admin.reports.read; building, revalidating and filing one
     are academics.exams.write (statutory.go:86-92). The screen offered all
     three to a reader and answered with a bare 403. */
  const can = useCan()
  const mayFile = can('academics.exams.write')
  const [selected, setSelected] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [form, setForm] = useState({
    board: 'BSE Telangana',
    exam_name: 'SSC Public Examination',
    stage: 'ssc',
    title: '',
    fee: '',
  })
  const [ack, setAck] = useState('')

  const list = useQuery({
    queryKey: ['loc-submissions'],
    queryFn: () => api.get<List<Submission>>('/api/v1/statutory/loc/submissions'),
  })

  const current = selected ?? list.data?.items[0]?.id ?? null

  const detail = useQuery({
    queryKey: ['loc-detail', current],
    queryFn: () => api.get<Detail>(`/api/v1/statutory/loc/submissions/${current}`),
    enabled: !!current,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['loc-submissions'] })
    qc.invalidateQueries({ queryKey: ['loc-detail'] })
  }

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/statutory/loc/submissions', {
        board: form.board,
        exam_name: form.exam_name,
        stage: form.stage || undefined,
        title: form.title || undefined,
        fee_per_candidate_paise: Math.round(Number(form.fee || 0) * 100),
      }),
    onSuccess: (r) => {
      setSelected(r.id)
      refresh()
    },
  })

  const validate = useMutation({
    mutationFn: () => api.post(`/api/v1/statutory/loc/submissions/${current}/validate`),
    onSuccess: refresh,
  })

  const file = useMutation({
    mutationFn: (force: boolean) =>
      api.post(`/api/v1/statutory/loc/submissions/${current}/file`, {
        board_ack_no: ack || undefined,
        force,
      }),
    onSuccess: () => {
      setAck('')
      refresh()
    },
  })

  const d = detail.data
  const blockers = d?.issues.filter((i) => i.severity === 'blocker') ?? []
  const warnings = d?.issues.filter((i) => i.severity === 'warning') ?? []
  /* A candidate is submittable when nothing blocking is recorded against them.

     Keyed on the admission number, and only on a real one. `admission_no ?? ''`
     put the empty string in the set the moment any blocker was not attributable
     to a named candidate — and then every candidate without an admission number
     matched it, so "candidates with a problem" listed children who had none.
     A blocker nobody can be matched to still has to be visible, so it pulls in
     the candidates who have no number rather than nobody at all. */
  const blockedNumbers = new Set(
    blockers.map((i) => i.admission_no).filter((a): a is string => !!a),
  )
  const unattributedBlocker = blockers.some((i) => !i.admission_no)
  const shown = showAll
    ? d?.candidates ?? []
    : (d?.candidates ?? []).filter((c) =>
        c.admission_no ? blockedNumbers.has(c.admission_no) : unattributedBlocker,
      )

  return (
    <>
      <PageHead
        eyebrow="Boards & accreditation"
        title="Board exam List of Candidates"
        description="Build the LOC from the board roll, see exactly who would be rejected and why, then file it. A filed list is frozen — what went to the board stays readable however the roll is corrected afterwards."
        width="wide"
        actions={
          current && d ? (
            <a href={`/api/v1/statutory/loc/submissions/${current}/export`} download>
              <Button variant="secondary">
                <Download className="h-4 w-4" /> Export in board format
              </Button>
            </a>
          ) : null
        }
      />
      <PageBody width="wide">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : (
          <>
            {!list.data?.items.length ? (
              <Card>
                <CardHeader
                  title="Start a List of Candidates"
                  description="Candidates are read from the board roll you already registered. Nothing is duplicated here."
                />
                <div className="px-5 pb-5">
                  <NewForm form={form} setForm={setForm} create={create} mayFile={mayFile} />
                </div>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader title="Lists" description={`${list.data.items.length} filing(s)`} />
                  <Table
                    head={['Title', 'Board', 'Stage', 'Candidates', 'Blockers', 'Status', 'Filed', '']}
                    empty={!list.data.items.length}
                  >
                    {list.data.items.map((s) => (
                      <tr key={s.id} className={s.id === current ? 'bg-accent/40' : undefined}>
                        <Td className="font-medium">{s.title}</Td>
                        <Td>{s.board}</Td>
                        <Td>{s.stage?.replace(/_/g, ' ') ?? '—'}</Td>
                        <Td className="tabular-nums">{s.candidate_count}</Td>
                        <Td className="tabular-nums">
                          {s.blocker_count ? (
                            <span className="text-destructive">{s.blocker_count}</span>
                          ) : (
                            '—'
                          )}
                        </Td>
                        <Td>
                          <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{s.status}</Badge>
                        </Td>
                        <Td>{s.filed_at ? formatDate(s.filed_at) : '—'}</Td>
                        <Td>
                          <Button
                            size="sm"
                            variant="ghost"
                            /* The acknowledgement number belongs to the list it
                               was typed against. Opening another one used to
                               carry it across, and it is written onto a filed
                               record that then freezes. */
                            onClick={() => { setSelected(s.id); setAck('') }}
                          >
                            Open
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </Card>

                <Card>
                  <CardHeader title="Start another list" />
                  <div className="px-5 pb-5">
                    <NewForm form={form} setForm={setForm} create={create} mayFile={mayFile} />
                  </div>
                </Card>
              </>
            )}

            {detail.isLoading && current ? (
              <Loading label="Reading the roll…" />
            ) : detail.error ? (
              <ErrorState error={detail.error} />
            ) : d ? (
              <>
                <CellGrid cols={4}>
                  <Stat label="Candidates" value={d.submission.candidate_count} />
                  <Stat
                    label="Would be rejected"
                    value={blockers.length}
                    delta={{
                      value: blockers.length ? 'Fix before filing' : 'Clean',
                      positive: blockers.length === 0,
                    }}
                  />
                  <Stat label="Warnings" value={warnings.length} />
                  <Stat
                    label="Fee per candidate"
                    value={rupees(d.submission.fee_per_candidate_paise)}
                  />
                </CellGrid>

                {d.frozen && (
                  <Card>
                    <div className="flex items-start gap-3 px-5 py-4">
                      <Lock className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <div className="text-[13px]">
                        <div className="font-medium">
                          Filed{d.submission.filed_at ? ` on ${formatDate(d.submission.filed_at)}` : ''}
                          {d.submission.filed_by ? ` by ${d.submission.filed_by}` : ''}
                          {d.submission.board_ack_no
                            ? ` · acknowledgement ${d.submission.board_ack_no}`
                            : ''}
                        </div>
                        <div className="text-muted-foreground">
                          This is what the board holds. Correcting a candidate now changes the
                          roll, not this list — raise an amendment with the board instead.
                        </div>
                      </div>
                    </div>
                  </Card>
                )}

                <Card>
                  <CardHeader
                    title="Why candidates would be rejected"
                    description={
                      blockers.length
                        ? `${blockers.length} blocker(s) across ${new Set(blockers.map((b) => b.admission_no)).size} candidate(s)`
                        : 'Every candidate on this list is submittable.'
                    }
                    action={
                      !d.frozen && mayFile ? (
                        <Button
                          variant="secondary"
                          disabled={validate.isPending}
                          onClick={() => validate.mutate()}
                        >
                          {validate.isPending ? 'Re-reading the roll…' : 'Revalidate'}
                        </Button>
                      ) : null
                    }
                  />
                  {!d.issues.length ? (
                    <EmptyState
                      title="Nothing outstanding"
                      body="Every candidate has a name, a date of birth, both parents' names, a photograph, a signature, a valid subject combination and their fee paid."
                    />
                  ) : (
                    <Table head={['Candidate', 'Admission no.', 'Severity', 'Field', 'What the board will do']}>
                      {d.issues.map((i, n) => (
                        <tr key={`${i.admission_no}-${i.code}-${n}`}>
                          <Td className="font-medium">{i.candidate_name ?? '—'}</Td>
                          <Td className="font-mono text-[12px]">{i.admission_no ?? '—'}</Td>
                          <Td>
                            <Badge tone={i.severity === 'blocker' ? 'danger' : 'warning'}>
                              {i.severity}
                            </Badge>
                          </Td>
                          <Td className="font-mono text-[12px]">{i.field ?? '—'}</Td>
                          <Td className="max-w-lg text-[13px]">{i.message}</Td>
                        </tr>
                      ))}
                    </Table>
                  )}
                  <FormNotice error={validate.error} />
                </Card>

                <Card>
                  <CardHeader
                    title={showAll ? 'Every candidate' : 'Candidates with a problem'}
                    description={`${shown.length} of ${d.candidates.length}`}
                    action={
                      <Button variant="secondary" onClick={() => setShowAll((v) => !v)}>
                        {showAll ? 'Show only problems' : 'Show all candidates'}
                      </Button>
                    }
                  />
                  <Table
                    head={[
                      'S.No', 'Candidate', 'Admission no.', 'Class', 'DOB', "Father's name",
                      'Group', 'Subjects', 'Fee paid', 'Photo', 'Signature',
                    ]}
                    empty={!shown.length}
                    emptyLabel={
                      showAll ? 'No candidates on this list.' : 'No candidate has a problem.'
                    }
                  >
                    {shown.map((c) => (
                      <tr key={c.id}>
                        <Td className="tabular-nums">{c.serial_no}</Td>
                        <Td className="font-medium">{c.candidate_name ?? '—'}</Td>
                        <Td className="font-mono text-[12px]">{c.admission_no ?? '—'}</Td>
                        <Td>{c.class_label ?? '—'}</Td>
                        <Td>{c.date_of_birth ? formatDate(c.date_of_birth) : '—'}</Td>
                        <Td>{c.father_name ?? '—'}</Td>
                        <Td>{c.group_code ?? '—'}</Td>
                        <Td className="max-w-xs text-[13px]">
                          {c.subjects.length ? c.subjects.join(', ') : '—'}
                        </Td>
                        <Td className="tabular-nums">{rupees(c.fee_paid_paise)}</Td>
                        <Td>{c.has_photo ? 'Yes' : <span className="text-destructive">No</span>}</Td>
                        <Td>
                          {c.has_signature ? 'Yes' : <span className="text-destructive">No</span>}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </Card>

                {!d.frozen && mayFile && (
                  <Card>
                    <CardHeader
                      title="File this list with the board"
                      description="Revalidates against the roll first, then freezes. Nothing on a filed list can be edited afterwards."
                    />
                    <div className="space-y-3 px-5 pb-5">
                      <FormGrid>
                        <Field label="Board acknowledgement no." hint="If the board gave you one">
                          <Input value={ack} onChange={setAck} placeholder="Optional" />
                        </Field>
                      </FormGrid>
                      {blockers.length > 0 && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px]">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                          <span>
                            {blockers.length} blocker(s) outstanding. Filing anyway is refused
                            unless you override — a rejected LOC comes back without telling you
                            which rows failed.
                          </span>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={file.isPending || !d.candidates.length}
                          onClick={() => file.mutate(false)}
                        >
                          {file.isPending ? 'Filing…' : 'File the list'}
                        </Button>
                        {blockers.length > 0 && (
                          <ConfirmButton
                            variant="secondary"
                            tone="danger"
                            confirmLabel="File with blockers"
                            question={`File ${d.candidates.length} candidate(s) with ${blockers.length} known blocker(s)? The issues stay on the record showing they were known.`}
                            onConfirm={() => file.mutate(true)}
                          >
                            File anyway
                          </ConfirmButton>
                        )}
                      </div>
                      <FormNotice error={file.error} />
                    </div>
                  </Card>
                )}
              </>
            ) : null}
          </>
        )}
      </PageBody>
    </>
  )
}

function NewForm({
  form,
  setForm,
  create,
  mayFile,
}: {
  form: { board: string; exam_name: string; stage: string; title: string; fee: string }
  setForm: (v: typeof form) => void
  create: { mutate: () => void; isPending: boolean; error: unknown }
  mayFile: boolean
}) {
  if (!mayFile) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Building a List of Candidates needs the examinations permission. You can read every list
        here and export one in the board's format.
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <FormGrid>
        <Field label="Board" required>
          <Input value={form.board} onChange={(v) => setForm({ ...form, board: v })} />
        </Field>
        <Field label="Examination" required>
          <Input value={form.exam_name} onChange={(v) => setForm({ ...form, exam_name: v })} />
        </Field>
        <Field label="Stage">
          <Select
            value={form.stage}
            onChange={(v) => setForm({ ...form, stage: v })}
            options={STAGES}
          />
        </Field>
        <Field label="Fee per candidate (₹)" hint="Used to check each candidate has paid in full">
          <Input value={form.fee} onChange={(v) => setForm({ ...form, fee: v })} placeholder="0" />
        </Field>
        <Field label="Title" hint="Defaults to the exam and year" wide>
          <Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
        </Field>
      </FormGrid>
      {/* `Number(form.fee || 0)` made an empty box mean nought rupees, and the
          fee is what every candidate's payment is checked against — so a blank
          box silently turned the fee check off and passed the whole roll.
          A typo is worse: Number('12o') is NaN, which JSON writes as null.
          Nought is still sayable by typing it. */}
      <Button
        disabled={
          create.isPending ||
          !form.board.trim() ||
          !form.exam_name.trim() ||
          form.fee.trim() === '' ||
          !Number.isFinite(Number(form.fee)) ||
          Number(form.fee) < 0
        }
        onClick={() => create.mutate()}
      >
        {create.isPending ? 'Reading the roll…' : 'Build the list'}
      </Button>
      <FormNotice error={create.error} />
    </div>
  )
}
