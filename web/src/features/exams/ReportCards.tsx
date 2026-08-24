import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Printer, TriangleAlert } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Input, Select, Loading, ErrorState, FormNotice,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'

/* One report card, for everybody who has to look at one.
 *
 * The class teacher's copy is this screen: every child in the section in roll
 * order, each row opening into the subject-by-subject breakdown the card is
 * actually made of. The family reads the same rows through the portal once
 * they are published, and each child sees only their own — the narrowing is
 * the server's, so there is no second screen to drift out of step with this
 * one.
 *
 * Roll order, not rank. The old list was ranked, which is the right order for
 * a prize-giving and the wrong one for a class teacher checking that thirty
 * cards are correct: they are holding a mark list in roll order and reading
 * down it.
 *
 * Readiness sits above the table because a card generated before every subject
 * teacher has entered marks is not blank. It totals the marks that exist and
 * divides by the marks that were expected, so a paper nobody has marked yet
 * reads exactly like a paper the child failed.
 */

interface Exam { id: string; name: string; kind: string; papers: number }

interface SubjectMark {
  subject: string
  marks_obtained?: number
  max_marks: number
  percent?: number
  grade?: string
  is_absent: boolean
}

interface ReportCard {
  student_id: string; admission_no: string; roll_no?: number; full_name: string
  class_name?: string; section_name?: string
  total_marks?: number; max_marks?: number; percentage?: number
  grade?: string; rank_in_section?: number; attendance_percent?: number
  is_published: boolean
  subjects: SubjectMark[]
}

interface Readiness {
  subject: string
  teacher?: string
  marks_entered: number
  students: number
}

