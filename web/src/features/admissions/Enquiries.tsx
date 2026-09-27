import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Phone, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, Textarea, SkeletonTable, ErrorState, FormNotice, SEG_BAR, segClass,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { StatusPill } from '@/components/NeedsAttention'
import { formatDate } from '@/lib/utils'
import LeadPanel, { LostForm, SOURCES, STAGES, convertHref, stageLabel, waLink, ymdIn } from './LeadPanel'

/* The admissions desk, as a working queue rather than a list.
 *
 * An enquiry is a phone call that has not become a student yet, and the only
 * thing that moves it along is somebody ringing back on the day they said they
 * would. So the follow-ups door opens on today's calls and the overdue ones,
 * and the all-leads door offers the same leads as a board by stage, which is
 * how an admissions office talks about its season ("forty visits booked, how
 * many applied?").
 *
 * Opening a lead shows its timeline (every call, WhatsApp, note and stage
 * move, with who and when), one-tap call and WhatsApp, and a single "log this
 * call and set the next date" action. */

interface Enquiry {
  id: string
  student_name: string
  parent_name?: string
  phone: string
  email?: string
  source: string
  status: string
  next_follow_up?: string
  assigned_to?: string
  class_id?: string
  class_name?: string
  last_contacted_at?: string
  created_at: string
}

interface ParentLogin {
  sign_in_as?: string
  password?: string
  existing?: boolean
  sent_to?: string[]
  note?: string
}
interface Dup { id: string; student_name: string; parent_name?: string; status: string; created_at: string }

const OPEN = (s: string) => s !== 'applied' && s !== 'lost'
const blankForm = () => ({
  student_name: '', parent_name: '', phone: '', email: '', source: 'walk_in',
  class_sought: '', notes: '', referred_by: '', next_follow_up: ymdIn(1),
})

