import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Printer, TriangleAlert } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Input, Select, Loading, ErrorState, FormNotice, EmptyState,
} from '@/components/ui'
import { ExportRows } from '@/components/rows'
import { useRouteFeature } from '@/lib/catalog'
import { useCan } from '@/lib/session'

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
  id: string; student_id: string; admission_no: string; roll_no?: number; full_name: string
  class_name?: string; section_name?: string
  total_marks?: number; max_marks?: number; percentage?: number
  grade?: string; rank_in_section?: number; attendance_percent?: number
  is_published: boolean
  /* draft → submitted → published, with returned as the way back.
     is_published only says whether a family can read it; this says whose desk
     the card is sitting on. */
  status: 'draft' | 'submitted' | 'returned' | 'published'
  return_note?: string
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
  /* Two letters, then the names.

     Typing into the box narrowed the table underneath and said nothing until
     it matched — so somebody who half-remembers a name types "nik" and reads
     "Nobody in this section matches", with no way to tell whether they have
     the spelling wrong or the wrong section. The suggestions answer that: they
     show who is actually here. One letter would offer half the section, which
     is the roll list they can already see. */
  const [suggesting, setSuggesting] = useState(false)

  const exams = useQuery({
    queryKey: ['exam-list'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })
  const sections = useQuery({
    queryKey: ['sections', 'class_teacher'],
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
          (publish ? 'generated and published — the parents have been told.' : 'generated. Nobody has been told yet; publish when you are ready.'),
      )
      qc.invalidateQueries({ queryKey: ['report-cards', sectionId, examId] })
      qc.invalidateQueries({ queryKey: ['report-readiness', sectionId, examId] })
    },
    onError: () => setOutcome(''),
  })

  /* Building a card and releasing it are different jobs, held by different
     people. The class teacher generates and sends up; the head signs off and
     the families are told. Both buttons used to be on every screen, so a
     teacher without the right filled the form and was refused on submit. */
  const can = useCan()
  const mayGenerate = can('academics.reportcards.generate')
  const mayPublish = can('academics.reportcards.publish')

  /* Ticked rows, so a head can act on the whole section, on the ones they
     picked, or on one child — the same three shapes as any other list, and
     one endpoint behind all of them: what is ticked is what is sent. */
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState('')

  const act = useMutation({
    mutationFn: (v: { verb: 'submit' | 'publish' | 'return'; ids: string[]; note?: string }) =>
      api.post<{ submitted?: number; published?: number; returned?: number }>(
        `/api/v1/exams/report-cards/${v.verb}`, { ids: v.ids, note: v.note },
      ),
    onSuccess: (r, v) => {
      const n = r.submitted ?? r.published ?? r.returned ?? 0
      const noun = `${n} report ${n === 1 ? 'card' : 'cards'}`
      setOutcome(
        v.verb === 'submit'
          ? `${noun} sent to the principal for approval.`
          : v.verb === 'publish'
            ? `${noun} published — the students and their parents have been told.`
            : `${noun} sent back to the class teacher with your note.`,
      )
      setPicked({})
      setNote('')
      qc.invalidateQueries({ queryKey: ['report-cards', sectionId, examId] })
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
  /* At most eight, because a list longer than the screen is one nobody reads
     to the end — and if eight children match, the word typed is not the one
     that finds anybody. */
  const suggestions = needle.length >= 2 && rows.length !== all.length ? rows.slice(0, 8) : []
  // Counted over the whole section, not the search. A section average that
  // changes as somebody types a name is not a section average.
  const published = all.filter((r) => r.is_published).length
  const awaiting = all.filter((r) => r.status === 'submitted')
  const sendable = all.filter((r) => r.status === 'draft' || r.status === 'returned')
  const ticked = all.filter((r) => picked[r.id])
  /* Nothing ticked means the whole section — "approve all" and "approve the
     ones I picked" are the same action with a different list, so there is one
     button rather than two that disagree about what "all" meant. */
  const toSubmit = (ticked.length ? ticked : sendable).filter(
    (r) => r.status === 'draft' || r.status === 'returned')
  const toDecide = (ticked.length ? ticked : awaiting).filter((r) => r.status === 'submitted')
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
        description="Every child in the section in roll order, with the subject breakdown behind each row. Publishing tells the parent."
        actions={
          <>
            {/* The search leads, because finding one child is what this screen
                is opened for far more often than rebuilding thirty cards. */}
            <div className="relative">
              <Input
                value={find}
                onChange={(v) => { setFind(v); setSuggesting(true) }}
                onFocus={() => setSuggesting(true)}
                // A blur that fires before the click would close the list out
                // from under the finger that was reaching for it.
                onBlur={() => window.setTimeout(() => setSuggesting(false), 150)}
                placeholder="Search roll no, name or admission no"
                className="w-64"
              />
              {suggesting && suggestions.length > 0 && (
                <ul className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md border bg-surface shadow-lg">
                  {suggestions.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted/60"
                        onClick={() => {
                          // The admission number, not the name: it is unique, so
                          // picking a child leaves exactly that child in the table
                          // even where two of them share a first name.
                          setFind(r.admission_no)
                          setSuggesting(false)
                        }}
                      >
                        <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                          {r.roll_no ?? '—'}
                        </span>
                        <span className="flex-1 font-medium">{r.full_name}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {r.admission_no}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
            {mayGenerate && (
              <Button variant="secondary" disabled={!sectionId || !examId || generate.isPending}
                onClick={() => generate.mutate(false)}>
                {generate.isPending ? 'Generating…' : 'Generate'}
              </Button>
            )}
            {/* The head's shortcut, and only theirs: a class teacher builds the
                cards and sends them up. The server refuses this either way; the
                button is hidden so nobody fills a form to be told no. */}
            {mayGenerate && mayPublish && (
              <Button
                variant="secondary"
                disabled={!sectionId || !examId || generate.isPending}
                onClick={() => generate.mutate(true)}
                title={
                  ready
                    ? 'Publish to the parents and the students'
                    : 'Some papers are still unmarked — publishing now prints them as zero'
                }
              >
                Generate &amp; publish
              </Button>
            )}
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
        {/* Nothing is claimed until an exam is chosen.
        
            These four read 0, 0, — and — before anybody picks one: a confident
            row of figures about an exam that has not been named. "Report cards
            0" is indistinguishable from a real exam with no cards generated. */}
        {!examId ? (
          <EmptyState
            title="Choose an exam"
            body="Report cards, averages and the topper are per exam. Pick one above to see where this section stands."
          />
        ) : (
          <CellGrid cols={4}>
            <Stat label="Report cards" value={all.length} />
            <Stat label="Published" value={published} hint={`${all.length - published} draft`} />
            <Stat label="Section average" value={avg !== '—' ? `${avg}%` : '—'} />
            <Stat label="Topper" value={all.find((r) => r.rank_in_section === 1)?.full_name ?? '—'} />
          </CellGrid>
        )}

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

        {/* Up, then out.

            The class teacher sends the set to the principal; the principal
            releases it to the children and their parents, or sends it back
            saying what is wrong. Whoever is looking sees only their half. */}
        {examId && (toSubmit.length > 0 || (mayPublish && awaiting.length > 0)) && (
          <Card>
            <CardHeader
              title={mayPublish && awaiting.length ? 'Waiting for your approval' : 'Send for approval'}
              description={
                mayPublish && awaiting.length
                  ? `${awaiting.length} ${awaiting.length === 1 ? 'card is' : 'cards are'} signed off by the class teacher and waiting on you. Tick rows below to act on some of them, or leave everything unticked to act on all.`
                  : 'The principal approves before a card reaches a family. Tick rows to send only those, or leave everything unticked to send the section.'
              }
            />
            <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
              {mayGenerate && toSubmit.length > 0 && (
                <Button
                  disabled={act.isPending}
                  onClick={() => act.mutate({ verb: 'submit', ids: toSubmit.map((r) => r.id) })}
                >
                  Send {toSubmit.length} for approval
                </Button>
              )}
              {mayPublish && toDecide.length > 0 && (
                <>
                  <Button
                    disabled={act.isPending}
                    onClick={() => act.mutate({ verb: 'publish', ids: toDecide.map((r) => r.id) })}
                    title={ready ? undefined : 'Some papers are still unmarked'}
                  >
                    Approve &amp; publish {toDecide.length}
                  </Button>
                  {/* The reason travels with the card. A set sent back without
                      one is a class teacher walking to the office to ask. */}
                  <Input
                    value={note}
                    onChange={setNote}
                    placeholder="Why it is going back"
                    className="w-72"
                  />
                  <Button
                    variant="secondary"
                    disabled={act.isPending || !note.trim()}
                    onClick={() => act.mutate({ verb: 'return', ids: toDecide.map((r) => r.id), note })}
                  >
                    Send back
                  </Button>
                </>
              )}
              {ticked.length > 0 && (
                <Button variant="ghost" onClick={() => setPicked({})}>
                  Clear {ticked.length} ticked
                </Button>
              )}
            </div>
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
            action={
              /* The sheet a class teacher takes into a parents' evening, and
                 the one a head of department asks for at the end of term. */
              <ExportRows
                rows={rows}
                name="report-cards"
                columns={[
                  { header: 'Roll', value: (r) => r.roll_no },
                  { header: 'Admission no', value: (r) => r.admission_no },
                  { header: 'Student', value: (r) => r.full_name },
                  { header: 'Class', value: (r) => r.class_name },
                  { header: 'Section', value: (r) => r.section_name },
                  { header: 'Total', value: (r) => r.total_marks },
                  { header: 'Out of', value: (r) => r.max_marks },
                  { header: 'Percentage', value: (r) => r.percentage },
                  { header: 'Grade', value: (r) => r.grade },
                  { header: 'Rank in section', value: (r) => r.rank_in_section },
                  { header: 'Attendance %', value: (r) => r.attendance_percent },
                  { header: 'Published', value: (r) => (r.is_published ? 'yes' : 'no') },
                ]}
              />
            }
          />
          {cards.isLoading ? <Loading /> : cards.error ? <ErrorState error={cards.error} /> : (
            <Table
              head={[
                ...(mayPublish || mayGenerate ? [''] : []),
                'Roll', 'Admission no.', 'Student', 'Total', 'Percentage', 'Grade', 'Attendance', 'State', '',
              ]}
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
                    {(mayPublish || mayGenerate) && (
                      <Td>
                        <input
                          type="checkbox"
                          checked={!!picked[r.id]}
                          onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked })}
                          aria-label={`Select the report card for ${r.full_name}`}
                        />
                      </Td>
                    )}
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
                      <Badge
                        tone={
                          r.status === 'published' ? 'success'
                            : r.status === 'submitted' ? 'primary'
                              : r.status === 'returned' ? 'warning' : 'neutral'
                        }
                      >
                        {r.status === 'submitted' ? 'with principal' : r.status}
                      </Badge>
                      {/* Sent back means somebody said why, and the person who
                          has to fix it should not have to go and ask. */}
                      {r.status === 'returned' && r.return_note && (
                        <div className="mt-1 max-w-[16rem] text-[12px] text-muted-foreground">
                          {r.return_note}
                        </div>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {/* One card on its own: the same endpoint as the bar
                          above, with a list of one. */}
                      {mayPublish && r.status === 'submitted' && (
                        <Button
                          size="sm"
                          disabled={act.isPending}
                          onClick={() => act.mutate({ verb: 'publish', ids: [r.id] })}
                        >
                          Publish
                        </Button>
                      )}
                      {mayGenerate && !mayPublish && (r.status === 'draft' || r.status === 'returned') && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={act.isPending}
                          onClick={() => act.mutate({ verb: 'submit', ids: [r.id] })}
                        >
                          Send up
                        </Button>
                      )}
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
                      <Td colSpan={mayPublish || mayGenerate ? 10 : 9} className="bg-muted/30">
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