export default function ReportCards() {
  const nav = useRouteFeature()
  const qc = useQueryClient()
  const [sectionId, setSectionId] = useState('')
  const [examId, setExamId] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  /* Finding one child in a section of forty.
   *
   * A principal opens this because a parent is on the telephone or the board
   * has asked about one student, not to read thirty cards in order. Roll
   * number, name and admission number all match, because which of the three
   * somebody has to hand depends on who rang. */
  const [find, setFind] = useState('')

  const exams = useQuery({
    queryKey: ['exam-list'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })
  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections?mine=class_teacher'),
  })
  const cards = useQuery({
    queryKey: ['report-cards', sectionId, examId],
    queryFn: () =>
      api.get<List<ReportCard>>(
        `/api/v1/exams/report-cards?section_id=${sectionId}${examId ? `&exam_id=${examId}` : ''}`,
      ),
    enabled: !!sectionId,
  })
  const readiness = useQuery({
    queryKey: ['report-readiness', sectionId, examId],
    queryFn: () =>
      api.get<List<Readiness>>(
        `/api/v1/exams/report-cards/readiness?section_id=${sectionId}&exam_id=${examId}`,
      ),
    enabled: !!sectionId && !!examId,
  })
  /* Generate used to say nothing at all — no card, no error, no explanation —
   * which leaves somebody unable to tell whether the button is broken, the
   * marks are missing or they picked the wrong section. The server now refuses
   * with a reason when it would write nothing; this shows both that and the
   * count when it works. */
  const [outcome, setOutcome] = useState('')
  const generate = useMutation({
    mutationFn: (publish: boolean) =>
      api.post<{ report_cards: number; published: boolean }>(
        '/api/v1/exams/report-cards/generate',
        { exam_id: examId, section_id: sectionId, publish },
      ),
    onSuccess: (r, publish) => {
      setOutcome(
        `${r.report_cards} report ${r.report_cards === 1 ? 'card' : 'cards'} ` +
          (publish ? 'generated and published — the families have been told.' : 'generated. Nobody has been told yet; publish when you are ready.'),
      )
      qc.invalidateQueries({ queryKey: ['report-cards', sectionId, examId] })
      qc.invalidateQueries({ queryKey: ['report-readiness', sectionId, examId] })
    },
    onError: () => setOutcome(''),
  })

  const all = cards.data?.items ?? []
  const needle = find.trim().toLowerCase()
  const rows = needle
    ? all.filter(
        (r) =>
          String(r.roll_no ?? '') === needle ||
          r.full_name.toLowerCase().includes(needle) ||
          r.admission_no.toLowerCase().includes(needle),
      )
    : all
  // Counted over the whole section, not the search. A section average that
  // changes as somebody types a name is not a section average.
  const published = all.filter((r) => r.is_published).length
  const avg = all.length
    ? (all.reduce((a, r) => a + (r.percentage ?? 0), 0) / all.length).toFixed(1)
    : '—'

  const papers = readiness.data?.items ?? []
  const outstanding = papers.filter((p) => p.marks_entered < p.students)
  // Every subject teacher has finished. Publishing before this is what turns
  // an unmarked paper into a failed one on somebody's card.
  const ready = papers.length > 0 && outstanding.length === 0

  return (
    <>
      {/* Two catalogue entries open this screen — "Academic Performance"
          under Students, and "Exams & results" under Examinations — and it
          announced itself as "Examinations / Report cards" whichever one you
          came through. Whoever clicked from Students had every word on the
          band disagree with the word they clicked. The catalogue answers per
          route, so both are right now. */}
      <PageHead
        eyebrow={nav.section?.name ?? 'Examinations'}
        title={nav.feature?.name ?? 'Report cards'}
        description="Every child in the section in roll order, with the subject breakdown behind each row. Publishing tells the family."
        actions={
          <>
            {/* The search leads, because finding one child is what this screen
                is opened for far more often than rebuilding thirty cards. */}
            <Input
              value={find}
              onChange={setFind}
              placeholder="Search roll no, name or admission no"
              className="w-64"
            />
            <Select value={sectionId} onChange={setSectionId} placeholder="Section"
              options={(sections.data?.items ?? []).map((s) => ({
                value: s.id, label: `${s.class_name}-${s.name}`,
              }))} />
            <Select
              value={examId}
              onChange={setExamId}
              placeholder="Choose an exam"
              options={(exams.data?.items ?? []).map((e) => ({
                value: e.id, label: `${e.name} (${e.papers} papers)`,
              }))}
            />
            <Button variant="secondary" disabled={!sectionId || !examId || generate.isPending}
              onClick={() => generate.mutate(false)}>
              {generate.isPending ? 'Generating…' : 'Generate'}
            </Button>
            <Button
              variant="secondary"
              disabled={!sectionId || !examId || generate.isPending}
              onClick={() => generate.mutate(true)}
              title={
                ready
                  ? 'Publish to the families and the students'
                  : 'Some papers are still unmarked — publishing now prints them as zero'
              }
            >
              Generate &amp; publish
            </Button>
            {rows.length > 0 && (
              <Button variant="ghost" onClick={() => window.print()}>
                <Printer className="h-3.5 w-3.5" />
                Print
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        {generate.error && <FormNotice error={generate.error} />}
        {outcome && <FormNotice ok={outcome} />}
        <CellGrid cols={4}>
          <Stat label="Report cards" value={all.length} />
          <Stat label="Published" value={published} hint={`${all.length - published} draft`} />
          <Stat label="Section average" value={avg !== '—' ? `${avg}%` : '—'} />
          <Stat label="Topper" value={all.find((r) => r.rank_in_section === 1)?.full_name ?? '—'} />
        </CellGrid>

        {examId && papers.length > 0 && (
          <Card className={outstanding.length ? 'border-warning' : undefined}>
            <CardHeader
              title={
                outstanding.length
                  ? `${outstanding.length} ${outstanding.length === 1 ? 'paper is' : 'papers are'} still being marked`
                  : 'Every subject teacher has finished'
              }
              description={
                outstanding.length
                  ? 'A card generated now totals the marks that exist over the marks that were expected, so an unmarked paper prints as a failed one.'
                  : 'Marks are complete for every paper in this exam. The cards will be right.'
              }
            />
            {outstanding.length > 0 && (
              <ul className="divide-y">
                {outstanding.map((p) => (
                  <li key={p.subject} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                    <span className="min-w-[10rem] flex-1 text-[14px] font-medium">{p.subject}</span>
                    {/* Named, because "three papers outstanding" is a fact and
                        "Physics, Mrs Rao" is something you can act on. */}
                    <span className="text-[13px] text-muted-foreground">
                      {p.teacher ?? 'no teacher allocated'}
                    </span>
                    <span className="text-[13px] tabular-nums text-muted-foreground">
                      {p.marks_entered}/{p.students} entered
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card>
          {/* The search belongs to the table it filters.
              It sat in the page's action row between Generate and Print, where
              a box that changes what you are looking at reads like a box that
              does something. */}
          <CardHeader
            title="Results"
            description={
              needle
                ? `${rows.length} matching "${find.trim()}". Open a row for the subject breakdown.`
                : 'Roll order. Open a row for the subject breakdown.'
            }
          />
          {cards.isLoading ? <Loading /> : cards.error ? <ErrorState error={cards.error} /> : (
            <Table
              head={['Roll', 'Admission no.', 'Student', 'Total', 'Percentage', 'Grade', 'Attendance', 'State', '']}
              empty={!rows.length}
              emptyLabel={
                needle
                  ? `Nobody in this section matches "${find.trim()}".`
                  : sectionId
                    ? 'No report cards generated for this section yet.'
                    : 'Choose a section to see its report cards.'
              }
            >
              {rows.map((r) => (
                <>
                  <tr key={r.student_id}>
                    <Td className="font-medium tabular-nums">{r.roll_no ?? '—'}</Td>
                    <Td className="font-mono text-[12px]">{r.admission_no}</Td>
                    <Td className="font-medium">{r.full_name}</Td>
                    <Td>{r.total_marks ?? '—'}{r.max_marks ? ` / ${r.max_marks}` : ''}</Td>
                    <Td>{r.percentage != null ? `${r.percentage}%` : '—'}</Td>
                    <Td>{r.grade ? <Badge tone="primary">{r.grade}</Badge> : '—'}</Td>
                    <Td>
                      {r.attendance_percent != null && (
                        <Badge tone={r.attendance_percent < 75 ? 'danger' : 'success'}>
                          {r.attendance_percent}%
                        </Badge>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={r.is_published ? 'success' : 'neutral'}>
                        {r.is_published ? 'published' : 'draft'}
                      </Badge>
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpen(open === r.student_id ? null : r.student_id)}
                      >
                        {open === r.student_id ? 'Close' : 'Open'}
                      </Button>
                    </Td>
                  </tr>
                  {open === r.student_id && (
                    <tr key={`${r.student_id}-subjects`}>
                      <Td colSpan={9} className="bg-muted/30">
                        <SubjectBreakdown subjects={r.subjects} />
                      </Td>
                    </tr>
                  )}
                </>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/**
 * The card itself: one line per subject, with what it was out of.
 *
 * A percentage with nothing underneath it tells a parent their child got 62%
 * and not which subject to help them with, which is the only reason anybody
 * reads a report card at home.
 *
 * A subject with no mark says so rather than showing a zero. The two look the
 * same in a total and mean opposite things.
 */
function SubjectBreakdown({ subjects }: { subjects: SubjectMark[] }) {
  if (!subjects?.length) {
    return (
      <p className="px-2 py-2 text-[13px] text-muted-foreground">
        No papers are attached to this exam for this class yet.
      </p>
    )
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1.5 font-medium">Subject</th>
          <th className="py-1.5 font-medium">Marks</th>
          <th className="py-1.5 font-medium">Percentage</th>
          <th className="py-1.5 font-medium">Grade</th>
        </tr>
      </thead>
      <tbody>
        {subjects.map((s) => (
          <tr key={s.subject} className="border-t">
            <td className="py-1.5">{s.subject}</td>
            <td className="py-1.5 tabular-nums">
              {s.is_absent
                ? 'absent'
                : s.marks_obtained == null
                  ? 'not marked'
                  : `${s.marks_obtained} / ${s.max_marks}`}
            </td>
            <td className="py-1.5 tabular-nums">{s.percent != null ? `${s.percent}%` : '—'}</td>
            <td className="py-1.5">{s.grade ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
