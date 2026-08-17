import { useState } from 'react'
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

  const update = useMutation({
    mutationFn: (v: { id: string; status?: string; next_follow_up?: string }) =>
      api.put(`/api/v1/admissions/workflow/enquiries/${v.id}`, v),
    onSuccess: () => {
      setNote('Updated.')
      qc.invalidateQueries({ queryKey: ['enquiries'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const items = q.data?.items ?? []
  const today = new Date().toISOString().slice(0, 10)
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
        title="Enquiries & follow-ups"
        description="Every enquiry that has not become a student yet, and who needs calling back today."
        actions={
          <Button onClick={() => setAdding((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Add enquiry
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
                              variant="ghost"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: e.id, status: 'visit_scheduled' })}
                            >
                              Visit booked
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              tone="danger"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: e.id, status: 'lost' })}
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
