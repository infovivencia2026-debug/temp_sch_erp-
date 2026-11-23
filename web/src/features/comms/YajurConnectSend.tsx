import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  ConnectCampaign, ConnectPerson, ConnectRecipientStatus, ConnectRelation, ConnectRepeat, ConnectSendTemplate,
} from '@shared/api/feature_yajur_connect'
import {
  Badge, Button, Card, ConfirmButton, Dialog, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select, Switch, Table, Td,
  SEG_BAR, segClass,
} from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import SendNotice from './ConnectSendNotice'

/* Yajur Connect sending (worker/src/routes/comms/yajur_connect_send.ts):
   the Send, Campaigns and Scheduled tabs. Every message is only queued; while
   the recipient guard is on, the queue blocks it and the screen above says so. */

export const MERGE_FIELDS = ['parent_name', 'student_name', 'class', 'staff_name']
const FIELD_LABEL: Record<string, string> = { parent_name: "Parent's name", student_name: "Student's name", class: 'Class', staff_name: "Staff member's name" }
export const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
export const RELATIONS: { value: ConnectRelation; label: string }[] = [
  { value: 'both', label: 'Both parents' }, { value: 'father', label: 'Fathers' }, { value: 'mother', label: 'Mothers' },
]
export const REPEATS: { value: ConnectRepeat; label: string }[] = [
  { value: 'once', label: 'Once' }, { value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'Every week' }, { value: 'monthly', label: 'Every month' },
]
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
export function fill(t: ConnectSendTemplate, values: Record<string, string>, who: Record<string, string>): string {
  const vars: Record<string, string> = { ...who }
  for (const f of t.fields) if (values[f]?.trim()) vars[f] = render(values[f], who)
  return render(t.body, vars)
}

/** The school's name, for {{school_name}} in previews. */
export const SchoolName = createContext('')

/** Template wording as the recipient reads it: the school's name filled in, a field still empty as a highlighted [field name]. */
function Wording({ text, className }: { text: string; className?: string }) {
  const school = useContext(SchoolName)
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)) {
    parts.push(text.slice(last, m.index))
    const k = m[1]
    parts.push(k === 'school_name' && school ? school
      : <span key={m.index} className="rounded bg-primary/10 px-1 font-medium text-primary">[{k.replace(/_/g, ' ')}]</span>)
    last = m.index! + m[0].length
  }
  parts.push(text.slice(last))
  return <p className={cn('whitespace-pre-wrap break-words', className)}>{parts}</p>
}

/* CHECK BEFORE SENDING (owner, 2026-11-23: "we want preview before sending").
   Pressing Send opens this: the message as the parent's WhatsApp shows it,
   who gets it, when, and what is left out. Nothing goes until "Send now". */
export function CheckBeforeSending({ onClose, onSend, pending, text, sampleTo, count, audience, when, template, leftOut, image, action }: {
  onClose: () => void; onSend: () => void; pending: boolean; text: string; sampleTo?: string; count: number; audience: string
  when: string; template: string; leftOut?: string; image?: string; action: string
}) {
  const school = useContext(SchoolName)
  return (
    <Dialog open size="lg" onClose={onClose} title="Check before sending"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Edit</Button>
        <Button pending={pending} onClick={onSend}>{action}</Button>
      </>}>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">What they will see</div>
          <div className="rounded-2xl bg-[#e5ddd5] p-4 dark:bg-[#0b141a]">
            <div className="mb-1.5 text-[12px] font-bold text-[#075e54] dark:text-[#25d366]">{school || 'School'}</div>
            <div className="max-w-full rounded-[10px] rounded-bl-[2px] bg-white p-3 text-[14px] text-[#111] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
              {image && <img src={image} alt="" className="mb-2 max-h-40 w-full rounded-md object-cover" />}
              <Wording text={text} />
            </div>
          </div>
          {sampleTo && <p className="mt-1.5 text-[12.5px] text-muted-foreground">Shown as {sampleTo} gets it. Each person sees their own name and child.</p>}
        </div>
        <div className="space-y-3 text-[14px]">
          <div><div className="text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Goes to</div>
            <div className="text-[26px] font-extrabold tabular-nums">{count} {count === 1 ? 'person' : 'people'}</div>
            <div className="text-muted-foreground">{audience}</div></div>
          <div><div className="text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">When</div><div className="font-semibold">{when}</div></div>
          <div><div className="text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Template</div><div className="font-semibold">{template}</div></div>
          {leftOut && <p className="rounded-lg bg-warning/15 p-2.5 text-[13px] text-warning">{leftOut}</p>}
        </div>
      </div>
    </Dialog>
  )
}

/** Template, its fields and the optional header picture: shared by one-parent and broadcast sends. */
export function Compose({ templates, code, setCode, values, setValues, image, setImage }: {
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
      {t && t.fields.filter((f) => !MERGE_FIELDS.includes(f)).map((f) => (
        <Field key={f} label={fieldLabel(f)} hint="You can use {{parent_name}}, {{staff_name}}, {{student_name}} and {{class}}">
          <Input value={values[f] ?? ''} onChange={(v) => setValues({ ...values, [f]: v })} />
        </Field>
      ))}
      {t && t.fields.some((f) => MERGE_FIELDS.includes(f)) && (
        <p className="text-[14px] text-muted-foreground">
          Filled per recipient: {t.fields.filter((f) => MERGE_FIELDS.includes(f)).map(fieldLabel).join(', ')}.
        </p>
      )}
      {t?.has_image_header && (
        <Field label="Header picture (optional)" hint="JPEG or PNG, up to 5 MB. Only for a template approved with a picture header.">
          <FilePicker value={file && file.url === image ? file : null} onChange={(f) => { setFile(f); setImage(f?.url ?? '') }}
            endpoint="/api/v1/comms/yajur-connect/send/image" accept="image/jpeg,image/png" label="Choose a picture" />
        </Field>
      )}
    </div>
  )
}

