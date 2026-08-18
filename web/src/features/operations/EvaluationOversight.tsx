import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Loading, ErrorState, FormNotice, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'
import {
  adminOpsBase,
  type EvalCycle, type Reviewee, type RelationResult,
} from './admin-ops-lib'

/* 360 evaluation oversight.
 *
 * The principal's view of a feedback round: which cycles are open, who has
 * been asked, who has answered, where the gaps are, and releasing results.
 *
 * Anonymity is the whole instrument, and this screen is not what enforces it.
 * The server does, in three ways, and it is worth knowing which is which
 * because it changes what this page can honestly show:
 *
 *   The schema has no link. evaluation_responses carries no respondent id and
 *   evaluation_invitations carries no response id. There is no join in either
 *   direction. So the counts below and the answers on the results panel come
 *   from two tables that cannot be correlated, and nothing this screen asks
 *   for could return "what did Priya say".
 *
 *   The floor is applied server-side, to everyone. A direction with fewer
 *   responses than the cycle's minimum returns no figures at all — not to the
 *   teacher, and not to the principal. Suppressing only for the subject would
 *   be theatre, because this very page lists who was invited.
 *
 *   Head and self ratings are labelled attributed rather than dressed up as
 *   anonymous. A teacher has one head. Pretending the head's 3 is anonymous is
 *   a fiction the teacher sees through immediately, and it is the fiction that
 *   destroys trust in the rest of the instrument.
 */

const CYCLE_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  draft: 'neutral',
  open: 'info',
  closed: 'warning',
  released: 'success',
}

const RELATION_LABEL: Record<string, string> = {
  head: 'Head',
  peer: 'Peers',
  self: 'Self',
  student: 'Students',
  parent: 'Parents',
}

export default function EvaluationOversight() {
  const qc = useQueryClient()
  const can = useCan()
  const mayRun = can('hr.employees.write')

  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const list = useQuery({
    queryKey: ['admin-ops', 'evaluation', 'cycles'],
    queryFn: () => api.get<List<EvalCycle>>(`${adminOpsBase}/evaluation/cycles`),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.post(`${adminOpsBase}/evaluation/cycles/${id}/status`, { status }),
    onSuccess: (_r, v) => {
      setNote(v.status === 'released'
        ? 'Results released. Each person can now see their own aggregate, and nothing else.'
        : `Cycle ${v.status}.`)
      qc.invalidateQueries({ queryKey: ['admin-ops', 'evaluation'] })
    },
  })

  const items = list.data?.items ?? []
  const live = items.filter((c) => c.status === 'open')
  const outstanding = live.reduce((n, c) => n + (c.invited - c.responded), 0)

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title="360 evaluation oversight"
        description="Feedback on a member of staff from their head, their peers and, where appropriate, students and parents. Who has been asked, who has answered, and when results may be released."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Cycles" value={items.length} />
          <Stat label="Open now" value={live.length} />
          <Stat label="Responses outstanding" value={outstanding}
            hint={outstanding ? 'People still to be chased' : 'Nothing outstanding'} />
          <Stat label="Staff under review"
            value={live.reduce((n, c) => n + c.reviewee_count, 0)} />
        </CellGrid>

        <FormNotice error={setStatus.error} ok={note} />

        <Card>
          <CardHeader
            title="Cycles"
            description="A cycle gathers feedback from several directions at once, and holds a minimum responder count below which nothing is shown."
          />
          {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
            <Table
              head={['Cycle', 'Window', 'Directions', 'Staff', 'Responses', 'Floor', 'Status', '']}
              empty={!items.length}
              emptyLabel="No evaluation cycles yet."
            >
              {items.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">
                    {c.name}
                    {c.purpose && (
                      <span className="block text-[12px] text-muted-foreground">{c.purpose}</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground text-[12px]">
                    {c.opens_on} → {c.closes_on}
                  </Td>
                  <Td className="text-muted-foreground text-[12px]">
                    {c.relations.map((r) => RELATION_LABEL[r] ?? r).join(', ')}
                  </Td>
                  <Td className="tabular-nums">{c.reviewee_count}</Td>
                  <Td className="tabular-nums">
                    {c.responded} of {c.invited}
                    {c.invited > c.responded && (
                      <span className="block text-[12px] text-muted-foreground">
                        {c.invited - c.responded} outstanding
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{c.min_responses}</Td>
                  <Td><Badge tone={CYCLE_TONE[c.status] ?? 'neutral'}>{c.status}</Badge></Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="secondary"
                        onClick={() => setOpen(open === c.id ? null : c.id)}>
                        {open === c.id ? 'Close' : 'Open'}
                      </Button>
                      {mayRun && c.status === 'draft' && (
                        <Button size="sm" disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: c.id, status: 'open' })}>
                          Start
                        </Button>
                      )}
                      {mayRun && c.status === 'open' && (
                        <Button size="sm" variant="secondary" disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: c.id, status: 'closed' })}>
                          Close
                        </Button>
                      )}
                      {mayRun && c.status === 'closed' && (
                        <Button size="sm" disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: c.id, status: 'released' })}>
                          Release
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {open && <CycleDetail
          /* Keyed by the cycle. `showing` inside it is a reviewee id, so
             opening a second cycle kept the first cycle's person selected and
             drew their results panel underneath the new cycle's roll. */
          key={open}
          id={open}
          mayRun={mayRun}
          onDone={(m) => {
            setNote(m)
            qc.invalidateQueries({ queryKey: ['admin-ops', 'evaluation'] })
          }}
        />}
      </PageBody>
    </>
  )
}

