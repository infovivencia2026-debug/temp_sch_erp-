import { Fragment, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Loading, ErrorState, ExportButton,
} from '@/components/ui'
import EnrolPanel from './EnrolPanel'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { StatusPill } from '@/components/NeedsAttention'

interface Merit {
  application_id: string; application_no: string; name: string
  class_sought?: string; category?: string; is_rte: boolean
  test_percent?: number; interview_percent?: number
  merit_score: number; rank: number; status: string
}
interface Seat {
  class_id: string; class_name: string; capacity: number; enrolled: number
  offered: number; available: number; rte_quota: number; rte_filled: number
}
interface Stage { stage: string; count: number }
interface Section { id: string; class_id: string; class_name: string; name: string }

/* Status comes from StatusPill, not from a map kept here.

   This file had five of the eleven statuses `applications` can hold, so
   documents_pending, under_review, test_scheduled, interviewed, withdrawn and
   draft all rendered as the same undifferentiated grey — the states a
   counsellor most needs to tell apart were exactly the ones that looked
   identical. One vocabulary, rendered one way, everywhere. */

/** The admissions pipeline: merit ranking, seat availability against quota,
    and the decisions that move an applicant to enrolled. */
/* What each menu entry means, in one place.

   `only` narrows the applicants in view; `lead` says which card the reader
   came for and therefore goes first. Anything not listed — Seat Allotment —
   is the whole screen, which is what it has always been. */
const VIEWS: Record<string, {
  title: string
  description: string
  only?: (m: Merit) => boolean
  lead: 'merit' | 'seats' | 'stages'
  emptyLabel?: string
}> = {
  rte_quota: {
    title: 'RTE quota',
    description: 'The 25% the Act requires: who has claimed it, and how much of each class\u2019s reservation is still open.',
    only: (m) => m.is_rte,
    lead: 'seats',
    emptyLabel: 'Nobody has applied under RTE yet.',
  },
  fee_enrollment: {
    title: 'Fee & enrolment',
    description: 'Applicants who have been offered a place or accepted one \u2014 the queue that becomes students.',
    only: (m) => ['offered', 'accepted'].includes(m.status),
    lead: 'merit',
    emptyLabel: 'Nobody has been offered a place yet.',
  },
  admission_reports: {
    title: 'Admission reports',
    description: 'Enquiries, applications and admissions with the conversion between them. Cumulative totals \u2014 every application ever raised.',
    lead: 'stages',
  },
}

/** The admissions pipeline: merit ranking, seat availability against quota,
    and the decisions that move an applicant to enrolled. */
