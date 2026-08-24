import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, Loading, ErrorState, FormNotice,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { useCan } from '@/lib/session'
import { formatDate, cn } from '@/lib/utils'

/* The application, from submitted to enrolled.
 *
 * Four endpoints existed for this ladder — assessment, decision, enrol, plus
 * the list — and only the list had a caller. So an application could be taken
 * and then not moved: no way to schedule a test, issue an offer, or turn an
 * accepted applicant into a student.
 *
 * The stages are a real sequence, so the screen shows where each applicant
 * has got to and offers only the step that comes next. A decision button on a
 * candidate who has not sat the test is a way to make a mistake quickly.
 */

interface Application {
  id: string
  application_no: string
  name: string
  class_sought?: string
  parent_name: string
  parent_phone: string
  is_rte: boolean
  status: string
  created_at: string
}

/* The ladder, in order. Anything not listed — withdrawn, rejected — is a
   terminal state and offers nothing further. */
const LADDER = [
  'draft', 'submitted', 'under_review', 'documents_pending',
  'test_scheduled', 'interviewed', 'offered', 'accepted',
]

function stageIndex(status: string) {
  return LADDER.indexOf(status)
}

/* Five entries, five stages of one ladder.
 *
 * All applications, Document check, Entrance exams, Interviews and the
 * approvals queue are the same screen — because an application is one thing
 * that moves, and splitting it into five screens would mean five copies of the
 * same row and a decision button on each. What differs is where each entry
 * lands: the stage that entry is about.
 *
 * Without that they were five names for one unfiltered list, which is how a
 * menu grows entries that lead nowhere new. A person who clicks "Document
 * check" has already told you what they want to see.
 */
const OPENS_ON: Record<string, string> = {
  document_check: 'documents_pending',
  entrance_exams: 'test_scheduled',
  interviews: 'interviewed',
  approvals_queue: 'under_review',
}

const TITLES: Record<string, [string, string]> = {
  document_check: ['Document check',
    'Applications waiting on paperwork. Mark a document verified as it arrives.'],
  entrance_exams: ['Entrance exams',
    'Applicants due to sit the test: book the date, then record the score.'],
  interviews: ['Interviews',
    'Applicants due an interview: book the slot, then record what was said.'],
  approvals_queue: ['Approvals queue',
    'Applications sitting at a stage that needs a decision. The work, rather than the archive.'],
}

