import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, SkeletonTable, ErrorState, FormNotice,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
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

interface ParentLogin {
  sign_in_as?: string
  password?: string
  existing?: boolean
  sent_to?: string[]
  note?: string
}

const STATUSES = ['new', 'contacted', 'visit_scheduled', 'applied', 'lost']

export default function Enquiries() {
  const qc = useQueryClient()
  const nav = useNavigate()
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

  const [form, setForm] = useState({ student_name: '', parent_name: '', phone: '', email: '', source: 'walk_in' })
  const [note, setNote] = useState('')

  const q = useQuery({
    queryKey: ['enquiries', status],
    queryFn: () => api.get<List<Enquiry>>(`/api/v1/admissions/enquiries${status ? `?status=${status}` : ''}`),
  })

  /* The login the enquiry just issued, held on screen until it is dismissed.
   *
   * The password exists nowhere else. Nothing in this product can read one back
   * out, so if the message does not arrive — no signal, a mistyped address, a
   * gateway not yet set up — this panel is the only copy that was ever made.
   * The parent is standing at the desk at this moment, which is the one time it
   * can be handed over by hand, so it stays up until somebody closes it rather
   * than flashing past as a toast. */
  const [issued, setIssued] = useState<ParentLogin | null>(null)

  const create = useMutation({
    mutationFn: () => api.post<{ parent_login?: ParentLogin; link_not_sent?: string[] }>(
      '/api/v1/admissions/workflow/enquiries', form),
    onSuccess: (res) => {
      setAdding(false)
      setForm({ student_name: '', parent_name: '', phone: '', email: '', source: 'walk_in' })
      /* Say which channels the application link could not go out on.
       *
       * A desk that types a parent's email address and never sees an email
       * arrive has no way, from this screen, to tell a broken mail server from
       * one nobody has configured — so it gets reported as "email not sent" and
       * the integrations screen that fixes it in a minute is never opened. The
       * server now returns the reason; this shows it. */
      const missed = res?.link_not_sent ?? []
      setNote(missed.length
        ? `Enquiry logged. The application link could not be sent — ${missed.join('; ')}.`
        : 'Enquiry logged.')
      // Only where an account was actually issued. A family that already had
      // one gets a note and no password, and showing an empty box would read
      // as a credential that failed to generate.
      setIssued(res?.parent_login?.sign_in_as ? res.parent_login : null)
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

  /* A counsellor looks for a lead by the parent's name or the number on a
     scrap of paper, not by scrolling. Over what is loaded, which for a term's
     enquiries is the whole list. */
  const { q: term, setQ: setTerm, shown } = useSearch(items,
    (e) => [e.student_name, e.parent_name, e.phone, e.source, e.status])

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

        {issued && (
          <Card>
            <CardHeader
              title="The parent's login"
              description={
                issued.existing
                  ? 'This family already had an account, so nothing was changed.'
                  : 'Shown once. Give it to the parent now — it cannot be read back.'
              }
              action={<Button variant="ghost" onClick={() => setIssued(null)}>Done</Button>}
            />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <div>
                <div className="text-[13px] text-muted-foreground">Sign in as</div>
                <div className="font-mono text-base">{issued.sign_in_as}</div>
              </div>
              {issued.password ? (
                <div>
                  <div className="text-[13px] text-muted-foreground">Temporary password</div>
                  <div className="font-mono text-base">{issued.password}</div>
                </div>
              ) : null}
            </div>
            <div className="border-t px-5 py-4 text-[13px] text-muted-foreground">
              {/* What actually went out, rather than a claim that it did. The
                  channels a school has not bought yet queue nothing at all,
                  and a desk told "sent" for a message that was never queued
                  will not hand the password over — which is how a family ends
                  up with neither. */}
              {issued.sent_to?.length
                ? `Sent by ${issued.sent_to.join(', ')}. They can sign in and follow the admission from there.`
                : 'Not sent to the parent — no messaging channel is set up. Give these to them now.'}
              {issued.note ? <div className="mt-1">{issued.note}</div> : null}
            </div>
          </Card>
        )}

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
                {/* Not decoration: this is where the parent's login is sent,
                    and the only channel of the three that carries a password
                    reliably. A desk that skips it leaves the family with an
                    account they can only be told about by hand. */}
                <span className="text-muted-foreground">Email</span>
                <Input
                  value={form.email}
                  onChange={(v) => setForm({ ...form, email: v })}
                  placeholder="parent@example.com"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Source</span>
                <Select
                  value={form.source}
                  onChange={(v) => setForm({ ...form, source: v })}
                  /* These are the six the server accepts, and they were not.
                     'online', 'newspaper' and 'hoarding' are not in
                     enquiries_source_check, so a clerk who picked the obvious
                     option for a web lead got "source must be one of" and lost
                     the enquiry they had just typed. */
                  options={[
                    { value: 'walk_in', label: 'Walk-in' },
                    { value: 'phone', label: 'Telephone' },
                    { value: 'website', label: 'Website' },
                    { value: 'referral', label: 'Referral' },
                    { value: 'campaign', label: 'Campaign' },
                    { value: 'other', label: 'Other' },
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
              <span className="flex flex-wrap items-center gap-2">
                <Showing shown={shown.length} total={items.length} noun="enquiries" />
                <SearchBox value={term} onChange={setTerm} placeholder="Name, parent or phone" />
                <Select
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: '', label: 'All statuses' },
                    ...STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') })),
                  ]}
                />
                <ExportRows
                  rows={shown}
                  name="enquiries"
                  columns={[
                    { header: 'Student', value: (e) => e.student_name },
                    { header: 'Parent', value: (e) => e.parent_name },
                    { header: 'Phone', value: (e) => e.phone },
                    { header: 'Source', value: (e) => e.source },
                    { header: 'Follow-up', value: (e) => e.next_follow_up },
                    { header: 'Status', value: (e) => e.status },
                  ]}
                />
              </span>
            }
          />
          <FormNotice error={update.error} ok={note} />
          {q.isLoading ? (
            <SkeletonTable columns={7} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              wide
              head={['Student', 'Parent', 'Phone', 'Source', 'Follow-up', 'Status', '']}
              empty={!shown.length}
              emptyLabel={term ? 'No enquiry matches that.' : 'No enquiries yet.'}
            >
              {[...shown]
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
                              disabled={update.isPending}
                              title="Open the application form with this lead filled in"
                              onClick={() => {
                                /* The names and the number were taken on the
                                   phone; retyping them is how they end up
                                   spelled two ways in two tables. The server
                                   marks the enquiry converted when the
                                   application is filed against it. */
                                const q = new URLSearchParams({
                                  from: e.id,
                                  student: e.student_name,
                                  parent: e.parent_name ?? '',
                                  phone: e.phone,
                                })
                                /* /go resolves the workspace at the moment it is opened, which is
                                   the only moment anybody knows it — the same
                                   counsellor may hold the admissions role or the
                                   front-office one, and the path differs. */
                                nav(`/go/application_forms?${q}`)
                              }}
                            >
                              Convert
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
