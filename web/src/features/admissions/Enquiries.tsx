import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, Loading, ErrorState, FormNotice,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { formatDate } from '@/lib/utils'

/* The admissions desk, as a working queue rather than a list.
 *
 * An enquiry is a phone call that has not become a student yet, and the only
 * thing that moves it along is somebody ringing back on the day they said they
 * would. So the default view is today's follow-ups and the overdue ones, not
 * the full list — a counsellor opening this screen wants their call sheet.
 *
 * The endpoints have been here since the admissions module landed and nothing
 * called them: the enquiry list, the create, and the update that reschedules a
 * follow-up. A lead nobody can call back is just a row.
 */

interface Enquiry {
  id: string
  student_name: string
  parent_name?: string
  phone: string
  source: string
  status: string
  next_follow_up?: string
  assigned_to?: string
  created_at: string
}

const STATUSES = ['new', 'contacted', 'visit_scheduled', 'applied', 'lost']

export default function Enquiries() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const [adding, setAdding] = useState(false)
  /* Which of the two doors somebody came through.
   *
   * "All leads" and "My follow-ups" both read the same enquiries, and they are
   * not the same question: one is the whole pipeline, the other is what a
   * counsellor has to do before this evening. Opening both on the same
   * unfiltered list made the second entry pointless, which is how a menu
   * accumulates names that lead nowhere new. */
  const { featureSlug } = useParams()
  const mine = featureSlug === 'my_follow_ups'

  const [form, setForm] = useState({ student_name: '', parent_name: '', phone: '', source: 'walk_in' })
  const [note, setNote] = useState('')

  const q = useQuery({
    queryKey: ['enquiries', status],
    queryFn: () => api.get<List<Enquiry>>(`/api/v1/admissions/enquiries${status ? `?status=${status}` : ''}`),
  })

  const create = useMutation({
    mutationFn: () => api.post('/api/v1/admissions/workflow/enquiries', form),
    onSuccess: () => {
      setAdding(false)
      setForm({ student_name: '', parent_name: '', phone: '', source: 'walk_in' })
      setNote('Enquiry logged.')
      qc.invalidateQueries({ queryKey: ['enquiries'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  /* The id goes in the path, not the body.
   *
   * The whole object was being sent as the body, id included, and the server
   * rejects unknown fields — so a perfectly valid request came back "malformed
   * JSON body" and no enquiry could ever be advanced. The id was never a field
   * of the request: it is the thing being addressed, and it is already in the
   * URL.
   *
   * Losing an enquiry needs a reason, which the server has always required and
   * the screen never asked for. "Fee too high" and "moved city" lead to
   * completely different actions, and a funnel report that cannot tell them
   * apart is a report nobody can act on. */
  const update = useMutation({
    mutationFn: ({ id, ...body }: {
      id: string
      status?: string
      next_follow_up?: string
      lost_reason?: string
    }) => api.put(`/api/v1/admissions/workflow/enquiries/${id}`, body),
    onSuccess: () => {
      setNote('Updated.')
      qc.invalidateQueries({ queryKey: ['enquiries'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const today = new Date().toISOString().slice(0, 10)
  const all = q.data?.items ?? []
  /* On the follow-ups door, show the work rather than the archive: what is
     overdue or due today. The whole pipeline is one click away under All
     leads, which is the entry that promises it. */
  const items = mine
    ? all.filter((e) => e.next_follow_up && e.next_follow_up <= today
                        && !['applied', 'lost'].includes(e.status))
    : all

  const overdue = items.filter(
    (e) => e.next_follow_up && e.next_follow_up < today && !['applied', 'lost'].includes(e.status),
  )
  const dueToday = items.filter((e) => e.next_follow_up === today)

  /* Tomorrow, in the school's own date format. Rescheduling to "tomorrow" is
     the single most common thing a counsellor does after a call. */
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10)

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title={mine ? 'My follow-ups' : 'All leads'}
        description={
          mine
            ? 'The calls and visits due today, for whoever is signed in. What a counsellor opens first.'
            : 'Every lead that has not become a student yet, with where it has got to and who is chasing it.'
        }
        actions={
          /* A walk-in is typed the moment somebody is standing at the desk, so
             the control that starts it sits in the corner every screen puts its
             primary action in — not buried under the table it will appear in. */
          <Button onClick={() => setAdding((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Add lead
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Open enquiries" value={items.filter((e) => !['applied', 'lost'].includes(e.status)).length} />
          <Stat label="Due today" value={dueToday.length} />
          <Stat label="Overdue" value={overdue.length} hint={overdue.length ? 'Call these first' : 'All caught up'} />
          <Stat label="Converted" value={items.filter((e) => e.status === 'applied').length} />
        </CellGrid>

        {adding && (
          <Card>
            <CardHeader title="New enquiry" description="What the front desk takes down on the phone" />
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Student name</span>
                <Input value={form.student_name} onChange={(v) => setForm({ ...form, student_name: v })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Parent name</span>
                <Input value={form.parent_name} onChange={(v) => setForm({ ...form, parent_name: v })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Phone</span>
                <Input value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="98xxxxxxxx" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Source</span>
                <Select
                  value={form.source}
                  onChange={(v) => setForm({ ...form, source: v })}
                  options={[
                    { value: 'walk_in', label: 'Walk-in' },
                    { value: 'referral', label: 'Referral' },
                    { value: 'online', label: 'Online' },
                    { value: 'newspaper', label: 'Newspaper' },
                    { value: 'hoarding', label: 'Hoarding' },
                  ]}
                />
              </label>
            </div>
            <div className="flex gap-2 border-t px-5 py-4">
              <Button
                disabled={!form.student_name.trim() || !form.phone.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Saving…' : 'Log enquiry'}
              </Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
            <FormNotice error={create.error} />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Enquiries"
            description="Overdue first, then by follow-up date"
            action={
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'All statuses' },
                  ...STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') })),
                ]}
              />
            }
          />
          <FormNotice error={update.error} ok={note} />
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              wide
              head={['Student', 'Parent', 'Phone', 'Source', 'Follow-up', 'Status', '']}
              empty={!items.length}
              emptyLabel="No enquiries yet."
            >
              {[...items]
                .sort((a, b) => (a.next_follow_up ?? '9999').localeCompare(b.next_follow_up ?? '9999'))
                .map((e) => {
                  const late = e.next_follow_up && e.next_follow_up < today &&
                    !['applied', 'lost'].includes(e.status)
                  return (
                    <tr key={e.id}>
                      <Td className="font-medium">{e.student_name}</Td>
                      <Td className="text-muted-foreground">{e.parent_name ?? '—'}</Td>
                      <Td>
                        <a href={`tel:${e.phone}`} className="inline-flex items-center gap-1 text-primary">
                          <Phone className="h-3 w-3" />{e.phone}
                        </a>
                      </Td>
                      <Td className="text-muted-foreground">{e.source?.replace('_', ' ') ?? '—'}</Td>
                      <Td className={late ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                        {e.next_follow_up ? formatDate(e.next_follow_up) : '—'}
                        {late && ' · overdue'}
                      </Td>
                      <Td><StatusPill status={e.status} /></Td>
                      <Td>
                        {!['applied', 'lost'].includes(e.status) && (
                          <span className="flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={update.isPending}
                              onClick={() => update.mutate({
                                id: e.id, status: 'contacted', next_follow_up: tomorrow,
                              })}
                            >
                              Called
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: e.id, status: 'visit_scheduled' })}
                            >
                              Visit booked
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              tone="danger"
                              disabled={update.isPending}
                              onClick={() => {
                                const why = prompt(
                                  'Why was this enquiry lost? (fee too high, moved city, chose another school…)',
                                )?.trim()
                                if (why) update.mutate({ id: e.id, status: 'lost', lost_reason: why })
                              }}
                            >
                              Lost
                            </Button>
                          </span>
                        )}
                      </Td>
                    </tr>
                  )
                })}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
