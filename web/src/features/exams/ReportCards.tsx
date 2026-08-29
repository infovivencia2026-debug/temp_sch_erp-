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

/** The design the school prints on. */
interface Template {
  name: string
  template_html: string
  is_built_in: boolean
  css?: string
  updated_at?: string
  updated_by?: string
}

/** A section waiting on the head, as one line. */
interface Pending {
  section_id: string; section_name: string; class_name: string
  cards: number; submitted_by?: string; submitted_at?: string
}

/** A child on the roll, whether or not a report card exists for them yet. */
interface Pupil {
  id: string; admission_no: string; full_name: string; roll_no?: number
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
  /* Whose sections this person is choosing between.

     A class teacher builds cards for the section they answer for, so the list
     is theirs alone. The head approves for the whole school and is class
     teacher of nothing — with mine=class_teacher they got an empty dropdown,
     could never pick a section, and the approval queue was unreachable by the
     only person who can act on it. */
  const canPublishSections = useCan()('academics.reportcards.publish')
  const sections = useQuery({
    queryKey: ['sections', canPublishSections ? 'all' : 'class_teacher'],
    queryFn: () => api.get<List<Section>>(
      canPublishSections
        ? '/api/v1/academics/sections'
        : '/api/v1/academics/sections?mine=class_teacher'),
  })
  const cards = useQuery({
    queryKey: ['report-cards', sectionId, examId],
    queryFn: () =>
      api.get<List<ReportCard>>(
        `/api/v1/exams/report-cards?section_id=${sectionId}${examId ? `&exam_id=${examId}` : ''}`,
      ),
    enabled: !!sectionId,
  })
  /* Who is in this section, whatever state their card is in. Named `roster`
     rather than folded into `cards` because the two answer different
     questions: this one is "who is here", that one is "whose card exists". */
  const roster = useQuery({
    queryKey: ['section-roster', sectionId],
    enabled: !!sectionId,
    queryFn: () => api.get<List<Pupil>>(
      `/api/v1/students?section_id=${sectionId}&limit=200`),
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

  /* Everything waiting on the head, across the school.

     The rest of this screen is one section at a time, which is right for
     reading thirty cards and wrong for the afternoon a term's results go out:
     eleven sections are waiting and the answer to all of them is yes. Only
     fetched for somebody who can act on it. */
  const pending = useQuery({
    queryKey: ['report-cards-pending'],
    enabled: mayPublish,
    queryFn: () => api.get<List<Pending>>('/api/v1/exams/report-cards/pending'),
  })
  const waiting = pending.data?.items ?? []
  const [pickedSections, setPickedSections] = useState<Record<string, boolean>>({})
  const chosen = waiting.filter((x) => pickedSections[x.section_id])
  // Nothing chosen means all of them, the same rule as the rows below.
  const releasing = chosen.length ? chosen : waiting

  /* The school's own report card design.

     Read by everybody, because the preview is part of reading a card; written
     by the class teacher as well as the head, because the person who notices
     the subject column is in the wrong order is the one printing thirty. */
  const template = useQuery({
    queryKey: ['report-card-template'],
    queryFn: () => api.get<{
      template: Template
      placeholders: { token: string; means: string }[]
      default_html: string
    }>('/api/v1/exams/report-cards/template'),
  })
  const [showTemplate, setShowTemplate] = useState(false)
  const [preview, setPreview] = useState<{ html: string; css?: string } | null>(null)

  const importTemplate = useMutation({
    mutationFn: (v: { name: string; template_html: string }) =>
      api.post('/api/v1/exams/report-cards/template', v),
    onSuccess: (_r, v) => {
      setOutcome(`"${v.name}" is now the design every report card prints on.`)
      qc.invalidateQueries({ queryKey: ['report-card-template'] })
    },
  })
  const resetTemplate = useMutation({
    mutationFn: () => api.post('/api/v1/exams/report-cards/template/reset', {}),
    onSuccess: () => {
      setOutcome('Back to the standard design.')
      qc.invalidateQueries({ queryKey: ['report-card-template'] })
    },
  })

  /* Who is told when a card goes out, and how.

     A school does not always tell both: a board class is told through the
     child, a primary class through the parents, and a school running a
     parents' evening tells nobody by message because the card is being handed
     over. The in-app alert always goes to whoever is named — it costs nothing
     and it is the copy still there next week. */
  const [to, setTo] = useState<'both' | 'students' | 'parents'>('both')
  const [channels, setChannels] = useState<Record<string, boolean>>({})
  const chosenChannels = Object.keys(channels).filter((k) => channels[k])

  const act = useMutation({
    mutationFn: (v: {
      verb: 'submit' | 'publish' | 'return'
      ids?: string[]
      section_ids?: string[]
      note?: string
    }) =>
      api.post<{
        submitted?: number; published?: number; returned?: number
        messages_queued?: number; delivery_error?: string
      }>(
        `/api/v1/exams/report-cards/${v.verb}`,
        {
          ids: v.ids ?? [], section_ids: v.section_ids ?? [], note: v.note,
          // Only meaningful on publish; harmless on the other two.
          to, channels: chosenChannels,
        },
      ),
    onSuccess: (r, v) => {
      const n = r.submitted ?? r.published ?? r.returned ?? 0
      const noun = `${n} report ${n === 1 ? 'card' : 'cards'}`
      const told = to === 'both' ? 'the students and their parents'
        : to === 'students' ? 'the students' : 'the parents'
      const sent = r.messages_queued
        ? ` ${r.messages_queued} ${chosenChannels.join(' / ')} ${r.messages_queued === 1 ? 'message' : 'messages'} queued.`
        : ''
      setOutcome(
        v.verb === 'submit'
          ? `${noun} sent to the principal for approval.`
          : v.verb === 'publish'
            ? `${noun} published — ${told} have been told in the app.${sent}` +
              (r.delivery_error ? ` The cards are out, but sending failed: ${r.delivery_error}` : '')
            : `${noun} sent back to the class teacher with your note.`,
      )
      setPicked({})
      setPickedSections({})
      setNote('')
      qc.invalidateQueries({ queryKey: ['report-cards', sectionId, examId] })
      qc.invalidateQueries({ queryKey: ['report-cards-pending'] })
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
  /* The suggestions come from the SECTION, not from the report cards.

     They were drawn from the rows in the table, which is the list of cards
     that have been generated — so on a section whose cards do not exist yet,
     the table is empty, the search matches nothing, and the dropdown that was
     supposed to say who is actually there had nothing to say either. Exactly
     the case somebody is in when they cannot find a child.

     At most eight: a list longer than the screen is one nobody reads to the
     end, and if eight children match, the word typed is not the one that finds
     anybody. */
  const suggestions = needle.length < 2 ? [] : (roster.data?.items ?? [])
    .filter((r) =>
      String(r.roll_no ?? '') === needle ||
      r.full_name.toLowerCase().includes(needle) ||
      r.admission_no.toLowerCase().includes(needle))
    .slice(0, 8)
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
            {(mayGenerate || mayPublish) && (
              <Button variant="ghost" onClick={() => setShowTemplate((v) => !v)}>
                {showTemplate ? 'Hide the design' : 'Report card design'}
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

        {showTemplate && (mayGenerate || mayPublish) && (
          <Card>
            <CardHeader
              title={template.data?.template.is_built_in
                ? 'Printing on the standard design'
                : `Printing on "${template.data?.template.name}"`}
              description={
                template.data?.template.is_built_in
                  ? 'Every card prints on the design this product ships with. Import your school\'s own and every card generated from then on uses it, until you import another.'
                  : `Imported${template.data?.template.updated_by ? ` by ${template.data.template.updated_by}` : ''}${template.data?.template.updated_at ? ` on ${template.data.template.updated_at.replace('T', ' ')}` : ''}. Every card prints on this until it is replaced.`
              }
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted">
                    Import a design
                    <input
                      type="file"
                      accept=".html,.htm,.txt,text/html,text/plain"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        e.target.value = ''
                        if (!f) return
                        /* Read here rather than uploaded: the design is text
                           the server has to substitute into, not a file to be
                           handed back later, and a round trip through the file
                           store would leave a second copy nobody maintains. */
                        const reader = new FileReader()
                        reader.onload = () => importTemplate.mutate({
                          name: f.name.replace(/\.[^.]+$/, ''),
                          template_html: String(reader.result ?? ''),
                        })
                        reader.readAsText(f)
                      }}
                    />
                  </label>
                  {!template.data?.template.is_built_in && (
                    <Button
                      variant="ghost"
                      disabled={resetTemplate.isPending}
                      onClick={() => resetTemplate.mutate()}
                    >
                      Back to standard
                    </Button>
                  )}
                </div>
              }
            />
            {importTemplate.error && <FormNotice error={importTemplate.error} />}
            <div className="px-5 pb-5">
              <p className="mb-2 text-[13px] text-muted-foreground">
                An HTML file. Put these where the school's design wants them —
                anything else is left blank rather than printed as braces.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(template.data?.placeholders ?? []).map((ph) => (
                  <span
                    key={ph.token}
                    title={ph.means}
                    className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {ph.token}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[13px] text-muted-foreground">
                A photograph comes from the child's own record — open Student 360,
                Edit, and set the photo there. {'{{photo}}'} then prints it, and
                a child with none prints an empty frame rather than a broken image.
              </p>
            </div>
          </Card>
        )}

        {preview && (
          <Card>
            <CardHeader
              title="Preview"
              description="One child's card, on the design that is live."
              action={<Button variant="ghost" onClick={() => setPreview(null)}>Close</Button>}
            />
            <div className="overflow-x-auto px-5 pb-5">
              {preview.css && <style>{preview.css}</style>}
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
          </Card>
        )}

        {/* The whole school's queue, for the head.

            Sits above everything else because on the day results go out it is
            the only thing on this screen that matters, and because it is the
            one view that does not make somebody pick a section first. */}
        {mayPublish && waiting.length > 0 && (
          <Card>
            <CardHeader
              title={`${waiting.reduce((a, x) => a + x.cards, 0)} report cards waiting for you`}
              description={`Across ${waiting.length} ${waiting.length === 1 ? 'section' : 'sections'}. Tick sections to release only those, or leave them unticked to publish everything waiting.`}
            />
            <ul className="divide-y">
              {waiting.map((x) => (
                <li key={x.section_id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                  <input
                    type="checkbox"
                    checked={!!pickedSections[x.section_id]}
                    onChange={(e) =>
                      setPickedSections({ ...pickedSections, [x.section_id]: e.target.checked })}
                    aria-label={`Select ${x.class_name}-${x.section_name}`}
                  />
                  <span className="min-w-[7rem] font-medium">
                    {x.class_name}-{x.section_name}
                  </span>
                  <span className="flex-1 text-[13px] text-muted-foreground">
                    {/* Who sent it up: a head returning a section replies to a
                        person, not to a row. */}
                    {x.submitted_by ?? 'the class teacher'}
                    {x.submitted_at ? ` · sent ${x.submitted_at.replace('T', ' ')}` : ''}
                  </span>
                  <span className="text-[13px] tabular-nums text-muted-foreground">
                    {x.cards} {x.cards === 1 ? 'card' : 'cards'}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={act.isPending}
                    onClick={() => { setSectionId(x.section_id) }}
                  >
                    Read them
                  </Button>
                  <Button
                    size="sm"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ verb: 'publish', section_ids: [x.section_id] })}
                  >
                    Publish
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 px-5 pb-4 pt-3">
              <Button
                disabled={act.isPending || !releasing.length}
                onClick={() =>
                  act.mutate({ verb: 'publish', section_ids: releasing.map((x) => x.section_id) })}
              >
                {chosen.length
                  ? `Publish ${chosen.length} selected ${chosen.length === 1 ? 'section' : 'sections'}`
                  : `Publish all ${waiting.reduce((a, x) => a + x.cards, 0)} cards`}
              </Button>
              {chosen.length > 0 && (
                <Button variant="ghost" onClick={() => setPickedSections({})}>
                  Clear selection
                </Button>
              )}
            </div>
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
                  {/* The default is the whole section, and the button says
                      so rather than making somebody count. */}
                  {ticked.length
                    ? `Send ${toSubmit.length} ticked for approval`
                    : `Send all ${toSubmit.length} for approval`}
                </Button>
              )}
              {mayPublish && toDecide.length > 0 && (
                <>
                  <Select
                    value={to}
                    onChange={(v) => setTo(v as 'both' | 'students' | 'parents')}
                    options={[
                      { value: 'both', label: 'Tell students and parents' },
                      { value: 'parents', label: 'Tell the parents only' },
                      { value: 'students', label: 'Tell the students only' },
                    ]}
                  />
                  {/* The app alert always goes. These cost money per message,
                      so they are chosen per release rather than assumed. */}
                  {(['sms', 'whatsapp', 'email'] as const).map((ch) => (
                    <label key={ch} className="flex items-center gap-1.5 text-[13px]">
                      <input
                        type="checkbox"
                        checked={!!channels[ch]}
                        onChange={(e) => setChannels({ ...channels, [ch]: e.target.checked })}
                      />
                      {ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : 'Email'}
                    </label>
                  ))}
                  <Button
                    disabled={act.isPending}
                    onClick={() => act.mutate({ verb: 'publish', ids: toDecide.map((r) => r.id) })}
                    title={ready ? undefined : 'Some papers are still unmarked'}
                  >
                    {ticked.length
                      ? `Approve & publish ${toDecide.length} ticked`
                      : `Approve & publish all ${toDecide.length}`}
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
                        onClick={async () => {
                          const v = await api.get<{ html: string; css?: string }>(
                            `/api/v1/exams/report-cards/render?id=${r.id}`)
                          setPreview(v)
                        }}
                      >
                        Card
                      </Button>
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