function CycleDetail({ id, mayRun, onDone }: {
  id: string; mayRun: boolean; onDone: (m: string) => void
}) {
  const [showing, setShowing] = useState<string | null>(null)

  const detail = useQuery({
    queryKey: ['admin-ops', 'evaluation', 'cycles', id],
    queryFn: () => api.get<{
      cycle: EvalCycle
      questions: { id: string; seq: number; prompt: string; kind: string; max_rating: number }[]
      reviewees: Reviewee[]
      note: string
    }>(`${adminOpsBase}/evaluation/cycles/${id}`),
  })

  const release = useMutation({
    mutationFn: (revID: string) =>
      api.post(`${adminOpsBase}/evaluation/reviewees/${revID}/release`, {}),
    onSuccess: () => onDone('Released to that member of staff.'),
  })

  if (detail.isLoading) return <Card><Loading /></Card>
  if (detail.error) return <Card><ErrorState error={detail.error} /></Card>

  const c = detail.data!.cycle
  const reviewees = detail.data!.reviewees
  const questions = detail.data!.questions
  const canRelease = c.status === 'closed' || c.status === 'released'

  return (
    <>
      <Card>
        <CardHeader
          title={`${c.name} — who has answered`}
          description={detail.data!.note}
        />
        <Table
          head={['Member of staff', 'Department', 'By direction', 'Responses', 'Result', '']}
          empty={!reviewees.length}
          emptyLabel="Nobody has been added to this cycle."
        >
          {reviewees.map((v) => (
            <tr key={v.id}>
              <Td className="font-medium">
                {v.name}
                <span className="block font-mono text-[12px] text-muted-foreground">
                  {v.employee_code}
                </span>
              </Td>
              <Td className="text-muted-foreground">{v.department ?? '—'}</Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  {v.by_relation.length === 0 && (
                    <span className="text-[12px] text-muted-foreground">nobody invited yet</span>
                  )}
                  {v.by_relation.map((g) => (
                    <span
                      key={g.relation}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[12px]',
                        g.meets_floor ? 'bg-success/12 text-success' : 'bg-muted text-secondary-foreground',
                      )}
                      title={g.attributed
                        ? 'Attributed — one respondent by construction, and shown as such'
                        : `Needs ${c.min_responses} responses before anything is shown`}
                    >
                      {RELATION_LABEL[g.relation] ?? g.relation} {g.responded}/{g.invited}
                      {g.declined > 0 && ` (${g.declined} declined)`}
                    </span>
                  ))}
                </div>
              </Td>
              <Td className="tabular-nums">{v.responded} of {v.invited}</Td>
              <Td>
                {v.released
                  ? <Badge tone="success">released</Badge>
                  : v.complete
                    ? <Badge tone="info">ready</Badge>
                    : <Badge tone="neutral">gaps</Badge>}
              </Td>
              <Td>
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary"
                    onClick={() => setShowing(showing === v.id ? null : v.id)}>
                    {showing === v.id ? 'Hide' : 'Results'}
                  </Button>
                  {mayRun && canRelease && !v.released && (
                    <Button size="sm" disabled={release.isPending}
                      onClick={() => release.mutate(v.id)}>
                      Release
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
        <div className="border-t px-5 py-4 text-[12px] text-muted-foreground">
          This table shows who was asked and whether they replied. It cannot show what any one
          person said — the response rows carry no respondent, so there is no query that would
          return it.
        </div>
      </Card>

      {showing && <RevieweeResults id={showing} minResponses={c.min_responses} />}

      {questions.length > 0 && (
        <Card>
          <CardHeader title="Questions" description="What everyone was asked." />
          <Table head={['#', 'Question', 'Answer']}>
            {questions.map((q) => (
              <tr key={q.id}>
                <Td className="text-muted-foreground">{q.seq}</Td>
                <Td>{q.prompt}</Td>
                <Td className="text-muted-foreground">
                  {q.kind === 'rating' ? `1–${q.max_rating}` : 'comment'}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  )
}

function RevieweeResults({ id, minResponses }: { id: string; minResponses: number }) {
  const res = useQuery({
    queryKey: ['admin-ops', 'evaluation', 'results', id],
    queryFn: () => api.get<{
      cycle: { name: string; status: string; min_responses: number }
      subject: string
      viewer: { oversight: boolean; released: boolean }
      results: RelationResult[]
      suppressed: number
      anonymity_note: string
    }>(`${adminOpsBase}/evaluation/reviewees/${id}/results`),
  })

  if (res.isLoading) return <Card><Loading /></Card>
  if (res.error) return <Card><ErrorState error={res.error} /></Card>

  const d = res.data!

  return (
    <Card>
      <CardHeader
        title={`${d.subject} — results`}
        description={d.anonymity_note}
      />
      {!d.results.length ? (
        <EmptyState title="No responses yet" body="Nothing has been submitted for this person." />
      ) : (
        <div className="divide-y">
          {d.results.map((r) => (
            <div key={r.relation} className="p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h4 className="text-[14px] font-medium">
                  {RELATION_LABEL[r.relation] ?? r.relation}
                </h4>
                <Badge tone={r.attributed ? 'info' : r.suppressed ? 'warning' : 'success'}>
                  {r.attributed ? 'attributed' : r.suppressed ? 'withheld' : 'anonymous'}
                </Badge>
                <span className="text-[12px] text-muted-foreground">
                  {r.responses} response{r.responses === 1 ? '' : 's'}
                </span>
              </div>

              {r.suppressed ? (
                <p className="text-[13px] text-muted-foreground">
                  {r.suppressed_reason ??
                    `Fewer than ${minResponses} responses, so nothing is shown.`}
                </p>
              ) : (
                <Table head={['Question', 'Average', 'Range', 'Comments']}>
                  {r.questions.map((q) => (
                    <tr key={q.question_id}>
                      <Td>{q.prompt}</Td>
                      <Td className="tabular-nums">
                        {q.average !== undefined && q.average !== null
                          ? `${q.average.toFixed(1)} / ${q.max_rating}`
                          : '—'}
                      </Td>
                      <Td className="tabular-nums text-muted-foreground">
                        {q.low !== undefined && q.low !== null && q.high !== undefined && q.high !== null
                          ? `${q.low}–${q.high}`
                          : '—'}
                      </Td>
                      <Td>
                        {q.comments.length === 0
                          ? <span className="text-muted-foreground">—</span>
                          : q.comments.map((cm, i) => (
                            <span key={i} className="block text-[13px]">“{cm}”</span>
                          ))}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
          ))}
        </div>
      )}
      {d.suppressed > 0 && (
        <div className="border-t px-5 py-4 text-[12px] text-muted-foreground">
          {d.suppressed} direction{d.suppressed === 1 ? '' : 's'} withheld for having too few
          responses. This is applied on the server, to everybody — including whoever runs the
          cycle — because the invitation list on the panel above would otherwise name them.
        </div>
      )}
    </Card>
  )
}
