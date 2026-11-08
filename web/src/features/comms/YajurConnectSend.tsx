import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  ConnectAudience, ConnectBroadcastBody, ConnectCampaign, ConnectPerson, ConnectRecipientStatus, ConnectRelation, ConnectRepeat, ConnectSendTemplate,
} from '@shared/api/feature_yajur_connect'
import {
  Badge, Button, Card, Checkbox, ConfirmButton, Dialog, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select, Switch, Table, Td,
  SEG_BAR, segClass,
} from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'

/* Yajur Connect sending (worker/src/routes/comms/yajur_connect_send.ts):
   the Send, Campaigns and Scheduled tabs. Every message is only queued; while
   the recipient guard is on, the queue blocks it and the screen above says so. */

const MERGE_FIELDS = ['parent_name', 'student_name', 'class', 'staff_name']
const FIELD_LABEL: Record<string, string> = { parent_name: "Parent's name", student_name: "Student's name", class: 'Class', staff_name: "Staff member's name" }
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const RELATIONS: { value: ConnectRelation; label: string }[] = [
  { value: 'both', label: 'Both parents' }, { value: 'father', label: 'Fathers' }, { value: 'mother', label: 'Mothers' },
]
const REPEATS: { value: ConnectRepeat; label: string }[] = [
  { value: 'once', label: 'Once' }, { value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'Every week' }, { value: 'monthly', label: 'Every month' },
]
const SCOPE_LABEL: Record<ConnectAudience['scope'], string> = {
  school: 'Whole school', classes: 'Classes', sections: 'Sections', staff: 'All staff', departments: 'Departments',
}
const repeatLabel = (r: ConnectRepeat) => REPEATS.find((x) => x.value === r)?.label ?? r
export const STATUS_LABEL: Record<ConnectRecipientStatus, string> = {
  queued: 'Queued', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', blocked: 'Blocked',
}
export const STATUS_TONE: Record<ConnectRecipientStatus, 'neutral' | 'success' | 'danger' | 'primary' | 'warning' | 'info'> = {
  queued: 'neutral', sent: 'info', delivered: 'primary', read: 'success', failed: 'danger', blocked: 'warning',
}

function render(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (m, k: string) => (vars[k] !== undefined && vars[k] !== '' ? vars[k] : m))
}
function fill(t: ConnectSendTemplate, values: Record<string, string>, who: Record<string, string>): string {
  const vars: Record<string, string> = { ...who }
  for (const f of t.fields) if (values[f]?.trim()) vars[f] = render(values[f], who)
  return render(t.body, vars)
}

/** Template, its fields and the optional header picture: shared by one-parent and broadcast sends. */
function Compose({ templates, code, setCode, values, setValues, image, setImage }: {
  templates: ConnectSendTemplate[]; code: string; setCode: (v: string) => void; values: Record<string, string>; setValues: (v: Record<string, string>) => void
  image: string; setImage: (v: string) => void
}) {
  const t = templates.find((x) => x.code === code)
  const [file, setFile] = useState<UploadedFile | null>(null)
  if (templates.length === 0) {
    return <p className="text-[14px] text-muted-foreground">No approved WhatsApp template is mapped yet. Add one under Communication, Message channels, Wording.</p>
  }
  return (
    <div className="space-y-3">
      <Field label="Template">
        <Select value={code} onChange={(v) => { setCode(v); setValues({}) }} placeholder="Choose a template" options={templates.map((x) => ({ value: x.code, label: x.name }))} />
      </Field>
      {t && t.fields.map((f) => (
        <Field key={f} label={fieldLabel(f)}
          hint={MERGE_FIELDS.includes(f) ? "Leave empty to use each recipient's own" : 'You can use {{parent_name}}, {{staff_name}}, {{student_name}} and {{class}}'}>
          <Input value={values[f] ?? ''} onChange={(v) => setValues({ ...values, [f]: v })} />
        </Field>
      ))}
      {t && (
        <Field label="Header picture (optional)" hint="JPEG or PNG, up to 5 MB. Only for a template approved with a picture header.">
          <FilePicker value={file && file.url === image ? file : null} onChange={(f) => { setFile(f); setImage(f?.url ?? '') }}
            endpoint="/api/v1/comms/yajur-connect/send/image" accept="image/jpeg,image/png" label="Choose a picture" />
        </Field>
      )}
    </div>
  )
}

