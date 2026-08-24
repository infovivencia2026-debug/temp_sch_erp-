import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Loading, ErrorState, ExportButton,
} from '@/components/ui'
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
export default function Pipeline() {
  const qc = useQueryClient()
  const [testWeight, setTestWeight] = useState('70')
  const [enrolFor, setEnrolFor] = useState<string | null>(null)
  const [sectionId, setSectionId] = useState('')

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
  const enrol = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/admissions/workflow/applications/${id}/enrol`, { section_id: sectionId }),
    onSuccess: () => { setEnrolFor(null); refresh() },
  })

  const stages = funnel.data?.items ?? []
  const rows = merit.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Admissions Workspace"
        title="Admissions pipeline"
        description="Merit ranking, seat availability against RTE quota, and the offer-to-enrolment handoff. The stages below are cumulative totals — every application ever raised, not the ones still waiting on somebody, which is the dashboard's smaller 'open applications'."
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
        <CellGrid cols={4}>
          {stages.map((s) => <Stat key={s.stage} label={s.stage} value={s.count} />)}
        </CellGrid>

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

        <Card>
          <CardHeader title="Merit list" description={`${rows.length} applicants, weighted and ranked`} />
          {merit.isLoading ? <Loading /> : merit.error ? <ErrorState error={merit.error} /> : (
            <Table head={['Rank', 'Application', 'Applicant', 'Class', 'Entrance', 'Interview', 'Merit', 'Status', '']}
              empty={!rows.length} emptyLabel="No applications yet.">
              {rows.map((m) => (
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
                        <Button size="sm" variant="secondary" onClick={() => setEnrolFor(m.application_id)}>
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

        {enrolFor && (
          <Card>
            <CardHeader
              title="Enrol applicant"
              description="Creates the student record, the enrolment and the guardian link in one step."
            />
            <div className="flex flex-wrap items-end gap-3 p-5">
              <label>
                <span className="text-[13px] text-muted-foreground">Section</span>
                <div className="mt-1">
                  <Select value={sectionId} onChange={setSectionId} placeholder="Select section"
                    options={(sections.data?.items ?? []).map((s) => ({
                      value: s.id, label: `${s.class_name}-${s.name}`,
                    }))} />
                </div>
              </label>
              <Button disabled={!sectionId || enrol.isPending} onClick={() => enrol.mutate(enrolFor)}>
                {enrol.isPending ? 'Enrolling…' : 'Confirm enrolment'}
              </Button>
              <Button variant="ghost" onClick={() => setEnrolFor(null)}>Cancel</Button>
              {enrol.isError && (
                <p className="text-[13px] text-destructive">
                  {enrol.error instanceof Error ? enrol.error.message : 'Enrolment failed'}
                </p>
              )}
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
