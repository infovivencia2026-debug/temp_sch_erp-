import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSearch, TriangleAlert, Upload, UserCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Checkbox, Field, FormGrid, FormNotice, Input, Select, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The board's result file, reconciled against the school's own candidates.

   The screen is built around the two lists nobody wants to look at. The
   board's file will carry candidates this school does not have and will omit
   ones it does, and the only failure that really matters here is a child in
   the second list going unnoticed: they hear nothing on the afternoon every
   classmate hears, and the school finds out when the parent telephones.

   So both lists are shown before anything is written, publishing is refused
   while either is outstanding, and acknowledging them is a deliberate act that
   is recorded. */

interface ResultLine {
  id?: string
  line_no: number
  hall_ticket_no: string
  registration_no: string
  candidate_name: string
  student_id?: string
  school_record_name?: string
  admission_no?: string
  match_method: string
  result: string
  total_marks?: number
  max_marks?: number
  percent?: number
}

interface MissingCandidate {
  registration_id: string
  student_id: string
  admission_no: string
  candidate_name: string
  class_name: string
  hall_ticket_no?: string
  registration_no?: string
  status: string
}

interface Reconciliation {
  import_id?: string
  dry_run: boolean
  rows: number
  matched: number
  basis: string
  in_file_not_in_school: ResultLine[]
  in_school_not_in_file: MissingCandidate[]
  matches: ResultLine[]
  published: boolean
  published_on?: string
}

interface ImportRow {
  id: string
  board: string
  exam_name: string
  stage?: string
  file_name?: string
  rows: number
  matched: number
  unmatched: number
  missing_from_file: number
  imported_at: string
  imported_by?: string
  published_on?: string
  unmatched_acknowledged: boolean
}

const RESULT_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  pass: 'success',
  fail: 'danger',
  compartment: 'warning',
  absent: 'neutral',
  withheld: 'warning',
}