export default function Enquiries() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [status, setStatus] = useState('')
  const [adding, setAdding] = useState(false)
  /* "All leads" and "My follow-ups" read the same enquiries and are not the
     same question: one is the whole pipeline, the other is what a counsellor
     has to do before this evening. */
  const { featureSlug } = useParams()
  const mine = featureSlug === 'my_follow_ups'
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'board' && !mine ? 'board' : 'list'
  const openId = params.get('lead')
  const setParam = (k: string, v: string | null) => setParams((p) => {
    const n = new URLSearchParams(p)
    if (v) n.set(k, v); else n.delete(k)
    return n
  }, { replace: true })
  const openLead = (id: string | null) => setParam('lead', id)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (openId) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [openId])

  const [form, setForm] = useState(blankForm)
  const [note, setNote] = useState('')
  const [losing, setLosing] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['enquiries', status],
    queryFn: () => api.get<List<Enquiry>>(`/api/v1/admissions/enquiries${status ? `?status=${status}` : ''}`),
  })
  const classes = useQuery({
    queryKey: ['academics', 'classes'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/academics/classes'),
    enabled: adding,
  })
  /* The same family rings twice, or a parent walks in who filled the web form
     last week. Checked as the number is typed, before a second lead is made. */
  const digits = form.phone.replace(/\D/g, '')
  const dups = useQuery({
    queryKey: ['enquiry-dups', digits.slice(-10)],
    queryFn: () => api.get<List<Dup>>(`/api/v1/admissions/workflow/enquiries/duplicates?phone=${encodeURIComponent(digits)}`),
    enabled: adding && digits.length >= 10,
  })

  /* The login the enquiry just issued, held on screen until it is dismissed:
     the password exists nowhere else. */
  const [issued, setIssued] = useState<ParentLogin | null>(null)

  const create = useMutation({
    mutationFn: () => {
      const b: Record<string, string> = { student_name: form.student_name, phone: form.phone, source: form.source }
      for (const k of ['parent_name', 'email', 'class_sought', 'notes', 'next_follow_up'] as const) if (form[k].trim()) b[k] = form[k].trim()
      if (form.source === 'referral' && form.referred_by.trim()) b.referred_by = form.referred_by.trim()
      return api.post<{ id: string; parent_login?: ParentLogin; link_not_sent?: string[] }>('/api/v1/admissions/workflow/enquiries', b)
    },
    onSuccess: (res) => {
      setAdding(false)
      setForm(blankForm())
      /* Say which channels the application link could not go out on, with the
         server's reason, so the desk knows to open the integrations screen. */
      const missed = res?.link_not_sent ?? []
      setNote(missed.length
        ? `Enquiry logged. The application link could not be sent · ${missed.join('; ')}.`
        : 'Enquiry logged.')
      setIssued(res?.parent_login?.sign_in_as ? res.parent_login : null)
      qc.invalidateQueries({ queryKey: ['enquiries'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  /* The id goes in the path, not the body. */
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: string; next_follow_up?: string }) =>
      api.put(`/api/v1/admissions/workflow/enquiries/${id}`, body),
    onSuccess: () => {
      setNote('Updated.')
      qc.invalidateQueries({ queryKey: ['enquiries'] })
      qc.invalidateQueries({ queryKey: ['enquiry'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const today = ymdIn(0)
  const tomorrow = ymdIn(1)
  const all = q.data?.items ?? []
  const items = mine
    ? all.filter((e) => e.next_follow_up && e.next_follow_up <= today && OPEN(e.status))
    : all

  const { q: term, setQ: setTerm, shown } = useSearch(items,
    (e) => [e.student_name, e.parent_name, e.phone, e.source, e.status, e.class_name])

  const overdue = items.filter((e) => e.next_follow_up && e.next_follow_up < today && OPEN(e.status))
  const dueToday = items.filter((e) => e.next_follow_up === today && OPEN(e.status))
  const converted = all.filter((e) => e.status === 'applied').length
  const decided = all.filter((e) => !OPEN(e.status)).length

  const convert = (e: Enquiry) => nav(convertHref(e))
  /* A card dropped on a column: "Applied" means filling the application, and
     "Lost" needs a reason, so those two open their forms instead of moving. */
  const moveTo = (e: Enquiry, to: string) => {
    if (to === e.status) return
    if (to === 'applied') return convert(e)
    if (to === 'lost') return setLosing(e.id)
    update.mutate({ id: e.id, status: to })
  }

  const actions = (e: Enquiry) => OPEN(e.status) && (
    <span className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="secondary" disabled={update.isPending}
        title="Called today; ring again tomorrow"
        onClick={() => update.mutate({ id: e.id, status: 'contacted', next_follow_up: tomorrow })}>Called</Button>
      <Button size="sm" variant="secondary" onClick={() => openLead(e.id)}>Open</Button>
      <Button size="sm" variant="secondary" title="Open the application form with this lead filled in" onClick={() => convert(e)}>Convert</Button>
      <Button size="sm" variant="secondary" tone="danger" onClick={() => setLosing(e.id)}>Lost</Button>
    </span>
  )

  const losingLead = losing ? all.find((e) => e.id === losing) : null

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title={mine ? 'My follow-ups' : 'All leads'}
        description={
          mine
            ? 'The calls and visits due today and the overdue ones. What a counsellor opens first.'
            : 'Every lead that has not become a student yet, with where it has got to and who is chasing it.'
        }
        actions={
          <Button onClick={() => setAdding((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Add lead
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Open enquiries" value={all.filter((e) => OPEN(e.status)).length} />
          <Stat label="Due today" value={dueToday.length} />
          <Stat label="Overdue" value={overdue.length} hint={overdue.length ? 'Call these first' : 'All caught up'} />
          <Stat label="Converted" value={converted}
            hint={decided ? `${Math.round((100 * converted) / decided)}% of closed leads applied` : undefined} />
        </CellGrid>

        {issued && (
          <Card>
            <CardHeader
              title="The parent's login"
              description={
                issued.existing
                  ? 'This family already had an account, so nothing was changed.'
                  : 'Shown once. Give it to the parent now, it cannot be read back.'
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
                : 'Not sent to the parent, no messaging channel is set up. Give these to them now.'}
              {issued.note ? <div className="mt-1">{issued.note}</div> : null}
            </div>
          </Card>
        )}

        {adding && (
          <Card>
            <CardHeader title="New enquiry" description="Phone first: if the family has enquired before, you will see it here" />
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Phone</span>
                <Input type="tel" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="98xxxxxxxx" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Student name</span>
                <Input value={form.student_name} onChange={(v) => setForm({ ...form, student_name: v })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Parent name</span>
                <Input value={form.parent_name} onChange={(v) => setForm({ ...form, parent_name: v })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Class sought</span>
                <Select value={form.class_sought} onChange={(v) => setForm({ ...form, class_sought: v })}
                  placeholder={classes.isLoading ? 'Loading…' : 'Pick a class'}
                  options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                {/* Where the parent's login and the application link are sent. */}
                <span className="text-muted-foreground">Email</span>
                <Input type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="parent@example.com" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Source</span>
                {/* The six the server accepts (enquiries_source_check). */}
                <Select value={form.source} onChange={(v) => setForm({ ...form, source: v })} options={SOURCES} />
              </label>
              {form.source === 'referral' && (
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Referred by</span>
                  <Input value={form.referred_by} onChange={(v) => setForm({ ...form, referred_by: v })} placeholder="Parent of … in Class 3" />
                </label>
              )}
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Follow up on</span>
                <Input type="date" value={form.next_follow_up} onChange={(v) => setForm({ ...form, next_follow_up: v })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] sm:col-span-2 lg:col-span-4">
                <span className="text-muted-foreground">Notes</span>
                <Textarea value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} rows={2}
                  placeholder="Sibling in school, needs the bus, wants a visit on Saturday…" />
              </label>
            </div>
            {(dups.data?.items.length ?? 0) > 0 && (
              <div className="mx-5 mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-[13px]">
                <div className="font-medium">This number has enquired before</div>
                <ul className="mt-1 space-y-0.5">
                  {dups.data!.items.map((d) => (
                    <li key={d.id}>
                      <button type="button" className="text-primary hover:underline" onClick={() => { setAdding(false); openLead(d.id) }}>
                        {d.student_name}{d.parent_name ? ` (${d.parent_name})` : ''}
                      </button>
                      <span className="text-muted-foreground"> · {stageLabel(d.status)} · {formatDate(d.created_at)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 text-muted-foreground">Open that lead instead, or save this one if it is a different child.</div>
              </div>
            )}
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

        {losingLead && (
          <Card>
            <CardHeader title={`Close ${losingLead.student_name} as lost`} description="The reason feeds the lost-leads report" />
            <div className="border-t p-5">
              <LostForm id={losingLead.id} onDone={() => { setLosing(null); setNote('Closed as lost.') }} onCancel={() => setLosing(null)} />
            </div>
          </Card>
        )}

        {openId && (
          <div ref={panelRef} className="scroll-mt-4">
            <LeadPanel id={openId} onClose={() => openLead(null)} onOpen={openLead} />
          </div>
        )}

        {!mine && (
          <div className={SEG_BAR} role="group" aria-label="View">
            <button type="button" className={segClass(view === 'list')} onClick={() => setParam('view', null)}>Call sheet</button>
            <button type="button" className={segClass(view === 'board')} onClick={() => setParam('view', 'board')}>Board</button>
          </div>
        )}

        {view === 'board' ? (
          <Board items={shown} all={all} loading={q.isLoading} error={q.error} today={today}
            term={term} setTerm={setTerm} onOpen={openLead} onMove={moveTo} note={note} updateError={update.error} />
        ) : (
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
                    options={[{ value: '', label: 'All stages' }, ...STAGES.map((s) => ({ value: s.value, label: s.label }))]}
                  />
                  <ExportRows
                    rows={shown}
                    name="enquiries"
                    columns={[
                      { header: 'Student', value: (e) => e.student_name },
                      { header: 'Parent', value: (e) => e.parent_name },
                      { header: 'Phone', value: (e) => e.phone },
                      { header: 'Class', value: (e) => e.class_name },
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
                head={['Student', 'Phone', 'Class', 'Source', 'Follow-up', 'Status', '']}
                empty={!shown.length}
                emptyLabel={term ? 'No enquiry matches that.' : mine ? 'Nothing due today.' : 'No enquiries yet.'}
              >
                {[...shown]
                  .sort((a, b) => (a.next_follow_up ?? '9999').localeCompare(b.next_follow_up ?? '9999'))
                  .map((e) => {
                    const late = e.next_follow_up && e.next_follow_up < today && OPEN(e.status)
                    return (
                      <tr key={e.id}>
                        <Td>
                          <button type="button" className="text-left font-medium hover:text-primary hover:underline" onClick={() => openLead(e.id)}>
                            {e.student_name}
                          </button>
                          {e.parent_name && <div className="text-[13px] text-muted-foreground">{e.parent_name}</div>}
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-2">
                            <a href={`tel:${e.phone}`} className="inline-flex items-center gap-1 text-primary">
                              <Phone className="h-3 w-3" />{e.phone}
                            </a>
                            <a href={waLink(e.phone)} target="_blank" rel="noreferrer" title="WhatsApp" aria-label="WhatsApp" className="text-success">
                              <MessageCircle className="h-3.5 w-3.5" />
                            </a>
                          </span>
                        </Td>
                        <Td className="text-muted-foreground">{e.class_name ?? '-'}</Td>
                        <Td className="text-muted-foreground">{SOURCES.find((s) => s.value === e.source)?.label ?? e.source ?? '-'}</Td>
                        <Td className={late ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                          {e.next_follow_up ? formatDate(e.next_follow_up) : '-'}
                          {late && ' · overdue'}
                        </Td>
                        <Td><StatusPill status={e.status} /></Td>
                        <Td>{actions(e)}</Td>
                      </tr>
                    )
                  })}
              </Table>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}

/* The season as columns. Counts per stage, and the share of all leads that
   reached at least that stage, which is the conversion an admissions head
   reports. Cards drag between columns; on a phone, where dragging is awkward,
   each card opens the lead and its stage buttons. */
function Board({ items, all, loading, error, today, term, setTerm, onOpen, onMove, note, updateError }: {
  items: Enquiry[]; all: Enquiry[]; loading: boolean; error: unknown; today: string
  term: string; setTerm: (v: string) => void
  onOpen: (id: string) => void; onMove: (e: Enquiry, to: string) => void
  note: string; updateError: unknown
}) {
  const [over, setOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const rank: Record<string, number> = { new: 0, contacted: 1, visit_scheduled: 2, applied: 3, lost: -1 }
  const total = all.length
  const reached = (stage: string) => all.filter((e) => (rank[e.status] ?? 0) >= rank[stage]).length

  if (loading) return <Card><SkeletonTable columns={5} /></Card>
  if (error) return <Card><ErrorState error={error} /></Card>
  return (
    <Card>
      <CardHeader title="Pipeline" description="Drag a card to move it; Applied opens the application form, Lost asks why"
        action={<SearchBox value={term} onChange={setTerm} placeholder="Name, parent or phone" />} />
      <FormNotice error={updateError} ok={note} />
      <div className="grid gap-3 overflow-x-auto border-t p-4 md:grid-cols-5">
        {STAGES.map((s) => {
          const col = items.filter((e) => e.status === s.value)
            .sort((a, b) => (a.next_follow_up ?? '9999').localeCompare(b.next_follow_up ?? '9999'))
          const pct = s.value !== 'lost' && s.value !== 'new' && total ? Math.round((100 * reached(s.value)) / total) : null
          return (
            <div key={s.value}
              onDragOver={(ev) => { ev.preventDefault(); setOver(s.value) }}
              onDragLeave={() => setOver((o) => (o === s.value ? null : o))}
              onDrop={(ev) => {
                ev.preventDefault(); setOver(null)
                const e = all.find((x) => x.id === ev.dataTransfer.getData('text/plain'))
                if (e) onMove(e, s.value)
              }}
              className={`flex min-w-0 flex-col rounded-md border bg-muted/40 ${over === s.value && dragging ? 'ring-2 ring-primary' : ''}`}>
              <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
                <span className="text-[13px] font-medium">{s.label}</span>
                <span className="text-[13px] tabular-nums text-muted-foreground">
                  {col.length}{pct !== null ? ` · ${pct}%` : ''}
                </span>
              </div>
              <div className="flex max-h-[60vh] min-h-[6rem] flex-col gap-2 overflow-y-auto p-2">
                {col.length === 0 && <div className="px-1 py-3 text-center text-[13px] text-muted-foreground">None</div>}
                {col.map((e) => {
                  const late = e.next_follow_up && e.next_follow_up < today && OPEN(e.status)
                  return (
                    <div key={e.id} draggable
                      onDragStart={(ev) => { ev.dataTransfer.setData('text/plain', e.id); setDragging(e.id) }}
                      onDragEnd={() => setDragging(null)}
                      className={`cursor-grab rounded-md border bg-card p-2.5 text-[13px] shadow-sm ${dragging === e.id ? 'opacity-50' : ''}`}>
                      <button type="button" className="block w-full text-left font-medium hover:text-primary" onClick={() => onOpen(e.id)}>
                        {e.student_name}
                      </button>
                      <div className="text-muted-foreground">{[e.class_name, e.parent_name].filter(Boolean).join(' · ') || e.phone}</div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className={late ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                          {e.next_follow_up && OPEN(e.status) ? `${late ? 'Overdue · ' : ''}${formatDate(e.next_follow_up)}` : ''}
                        </span>
                        <span className="flex items-center gap-2">
                          <a href={`tel:${e.phone}`} title="Call" aria-label="Call" className="text-primary"><Phone className="h-3.5 w-3.5" /></a>
                          <a href={waLink(e.phone)} target="_blank" rel="noreferrer" title="WhatsApp" aria-label="WhatsApp" className="text-success">
                            <MessageCircle className="h-3.5 w-3.5" />
                          </a>
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
