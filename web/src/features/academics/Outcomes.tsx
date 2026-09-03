import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Target, ListChecks, HelpCircle } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* Outcome-based education: what a subject claims to produce, and whether it did.

   Nothing here stores an attainment percentage. It is computed from marks each
   time it is read, for the same reason syllabus coverage is: a stored figure
   is wrong the moment a paper is re-marked and nobody recomputes it.

   Two bars, both set per outcome because departments genuinely disagree about
   them: a child attains an outcome by clearing the threshold on the papers
   mapped to it, and the outcome is attained when the target share of the class
   clears that bar. An outcome with no paper mapped reports "not measured",
   which is a different fact from nought per cent. */

interface ProgrammeOutcome {
  id: string
  code: string
  statement: string
  kind: 'po' | 'pso'
  sequence: number
}

interface CourseOutcome {
  id: string
  class_subject_id: string
  class_name: string
  subject: string
  code: string
  statement: string
  bloom_level?: string
  threshold_percent: number
  target_percent: number
  sequence: number
  mapped_to: string[]
  papers: number
}

interface Attainment {
  course_outcome_id: string
  code: string
  statement: string
  class_name: string
  subject: string
  class_subject_id: string
  threshold_percent: number
  target_percent: number
  papers: number
  students_assessed: number
  students_cleared: number
  attainment_percent: number
  attained: boolean
  gap: number
  mapped_to: string[]
}

interface ProgrammeAttainment {
  code: string
  statement: string
  course_outcomes: number
  attainment_percent: number
  measured: boolean
}

interface ClassSubject {
  id: string
  class_name: string
  subject_name: string
}

