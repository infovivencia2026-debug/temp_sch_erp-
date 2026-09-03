import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe2, CalendarClock, Trophy } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Checkbox, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Entry {
  id: string
  university: string
  country: string
  course?: string
  intake?: string
  application_deadline?: string
  entrance_exams?: string
  annual_fee_paise?: number
  scholarship_sought: boolean
  status: string
  notes?: string
  days_to_deadline?: number
  added_on: string
}

const STATUSES = [
  { value: 'researching', label: 'Researching' },
  { value: 'shortlisted', label: 'Shortlisted' },
  { value: 'applied', label: 'Applied' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
]

const TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  researching: 'neutral',
  shortlisted: 'info',
  applied: 'warning',
  interview: 'warning',
  offer: 'success',
  accepted: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
}

/** How a closing date reads to the person who has to meet it. */
function deadline(days?: number) {
  if (days === undefined || days === null) return { text: 'No date set', urgent: false }
  if (days < 0) return { text: 'Closed', urgent: true }
  if (days === 0) return { text: 'Closes today', urgent: true }
  if (days === 1) return { text: 'Closes tomorrow', urgent: true }
  if (days <= 30) return { text: `${days} days left`, urgent: true }
  return { text: `${days} days left`, urgent: false }
}

/* Applying abroad, kept by the child rather than in a counsellor's inbox.

   Sorted by what closes next, because Indian families lose places to the
   closing date far more often than to the essay — and a list in that order is
   most of the guidance a school can actually give.

   The fee is the rupee equivalent to plan for, not the figure on the
   prospectus. A family budgets in rupees, and a screen that mixed dollars with
   pounds would be adding them together somewhere. */
