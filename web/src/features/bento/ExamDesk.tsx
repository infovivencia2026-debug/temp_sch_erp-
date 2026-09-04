import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Gauge, Rows } from './bento-cards'
import { Facts, PersonaCard, PersonaPage, Say, useShape } from './persona-kit'
import { Widget } from './WidgetLayer'
import { inClassic } from './classic-board'

/* THE EXAM OFFICE'S DESK.

   Three cells, every figure from two lists the exam controller already
   reads: `/exams/list` (every exam, its date and whether it is published)
   and `/exams/subjects` (every paper, with marks entered against marks
   expected). Nothing is derived from a total this payload does not carry:
   the gauge is entered over expected, both counted by the server, and the
   ranking is papers against papers in one unit — marks still missing. */

interface Exam {
  id: string
  name: string
  kind: string
  starts_on?: string
  is_published: boolean
  papers: number
}
interface Paper {
  id: string
  exam_name: string
  subject: string
  class_name: string
  label: string
  marks_entered: number
  students: number
}

function today(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

function ExamDesk() {
  const exams = useQuery({
    queryKey: ['exams'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })
  const papers = useQuery({
    queryKey: ['exam-papers'],
    queryFn: () => api.get<List<Paper>>('/api/v1/exams/subjects'),
  })
  const toExams = useFeatureHref('exam_controller.examinations.exams_papers')
  const toCards = useFeatureHref('exam_controller.examinations.report_cards')

  if (exams.isLoading || papers.isLoading) return <BentoLoading message="Reading the exam calendar…" />
  if (exams.error) return <BentoError message={String(exams.error)} />
  if (papers.error) return <BentoError message={String(papers.error)} />

  const list = exams.data?.items ?? []
  const all = papers.data?.items ?? []

  return (
    <PersonaPage eyebrow="Home" title="Exam desk" dashboard="exam_desk">
      <Widget id="calendar" label="Exams" size="large" index={0}>
        {(span) => <CalendarCell span={span} exams={list} to={toExams} />}
      </Widget>
      <Widget id="marks" label="Marks in" size="small" index={1}>
        {(span) => <MarksCell span={span} papers={all} to={toCards} />}
      </Widget>
      <Widget id="short" label="Papers short" size="small" index={2}>
        {(span) => <ShortCell span={span} papers={all} to={toExams} />}
      </Widget>
    </PersonaPage>
  )
}

function CalendarCell({ span, exams, to }: { span: CellSpan; exams: Exam[]; to?: string }) {
  const { tall } = useShape()
  const day = today()
  const upcoming = exams
    .filter((e) => (e.starts_on ?? '') >= day)
    .sort((a, b) => (a.starts_on ?? '').localeCompare(b.starts_on ?? ''))
  const published = exams.filter((e) => e.is_published).length
  const facts = upcoming.slice(0, tall ? 6 : 3).map((e) => ({
    label: e.name,
    value: e.starts_on ?? '—',
  }))
  return (
    <PersonaCard
      span={span}
      ground="academics"
      title="Exams ahead"
      glyph="◷"
      value={upcoming.length}
      change={`${exams.length} this year, ${published} published`}
      to={to}
      cueLabel="Open exams and papers"
    >
      {facts.length === 0 ? (
        <Say>{exams.length === 0 ? 'No exam has been scheduled yet' : 'Nothing further on the calendar'}</Say>
      ) : (
        <Facts items={facts} srLabel="The next exams and their dates" />
      )}
    </PersonaCard>
  )
}

function MarksCell({ span, papers, to }: { span: CellSpan; papers: Paper[]; to?: string }) {
  const entered = papers.reduce((a, p) => a + p.marks_entered, 0)
  const expected = papers.reduce((a, p) => a + p.students, 0)
  const short = papers.filter((p) => p.marks_entered < p.students).length
  return (
    <PersonaCard
      span={span}
      title="Marks in"
      glyph="✓"
      value={expected === 0 ? '—' : `${Math.round((entered / expected) * 100)}%`}
      change={
        papers.length === 0
          ? 'No paper set yet'
          : short === 0
            ? 'Every paper is complete'
            : `${short} of ${papers.length} papers still short`
      }
      to={to}
      cueLabel="Open report cards"
    >
      {expected === 0 ? (
        <Say>No marks are expected yet</Say>
      ) : (
        <Gauge value={entered} total={expected} srLabel="Marks entered out of marks expected" />
      )}
    </PersonaCard>
  )
}

function ShortCell({ span, papers, to }: { span: CellSpan; papers: Paper[]; to?: string }) {
  const { tall } = useShape()
  const rows = papers
    .map((p) => ({ label: `${p.subject} ${p.class_name}`, value: p.students - p.marks_entered }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, tall ? 8 : 4)
  const missing = rows.reduce((a, r) => a + r.value, 0)
  return (
    <PersonaCard
      span={span}
      title="Marks missing"
      glyph="•"
      value={missing}
      change={rows.length === 0 ? 'Nothing outstanding' : 'By paper, most short first'}
      to={to}
      cueLabel="Open exams and papers"
    >
      {rows.length === 0 ? (
        <Say>Every paper has its marks</Say>
      ) : (
        <Rows items={rows} srLabel="Papers by marks still missing" />
      )}
    </PersonaCard>
  )
}

export const Classic = inClassic(ExamDesk)
export default ExamDesk
