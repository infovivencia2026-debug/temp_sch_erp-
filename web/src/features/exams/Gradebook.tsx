import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Loading, ErrorState, EmptyState, ExportButton, PrintButton, FormNotice, FormGrid, Field, Input,
} from '@/components/ui'
import { useToast } from '@/components/Toast'

interface Paper {
  id: string; label: string; max_marks: number
  marks_entered: number; students: number
  exam_id: string; exam_name: string; exam_kind: string
  class_id: string; class_name: string; subject: string
}

interface Row {
  student_id: string; admission_no: string; full_name: string
  marks_obtained?: number; max_marks: number; grade?: string; is_absent: boolean
}

/** Marks entry. The grade is computed server-side from the exam's grading
    scale — the teacher enters marks, never a grade. */
export default function Gradebook() {
  const qc = useQueryClient()
  const [esID, setESID] = useState('')
  /* Class, then kind of exam, then the paper.
   *
   * There was one dropdown listing every paper in the school as
   * "Half Yearly · Class 8 · Mathematics", and a teacher with four classes
   * and three subjects read three facts out of one concatenated string to
   * find the one they were about to mark. Choosing the class and the exam
   * type first is how anybody describes the job — "Class 8B half-yearly
   * maths" — and it is what was asked for. */
  const [classID, setClassID] = useState('')
  const [examKind, setExamKind] = useState('')

  // A teacher picks the paper from a list. Asking them to paste a UUID was the
  // single worst thing left in the interface.
  const papers = useQuery({
    queryKey: ['exam-subjects'],
    queryFn: () => api.get<List<Paper>>('/api/v1/exams/subjects'),
  })
  /* What the paper is out of, and which scale grades it — before any mark.
   *
   * Both were decided invisibly when the exam was created: every paper took the
   * same maximum and the grade came from whichever scale happened to be the
   * default. A formative is out of 20 and a term paper out of 80, in the same
   * exam, in every school in the country.
   *
   * Only before marks exist. Moving the maximum afterwards re-grades every
   * child in silence — 45 out of 50 is a distinction and 45 out of 100 is a
   * fail — so the server refuses it and this hides the control rather than
   * offering something that will be rejected.
   */
  const [outOf, setOutOf] = useState('')
  const [scaleID, setScaleID] = useState('')
  const [setupNote, setSetupNote] = useState('')

  const scales = useQuery({
    queryKey: ['grading-scales'],
    queryFn: () => api.get<List<{ id: string; name: string; is_default: boolean }>>(
      '/api/v1/academics/grading-scales',
    ),
    retry: false,
  })

  const setup = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/exams/subjects/${esID}/setup`, {
        ...(outOf ? { max_marks: Number(outOf) } : {}),
        ...(scaleID ? { grading_scale_id: scaleID } : {}),
      }),
    onSuccess: () => {
      setSetupNote('Saved. Marks entered below are out of this figure and graded on this scale.')
      setOutOf('')
      qc.invalidateQueries({ queryKey: ['exam-subjects'] })
      qc.invalidateQueries({ queryKey: ['gradebook', esID] })
    },
    onError: () => setSetupNote(''),
  })

  const [draft, setDraft] = useState<Record<string, string>>({})
  /* Absence is an override, not a set of names.
     A Set can only say "the teacher ticked this one", which is not the same
     question as "is this child absent" — the server answers that one in
     `is_absent`. With only the Set, a row that came back already absent was
     drawn ticked, and the first click on it *added* the child to the Set: the
     tick did not move, and the save wrote the same absence again. There was no
     way to tell the school a child had in fact sat the paper. Undefined means
     "as the server has it"; true and false are the teacher overruling it. */
  const [absent, setAbsent] = useState<Record<string, boolean>>({})

  /* Switching paper empties the sheet.
     Marks are keyed by student and a class sits every subject, so the sheet a
     teacher half-filled for Maths was still in `draft` when they picked
     Science — same children, same keys — and Save posted the Maths marks
     against the Science paper. */
  const pickPaper = (id: string) => {
    setESID(id)
    setDraft({})
    setAbsent({})
  }

  const book = useQuery({
    queryKey: ['gradebook', esID],
    queryFn: () => api.get<List<Row>>(`/api/v1/exams/gradebook?exam_subject_id=${esID}`),
    enabled: !!esID,
  })

  const toast = useToast()

  const rows = book.data?.items ?? []

  /** Absent as the teacher has left it: their override, else the record. */
  const isAbsent = (r: Row) => absent[r.student_id] ?? r.is_absent
  /** What the box shows: the teacher's typing, else the recorded mark. */
  const markOf = (r: Row) =>
    draft[r.student_id] ?? (r.marks_obtained != null ? String(r.marks_obtained) : '')

  // Only rows the teacher has actually touched are sent. An untouched row is
  // not "zero", and posting one would overwrite a colleague's entry.
  const touched = rows.filter(
    (r) => draft[r.student_id] !== undefined || absent[r.student_id] !== undefined,
  )

  /* A mark the server will refuse.
     It rejects the whole batch for one bad number — correctly, since 950 for 95
     must not become a pass — so a typo would lose the other thirty-nine entries
     and the message would not say whose. Caught here, before it is sent, and
     the box carrying it is named. `parseFloat` used to turn a cleared field
     into NaN, which JSON writes as null: the mark was quietly erased. */
  const invalid = touched.filter((r) => {
    const raw = draft[r.student_id]
    if (isAbsent(r) || raw === undefined || raw.trim() === '') return false
    const n = Number(raw)
    return !Number.isFinite(n) || n < 0 || n > r.max_marks
  })

  const entryFor = (r: Row) => {
    if (isAbsent(r)) return { student_id: r.student_id, marks_obtained: null, is_absent: true }
    const raw = draft[r.student_id]
    // An emptied box erases the mark; a row touched only by un-ticking absent
    // keeps the one already recorded.
    const marks =
      raw === undefined ? (r.marks_obtained ?? null) : raw.trim() === '' ? null : Number(raw)
    return { student_id: r.student_id, marks_obtained: marks, is_absent: false }
  }

  const all = papers.data?.items ?? []
  const visible = all.filter(
    (p) => (!classID || p.class_id === classID) && (!examKind || p.exam_kind === examKind),
  )

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/exams/marks', {
        exam_subject_id: esID,
        entries: touched.map(entryFor),
      }),
    onSuccess: () => {
      // Counted before the draft is cleared: the mutation builds its own
      // payload, so there is nothing handed back to count.
      const entered = touched.length
      setDraft({}); setAbsent({})
      qc.invalidateQueries({ queryKey: ['gradebook', esID] })
      toast.ok(`${entered} mark${entered === 1 ? '' : 's'} entered`)
    },
  })

  const entered = rows.filter((r) => r.marks_obtained != null).length
  const max = rows[0]?.max_marks ?? 0
  const avg = entered
    ? Math.round(rows.reduce((a, r) => a + (r.marks_obtained ?? 0), 0) / entered)
    : 0

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Marks entry"
        description="Enter marks for a paper. Grades are derived from the exam's grading scale, not typed."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* A mark sheet is filed, signed and argued over on paper. */}
            <ExportButton report="marks" />
            <PrintButton />
            <Select
              value={classID}
              onChange={(v) => { setClassID(v); setESID('') }}
              placeholder="Any class"
              options={[
                { value: '', label: 'Any class' },
                ...classOptions(all),
              ]}
            />
            <Select
              value={examKind}
              onChange={(v) => { setExamKind(v); setESID('') }}
              placeholder="Any exam type"
              options={[
                { value: '', label: 'Any exam type' },
                ...kindOptions(all),
              ]}
            />
            <Select
              value={esID}
              onChange={pickPaper}
              placeholder={visible.length ? 'Choose a paper' : 'No papers match'}
              options={visible.map((p) => ({
                value: p.id,
                label: `${p.subject} · ${p.exam_name} — ${p.marks_entered}/${p.students} entered`,
              }))}
            />
          </div>
        }
      />
      <PageBody>
        {!esID ? (
          <EmptyState
            title="Choose a paper"
            body={
              papers.data?.items.length
                ? 'Pick a paper above to start entering marks.'
                : 'No exam papers exist yet. Create an exam in setup first.'
            }
          />
        ) : book.isLoading ? (
          <Loading />
        ) : book.error ? (
          <ErrorState error={book.error} />
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat label="Students" value={rows.length} />
              <Stat label="Marks entered" value={`${entered}/${rows.length}`} />
              <Stat label="Class average" value={entered ? `${avg}/${max}` : '—'} />
              <Stat label="Pending" value={rows.length - entered} />
            </CellGrid>

            {entered === 0 && (
              <Card>
                <CardHeader
                  title="Before you enter marks"
                  description={`This paper is out of ${max}. Change it now if that is wrong — once a single mark is in it is fixed, because 45 out of 50 is a distinction and 45 out of 100 is a fail.`}
                />
                {setupNote && <FormNotice ok={setupNote} />}
                {setup.error && <FormNotice error={setup.error} />}
                <FormGrid>
                  <Field label="Out of" hint="20 for a formative, 80 for a summative, 100 for a term paper.">
                    <Input
                      type="number"
                      value={outOf}
                      onChange={setOutOf}
                      placeholder={String(max)}
                    />
                  </Field>
                  <Field
                    label="Grade scale"
                    hint="Applies to every paper in this exam, so one report card does not mix two scales."
                  >
                    <Select
                      value={scaleID}
                      onChange={setScaleID}
                      placeholder="Leave as it is"
                      options={(scales.data?.items ?? []).map((g) => ({
                        value: g.id,
                        label: g.is_default ? `${g.name} (school default)` : g.name,
                      }))}
                    />
                  </Field>
                </FormGrid>
                <Button
                  onClick={() => setup.mutate()}
                  disabled={setup.isPending || (!outOf && !scaleID)}
                >
                  Save the paper's setup
                </Button>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Gradebook"
                description={`Out of ${max}`}
                action={
                  <Button
                    disabled={save.isPending || !touched.length || invalid.length > 0}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? 'Saving…' : 'Save marks'}
                  </Button>
                }
              />
              <Table head={['Admission no.', 'Student', 'Marks', 'Absent', 'Grade']} empty={!rows.length}>
                {rows.map((r) => (
                  <tr key={r.student_id}>
                    <Td className="font-mono text-[12px]">{r.admission_no}</Td>
                    <Td className="font-medium">{r.full_name}</Td>
                    <Td>
                      <input
                        type="number" min={0} max={r.max_marks}
                        disabled={isAbsent(r)}
                        value={markOf(r)}
                        onChange={(e) => setDraft({ ...draft, [r.student_id]: e.target.value })}
                        aria-label={`Marks for ${r.full_name}, out of ${r.max_marks}`}
                        aria-invalid={invalid.some((x) => x.student_id === r.student_id) || undefined}
                        className="field w-24 disabled:opacity-40"
                      />
                    </Td>
                    <Td>
                      <input
                        type="checkbox"
                        checked={isAbsent(r)}
                        onChange={() => setAbsent({ ...absent, [r.student_id]: !isAbsent(r) })}
                        aria-label={`Mark ${r.full_name} absent`}
                      />
                    </Td>
                    <Td>{r.grade ? <Badge tone="primary">{r.grade}</Badge> : '—'}</Td>
                  </tr>
                ))}
              </Table>
              {invalid.length > 0 && (
                <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
                  {invalid.length === 1
                    ? `${invalid[0].full_name}'s mark must be a number between 0 and ${invalid[0].max_marks}.`
                    : `${invalid.length} marks are not a number between 0 and ${max}: ${invalid
                        .map((r) => r.full_name)
                        .join(', ')}.`}
                </p>
              )}
              {save.isError && (
                <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
                  {save.error instanceof Error ? save.error.message : 'Could not save marks'}
                </p>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}


/* The two narrowing lists, built from the papers themselves.
 *
 * Not separate endpoints. The classes a teacher may enter marks for are
 * exactly the classes appearing in their own paper list, and asking the
 * server a second question could only produce a list with entries that
 * narrow to nothing.
 */
function classOptions(papers: Paper[]) {
  const seen = new Map<string, string>()
  for (const p of papers) seen.set(p.class_id, p.class_name)
  return [...seen].map(([value, label]) => ({ value, label }))
}

function kindOptions(papers: Paper[]) {
  const seen = new Set<string>()
  for (const p of papers) if (p.exam_kind) seen.add(p.exam_kind)
  return [...seen].map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))
}