export default function BoardResultImport() {
  const qc = useQueryClient()
  const [board, setBoard] = useState('BSE Telangana')
  const [examName, setExamName] = useState(`SSC Public Examination March ${new Date().getFullYear()}`)
  const [stage, setStage] = useState('ssc')
  const [fileName, setFileName] = useState('')
  const [csv, setCsv] = useState('')
  const [ack, setAck] = useState(false)
  const [openImport, setOpenImport] = useState('')

  const imports = useQuery({
    queryKey: ['board-imports'],
    queryFn: () => api.get<List<ImportRow>>('/api/v1/exams/board/results/imports'),
  })
  const stored = useQuery({
    queryKey: ['board-reconciliation', openImport],
    queryFn: () =>
      api.get<Reconciliation>(
        `/api/v1/exams/board/results/reconciliation${openImport ? `?import_id=${openImport}` : ''}`,
      ),
  })

  const run = useMutation({
    mutationFn: (commit: boolean) =>
      api.post<Reconciliation>('/api/v1/exams/board/results/import', {
        board, exam_name: examName, stage, file_name: fileName, csv, commit,
      }),
    onSuccess: (d) => {
      if (d.import_id) {
        setOpenImport(d.import_id)
        qc.invalidateQueries({ queryKey: ['board-imports'] })
        qc.invalidateQueries({ queryKey: ['board-reconciliation'] })
      }
    },
  })
  const match = useMutation({
    mutationFn: (v: { row: string; student: string }) =>
      api.post(`/api/v1/exams/board/results/rows/${v.row}/match`, { student_id: v.student }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board-reconciliation'] })
      qc.invalidateQueries({ queryKey: ['board-imports'] })
    },
  })
  const publish = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/exams/board/results/imports/${id}/publish`, { acknowledge_unmatched: ack }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board-reconciliation'] })
      qc.invalidateQueries({ queryKey: ['board-imports'] })
    },
  })

  const onFile = (f: File) => {
    setFileName(f.name)
    const reader = new FileReader()
    reader.onload = () => setCsv(String(reader.result ?? ''))
    reader.readAsText(f)
  }

  // The dry run's report until something is committed, then the stored one.
  // A stored report with nothing in it means no file has been imported yet —
  // the screen shows its upload panel rather than a page of zeroes.
  const latest = run.data && run.data.dry_run ? run.data : stored.data
  const report: Reconciliation | undefined =
    latest && (latest.rows > 0 || latest.import_id) ? latest : undefined
  const unmatched = report?.in_file_not_in_school ?? []
  const missing = report?.in_school_not_in_file ?? []
  const unreconciled = unmatched.length + missing.length

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Board result import"
        description="Read the board's published file and reconcile it against the school's own candidates. Nothing in the file is discarded, and nothing missing from it is passed over."
      />
      <PageBody width="wide">
        <Card>
          <CardHeader
            title="The file the board published"
            description="Column names are read loosely: hall ticket, HTNO or roll no all work, and any other numeric column is read as a subject mark."
          />
          <div className="space-y-5 p-5">
            <FormGrid>
              <Field label="Board">
                <Input value={board} onChange={setBoard} />
              </Field>
              <Field label="Examination">
                <Input value={examName} onChange={setExamName} />
              </Field>
              <Field label="Which examination this is">
                <Select
                  value={stage}
                  onChange={setStage}
                  options={[
                    { value: 'ssc', label: 'SSC (Class 10)' },
                    { value: 'inter_first_year', label: 'Intermediate first year' },
                    { value: 'inter_second_year', label: 'Intermediate second year' },
                  ]}
                />
              </Field>
            </FormGrid>

            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed py-10 text-center transition-colors hover:bg-accent/40">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-[14px] font-medium">
                {fileName || "Click to choose the board's CSV"}
              </span>
              <span className="text-[13px] text-muted-foreground">
                Checked and reconciled before anything is stored
              </span>
              <input
                type="file" accept=".csv,text/csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <Button disabled={!csv || run.isPending} onClick={() => run.mutate(false)}>
                {run.isPending ? 'Reconciling…' : 'Check the file'}
              </Button>
              <Button
                variant="secondary"
                disabled={!csv || run.isPending || !run.data}
                onClick={() => run.mutate(true)}
                title="Store the file and its reconciliation"
              >
                Import {run.data ? `${run.data.rows} line(s)` : ''}
              </Button>
            </div>
            <FormNotice error={run.error} />
          </div>
        </Card>

        {report && (
          <>
            <CellGrid cols={4}>
              <Stat label="Lines in the file" value={report.rows} icon={FileSearch} />
              <Stat label="Matched to a candidate" value={report.matched} icon={UserCheck} />
              <Stat
                label="In the file, not ours"
                value={unmatched.length}
                icon={TriangleAlert}
                hint="Kept, never discarded"
              />
              <Stat
                label="Ours, not in the file"
                value={missing.length}
                icon={TriangleAlert}
                hint="These families hear nothing unless somebody acts"
              />
            </CellGrid>

            <Card>
              <CardHeader
                title="Candidates the file does not mention"
                description={report.basis}
              />
              {missing.length === 0 ? (
                <EmptyState title="Every candidate the school entered appears in the file" />
              ) : (
                <Table head={['Candidate', 'Admission no', 'Class', 'Hall ticket', 'Registration no', 'On the roll as']}>
                  {missing.map((m) => (
                    <tr key={m.registration_id}>
                      <Td className="font-medium">{m.candidate_name}</Td>
                      <Td>{m.admission_no}</Td>
                      <Td>{m.class_name}</Td>
                      <Td className="tabular-nums">{m.hall_ticket_no ?? '—'}</Td>
                      <Td className="tabular-nums">{m.registration_no ?? '—'}</Td>
                      <Td><Badge tone="warning">{m.status.replace(/_/g, ' ')}</Badge></Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Lines this school cannot place"
                description="A private candidate at the same centre, or a name typed differently. Attach one to a child only where you are sure — the alternative is one child's result on another's record."
              />
              {unmatched.length === 0 ? (
                <EmptyState title="Every line in the file matched a candidate" />
              ) : (
                <Table head={['Line', 'Hall ticket', 'Registration no', 'Name as printed', 'Result', '%', '']}>
                  {unmatched.map((l) => (
                    <tr key={l.line_no}>
                      <Td className="tabular-nums">{l.line_no}</Td>
                      <Td className="tabular-nums">{l.hall_ticket_no || '—'}</Td>
                      <Td className="tabular-nums">{l.registration_no || '—'}</Td>
                      <Td className="font-medium">{l.candidate_name}</Td>
                      <Td><Badge tone={RESULT_TONE[l.result] ?? 'neutral'}>{l.result || '—'}</Badge></Td>
                      <Td className="tabular-nums">{l.percent ?? '—'}</Td>
                      <Td>
                        {l.id && missing.length > 0 && (
                          <Select
                            value=""
                            placeholder="Match to…"
                            onChange={(v) => v && match.mutate({ row: l.id!, student: v })}
                            options={missing.map((m) => ({
                              value: m.student_id,
                              label: `${m.candidate_name} (${m.admission_no})`,
                            }))}
                          />
                        )}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
              <div className="px-5 pb-5"><FormNotice error={match.error} /></div>
            </Card>

            <Card>
              <CardHeader
                title="Matched results"
                description="How each line was matched is kept, because a name match is a guess and somebody has to be able to look at the guesses."
                action={
                  report.import_id && !report.published ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Checkbox
                        checked={ack}
                        onChange={setAck}
                        label="I have seen both lists"
                        hint="Required while anything is unreconciled"
                      />
                      <Button
                        disabled={publish.isPending || (unreconciled > 0 && !ack)}
                        onClick={() => publish.mutate(report.import_id!)}
                      >
                        Publish to families
                      </Button>
                    </div>
                  ) : report.published ? (
                    <Badge tone="success">published {formatDate(report.published_on)}</Badge>
                  ) : undefined
                }
              />
              {(report.matches ?? []).length === 0 ? (
                <EmptyState title="Nothing matched yet" />
              ) : (
                <Table head={['Line', 'Candidate', 'On the roll as', 'Matched by', 'Result', 'Total', '%']}>
                  {report.matches.map((l) => (
                    <tr key={l.line_no}>
                      <Td className="tabular-nums">{l.line_no}</Td>
                      <Td className="font-medium">{l.candidate_name}</Td>
                      <Td className="text-muted-foreground">
                        {l.school_record_name} {l.admission_no ? `(${l.admission_no})` : ''}
                      </Td>
                      <Td>
                        <Badge tone={l.match_method === 'name' ? 'warning' : 'neutral'}>
                          {l.match_method.replace(/_/g, ' ')}
                        </Badge>
                      </Td>
                      <Td><Badge tone={RESULT_TONE[l.result] ?? 'neutral'}>{l.result || '—'}</Badge></Td>
                      <Td className="tabular-nums">
                        {l.total_marks ?? '—'}{l.max_marks ? ` / ${l.max_marks}` : ''}
                      </Td>
                      <Td className="tabular-nums">{l.percent ?? '—'}</Td>
                    </tr>
                  ))}
                </Table>
              )}
              <div className="px-5 pb-5"><FormNotice error={publish.error} /></div>
            </Card>
          </>
        )}

        <Card>
          <CardHeader
            title="Files already imported"
            description="A board publishes more than once — the main result and then the supplementary — so each file is kept with its own reconciliation."
          />
          {(imports.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No result file has been imported yet" />
          ) : (
            <Table head={['Examination', 'File', 'Lines', 'Matched', 'Unplaced', 'Missing', 'Imported', 'Published', '']}>
              {(imports.data?.items ?? []).map((i) => (
                <tr key={i.id}>
                  <Td className="font-medium">{i.exam_name}<span className="block text-[12px] text-muted-foreground">{i.board}</span></Td>
                  <Td>{i.file_name ?? '—'}</Td>
                  <Td className="tabular-nums">{i.rows}</Td>
                  <Td className="tabular-nums">{i.matched}</Td>
                  <Td className="tabular-nums">{i.unmatched || '—'}</Td>
                  <Td className="tabular-nums">{i.missing_from_file || '—'}</Td>
                  <Td>{i.imported_at}<span className="block text-[12px] text-muted-foreground">{i.imported_by ?? ''}</span></Td>
                  <Td>
                    {i.published_on ? (
                      <Badge tone={i.unmatched_acknowledged ? 'warning' : 'success'}>
                        {i.unmatched_acknowledged ? 'published, gaps acknowledged' : 'published'}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">not published</Badge>
                    )}
                  </Td>
                  <Td>
                    <Button size="sm" variant="ghost" onClick={() => { run.reset(); setOpenImport(i.id) }}>
                      Open
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {stored.error && <ErrorState error={stored.error} />}
      </PageBody>
    </>
  )
}