export default function Applications() {
  const { featureSlug } = useParams()
  const [title, description] = TITLES[featureSlug ?? ''] ?? [
    'Applications',
    'Every application and where it has got to on the ladder.',
  ]

  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('admissions.write')
  const mayEnrol = can('students.write')

  const [status, setStatus] = useState(OPENS_ON[featureSlug ?? ''] ?? '')

  /* Following the menu between entries, not only into one.
   *
   * All five entries render this component, so walking from "Document check"
   * to "Interviews" changes a route parameter and nothing else — React keeps
   * it mounted and the initial state above never runs again. The heading said
   * Interviews over a list still filtered to documents pending. Adjusted
   * during render so it is right on the first paint. */
  const [lastSlug, setLastSlug] = useState(featureSlug)
  if (featureSlug !== lastSlug) {
    setLastSlug(featureSlug)
    setStatus(OPENS_ON[featureSlug ?? ''] ?? '')
  }
  const [open, setOpen] = useState<Application | null>(null)
  const [remarks, setRemarks] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [score, setScore] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [note, setNote] = useState('')

  const apps = useQuery({
    queryKey: ['applications', status],
    queryFn: () =>
      api.get<List<Application>>(`/api/v1/admissions/applications${status ? `?status=${status}` : ''}`),
  })
  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  function after() {
    qc.invalidateQueries({ queryKey: ['applications'] })
    qc.invalidateQueries({ queryKey: ['attention'] })
    setRemarks(''); setScore(''); setScheduledAt('')
  }

  const assess = useMutation({
    mutationFn: (kind: 'entrance_test' | 'interview') =>
      api.post(`/api/v1/admissions/workflow/applications/${open!.id}/assessment`, {
        kind,
        scheduled_at: scheduledAt || undefined,
        score: score ? Number(score) : undefined,
        max_score: score ? 100 : undefined,
        remarks,
      }),
    onSuccess: (_r, kind) => {
      setNote(kind === 'entrance_test' ? 'Entrance test recorded.' : 'Interview recorded.')
      after()
    },
  })

  const decide = useMutation({
    mutationFn: (decision: 'offered' | 'rejected' | 'waitlisted') =>
      api.post(`/api/v1/admissions/workflow/applications/${open!.id}/decision`, {
        decision, remarks,
      }),
    onSuccess: (_r, d) => {
      setNote(
        d === 'offered'
          ? 'Offer issued. The family can be told to pay the admission fee.'
          : d === 'waitlisted' ? 'Waitlisted.' : 'Rejected.',
      )
      after()
    },
  })

  const enrol = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/admissions/workflow/applications/${open!.id}/enrol`, {
        section_id: sectionId,
      }),
    onSuccess: () => {
      setNote('Enrolled. The applicant is now a student with an admission number.')
      setOpen(null); setSectionId('')
      after()
      qc.invalidateQueries({ queryKey: ['students'] })
    },
  })

  const items = apps.data?.items ?? []
  const count = (s: string) => items.filter((a) => a.status === s).length
  const live = items.filter((a) => !['rejected', 'withdrawn'].includes(a.status))

  const stage = open ? stageIndex(open.status) : -1
  const terminal = open ? ['rejected', 'withdrawn'].includes(open.status) : false

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title={title}
        description={description}
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Live applications" value={live.length} />
          <Stat label="Awaiting documents" value={count('documents_pending')} />
          <Stat label="Offered" value={count('offered')} hint="Waiting on the family" />
          <Stat label="Accepted" value={count('accepted')} hint={count('accepted') ? 'Ready to enrol' : undefined} />
        </CellGrid>

        <FormNotice
          error={assess.error || decide.error || enrol.error}
          ok={note}
        />

        <Card>
          <CardHeader
            title="Applicants"
            description="Select one to move it along"
            action={
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'All' },
                  ...LADDER.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
                  { value: 'waitlisted', label: 'waitlisted' },
                  { value: 'rejected', label: 'rejected' },
                ]}
              />
            }
          />
          {apps.isLoading ? (
            <Loading />
          ) : apps.error ? (
            <ErrorState error={apps.error} />
          ) : (
            <Table
              head={['Application', 'Applicant', 'Class', 'Parent', 'Status', 'Applied', '']}
              empty={!items.length}
              emptyLabel="No applications."
            >
              {items.map((a) => (
                <tr key={a.id} className={cn(open?.id === a.id && 'bg-accent')}>
                  <Td className="font-mono text-[12px]">{a.application_no}</Td>
                  <Td className="font-medium">
                    {a.name}
                    {a.is_rte && (
                      <span className="ml-1.5 rounded-sm border px-1 text-[11px] text-muted-foreground">
                        RTE
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{a.class_sought ?? '—'}</Td>
                  <Td>
                    {a.parent_name}
                    <a href={`tel:${a.parent_phone}`} className="block text-[12px] text-primary">
                      {a.parent_phone}
                    </a>
                  </Td>
                  <Td><StatusPill status={a.status} /></Td>
                  <Td className="text-muted-foreground">{formatDate(a.created_at)}</Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { setOpen(open?.id === a.id ? null : a); setNote('') }}
                    >
                      Open
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {open && (
          <Card>
            <CardHeader
              title={`${open.name} · ${open.application_no}`}
              description={`${open.class_sought ?? 'Class not set'} · parent ${open.parent_name}`}
              action={<Button variant="ghost" onClick={() => setOpen(null)}>Close</Button>}
            />

            {/* Where this applicant has got to. A ladder read left to right
                says more than a status word on its own. */}
            <div className="flex flex-wrap items-center gap-1 border-b px-5 py-4">
              {LADDER.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'rounded-[6px] px-2 py-1 text-[12px]',
                    i < stage && 'text-muted-foreground',
                    i === stage && 'bg-nav-active font-medium text-foreground',
                    i > stage && 'text-muted-foreground/50',
                  )}
                >
                  {s.replace(/_/g, ' ')}
                </span>
              ))}
              {terminal && <StatusPill status={open.status} className="ml-2" />}
            </div>

            {terminal ? (
              <div className="px-5 py-6 text-[14px] text-muted-foreground">
                This application is closed. Nothing further to do.
              </div>
            ) : (
              <div className="flex flex-col gap-5 p-5">
                {/* Assessment — schedule or score a test or interview. */}
                {mayWrite && stage < stageIndex('offered') && (
                  <div>
                    <p className="eyebrow mb-2">Entrance test or interview</p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Scheduled for</span>
                        <Input value={scheduledAt} onChange={setScheduledAt} type="date" />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Score out of 100</span>
                        <Input value={score} onChange={setScore} placeholder="leave blank to schedule" />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Remarks</span>
                        <Input value={remarks} onChange={setRemarks} />
                      </label>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="secondary" disabled={assess.isPending}
                        onClick={() => assess.mutate('entrance_test')}>
                        Record entrance test
                      </Button>
                      <Button size="sm" variant="secondary" disabled={assess.isPending}
                        onClick={() => assess.mutate('interview')}>
                        Record interview
                      </Button>
                    </div>
                  </div>
                )}

                {/* Decision. */}
                {mayWrite && stage < stageIndex('offered') && (
                  <div className="border-t pt-5">
                    <p className="eyebrow mb-2">Decision</p>
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={decide.isPending} onClick={() => decide.mutate('offered')}>
                        Offer a place
                      </Button>
                      <Button variant="secondary" disabled={decide.isPending}
                        onClick={() => decide.mutate('waitlisted')}>
                        Waitlist
                      </Button>
                      <Button variant="secondary" tone="danger" disabled={decide.isPending}
                        onClick={() => decide.mutate('rejected')}>
                        Reject
                      </Button>
                    </div>
                  </div>
                )}

                {/* Enrol — only once the family has accepted. Turning an
                    applicant into a student is the one irreversible step here,
                    so it appears only when it is actually the next one. */}
                {open.status === 'accepted' && mayEnrol && (
                  <div className="border-t pt-5">
                    <p className="eyebrow mb-2">Enrol</p>
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Into section</span>
                        <Select
                          value={sectionId}
                          onChange={setSectionId}
                          placeholder="Select…"
                          options={(sections.data?.items ?? []).map((s) => ({
                            value: s.id,
                            label: `${s.class_name}-${s.name} (${s.enrolled}/${s.capacity})`,
                          }))}
                        />
                      </label>
                      <Button disabled={!sectionId || enrol.isPending} onClick={() => enrol.mutate()}>
                        {enrol.isPending ? 'Enrolling…' : 'Create the student record'}
                      </Button>
                    </div>
                    <p className="mt-2 text-[12.5px] text-muted-foreground">
                      This issues an admission number and creates the enrolment. The application
                      stays on file against the new student.
                    </p>
                  </div>
                )}

                {open.status === 'offered' && (
                  <p className="text-[13.5px] text-muted-foreground">
                    An offer is out. The family accepts by paying the admission fee — once the
                    payment is recorded, this application becomes enrollable.
                  </p>
                )}
              </div>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