export const missing = (t: ConnectSendTemplate | undefined, values: Record<string, string>) =>
  !t || t.fields.some((f) => !MERGE_FIELDS.includes(f) && !(values[f] ?? '').trim())

export function SendTab({ onOpenChat, initialCode = '', presetGuardian = '', presetStudent = '' }: { onOpenChat: (id: string) => void; initialCode?: string; presetGuardian?: string; presetStudent?: string }) {
  const [mode, setMode] = useState<'one' | 'many' | 'test'>('one')
  const templates = useQuery({ queryKey: ['connect', 'send-templates'], queryFn: () => api.call('GET /comms/yajur-connect/send/templates'), staleTime: 60_000 })
  if (templates.isLoading) return <Loading />
  if (templates.error) return <ErrorState error={templates.error} />
  const list = templates.data?.items ?? []
  return (
    <SchoolName.Provider value={templates.data?.school_name ?? ''}>
    <div className="space-y-4">
      <div className={SEG_BAR} role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'one'} className={segClass(mode === 'one')} onClick={() => setMode('one')}>One parent</button>
        <button type="button" role="tab" aria-selected={mode === 'many'} className={segClass(mode === 'many')} onClick={() => setMode('many')}>Classes &amp; groups</button>
        <button type="button" role="tab" aria-selected={mode === 'test'} className={segClass(mode === 'test')} onClick={() => setMode('test')}>Test</button>
      </div>
      {mode === 'one' ? <OneParent templates={list} onOpenChat={onOpenChat} initialCode={initialCode} presetGuardian={presetGuardian} presetStudent={presetStudent} /> : mode === 'many' ? <SendNotice templates={list} initialCode={initialCode} /> : <TestSend templates={list} initialCode={initialCode} />}
    </div>
    </SchoolName.Provider>
  )
}

function OneParent({ templates, onOpenChat, initialCode = '', presetGuardian = '', presetStudent = '' }: { templates: ConnectSendTemplate[]; onOpenChat: (id: string) => void; initialCode?: string; presetGuardian?: string; presetStudent?: string }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [who, setWho] = useState<ConnectPerson | null>(null)
  /* Opened from Students & parents with a parent already chosen (owner, 2026-11-23). */
  const preset = useQuery({
    queryKey: ['connect', 'people', 'preset', presetGuardian, presetStudent],
    queryFn: () => api.call('GET /comms/yajur-connect/send/people', { query: { q: presetGuardian } }),
    enabled: !!presetGuardian && !who,
  })
  useEffect(() => {
    const hit = preset.data?.items.find((x) => x.guardian_id === presetGuardian && (!presetStudent || x.student_id === presetStudent)) ?? preset.data?.items.find((x) => x.guardian_id === presetGuardian)
    if (hit) setWho(hit)
  }, [preset.data, presetGuardian, presetStudent])
  const [code, setCode] = useState(templates.some((x) => x.code === initialCode) ? initialCode : '')
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
  const [checking, setChecking] = useState(false)

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
            <Wording text={preview} className="rounded-md border bg-muted/40 p-3 text-[14px]" />
          </div>
        )}
        <FormNotice error={send.error} ok={send.data ? 'Sent. Follow it in this parent\'s chat.' : undefined} />
        {send.data ? (
          <Button variant="secondary" onClick={() => onOpenChat(send.data!.conversation_id)}>Open chat</Button>
        ) : who && (
          <Button disabled={missing(t, values)} pending={send.isPending} onClick={() => setChecking(true)}>Send</Button>
        )}
        {checking && who && t && (
          <CheckBeforeSending onClose={() => setChecking(false)} pending={send.isPending} action="Send now"
            onSend={() => send.mutate(undefined, { onSettled: () => setChecking(false) })}
            text={preview} count={1} audience={`${who.guardian_name} (${who.relation}) · ${who.phone}${who.student_name ? ` · ${who.student_name}` : ''}`}
            when="Now" template={t.name ?? t.code} image={image.trim() || undefined}
            leftOut={who.opted_out ? 'This parent opted out of messages. It will be blocked.' : undefined} />
        )}
      </div>
    </Card>
  )
}

export const TEST_WHO = { parent_name: 'Test', student_name: 'Test', class: 'Test' }

/** One template to a number on the school's test list; no student is involved. */
function TestSend({ templates, initialCode = '' }: { templates: ConnectSendTemplate[]; initialCode?: string }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState(templates.some((x) => x.code === initialCode) ? initialCode : '')
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
            <Wording text={preview} className="rounded-md border bg-muted/40 p-3 text-[14px]" />
          </div>
        )}
        <FormNotice error={send.error} ok={send.data ? 'Sent to the test number.' : undefined} />
        <Button disabled={!phone || missing(t, values)} pending={send.isPending} onClick={() => send.mutate()}>Send test</Button>
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
          <Wording text={c.rendered} className="rounded-md border bg-muted/40 p-3" />
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
        <Card><EmptyState title="Nothing scheduled." body="On the Send tab, choose Classes &amp; groups, then Schedule, to send at a set time or on repeat." /></Card>
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
