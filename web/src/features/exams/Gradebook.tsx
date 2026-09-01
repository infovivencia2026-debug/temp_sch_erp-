import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Loading, ErrorState, EmptyState, PrintButton, FormNotice, FormGrid, Field, Input,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
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
  section: string
}

interface SectionRow { id: string; name: string; class_id: string; class_name: string }

/* Reading a marks sheet the exam cell already has.

   CSV because that is what every spreadsheet in an Indian school exports to,
   and because a format a person can open in Notepad is one they can fix
   themselves when a column is wrong.

   The header is found rather than demanded: a sheet whose columns are
   "Roll No, Name, Marks" and one whose columns are "admission_no, student,
   score" are the same sheet, and refusing the second on a technicality is how
   an import feature goes unused. */
function readMarksSheet(text: string): { key: string; value: string }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return []

  const split = (line: string) =>
    line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))

  const header = split(lines[0]).map((h) => h.toLowerCase())
  const find = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h.includes(n)))

  let idCol = find('admission', 'adm no', 'adm_no', 'roll')
  let markCol = find('mark', 'score', 'obtained')
  let nameCol = find('name', 'student')

  /* A sheet with no header at all — somebody pasted two columns. Assume the
     first is who and the last is how many, which is the only arrangement that
     makes sense and the one a person would have typed. */
  let body = lines.slice(1)
  if (idCol < 0 && nameCol < 0 && markCol < 0) {
    idCol = 0
    markCol = split(lines[0]).length - 1
    body = lines
  }
  if (markCol < 0) markCol = split(lines[0]).length - 1

  const out: { key: string; value: string }[] = []
  for (const line of body) {
    const cells = split(line)
    const key = (idCol >= 0 ? cells[idCol] : nameCol >= 0 ? cells[nameCol] : '') ?? ''
    const value = (cells[markCol] ?? '').trim()
    if (key) out.push({ key: key.trim(), value })
  }
  return out
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

  /* /setup/grading-scales, not /academics/grading-scales.

     That second path has never existed. The route is registered inside
     r.Route("/setup") in api.go, and the setup panel has always called it
     correctly; only this screen guessed. So the request 404'd on every visit
     to Marks entry, the Grade scale dropdown was permanently stuck on "Leave
     as it is", and `retry: false` meant it failed quietly enough that nobody
     traced it -- a wrong URL is indistinguishable from a feature nobody
     finished, right up until you read the router. */
  const scales = useQuery({
    queryKey: ['grading-scales'],
    queryFn: () => api.get<List<{ id: string; name: string; is_default: boolean }>>(
      '/api/v1/setup/grading-scales',
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
  const [importNote, setImportNote] = useState('')
  const [importErr, setImportErr] = useState('')

  /* Filling the boxes from a sheet, and stopping there.

     The teacher sees what arrived against names they recognise and presses the
     Save button that was already on the screen. An import that wrote straight
     to the database would be ninety marks entered by a file nobody read. */
  const importSheet = (file: File) => {
    setImportNote('')
    setImportErr('')
    const reader = new FileReader()
    reader.onerror = () => setImportErr('That file could not be read.')
    reader.onload = () => {
      const pairs = readMarksSheet(String(reader.result ?? ''))
      if (pairs.length === 0) {
        setImportErr('Nothing in that file looked like a marks sheet.')
        return
      }
      /* Admission number first, name second. Two children called Rahul Iyer
         sit in the same room, and an admission number belongs to one of them —
         so a name is only trusted when nothing matched by number. */
      const byAdm = new Map(rows.map((r) => [r.admission_no.toLowerCase(), r]))
      const byName = new Map(rows.map((r) => [r.full_name.trim().toLowerCase(), r]))

      const next = { ...draft }
      const missed: string[] = []
      let filled = 0
      for (const { key, value } of pairs) {
        const row = byAdm.get(key.toLowerCase()) ?? byName.get(key.toLowerCase())
        if (!row) {
          missed.push(key)
          continue
        }
        next[row.student_id] = value
        filled++
      }
      setDraft(next)
      setImportNote(
        `${filled} mark${filled === 1 ? '' : 's'} filled in. Check them, then press Save marks.`,
      )
      if (missed.length) {
        setImportErr(
          `Nobody in this paper matched: ${missed.slice(0, 6).join(', ')}` +
            (missed.length > 6 ? ` and ${missed.length - 6} more` : '') +
            '. Those rows were left alone.',
        )
      }
    }
    reader.readAsText(file)
  }
  /* Absence is an override, not a set of names.
     A Set can only say "the teacher ticked this one", which is not the same
     question as "is this child absent" — the server answers that one in
     `is_absent`. With only the Set, a row that came back already absent was
     drawn ticked, and the first click on it *added* the child to the Set: the
     tick did not move, and the save wrote the same absence again. There was no
     way to tell the school a child had in fact sat the paper. Undefined means
     "as the server has it"; true and false are the teacher overruling it. */
  const [absent, setAbsent] = useState<Record<string, boolean>>({})
  const [sectionID, setSectionID] = useState('')

  /* Switching paper empties the sheet.
     Marks are keyed by student and a class sits every subject, so the sheet a
     teacher half-filled for Maths was still in `draft` when they picked
     Science — same children, same keys — and Save posted the Maths marks
     against the Science paper. */
  const pickPaper = (id: string) => {
    setESID(id)
    // The sections belong to the old paper's class; keeping one would filter
    // the new sheet down to nobody.
    setSectionID('')
    setDraft({})
    setAbsent({})
  }

  /* A paper is set for a class, a teacher stands in front of a section.

     Grade 6 has 6-A, 6-B and 6-C, so the roster for one Maths paper is all
     three interleaved by admission number. The teacher who taught 6-B was
     typing their marks down a sheet two thirds of which was somebody else's.
     Empty means the whole class, which is what the exam cell wants when it is
     checking whether a paper is fully entered. */
  const sections = useQuery({
    queryKey: ['sections', 'mine'],
    queryFn: () => api.get<List<SectionRow>>('/api/v1/academics/sections?mine=true'),
  })
  const paper = (papers.data?.items ?? []).find((p) => p.id === esID)
  const ofClass = (sections.data?.items ?? []).filter((x) => x.class_id === paper?.class_id)

  const book = useQuery({
    queryKey: ['gradebook', esID, sectionID],
    queryFn: () => api.get<List<Row>>(
      `/api/v1/exams/gradebook?exam_subject_id=${esID}` +
      (sectionID ? `&section_id=${sectionID}` : '')),
    enabled: !!esID,
  })

  const toast = useToast()

  /* Setting the paper up is the exam cell's, entering the marks is the
     teacher's. Both live on this screen because they happen in that order. */
  const maySetUp = useCan()('academics.exams.write')

  const rows = book.data?.items ?? []
  /* A class of sixty is scrolled, and a mark typed against the wrong row is
     the error nobody catches until a report card is printed. */
  const { q: term, setQ: setTerm, shown } = useSearch(rows,
    (x) => [x.admission_no, x.full_name])

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
            {/* Import, not export.

                Export sat on the screen whose job is putting marks IN, and
                downloaded every mark in the school — the wrong direction and
                the wrong scope on a teacher's page. */}
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted">
              <Upload className="h-3.5 w-3.5" aria-hidden />
              Import marks
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) importSheet(f)
                  // Cleared so the same file can be picked twice after a fix.
                  e.target.value = ''
                }}
              />
            </label>
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
            {/* Only once a paper is chosen: before that there is no class, so
                there is no set of sections to offer. Hidden rather than
                disabled when the class has one section — a choice with one
                option is a control that does nothing. */}
            {esID && ofClass.length > 1 && (
              <Select
                value={sectionID}
                onChange={(v) => { setSectionID(v); setDraft({}); setAbsent({}) }}
                placeholder="All sections"
                options={[
                  { value: '', label: 'All sections' },
                  ...ofClass.map((x) => ({ value: x.id, label: `${x.class_name}-${x.name}` })),
                ]}
              />
            )}
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

            {/* Only for somebody who may actually set it.

                Deciding a paper is out of twenty rather than eighty is an
                exam-cell decision, and the endpoint is gated on
                academics.exams.write — which a subject teacher does not hold.
                The card was drawn for everybody, so a teacher opening the
                gradebook to enter marks met "missing permission:
                academics.exams.write" before she had typed anything, and had
                no way to know the message was not about the marks. */}
            {entered === 0 && maySetUp && (
              <Card>
                <CardHeader
                  title="Set up this paper"
                  description={`Out of ${max} at the moment. Change it before you start — it locks once the first mark is saved.`}
                />
                {/* Card draws the border; the screen supplies the padding
                    inside it. Without this the fields ran to the card's edge
                    and the Save button was clipped by it. */}
                <div className="space-y-4 px-5 pb-5">
                {setupNote && <FormNotice ok={setupNote} />}
                {setup.error && <FormNotice error={setup.error} />}
                <FormGrid>
                  <Field label="Out of" hint="Usually 20, 80 or 100.">
                    <Input
                      type="number"
                      value={outOf}
                      onChange={setOutOf}
                      placeholder={String(max)}
                    />
                  </Field>
                  <Field label="Grade scale" hint="Applies to every paper in this exam.">
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
                  Save
                </Button>
                </div>
              </Card>
            )}

            {(importNote || importErr) && (
              <div className="space-y-2">
                {importNote && <FormNotice ok={importNote} />}
                {importErr && <FormNotice error={new Error(importErr)} />}
              </div>
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
              <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
                <SearchBox value={term} onChange={setTerm} placeholder="Name or admission no." />
                <Showing shown={shown.length} total={rows.length} noun="students" />
                <ExportRows
                  rows={shown}
                  name="marks"
                  columns={[
                    { header: 'Admission no', value: (x) => x.admission_no },
                    { header: 'Student', value: (x) => x.full_name },
                    { header: 'Marks', value: (x) => x.marks_obtained },
                    { header: 'Out of', value: (x) => x.max_marks },
                    { header: 'Absent', value: (x) => (x.is_absent ? 'yes' : 'no') },
                    { header: 'Grade', value: (x) => x.grade },
                  ]}
                />
              </div>
              {/* The section column only when the sheet mixes them. Filtered to
                  one, every row would carry the same value the picker above
                  already shows. */}
              <Table
                head={['Admission no.', 'Student', ...(sectionID ? [] : ['Section']), 'Marks', 'Absent', 'Grade']}
                empty={!shown.length}
              >
                {shown.map((r) => (
                  <tr key={r.student_id}>
                    <Td className="font-mono text-[12px]">{r.admission_no}</Td>
                    <Td className="font-medium">{r.full_name}</Td>
                    {!sectionID && <Td className="text-muted-foreground">{r.section || '—'}</Td>}
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
