import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BriefcaseBusiness, MapPin, CalendarClock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Field,
  FormNotice, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Job {
  id: string
  kind: string
  title: string
  organisation: string
  location?: string
  is_remote: boolean
  description?: string
  eligibility?: string
  stipend_paise?: number
  apply_url?: string
  apply_email?: string
  closes_on?: string
  status: string
  posted_by: string
  poster_batch_year?: number
  interested: number
  registered_interest: boolean
  posted_on: string
}

const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'internship', label: 'Internships' },
  { value: 'work_experience', label: 'Work experience' },
  { value: 'apprenticeship', label: 'Apprenticeships' },
  { value: 'volunteering', label: 'Volunteering' },
  { value: 'job', label: 'Jobs' },
]

/* What the alumni bring back.

   Every post is gated by year group before it reaches the page, so a graduate
   role never appears on a Grade 6 screen — the school's name is on anything a
   child reads here.

   Registering interest is exactly that. The hiring happens outside this
   system, so there is no status to watch and the screen does not pretend
   otherwise: it hands the poster a list and gives the child the link. */
export default function AlumniJobs() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)
  const [kind, setKind] = useState('')

  const jobs = useQuery({
    queryKey: ['alumni-jobs', studentId, kind],
    queryFn: () =>
      api.get<List<Job>>(
        `/api/v1/portal/alumni/jobs${studentQuery(studentId, kind ? `kind=${kind}` : '')}`,
      ),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['alumni-jobs'] })

  const register = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/alumni/jobs/${id}/interest`, {
        student_id: studentId || undefined,
      }),
    onSuccess: refresh,
  })

  const withdraw = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/alumni/jobs/${id}/withdraw`, {
        student_id: studentId || undefined,
      }),
    onSuccess: refresh,
  })

  if (jobs.isLoading && ready) return <Loading label="Reading the board…" />
  if (jobs.error) return <ErrorState error={jobs.error} />

  const rows = jobs.data?.items ?? []
  const registered = rows.filter((j) => j.registered_interest).length
  const closingSoon = rows.filter((j) => {
    if (!j.closes_on) return false
    const days = Math.round(
      (new Date(`${j.closes_on}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
    )
    return days >= 0 && days <= 14
  }).length

  return (
    <>
      <PageHead
        eyebrow="Alumni"
        title="Jobs and internships"
        description="Openings former pupils and the school have brought back, filtered to your year group."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState
            title="Choose a child"
            body="Postings are filtered by year group, so the board differs per child."
          />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Open to you" value={rows.length} icon={BriefcaseBusiness} />
              <Stat label="You have put your name down for" value={registered} icon={MapPin} />
              <Stat
                label="Closing within a fortnight"
                value={closingSoon}
                icon={CalendarClock}
                delta={closingSoon > 0 ? { value: 'Worth a look now', positive: false } : undefined}
              />
            </CellGrid>

            <Card>
              <CardHeader
                title="The board"
                description="Soonest closing date first."
                action={
                  <div className="w-52">
                    <Field label="Kind">
                      <Select value={kind} onChange={setKind} options={KINDS} />
                    </Field>
                  </div>
                }
              />
              {rows.length === 0 ? (
                <EmptyState
                  title="Nothing on the board"
                  body="When an alumnus or the school posts something open to your year group it appears here."
                />
              ) : (
                <ul className="divide-y">
                  {rows.map((j) => (
                    <li key={j.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium">
                            {j.title}
                            <Badge tone="info">{j.kind.replace('_', ' ')}</Badge>
                            {j.is_remote && <Badge>Remote</Badge>}
                          </p>
                          <p className="mt-0.5 text-[13px]">{j.organisation}</p>
                          {j.description && (
                            <p className="mt-1 text-[13px] text-muted-foreground">{j.description}</p>
                          )}
                          {j.eligibility && (
                            <p className="mt-1 text-[12.5px] text-muted-foreground">
                              Who can apply: {j.eligibility}
                            </p>
                          )}
                          <p className="mt-1 text-[12.5px] text-muted-foreground">
                            {j.location ?? 'Location not stated'}
                            {j.stipend_paise ? ` · ${formatPaise(j.stipend_paise)} a month` : ''}
                            {j.closes_on ? ` · closes ${formatDate(j.closes_on)}` : ''}
                            {' · posted by '}
                            {j.posted_by}
                            {j.poster_batch_year ? ` (class of ${j.poster_batch_year})` : ''}
                          </p>
                          {(j.apply_url || j.apply_email) && (
                            <p className="mt-1 text-[12.5px]">
                              {j.apply_url ? (
                                <a href={j.apply_url} target="_blank" rel="noreferrer noopener"
                                  className="underline underline-offset-2 hover:text-primary">
                                  How to apply
                                </a>
                              ) : (
                                <span className="text-muted-foreground">{j.apply_email}</span>
                              )}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <span className="text-[12.5px] tabular-nums text-muted-foreground">
                            {j.interested} interested
                          </span>
                          {j.registered_interest ? (
                            <Button size="sm" variant="secondary" disabled={withdraw.isPending}
                              onClick={() => withdraw.mutate(j.id)}>
                              Take my name off
                            </Button>
                          ) : (
                            <Button size="sm" disabled={register.isPending}
                              onClick={() => register.mutate(j.id)}>
                              I am interested
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={register.error ?? withdraw.error} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
