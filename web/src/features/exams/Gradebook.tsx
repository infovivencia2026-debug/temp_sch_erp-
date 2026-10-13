import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Upload } from 'lucide-react'
import type { GradebookRow } from '@shared/api'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, SkeletonTiles, ErrorState, EmptyState, PrintButton, FormNotice, FormGrid, Field, Input,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { downloadCSV, SearchBox, Showing, useSearch } from '@/components/rows'
import { marksTemplate, readMarksSheet } from './marksSheet'
import ClassSheet from './ClassSheet'
import { useToast } from '@/components/Toast'

interface Paper {
  id: string; label: string; max_marks: number
  marks_entered: number; students: number
  exam_id: string; exam_name: string; exam_kind: string
  class_id: string; class_name: string; subject: string
}

type Row = GradebookRow

interface PartMarks {
  parts: { id: string; name: string; max_marks: number }[]
  items: { student_id: string; parts: Record<string, number | null> }[]
  bands?: { grade: string; min: number; max: number }[]
}

interface SectionRow { id: string; name: string; class_id: string; class_name: string }

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
  /* The whole class at once: every subject of the chosen exam and class. */
  const [wholeClass, setWholeClass] = useState(false)

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
  /* Per-part typing, for an exam marked in parts: student -> part -> box. */
  const [partDraft, setPartDraft] = useState<Record<string, Record<string, string>>>({})
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
      /* The template's own columns are found by heading, so the file the
         Template button wrote goes back in unchanged; a blank cell is "not
         entered", AB is absent, and a bad number is named, row by row. */
      const got = readMarksSheet(String(reader.result ?? ''), rows, parts, paper?.max_marks ?? 0)
      if (got.filled === 0 && got.missed.length === 0 && got.errors.length === 0) {
        setImportErr('Nothing in that file looked like a marks sheet, or every mark in it was blank.')
        return
      }
      if (hasParts) setPartDraft((d) => ({ ...d, ...got.parts }))
      else setDraft((d) => ({ ...d, ...got.marks }))
      setAbsent((d) => ({ ...d, ...got.absent }))
      setImportNote(
        got.partColumns
          ? `${got.filled} ${got.filled === 1 ? 'child' : 'children'} filled in across ${got.partColumns} part${got.partColumns === 1 ? '' : 's'}. Check them, then press Save marks.`
          : `${got.filled} mark${got.filled === 1 ? '' : 's'} filled in. Check them, then press Save marks.`,
      )
      const problems: string[] = []
      if (got.errors.length) {
        problems.push(got.errors.slice(0, 6).join('; ') + (got.errors.length > 6 ? ` and ${got.errors.length - 6} more` : '') + '. Those rows were left alone.')
      }
      if (got.missed.length) {
        problems.push(`Nobody in this paper matched: ${got.missed.slice(0, 6).join(', ')}` +
          (got.missed.length > 6 ? ` and ${got.missed.length - 6} more` : '') + '. Those rows were left alone.')
      }
      if (problems.length) setImportErr(problems.join(' '))
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
    setPartDraft({})
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
    queryFn: () => api.call('GET /exams/gradebook', { query: { exam_subject_id: esID, section_id: sectionID } }),
    enabled: !!esID,
  })

  /* An exam marked in parts (Written, Project, Notebook...): one box per part
     and the paper's mark is their sum, worked out by the server. With no
     parts this answers an empty list and the sheet is the one-figure sheet. */
  const partQ = useQuery({
    queryKey: ['part-marks', esID],
    queryFn: () => api.get<PartMarks>(`/api/v1/exams/subjects/${esID}/part-marks`),
    enabled: !!esID,
  })
  const parts = partQ.data?.parts ?? []
  const hasParts = parts.length > 0
  const savedParts = new Map((partQ.data?.items ?? []).map((x) => [x.student_id, x.parts]))
  const partOf = (sid: string, pid: string) => {
    const typed = partDraft[sid]?.[pid]
    if (typed !== undefined) return typed
    const v = savedParts.get(sid)?.[pid]
    return v == null ? '' : String(v)
  }
  const partTotal = (sid: string) => {
    const vals = parts.map((p) => partOf(sid, p.id)).filter((v) => v.trim() !== '' && Number.isFinite(Number(v)))
    return vals.length ? vals.reduce((a, v) => a + Number(v), 0) : null
  }
  const setPart = (sid: string, pid: string, v: string) =>
    setPartDraft((d) => ({ ...d, [sid]: { ...(d[sid] ?? {}), [pid]: v } }))

  const toast = useToast()

  /* Total and grade as they will be once saved, live while typing or after an
     import, by the paper's own grade bands -- so a sheet loaded from a file
     and marks typed by hand look the same before Save. Untouched rows show
     what the server recorded. */
  const bands = partQ.data?.bands ?? []
  const liveTotal = (r: Row): number | null => {
    if (absent[r.student_id] ?? r.is_absent) return null
    if (hasParts) return partTotal(r.student_id)
    const v = draft[r.student_id] ?? (r.marks_obtained != null ? String(r.marks_obtained) : '')
    return v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null
  }
  const liveGrade = (r: Row): string | null => {
    const dirty = draft[r.student_id] !== undefined || absent[r.student_id] !== undefined || partDraft[r.student_id] !== undefined
    if (!dirty) return r.grade ?? null
    const t = liveTotal(r)
    if (t === null || !bands.length || !r.max_marks) return null
    const pct = (t / r.max_marks) * 100
    return bands.find((b) => pct >= b.min && pct <= b.max)?.grade ?? null
  }

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
    (r) => draft[r.student_id] !== undefined || absent[r.student_id] !== undefined ||
      (hasParts && partDraft[r.student_id] !== undefined),
  )

  /* A mark the server will refuse.
     It rejects the whole batch for one bad number — correctly, since 950 for 95
     must not become a pass — so a typo would lose the other thirty-nine entries
     and the message would not say whose. Caught here, before it is sent, and
     the box carrying it is named. `parseFloat` used to turn a cleared field
     into NaN, which JSON writes as null: the mark was quietly erased. */
  const partBad = (r: Row, pid: string, max: number) => {
    const raw = partDraft[r.student_id]?.[pid]
    if (isAbsent(r) || raw === undefined || raw.trim() === '') return false
    const n = Number(raw)
    return !Number.isFinite(n) || n < 0 || n > max
  }
  const invalid = touched.filter((r) => {
    if (hasParts) return parts.some((p) => partBad(r, p.id, p.max_marks))
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
    (p) => (!classID || p.class_id === classID) && (!examKind || p.exam_id === examKind),
  )

  const save = useMutation({
    mutationFn: () => hasParts
      ? api.put(`/api/v1/exams/subjects/${esID}/part-marks`, {
          entries: touched.map((r) => ({
            student_id: r.student_id,
            is_absent: isAbsent(r),
            // Only the boxes typed in; an emptied box clears that part.
            parts: Object.fromEntries(Object.entries(partDraft[r.student_id] ?? {})
              .map(([pid, v]) => [pid, v.trim() === '' ? null : Number(v)])),
          })),
        })
      : api.call('POST /exams/marks', { body: {
        exam_subject_id: esID,
        entries: touched.map(entryFor),
      } }),
    onSuccess: () => {
      // Counted before the draft is cleared: the mutation builds its own
      // payload, so there is nothing handed back to count.
      const entered = touched.length
      setDraft({}); setPartDraft({}); setAbsent({})
      qc.invalidateQueries({ queryKey: ['gradebook', esID] })
      qc.invalidateQueries({ queryKey: ['part-marks', esID] })
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
            {/* THE SHEET TO FILL IN (owner, 2026-10-13: "with templent of
                roll no grade name subject and the parts and total marks").

                Who the row is, so whoever types into it can see they have the
                right child, and the class and subject on every row so a file
                that has been emailed about for a week still says what it is.
                One column per part where the exam has them, each headed with
                what it is out of; one Marks column where it has not. Total is
                left blank on purpose -- it is the parts added up, worked out
                here, and a figure typed into it would be ignored. */}
            {paper && rows.length > 0 && (
              <Button
                variant="secondary"
                title="Every child on this paper, with a column to type marks in. Fill it and import the same file."
                onClick={() => downloadCSV(
                  marksTemplate(paper, rows, parts, savedParts),
                  `marks-${paper.class_name}-${paper.subject}-${paper.exam_name}`.replace(/\s+/g, '-'),
                )}
              >
                <Download className="h-4 w-4" />
                Template
              </Button>
            )}
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
            {classID && examKind && visible.length > 0 && (
              <Button
                variant={wholeClass ? 'primary' : 'secondary'}
                title="Every subject of this class in this exam on one sheet"
                onClick={() => { setWholeClass((w) => !w); setESID('') }}
              >
                Whole class sheet
              </Button>
            )}
            <PrintButton />
            <Select
              value={classID}
              onChange={(v) => { setClassID(v); setESID(''); if (!v) setWholeClass(false) }}
              placeholder="Any class"
              options={[
                { value: '', label: 'Any class' },
                ...classOptions(all),
              ]}
            />
            <Select
              value={examKind}
              onChange={(v) => { setExamKind(v); setESID(''); if (!v) setWholeClass(false) }}
              placeholder="Any exam"
              options={[
                { value: '', label: 'Any exam' },
                ...examOptions(all),
              ]}
            />
            <Select
              value={esID}
              onChange={pickPaper}
              placeholder={visible.length ? 'Choose a paper' : 'No papers match'}
              options={visible.map((p) => ({
                value: p.id,
                label: `${p.subject} · ${p.exam_name} · ${p.marks_entered}/${p.students} entered`,
              }))}
            />
            {/* Only once a paper is chosen: before that there is no class, so
                there is no set of sections to offer. Hidden rather than
                disabled when the class has one section — a choice with one
                option is a control that does nothing. */}
            {esID && ofClass.length > 1 && (
              <Select
                value={sectionID}
                onChange={(v) => { setSectionID(v); setDraft({}); setPartDraft({}); setAbsent({}) }}
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
        {wholeClass && classID && examKind && visible.length > 0 && !esID ? (
          <ClassSheet
            key={`${classID}-${examKind}`}
            papers={visible.map((p) => ({ id: p.id, subject: p.subject, max_marks: p.max_marks }))}
            className={visible[0].class_name}
            examName={visible[0].exam_name}
          />
        ) : !esID ? (
          <EmptyState
            title="Choose a paper"
            body={
              papers.data?.items.length
                ? 'Pick a paper above to start entering marks.'
                : 'No exam papers exist yet. Create an exam in setup first.'
            }
          />
        ) : book.isLoading ? (
          <SkeletonTiles count={4} />
        ) : book.error ? (
          <ErrorState error={book.error} />
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat label="Students" value={rows.length} />
              <Stat label="Marks entered" value={`${entered}/${rows.length}`} />
              <Stat label="Class average" value={entered ? `${avg}/${max}` : '-'} />
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
                  description={`Out of ${max} at the moment. Change it before you start, it locks once the first mark is saved.`}
                />
                {/* Card draws the border; the screen supplies the padding
                    inside it. Without this the fields ran to the card's edge
                    and the Save button was clipped by it. */}
                <div className="space-y-4 px-5 pb-5">
                {setupNote && <FormNotice ok={setupNote} />}
                {setup.error && <FormNotice error={setup.error} />}
                <FormGrid>
                  {/* Marked in parts, the paper is out of the parts' sum: that is changed under Parts on the Exams screen. */}
                  {!hasParts && <Field label="Out of" hint="Usually 20, 80 or 100.">
                    <Input
                      type="number"
                      value={outOf}
                      onChange={setOutOf}
                      placeholder={String(max)}
                    />
                  </Field>}
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
                description={hasParts ? `Out of ${max}: ${parts.map((p) => `${p.name} ${p.max_marks}`).join(' + ')}` : `Out of ${max}`}
                action={
                  <Button
                    disabled={save.isPending || !touched.length || invalid.length > 0}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? 'Saving…' : 'Save marks'}
                  </Button>
                }
              />
              <div className="flex flex-wrap items-center gap-2 px-5 pb-3 pt-3">
                <SearchBox value={term} onChange={setTerm} placeholder="Name or admission no." />
                <Showing shown={shown.length} total={rows.length} noun="students" />
                {/* Export is the template too: every child, a column to type in,
                    what is recorded already filled, and it imports unchanged. */}
                <Button
                  variant="secondary"
                  title="Download every child with their marks; fill it and import the same file"
                  onClick={() => paper && downloadCSV(
                    marksTemplate(paper, rows, parts, savedParts),
                    `marks-${paper.class_name}-${paper.subject}-${paper.exam_name}`.replace(/\s+/g, '-'),
                  )}
                >
                  <Download className="h-4 w-4" />
                  Export
                </Button>
              </div>
              {/* The section column only when the sheet mixes them. Filtered to
                  one, every row would carry the same value the picker above
                  already shows. */}
              <Table
                head={['Admission no.', 'Student', ...(sectionID ? [] : ['Section']),
                  ...(hasParts ? [...parts.map((p) => `${p.name} (${p.max_marks})`), 'Total'] : [`Marks (${max})`, 'Total']), 'Absent', 'Grade']}
                empty={!shown.length}
              >
                {shown.map((r) => (
                  <tr key={r.student_id}>
                    <Td className="font-mono text-[12px]">{r.admission_no}</Td>
                    <Td className="font-medium">{r.full_name}</Td>
                    {!sectionID && <Td className="text-muted-foreground">{r.section || '-'}</Td>}
                    {hasParts ? (<>
                      {parts.map((p) => (
                        <Td key={p.id}>
                          <Input
                            type="number" min={0} max={p.max_marks}
                            disabled={isAbsent(r)}
                            value={partOf(r.student_id, p.id)}
                            onChange={(v) => setPart(r.student_id, p.id, v)}
                            srLabel={`${p.name} for ${r.full_name}, out of ${p.max_marks}`}
                            ariaInvalid={partBad(r, p.id, p.max_marks) || undefined}
                            className="w-20 disabled:opacity-40"
                          />
                        </Td>
                      ))}
                      <Td className="font-medium tabular-nums">
                        {isAbsent(r) ? '-' : partTotal(r.student_id) ?? '-'}
                      </Td>
                    </>) : (
                    <Td>
                      <Input
                        type="number" min={0} max={r.max_marks}
                        disabled={isAbsent(r)}
                        value={markOf(r)}
                        onChange={(v) => setDraft({ ...draft, [r.student_id]: v })}
                        srLabel={`Marks for ${r.full_name}, out of ${r.max_marks}`}
                        ariaInvalid={invalid.some((x) => x.student_id === r.student_id) || undefined}
                        className="w-24 disabled:opacity-40"
                      />
                    </Td>
                    )}
                    {!hasParts && (
                      <Td className="font-medium tabular-nums">{liveTotal(r) ?? '-'}</Td>
                    )}
                    <Td>
                      <input
                        type="checkbox"
                        checked={isAbsent(r)}
                        onChange={() => setAbsent({ ...absent, [r.student_id]: !isAbsent(r) })}
                        aria-label={`Mark ${r.full_name} absent`}
                      />
                    </Td>
                    <Td>{liveGrade(r) ? <Badge tone="primary">{liveGrade(r)}</Badge> : '-'}</Td>
                  </tr>
                ))}
              </Table>
              {invalid.length > 0 && (
                <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
                  {hasParts
                    ? `A part mark must be a number between 0 and that part's maximum: ${invalid.map((r) => r.full_name).join(', ')}.`
                    : invalid.length === 1
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

/* THE EXAM, BY ITS NAME (owner, 2026-10-13: "should be FA-01").

   This listed exam_kind -- the three words the database files an exam under,
   "formative", "summative", "term" -- so a school that runs FA-01, FA-02 and
   SA-01 was offered "formative" and got all of them at once. Nobody marking
   asks for "a formative paper"; they ask for FA-01, which is what the school
   wrote on the timetable and on the board.

   So the exams themselves are listed, newest first, each with the kind in
   small print behind it for the schools whose exam names are not obvious. */
function examOptions(papers: Paper[]) {
  const seen = new Map<string, string>()
  for (const p of papers) if (p.exam_id && !seen.has(p.exam_id)) seen.set(p.exam_id, p.exam_name || p.exam_kind)
  return [...seen].map(([id, name]) => ({ value: id, label: name }))
}