const missing = (t: ConnectSendTemplate | undefined, values: Record<string, string>) =>
  !t || t.fields.some((f) => !MERGE_FIELDS.includes(f) && !(values[f] ?? '').trim())

export function SendTab({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const [mode, setMode] = useState<'one' | 'many' | 'test'>('one')
  const templates = useQuery({ queryKey: ['connect', 'send-templates'], queryFn: () => api.call('GET /comms/yajur-connect/send/templates'), staleTime: 60_000 })
  if (templates.isLoading) return <Loading />
  if (templates.error) return <ErrorState error={templates.error} />
  const list = templates.data?.items ?? []
  return (
    <div className="space-y-4">
      <div className={SEG_BAR} role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'one'} className={segClass(mode === 'one')} onClick={() => setMode('one')}>One parent</button>
        <button type="button" role="tab" aria-selected={mode === 'many'} className={segClass(mode === 'many')} onClick={() => setMode('many')}>Broadcast</button>
        <button type="button" role="tab" aria-selected={mode === 'test'} className={segClass(mode === 'test')} onClick={() => setMode('test')}>Test</button>
      </div>
      {mode === 'one' ? <OneParent templates={list} onOpenChat={onOpenChat} /> : mode === 'many' ? <Broadcast templates={list} /> : <TestSend templates={list} />}
    </div>
  )
}