export default function Outcomes() {
  const qc = useQueryClient()
  const [csID, setCsID] = useState('')

  const subjects = useQuery({
    queryKey: ['class-subjects'],
    queryFn: () => api.get<List<ClassSubject>>('/api/v1/setup/class-subjects'),
  })
  const frame = useQuery({
    queryKey: ['outcomes', csID],
    queryFn: () =>
      api.get<{ programme_outcomes: ProgrammeOutcome[]; course_outcomes: CourseOutcome[] }>(
        '/api/v1/academics/admin/outcomes' + (csID ? `?class_subject_id=${csID}` : ''),
      ),
  })
  const attain = useQuery({
    queryKey: ['outcome-attainment', csID],
    queryFn: () =>
      api.get<{
        items: Attainment[]
        programme: ProgrammeAttainment[]
        summary: {
          course_outcomes: number
          measured: number
          attained: number
          not_measured: number
        }
      }>(
        '/api/v1/academics/admin/outcomes/attainment' +
          (csID ? `?class_subject_id=${csID}` : ''),
      ),
  })

  const savePO = useMutation({
    mutationFn: (v: { code: string; statement: string; kind: string }) =>
      api.post('/api/v1/academics/admin/outcomes/programme', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outcomes'] }),
  })
  const saveCO = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      api.post('/api/v1/academics/admin/outcomes/course', v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['outcomes'] })
      qc.invalidateQueries({ queryKey: ['outcome-attainment'] })
    },
  })

  if (frame.isLoading) return <SkeletonTable columns={8} label="Reading the outcome framework…" />
  if (frame.error) return <ErrorState error={frame.error} />

  const pos = frame.data?.programme_outcomes ?? []
  const cos = frame.data?.course_outcomes ?? []
  const rows = attain.data?.items ?? []
  const s = attain.data?.summary

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Outcomes and attainment"
        description="Programme and course outcomes, the papers that measure them, and the gap between the bar and the class."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Course outcomes" value={s?.course_outcomes ?? 0} icon={ListChecks} />
          <Stat
            label="Attained"
            value={`${s?.attained ?? 0} / ${s?.measured ?? 0}`}
            icon={Target}
            delta={
              (s?.measured ?? 0) > 0 && s?.attained === s?.measured
                ? { value: 'Every measured outcome clears its target', positive: true }
                : { value: 'Some outcomes are short of target', positive: false }
            }
          />
          <Stat
            label="Not measured"
            value={s?.not_measured ?? 0}
            icon={HelpCircle}
            hint="No paper mapped — not the same as nought"
          />
          <Stat label="Programme outcomes" value={pos.length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Attainment"
            description="A child clears an outcome at the threshold; the outcome is attained when the target share of the class clears it."
            action={
              <Select
                value={csID}
                onChange={setCsID}
                options={(subjects.data?.items ?? []).map((c) => ({
                  value: c.id,
                  label: `${c.class_name} · ${c.subject_name}`,
                }))}
                placeholder="Every subject"
              />
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No course outcomes yet"
              body="Write the first one below, then map it to the papers that measure it."
            />
          ) : (
            <Table
              head={['Outcome', 'Subject', 'Papers', 'Assessed', 'Cleared', 'Attainment', 'Target', 'Maps to']}
            >
              {rows.map((r) => (
                <tr key={r.course_outcome_id}>
                  <Td className="font-medium">
                    {r.code}
                    <span className="block text-[12px] text-muted-foreground">
                      {r.statement}
                    </span>
                  </Td>
                  <Td>
                    {r.class_name} · {r.subject}
                  </Td>
                  <Td className="tabular-nums">{r.papers || '—'}</Td>
                  <Td className="tabular-nums">{r.students_assessed || '—'}</Td>
                  <Td className="tabular-nums">
                    {r.students_assessed ? r.students_cleared : '—'}
                  </Td>
                  <Td>
                    {r.students_assessed === 0 ? (
                      <Badge tone="neutral">not measured</Badge>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              r.attained ? 'bg-success' : 'bg-destructive',
                            )}
                            style={{ width: `${Math.min(100, r.attainment_percent)}%` }}
                          />
                        </div>
                        <span className="tabular-nums">{r.attainment_percent}%</span>
                      </div>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {r.target_percent}%
                    {r.gap > 0 && (
                      <span className="ml-1.5 text-[12px] text-destructive">
                        −{r.gap}
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {r.mapped_to.length ? r.mapped_to.join(', ') : '—'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {(attain.data?.programme.length ?? 0) > 0 && (
          <Card>
            <CardHeader
              title="Programme outcomes"
              description="The strength-weighted mean of the course outcomes mapped to each — the figure an accreditation form asks for."
            />
            <Table head={['Code', 'Statement', 'Course outcomes', 'Attainment']}>
              {(attain.data?.programme ?? []).map((p) => (
                <tr key={p.code}>
                  <Td className="font-medium">{p.code}</Td>
                  <Td className="text-muted-foreground">{p.statement}</Td>
                  <Td className="tabular-nums">{p.course_outcomes}</Td>
                  <Td>
                    {p.measured ? (
                      <span className="tabular-nums">{p.attainment_percent}%</span>
                    ) : (
                      <Badge tone="neutral">not measured</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Mapping
          courseOutcomes={cos}
          programmeOutcomes={pos}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['outcomes'] })
            qc.invalidateQueries({ queryKey: ['outcome-attainment'] })
          }}
        />

        <Card>
          <CardHeader title="Write an outcome" />
          <div className="grid gap-6 px-5 pb-5 lg:grid-cols-2">
            <NewProgrammeOutcome save={savePO} />
            <NewCourseOutcome
              save={saveCO}
              subjects={subjects.data?.items ?? []}
              preselect={csID}
            />
          </div>
        </Card>
      </PageBody>
    </>
  )
}

/** Mapping a course outcome to the programme outcomes it feeds and the papers
    that measure it. Replaced as a set: a matrix is edited as a grid, and
    merging would leave last year's rows behind with nothing on screen. */
function Mapping({
  courseOutcomes,
  programmeOutcomes,
  onSaved,
}: {
  courseOutcomes: CourseOutcome[]
  programmeOutcomes: ProgrammeOutcome[]
  onSaved: () => void
}) {
  const [coID, setCoID] = useState('')
  const [strengths, setStrengths] = useState<Record<string, string>>({})
  const [papers, setPapers] = useState<string>('')

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/academics/admin/outcomes/mapping', {
        course_outcome_id: coID,
        programme_map: Object.entries(strengths)
          .filter(([, v]) => v !== '')
          .map(([id, v]) => ({ programme_outcome_id: id, strength: Number(v) })),
        assessments: papers
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((id) => ({ exam_subject_id: id, weight: 100 })),
      }),
    onSuccess: onSaved,
  })

  if (courseOutcomes.length === 0 || programmeOutcomes.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="Mapping"
        description="Strength is the 1–2–3 an accreditation form uses. Leave one blank to unmap it."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Course outcome" required>
            <Select
              value={coID}
              onChange={(v) => {
                setCoID(v)
                setStrengths({})
              }}
              options={courseOutcomes.map((c) => ({
                value: c.id,
                label: `${c.class_name} · ${c.subject} · ${c.code}`,
              }))}
              placeholder="Pick one"
            />
          </Field>
          <Field
            label="Papers that measure it"
            hint="Exam-subject ids, comma separated. Leaving this blank unmaps every paper."
          >
            <Input value={papers} onChange={setPapers} placeholder="uuid, uuid" />
          </Field>
        </FormGrid>

        {coID && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {programmeOutcomes.map((p) => (
              <Field key={p.id} label={`${p.code} — ${p.statement}`}>
                <Select
                  value={strengths[p.id] ?? ''}
                  onChange={(v) => setStrengths((s) => ({ ...s, [p.id]: v }))}
                  options={[
                    { value: '1', label: '1 — slight' },
                    { value: '2', label: '2 — moderate' },
                    { value: '3', label: '3 — substantial' },
                  ]}
                  placeholder="Not mapped"
                />
              </Field>
            ))}
          </div>
        )}

        <div className="mt-5 flex items-center gap-3">
          <Button disabled={!coID || save.isPending} onClick={() => save.mutate()}>
            Save mapping
          </Button>
          <FormNotice error={save.error} ok={save.isSuccess ? 'Mapping saved.' : undefined} />
        </div>
      </div>
    </Card>
  )
}

function NewProgrammeOutcome({ save }: { save: ReturnType<typeof useMutation<unknown, Error, { code: string; statement: string; kind: string }>> }) {
  const [code, setCode] = useState('')
  const [statement, setStatement] = useState('')
  const [kind, setKind] = useState('po')

  return (
    <div>
      <p className="mb-4 text-[13px] font-medium text-secondary-foreground">
        Programme outcome
      </p>
      <div className="space-y-4">
        <Field label="Code" required>
          <Input value={code} onChange={setCode} placeholder="PO1" />
        </Field>
        <Field label="Kind">
          <Select
            value={kind}
            onChange={setKind}
            options={[
              { value: 'po', label: 'Programme outcome' },
              { value: 'pso', label: 'Programme-specific outcome' },
            ]}
          />
        </Field>
        <Field label="Statement" required>
          <Textarea
            value={statement}
            onChange={setStatement}
            rows={2}
            placeholder="Communicates clearly in two languages"
          />
        </Field>
        <Button
          disabled={save.isPending || !code.trim() || !statement.trim()}
          onClick={() =>
            save.mutate(
              { code, statement, kind },
              { onSuccess: () => { setCode(''); setStatement('') } },
            )
          }
        >
          Save outcome
        </Button>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

function NewCourseOutcome({
  save,
  subjects,
  preselect,
}: {
  save: ReturnType<typeof useMutation<unknown, Error, Record<string, unknown>>>
  subjects: ClassSubject[]
  preselect: string
}) {
  const [csID, setCsID] = useState(preselect)
  const [code, setCode] = useState('')
  const [statement, setStatement] = useState('')
  const [bloom, setBloom] = useState('')
  const [threshold, setThreshold] = useState('50')
  const [target, setTarget] = useState('60')

  return (
    <div>
      <p className="mb-4 text-[13px] font-medium text-secondary-foreground">Course outcome</p>
      <div className="space-y-4">
        <Field label="Subject" required>
          <Select
            value={csID}
            onChange={setCsID}
            options={subjects.map((c) => ({
              value: c.id,
              label: `${c.class_name} · ${c.subject_name}`,
            }))}
            placeholder="Pick a subject"
          />
        </Field>
        <Field label="Code" required>
          <Input value={code} onChange={setCode} placeholder="CO1" />
        </Field>
        <Field label="Statement" required>
          <Textarea
            value={statement}
            onChange={setStatement}
            rows={2}
            placeholder="Solves linear equations in one variable"
          />
        </Field>
        <Field label="Bloom level">
          <Select
            value={bloom}
            onChange={setBloom}
            options={[
              { value: 'remember', label: 'Remember' },
              { value: 'understand', label: 'Understand' },
              { value: 'apply', label: 'Apply' },
              { value: 'analyse', label: 'Analyse' },
              { value: 'evaluate', label: 'Evaluate' },
              { value: 'create', label: 'Create' },
            ]}
            placeholder="Not stated"
          />
        </Field>
        <FormGrid>
          <Field label="Threshold %" hint="What a child must score to clear it.">
            <Input type="number" value={threshold} onChange={setThreshold} />
          </Field>
          <Field label="Target %" hint="Share of the class that must clear it.">
            <Input type="number" value={target} onChange={setTarget} />
          </Field>
        </FormGrid>
        <Button
          disabled={save.isPending || !csID || !code.trim() || !statement.trim()}
          onClick={() =>
            save.mutate(
              {
                class_subject_id: csID,
                code,
                statement,
                bloom_level: bloom,
                threshold_percent: Number(threshold) || 50,
                target_percent: Number(target) || 60,
              },
              { onSuccess: () => { setCode(''); setStatement('') } },
            )
          }
        >
          Save outcome
        </Button>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}