export default function Universities() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [university, setUniversity] = useState('')
  const [country, setCountry] = useState('')
  const [course, setCourse] = useState('')
  const [intake, setIntake] = useState('')
  const [closes, setCloses] = useState('')
  const [exams, setExams] = useState('')
  const [fee, setFee] = useState('')
  const [scholarship, setScholarship] = useState(false)
  const [notes, setNotes] = useState('')

  const list = useQuery({
    queryKey: ['universities', studentId],
    queryFn: () =>
      api.get<List<Entry>>(`/api/v1/portal/learning/universities${studentQuery(studentId)}`),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['universities'] })

  const add = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/learning/universities', {
        student_id: studentId || undefined,
        university,
        country,
        course: course || undefined,
        intake: intake || undefined,
        application_deadline: closes || undefined,
        entrance_exams: exams || undefined,
        // Entered in rupees because that is what a prospectus conversation is
        // in; stored in paise because that is what every amount here is.
        annual_fee_paise: fee ? Math.round(Number(fee) * 100) : undefined,
        scholarship_sought: scholarship,
        notes: notes || undefined,
      }),
    onSuccess: () => {
      setUniversity(''); setCountry(''); setCourse(''); setIntake('')
      setCloses(''); setExams(''); setFee(''); setScholarship(false); setNotes('')
      refresh()
    },
  })

  const move = useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      api.post(`/api/v1/portal/learning/universities/${v.id}`, {
        student_id: studentId || undefined,
        status: v.status,
      }),
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api.del(`/api/v1/portal/learning/universities/${id}${studentQuery(studentId)}`),
    onSuccess: refresh,
  })

  if (list.isLoading && ready) return <SkeletonTiles count={3} label="Opening your shortlist…" />
  if (list.error) return <ErrorState error={list.error} />

  const rows = list.data?.items ?? []
  const live = rows.filter((r) => !['rejected', 'withdrawn'].includes(r.status))
  const soon = rows.filter(
    (r) => r.days_to_deadline !== undefined && r.days_to_deadline !== null &&
      r.days_to_deadline >= 0 && r.days_to_deadline <= 30,
  ).length
  const offers = rows.filter((r) => ['offer', 'accepted'].includes(r.status)).length

  return (
    <>
      <PageHead
        eyebrow="Learning"
        title="University guidance"
        description="Places you are considering abroad, what each one wants, and when it closes."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="A shortlist belongs to one child." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="On your list" value={live.length} icon={Globe2}
                hint={`${rows.length} including closed`} />
              <Stat
                label="Closing within a month"
                value={soon}
                icon={CalendarClock}
                delta={soon > 0 ? { value: 'Needs work now', positive: false } : undefined}
              />
              <Stat label="Offers" value={offers} icon={Trophy} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Add a place"
                description="Only the university and the country are required; the rest can follow."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="University" required>
                    <Input value={university} onChange={setUniversity}
                      placeholder="University of Toronto" />
                  </Field>
                  <Field label="Country" required>
                    <Input value={country} onChange={setCountry} placeholder="Canada" />
                  </Field>
                  <Field label="Course">
                    <Input value={course} onChange={setCourse} placeholder="Computer Science" />
                  </Field>
                  <Field label="Intake" hint="However that country names it — Fall 2029, Michaelmas 2028.">
                    <Input value={intake} onChange={setIntake} placeholder="Fall 2029" />
                  </Field>
                  <Field label="Application closes">
                    <Input value={closes} onChange={setCloses} type="date" />
                  </Field>
                  <Field label="Entrance exams" hint="What you will have to sit before you can apply.">
                    <Input value={exams} onChange={setExams} placeholder="SAT, IELTS" />
                  </Field>
                  <Field label="Annual fee (₹)" hint="The rupee equivalent to plan for, not the figure on the prospectus.">
                    <Input value={fee} onChange={setFee} type="number" placeholder="4500000" />
                  </Field>
                  <Field label="Notes" wide>
                    <Textarea value={notes} onChange={setNotes} rows={2}
                      placeholder="Needs two references and a portfolio; early decision closes a month sooner." />
                  </Field>
                </FormGrid>
                <Checkbox checked={scholarship} onChange={setScholarship}
                  label="I am applying for a scholarship or bursary here"
                  hint="Scholarship deadlines are usually earlier than the course's." />
                <FormNotice error={add.error} ok={add.isSuccess ? 'Added to your list.' : undefined} />
                <Button onClick={() => add.mutate()}
                  disabled={!university.trim() || !country.trim() || add.isPending}>
                  {add.isPending ? 'Adding…' : 'Add to shortlist'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Your shortlist"
                description="Soonest deadline first. Move a place along as you hear back."
              />
              <Table
                head={['Place', 'Course', 'Closes', 'Exams', { label: 'Annual fee', align: 'right' },
                  'Status', '']}
                empty={rows.length === 0}
                emptyLabel="Nothing shortlisted yet."
              >
                {rows.map((e) => {
                  const d = deadline(e.days_to_deadline)
                  return (
                    <tr key={e.id}>
                      <Td>
                        <span className="font-medium">{e.university}</span>
                        <span className="block text-[12.5px] text-muted-foreground">
                          {e.country}
                          {e.intake ? ` · ${e.intake}` : ''}
                          {e.scholarship_sought ? ' · scholarship' : ''}
                        </span>
                      </Td>
                      <Td>{e.course ?? <span className="text-muted-foreground">Not decided</span>}</Td>
                      <Td>
                        {e.application_deadline ? formatDate(e.application_deadline) : '—'}
                        <span
                          className={
                            d.urgent
                              ? 'block text-[12.5px] text-destructive'
                              : 'block text-[12.5px] text-muted-foreground'
                          }
                        >
                          {d.text}
                        </span>
                      </Td>
                      <Td className="text-[13px] text-muted-foreground">{e.entrance_exams ?? '—'}</Td>
                      <Td className="text-right tabular-nums">
                        {e.annual_fee_paise ? formatPaise(e.annual_fee_paise) : '—'}
                      </Td>
                      <Td>
                        <Badge tone={TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
                      </Td>
                      <Td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-36">
                            <Select
                              value={e.status}
                              onChange={(v) => move.mutate({ id: e.id, status: v })}
                              options={STATUSES}
                            />
                          </div>
                          <ConfirmButton
                            size="sm"
                            variant="ghost"
                            tone="danger"
                            question="Remove it from your list?"
                            confirmLabel="Remove"
                            onConfirm={() => remove.mutate(e.id)}
                          >
                            Remove
                          </ConfirmButton>
                        </div>
                      </Td>
                    </tr>
                  )
                })}
              </Table>
              <div className="border-t px-5 py-3">
                <FormNotice error={move.error ?? remove.error} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