function OneParent({ templates, onOpenChat }: { templates: ConnectSendTemplate[]; onOpenChat: (id: string) => void }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [who, setWho] = useState<ConnectPerson | null>(null)
  const [code, setCode] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [image, setImage] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h) }, [q])
  const people = useQuery({
    queryKey: ['connect', 'people', term],
    queryFn: () => api.call('GET /comms/yajur-connect/send/people', { query: { q: term } }),
    enabled: term.length >= 2 && !who,
  })
  const t = templates.find((x) => x.code === code)
  const send = useMutation({
    mutationFn: () => api.call('POST /comms/yajur-connect/send', {
      body: { guardian_id: who!.guardian_id, student_id: who!.student_id, template_code: code, values, header_image_url: image.trim() || null },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connect', 'list'] }) },
  })
  const preview = t && who ? fill(t, values, { parent_name: who.guardian_name, student_name: who.student_name ?? '', class: who.class_section ?? '' }) : ''

  return (
    <Card>
      <div className="space-y-4 p-4">
        {who ? (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 text-[14px]">
              <div className="truncate text-[16px] font-semibold">{who.guardian_name} <span className="font-normal text-muted-foreground">({who.relation})</span></div>
              <div className="truncate text-muted-foreground">{who.phone}{who.student_name ? ` · ${who.student_name}` : ''}{who.class_section ? `, ${who.class_section}` : ''}</div>
              {who.opted_out && <p className="mt-1 text-destructive">This parent opted out of messages. The queue will block it.</p>}
            </div>
            <Button variant="secondary" size="sm" onClick={() => { setWho(null); send.reset() }}>Change</Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Field label="Parent or student"><Input value={q} onChange={setQ} placeholder="Name, admission number or phone" /></Field>
            {people.isLoading ? <Loading shape="inline" /> : people.error ? <ErrorState error={people.error} /> : term.length >= 2 && (people.data?.items ?? []).length === 0 ? (
              <p className="text-[14px] text-muted-foreground">Nobody with a phone number matches.</p>
            ) : (
              <ul className="divide-y rounded-md border empty:hidden">
                {(people.data?.items ?? []).map((p) => (
                  <li key={p.guardian_id + (p.student_id ?? '')}>
                    <button type="button" className="flex min-h-12 w-full flex-col items-start px-3 py-2 text-left hover:bg-muted/50" onClick={() => setWho(p)}>
                      <span className="w-full truncate text-[15px] font-medium">{p.guardian_name} <span className="font-normal text-muted-foreground">({p.relation})</span></span>
                      <span className="w-full truncate text-[13px] text-muted-foreground">{p.student_name ?? 'No child linked'}{p.class_section ? `, ${p.class_section}` : ''} · {p.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {who && <Compose templates={templates} code={code} setCode={setCode} values={values} setValues={setValues} image={image} setImage={setImage} />}
        {preview && (
          <div>
            <div className="mb-1 text-[13px] text-muted-foreground">Preview</div>
            <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[14px]">{preview}</p>
          </div>
        )}
        <FormNotice error={send.error} ok={send.data ? 'Queued. It is in this parent\'s chat.' : undefined} />
        {send.data ? (
          <Button variant="secondary" onClick={() => onOpenChat(send.data!.conversation_id)}>Open chat</Button>
        ) : who && (
          <Button disabled={missing(t, values)} pending={send.isPending} onClick={() => send.mutate()}>Queue message</Button>
        )}
      </div>
    </Card>
  )
}

const TEST_WHO = { parent_name: 'Test', student_name: 'Test', class: 'Test' }

/** One template to a number on the school's test list; no student is involved. */
function TestSend({ templates }: { templates: ConnectSendTemplate[] }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [image, setImage] = useState('')
  const numbers = useQuery({ queryKey: ['connect', 'test-numbers'], queryFn: () => api.call('GET /comms/yajur-connect/send/test-numbers'), staleTime: 60_000 })
  const t = templates.find((x) => x.code === code)
  const send = useMutation({
    mutationFn: () => api.call('POST /comms/yajur-connect/send/test', { body: { phone, template_code: code, values, header_image_url: image.trim() || null } }),
  })
  if (numbers.isLoading) return <Loading />
  if (numbers.error) return <ErrorState error={numbers.error} />
  const items = numbers.data?.items ?? []
  if (items.length === 0) {
    return <Card><EmptyState title="No test numbers." body="Add your number to the test list under Communication → Message channels → WhatsApp." /></Card>
  }
  const preview = t ? fill(t, values, TEST_WHO) : ''
  return (
    <Card>
      <div className="space-y-4 p-4">
        <Field label="Send to">
          <Select value={phone} onChange={(v) => { setPhone(v); send.reset() }} placeholder="Choose a test number"
            options={items.map((x) => ({ value: x.phone, label: x.label ? `${x.label} · ${x.phone}` : x.phone }))} />
        </Field>
        <Compose templates={templates} code={code} setCode={(v) => { setCode(v); send.reset() }} values={values} setValues={setValues} image={image} setImage={setImage} />
        {preview && (
          <div>
            <div className="mb-1 text-[13px] text-muted-foreground">Preview</div>
            <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[14px]">{preview}</p>
          </div>
        )}
        <FormNotice error={send.error} ok={send.data ? 'Test queued.' : undefined} />
        <Button disabled={!phone || missing(t, values)} pending={send.isPending} onClick={() => send.mutate()}>Send test</Button>
      </div>
    </Card>
  )
}

function Broadcast({ templates }: { templates: ConnectSendTemplate[] }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [image, setImage] = useState('')
  const [scope, setScope] = useState<ConnectAudience['scope']>('school')
  const [ids, setIds] = useState<string[]>([])
  const [relation, setRelation] = useState<ConnectRelation>('both')
  const staff = scope === 'staff' || scope === 'departments'
  const [later, setLater] = useState(false)
  const [runAt, setRunAt] = useState('')
  const [repeat, setRepeat] = useState<ConnectRepeat>('once')
  const [done, setDone] = useState('')
  const opts = useQuery({ queryKey: ['connect', 'audiences'], queryFn: () => api.call('GET /comms/yajur-connect/send/audiences'), staleTime: 300_000 })
  const t = templates.find((x) => x.code === code)
  const body: ConnectBroadcastBody = { name: name.trim(), template_code: code, values, header_image_url: image.trim() || null, audience: { scope, ids: scope === 'school' || scope === 'staff' ? [] : ids, relation } }
  const ready = !!body.name && !missing(t, values) && (scope === 'school' || scope === 'staff' || ids.length > 0)
  const [key, setKey] = useState('')
  const json = JSON.stringify(body)
  useEffect(() => { const h = setTimeout(() => setKey(json), 400); return () => clearTimeout(h) }, [json])
  const preview = useQuery({
    queryKey: ['connect', 'preview', key],
    queryFn: () => api.call('POST /comms/yajur-connect/send/preview', { body: JSON.parse(key) as ConnectBroadcastBody }),
    enabled: ready && key === json,
  })
  const reset = (msg: string) => { setDone(msg); setName(''); setValues({}); setImage(''); setRunAt('') }
  const queue = useMutation({
    mutationFn: () => api.call('POST /comms/yajur-connect/campaigns', { body }),
    onSuccess: (c) => { reset(`Queued for ${c.recipient_count}. See it under Campaigns.`); qc.invalidateQueries({ queryKey: ['connect', 'campaigns'] }) },
  })
  const schedule = useMutation({
    mutationFn: () => api.call('POST /comms/yajur-connect/schedules', { body: { ...body, repeat, run_at: new Date(runAt).toISOString() } }),
    onSuccess: () => { reset('Scheduled. See it under Scheduled.'); qc.invalidateQueries({ queryKey: ['connect', 'schedules'] }) },
  })
  const choices = useMemo(() => {
    const cls = opts.data?.classes ?? []
    if (scope === 'departments') return (opts.data?.departments ?? []).map((d) => ({ id: d.id, label: d.name }))
    return scope === 'classes' ? cls.map((c) => ({ id: c.id, label: c.name }))
      : cls.flatMap((c) => c.sections.map((s) => ({ id: s.id, label: `${c.name} ${s.name}` })))
  }, [opts.data, scope])
  const p = preview.data

  return (
    <Card>
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Campaign name"><Input value={name} onChange={setName} placeholder="Sports day notice" /></Field>
          <Compose templates={templates} code={code} setCode={setCode} values={values} setValues={setValues} image={image} setImage={setImage} />
        </div>
        <div className="space-y-3">
          <Field label="Send to">
            <div className={SEG_BAR} role="tablist">
              <button type="button" role="tab" aria-selected={!staff} className={segClass(!staff)} onClick={() => { setScope('school'); setIds([]) }}>Parents</button>
              <button type="button" role="tab" aria-selected={staff} className={segClass(staff)} onClick={() => { setScope('staff'); setIds([]) }}>Staff</button>
            </div>
          </Field>
          <div className={SEG_BAR} role="tablist">
            {(staff ? (['staff', 'departments'] as const) : (['school', 'classes', 'sections'] as const)).map((s) => (
              <button key={s} type="button" role="tab" aria-selected={scope === s} className={segClass(scope === s)} onClick={() => { setScope(s); setIds([]) }}>
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
          {scope !== 'school' && scope !== 'staff' && (
            opts.isLoading ? <Loading shape="inline" /> : opts.error ? <ErrorState error={opts.error} /> : (
              <div className="grid max-h-60 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-2 min-[400px]:grid-cols-2">
                {choices.map((c) => (
                  <Checkbox key={c.id} label={c.label} checked={ids.includes(c.id)} onChange={(on) => setIds(on ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
                ))}
              </div>
            )
          )}
          {!staff && <Field label="Parents"><Select value={relation} onChange={(v) => setRelation(v as ConnectRelation)} options={RELATIONS} /></Field>}
          <Field label="When">
            <div className={SEG_BAR} role="tablist">
              <button type="button" role="tab" aria-selected={!later} className={segClass(!later)} onClick={() => setLater(false)}>Now</button>
              <button type="button" role="tab" aria-selected={later} className={segClass(later)} onClick={() => setLater(true)}>Later</button>
            </div>
          </Field>
          {later && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date and time"><Input type="datetime-local" value={runAt} onChange={setRunAt} /></Field>
              <Field label="Repeat"><Select value={repeat} onChange={(v) => setRepeat(v as ConnectRepeat)} options={REPEATS} /></Field>
            </div>
          )}
          <div className="rounded-md border p-3 text-[14px]">
            {!ready ? <p className="text-muted-foreground">Fill the name, the template fields and the audience to see who gets it.</p>
              : preview.isLoading || key !== json ? <Loading shape="inline" /> : preview.error ? <ErrorState error={preview.error} /> : p && (
                <div className="space-y-2">
                  <p><strong className="tabular-nums">{p.count}</strong> {p.count === 1 ? 'recipient' : 'recipients'} · {p.audience_label}</p>
                  {(p.opted_out > 0 || p.no_phone > 0) && (
                    <p className="text-muted-foreground">Left out: {p.opted_out} opted out, {p.no_phone} without a readable number.</p>
                  )}
                  {p.sample && (
                    <>
                      <div className="text-[13px] text-muted-foreground">As {p.sample_to} gets it</div>
                      <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3">{p.sample}</p>
                    </>
                  )}
                </div>
              )}
          </div>
          <FormNotice error={queue.error ?? schedule.error} ok={done || undefined} />
          {later ? (
            <Button disabled={!ready || !runAt || !p?.count} pending={schedule.isPending} onClick={() => { setDone(''); schedule.mutate() }}>Schedule</Button>
          ) : (
            <ConfirmButton variant="primary" size="md" disabled={!ready || !p?.count} question={`Queue this to ${p?.count ?? 0} ${p?.count === 1 ? 'recipient' : 'recipients'}?`}
              confirmLabel="Queue" onConfirm={() => { setDone(''); queue.mutate() }}>
              {queue.isPending ? 'Queueing' : 'Queue broadcast'}
            </ConfirmButton>
          )}
        </div>
      </div>
    </Card>
  )
}

function Counts({ c }: { c: ConnectCampaign }) {
  const keys = (Object.keys(STATUS_LABEL) as ConnectRecipientStatus[]).filter((k) => c.counts[k])
  return <div className="flex flex-wrap gap-1">{keys.map((k) => <Badge key={k} tone={STATUS_TONE[k]}>{`${STATUS_LABEL[k]} ${c.counts[k]}`}</Badge>)}</div>
}

export function CampaignsTab() {
  const [open, setOpen] = useState<string | null>(null)
  const list = useQuery({ queryKey: ['connect', 'campaigns'], queryFn: () => api.call('GET /comms/yajur-connect/campaigns'), refetchInterval: 30_000 })
  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const items = list.data?.items ?? []
  return (
    <>
      {items.length === 0 ? (
        <Card><EmptyState title="No campaigns yet." body="A broadcast queued from the Send tab is kept here with each parent's status." /></Card>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setOpen(c.id)} className="card flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:border-primary/50">
                <div className="flex w-full items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold sm:text-[15px]">{c.name}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">{formatDateTime(c.created_at)}</span>
                </div>
                <span className="w-full truncate text-[14px] text-muted-foreground">{c.audience_label} · {c.recipient_count} queued{c.schedule_id ? ' · scheduled' : ''}</span>
                <Counts c={c} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <CampaignDetail id={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function CampaignDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ['connect', 'campaign', id], queryFn: () => api.call('GET /comms/yajur-connect/campaigns/{id}', { params: { id } }), refetchInterval: 15_000 })
  const c = d.data?.campaign
  return (
    <Dialog onClose={onClose} title={c?.name ?? 'Campaign'} description={c ? `${formatDateTime(c.created_at)}${c.created_by_name ? ' · ' + c.created_by_name : ''}` : undefined} size="lg">
      {d.isLoading ? <Loading /> : d.error ? <ErrorState error={d.error} /> : c && (
        <div className="space-y-4 text-[14px]">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Template</dt><dd className="min-w-0 truncate">{c.template_name ?? c.template_code}</dd>
            <dt className="text-muted-foreground">Audience</dt><dd className="min-w-0">{c.audience_label}</dd>
            <dt className="text-muted-foreground">Queued</dt><dd>{c.recipient_count}{c.opted_out ? `, ${c.opted_out} opted out and left out` : ''}</dd>
            {c.header_image_url && <><dt className="text-muted-foreground">Picture</dt><dd className="min-w-0"><img src={c.header_image_url} alt="" loading="lazy" decoding="async" className="h-14 w-14 rounded border object-cover" /></dd></>}
          </dl>
          <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3">{c.rendered}</p>
          <Counts c={c} />
          <Table head={['Parent', 'Student', 'Number', 'Status']} empty={d.data!.recipients.length === 0} emptyLabel="No messages were queued." noExport>
            {d.data!.recipients.map((r) => (
              <tr key={r.id}>
                <Td label="Parent" className="max-w-[200px] truncate">{r.parent_name ?? ''}</Td>
                <Td label="Student" className="max-w-[220px] truncate">{r.student_name ?? ''}{r.class ? `, ${r.class}` : ''}</Td>
                <Td label="Number" className="whitespace-nowrap tabular-nums">{r.recipient}</Td>
                <Td label="Status">
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  {r.error && (r.status === 'failed' || r.status === 'blocked') && <div className="mt-1 max-w-[260px] break-words text-[12px] text-muted-foreground">{r.error}</div>}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Dialog>
  )
}

export function ScheduledTab() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['connect', 'schedules'], queryFn: () => api.call('GET /comms/yajur-connect/schedules'), refetchInterval: 60_000 })
  const done = () => qc.invalidateQueries({ queryKey: ['connect', 'schedules'] })
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.call('PUT /comms/yajur-connect/schedules/{id}', { params: { id: v.id }, body: { active: v.active } }),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: (id: string) => api.call('DELETE /comms/yajur-connect/schedules/{id}', { params: { id } }), onSuccess: done })
  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const items = list.data?.items ?? []
  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <Card><EmptyState title="Nothing scheduled." body="On the Send tab, choose Broadcast, then Later, to send at a set time or on repeat." /></Card>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={s.id} className="card flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1 text-[14px]">
                <div className={cn('truncate text-[16px] font-semibold sm:text-[15px]', !s.active && 'text-muted-foreground')}>{s.name}</div>
                <div className="truncate text-muted-foreground">{repeatLabel(s.repeat)} · {s.audience_label}</div>
                <div className="text-muted-foreground">
                  {s.next_run_at && s.active ? `Next ${formatDateTime(s.next_run_at)}` : s.next_run_at ? 'Paused' : 'Done'}
                  {s.last_run_at ? ` · last ${formatDateTime(s.last_run_at)}` : ''}
                </div>
                {s.last_error && <div className="break-words text-destructive">{s.last_error}</div>}
              </div>
              {s.next_run_at && <Switch on={s.active} onChange={(v) => toggle.mutate({ id: s.id, active: v })} label={`Run ${s.name}`} />}
              <ConfirmButton variant="ghost" size="sm" tone="danger" question={`Delete the schedule "${s.name}"?`} confirmLabel="Delete" onConfirm={() => remove.mutate(s.id)}>
                Delete
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <FormNotice error={toggle.error ?? remove.error} />
    </div>
  )
}