export default function Pipeline() {
  const { featureSlug } = useParams()
  const view = VIEWS[featureSlug ?? '']
  const qc = useQueryClient()
  const [testWeight, setTestWeight] = useState('70')
  const [enrolFor, setEnrolFor] = useState<string | null>(null)

  const merit = useQuery({
    queryKey: ['merit', testWeight],
    queryFn: () => api.get<List<Merit>>(`/api/v1/admissions/workflow/merit?test_weight=${testWeight}`),
  })
  const seats = useQuery({
    queryKey: ['seats'],
    queryFn: () => api.get<List<Seat>>('/api/v1/admissions/workflow/seats'),
  })
  const funnel = useQuery({
    queryKey: ['funnel'],
    queryFn: () => api.get<List<Stage>>('/api/v1/admissions/workflow/funnel'),
  })
  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['merit'] })
    qc.invalidateQueries({ queryKey: ['seats'] })
    qc.invalidateQueries({ queryKey: ['funnel'] })
  }
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      api.post(`/api/v1/admissions/workflow/applications/${id}/decision`, { decision }),
    onSuccess: refresh,
  })

  const stages = funnel.data?.items ?? []
  /* The applicants this entry is about. The ranks are the school's real ranks
     — computed across everybody — so an RTE applicant ranked eleventh overall
     still reads #11 here rather than being renumbered into a private list that
     agrees with nothing. */
  const rows = (merit.data?.items ?? []).filter((m) => view?.only?.(m) ?? true)
  /* A merit list is read to find one child on it — the parent on the phone
     asking where their son came — which is exactly what ranking makes hard. */
  const { q: term, setQ: setTerm, shown } = useSearch(rows,
    (m) => [m.application_no, m.name, m.class_sought, m.category, m.status])

  /* Enrol into the class they applied for, and no other.
   *
   * The picker offered every section in the school, so a child who applied for
   * Grade 7 could be enrolled into Grade 6-A with one wrong click — and the
   * enrolment, the guardian link and the student record are all written in
   * that one step, so it is not a mistake anybody notices until a parent asks
   * why their son is in the wrong class.
   *
   * Matched on the class name because that is what the merit list carries. If
   * nothing matches — a class renamed since the application was filed — the
   * full list is offered rather than an empty picker, since a blocked
   * enrolment is worse than a wide one somebody has to read. */
  const enrolling = rows.find((m) => m.application_id === enrolFor)
  const allSections = sections.data?.items ?? []
  const inClass = allSections.filter((x) => x.class_name === enrolling?.class_sought)
  const openSections = inClass.length ? inClass : allSections

  /* The three cards, named so the order can be a list rather than three
     copies of the same JSX with the middle one moved. */
  const statsCard = (
          <CellGrid cols={4}>
            {stages.map((s) => <Stat key={s.stage} label={s.stage} value={s.count} />)}
          </CellGrid>

  )

  const seatsCard = (
          <Card>
            <CardHeader title="Seat matrix" description="RTE reservation is 25% of sanctioned intake" />
            {seats.isLoading ? <Loading /> : (
              <Table head={['Class', 'Capacity', 'Enrolled', 'Offered', 'Available', 'RTE quota', 'RTE filled']}
                empty={!seats.data?.items.length}>
                {(seats.data?.items ?? []).map((s) => (
                  <tr key={s.class_id}>
                    <Td className="font-medium">{s.class_name}</Td>
                    <Td>{s.capacity}</Td>
                    <Td>{s.enrolled}</Td>
                    <Td>{s.offered}</Td>
                    <Td>
                      <Badge tone={s.available === 0 ? 'danger' : s.available < 5 ? 'warning' : 'success'}>
                        {s.available}
                      </Badge>
                    </Td>
                    <Td>{s.rte_quota}</Td>
                    <Td>
                      <Badge tone={s.rte_filled >= s.rte_quota ? 'success' : 'warning'}>
                        {s.rte_filled}/{s.rte_quota}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
  )

  const meritCard = (
          <Card>
            <CardHeader
              title="Merit list"
              description={`${rows.length} applicants, weighted and ranked`}
              action={
                <span className="flex flex-wrap items-center gap-2">
                  <Showing shown={shown.length} total={rows.length} noun="applicants" />
                  <SearchBox value={term} onChange={setTerm} placeholder="Name, application no. or class" />
                  <ExportRows
                    rows={shown}
                    name="merit-list"
                    columns={[
                      { header: 'Rank', value: (m) => m.rank },
                      { header: 'Application no', value: (m) => m.application_no },
                      { header: 'Applicant', value: (m) => m.name },
                      { header: 'Class', value: (m) => m.class_sought },
                      { header: 'Category', value: (m) => m.category },
                      { header: 'RTE', value: (m) => (m.is_rte ? 'yes' : 'no') },
                      { header: 'Entrance %', value: (m) => m.test_percent },
                      { header: 'Interview %', value: (m) => m.interview_percent },
                      { header: 'Merit', value: (m) => m.merit_score },
                      { header: 'Status', value: (m) => m.status },
                    ]}
                  />
                </span>
              }
            />
            {merit.isLoading ? <Loading /> : merit.error ? <ErrorState error={merit.error} /> : (
              <Table head={['Rank', 'Application', 'Applicant', 'Class', 'Entrance', 'Interview', 'Merit', 'Status', '']}
                empty={!shown.length}
                emptyLabel={term
                  ? 'No applicant matches that.'
                  : view?.emptyLabel ?? 'No applications yet.'}>
                {shown.map((m) => (
                  <tr key={m.application_id}>
                    <Td className="font-medium">#{m.rank}</Td>
                    <Td className="font-mono text-[12px]">{m.application_no}</Td>
                    <Td className="font-medium">
                      {m.name}
                      {m.is_rte && <Badge tone="primary">RTE</Badge>}
                    </Td>
                    <Td>{m.class_sought ?? '—'}</Td>
                    <Td>{m.test_percent != null ? `${m.test_percent}%` : '—'}</Td>
                    <Td>{m.interview_percent != null ? `${m.interview_percent}%` : '—'}</Td>
                    <Td className="font-medium">{m.merit_score}</Td>
                    <Td><StatusPill status={m.status} /></Td>
                    <Td>
                      <div className="flex flex-wrap gap-1.5">
                        {m.status !== 'offered' && m.status !== 'accepted' && (
                          <>
                            <Button size="sm" disabled={decide.isPending}
                              onClick={() => decide.mutate({ id: m.application_id, decision: 'offered' })}>
                              Offer
                            </Button>
                            <Button size="sm" variant="secondary" disabled={decide.isPending}
                              onClick={() => decide.mutate({ id: m.application_id, decision: 'waitlisted' })}>
                              Waitlist
                            </Button>
                          </>
                        )}
                        {m.status === 'offered' && (
                          <Button size="sm" variant="secondary"
                            onClick={() => setEnrolFor(m.application_id)}>
                            Enrol
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
            {decide.isError && (
              <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
                {decide.error instanceof Error ? decide.error.message : 'Decision failed'}
              </p>
            )}
          </Card>
  )

  /* What the reader came for goes first. Every view still carries all
     three: somebody who opened RTE Quota still wants the ranking under it,
     and somebody who opened the report still wants the matrix. */
  const order = view?.lead === 'stages' ? [statsCard, seatsCard, meritCard]
    : view?.lead === 'seats' ? [seatsCard, meritCard, statsCard]
    : [meritCard, statsCard, seatsCard]

  return (
    <>
      <PageHead
        eyebrow="Admissions Workspace"
        title={view?.title ?? 'Seat allotment'}
        description={view?.description ?? "Merit ranking, seat availability against RTE quota, and the offer-to-enrolment handoff. The stages below are cumulative totals — every application ever raised, not the ones still waiting on somebody, which is the dashboard's smaller 'open applications'."}
        actions={
          <>
          {/* The applicant list, for the trustee who wants it in Excel. */}
          <ExportButton report="admissions" />
          <Select
            value={testWeight}
            onChange={setTestWeight}
            options={[
              { value: '100', label: 'Entrance 100%' },
              { value: '70', label: 'Entrance 70 / Interview 30' },
              { value: '50', label: 'Entrance 50 / Interview 50' },
              { value: '0', label: 'Interview 100%' },
            ]}
          />
          </>
        }
      />
      <PageBody>
        {order.map((card, i) => <Fragment key={i}>{card}</Fragment>)}

        {enrolFor && (
          <EnrolPanel
            applicationId={enrolFor}
            classSought={enrolling?.class_sought}
            sections={openSections.map((x) => ({
              id: x.id, label: `${x.class_name}-${x.name}`,
            }))}
            onDone={() => { setEnrolFor(null); refresh() }}
          />
        )}

      </PageBody>
    </>
  )
}
