import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConnectAudience, ConnectBroadcastBody, ConnectRelation, ConnectRepeat, ConnectSendTemplate } from '@shared/api/feature_yajur_connect'
import { Badge, Button, Card, Checkbox, ErrorState, Field, FormNotice, Input, Loading, Select, SEG_BAR, segClass } from '@/components/ui'
import { cn } from '@/lib/utils'
import { CheckBeforeSending, Compose, MERGE_FIELDS, RELATIONS, REPEATS, SchoolName, TEST_WHO, fieldLabel, fill, missing } from './YajurConnectSend'

/* SEND A NOTICE (owner-approved design, "Connect in our ERP - preview.html" #send):
   Audience and Message on the left, a live WhatsApp-style preview on the right,
   a bar with the count and Schedule / Review & Send at the bottom. Both buttons
   only open Check before sending; nothing is queued until it is confirmed there.
   The buttons stay off while the recipient count is loading or out of date, so
   the number confirmed is the number sent (the confirmed body is frozen). */

const SCOPE_LABEL: Record<ConnectAudience['scope'], string> = {
  school: 'Whole school', classes: 'Classes', sections: 'Sections', staff: 'All staff', departments: 'Departments',
}
const SAMPLE_PARENT: Record<string, string> = { parent_name: "Parent's name", student_name: "Student's name", class: 'Class', staff_name: "Staff member's name" }
const SAMPLE_STAFF: Record<string, string> = { parent_name: "Staff member's name", staff_name: "Staff member's name", student_name: '', class: '' }
const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/g

/** The message as the recipient reads it: per-recipient parts highlighted, typed values in bold, empty fields as [field]. */
function LiveText({ text, values, sample, depth = 0 }: { text: string; values: Record<string, string>; sample: Record<string, string>; depth?: number }) {
  const school = useContext(SchoolName)
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    parts.push(text.slice(last, m.index))
    const k = m[1]
    const at = m.index ?? 0
    if (k === 'school_name' && school) parts.push(school)
    else if (MERGE_FIELDS.includes(k)) parts.push(<span key={at} className="rounded bg-primary/15 px-1 font-medium text-primary">{sample[k] || fieldLabel(k)}</span>)
    else if (depth === 0 && values[k]?.trim()) parts.push(<strong key={at}><LiveText text={values[k]} values={values} sample={sample} depth={1} /></strong>)
    else parts.push(<span key={at} className="rounded bg-muted px-1 text-muted-foreground">[{fieldLabel(k)}]</span>)
    last = at + m[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

function Step({ n, label, done, on }: { n: number; label: string; done: boolean; on: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] font-medium',
      done ? 'border-success/40 bg-success/10 text-success' : on ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground')}>
      <span className={cn('grid size-5 place-items-center rounded-full text-[11px] font-bold',
        done ? 'bg-success text-primary-foreground' : on ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
        {done ? <Check className="size-3" aria-hidden /> : n}
      </span>
      {label}
    </span>
  )
}

type Frozen = { body: ConnectBroadcastBody; later: boolean; runAt: string; repeat: ConnectRepeat }

export default function SendNotice({ templates, initialCode = '' }: { templates: ConnectSendTemplate[]; initialCode?: string }) {
  const qc = useQueryClient()
  const school = useContext(SchoolName)
  const [name, setName] = useState('')
  const [code, setCode] = useState(templates.some((x) => x.code === initialCode) ? initialCode : '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [image, setImage] = useState('')
  const [scope, setScope] = useState<ConnectAudience['scope']>('school')
  const [ids, setIds] = useState<string[]>([])
  const [relation, setRelation] = useState<ConnectRelation>('both')
  const staff = scope === 'staff' || scope === 'departments'
  const [runAt, setRunAt] = useState('')
  const [repeat, setRepeat] = useState<ConnectRepeat>('once')
  const [done, setDone] = useState('')
  const [frozen, setFrozen] = useState<Frozen | null>(null)
  const busy = useRef(false)
  const opts = useQuery({ queryKey: ['connect', 'audiences'], queryFn: () => api.call('GET /comms/yajur-connect/send/audiences'), staleTime: 300_000 })
  const t = templates.find((x) => x.code === code)
  const body: ConnectBroadcastBody = { name: name.trim(), template_code: code, values, header_image_url: image.trim() || null, audience: { scope, ids: scope === 'school' || scope === 'staff' ? [] : ids, relation } }
  const audienceOk = scope === 'school' || scope === 'staff' || ids.length > 0
  const messageOk = !!body.name && !missing(t, values)
  const ready = audienceOk && messageOk
  const [key, setKey] = useState('')
  const json = JSON.stringify(body)
  useEffect(() => { const h = setTimeout(() => setKey(json), 400); return () => clearTimeout(h) }, [json])
  const preview = useQuery({
    queryKey: ['connect', 'preview', key],
    queryFn: () => api.call('POST /comms/yajur-connect/send/preview', { body: JSON.parse(key) as ConnectBroadcastBody }),
    enabled: ready && key === json,
  })
  const p = preview.data
  // Fresh: the count on screen belongs to exactly this form.
  const fresh = ready && key === json && !preview.isFetching && !preview.error && !!p
  const canGo = fresh && !!p && p.count > 0
  const reset = (msg: string) => { setDone(msg); setName(''); setValues({}); setImage(''); setRunAt('') }
  const queue = useMutation({
    mutationFn: (b: ConnectBroadcastBody) => api.call('POST /comms/yajur-connect/campaigns', { body: b }),
    onSuccess: (c) => { reset(`Sending to ${c.recipient_count}. Follow it under Campaigns.`); qc.invalidateQueries({ queryKey: ['connect', 'campaigns'] }) },
  })
  const schedule = useMutation({
    mutationFn: (f: Frozen) => api.call('POST /comms/yajur-connect/schedules', { body: { ...f.body, repeat: f.repeat, run_at: new Date(f.runAt).toISOString() } }),
    onSuccess: () => { reset('Scheduled. See it under Scheduled.'); qc.invalidateQueries({ queryKey: ['connect', 'schedules'] }) },
  })
  const pending = queue.isPending || schedule.isPending
  const choices = useMemo(() => {
    const cls = opts.data?.classes ?? []
    if (scope === 'departments') return (opts.data?.departments ?? []).map((d) => ({ id: d.id, label: d.name }))
    return scope === 'classes' ? cls.map((c) => ({ id: c.id, label: c.name }))
      : cls.flatMap((c) => c.sections.map((s) => ({ id: s.id, label: `${c.name} ${s.name}` })))
  }, [opts.data, scope])

  const open = (later: boolean) => {
    if (!canGo || pending || busy.current || (later && !runAt)) return
    setDone('')
    setFrozen({ body: JSON.parse(key) as ConnectBroadcastBody, later, runAt, repeat })
  }
  const confirm = () => {
    if (!frozen || busy.current || pending || JSON.stringify(frozen.body) !== key) return
    busy.current = true
    const settle = { onSettled: () => { busy.current = false; setFrozen(null) } }
    if (frozen.later) schedule.mutate(frozen, settle)
    else queue.mutate(frozen.body, settle)
  }

  const fmt = (v: string) => new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  const whenLabel = (f: Frozen) => f.later && f.runAt ? `${fmt(f.runAt)}${f.repeat !== 'once' ? ` · ${REPEATS.find((x) => x.value === f.repeat)?.label ?? f.repeat}` : ''}` : 'Now'
  const leftOut = p && (p.opted_out > 0 || p.no_phone > 0) ? `Left out: ${p.opted_out} opted out, ${p.no_phone} without a readable number.` : undefined
  const needed = [
    !t && 'pick a template',
    t && t.fields.filter((f) => !MERGE_FIELDS.includes(f) && !(values[f] ?? '').trim()).map((f) => `fill ${fieldLabel(f)}`).join(', '),
    !body.name && 'type a notice title',
    !audienceOk && `tick at least one ${scope === 'classes' ? 'class' : scope === 'sections' ? 'section' : 'department'}`,
  ].filter(Boolean).join(' · ')
  const counting = ready && !fresh && !preview.error
  const relLabel = RELATIONS.find((r) => r.value === relation)?.label.toLowerCase() ?? ''
  const audienceText = p && fresh ? p.audience_label : `${SCOPE_LABEL[scope]}${staff ? '' : ` · ${relLabel}`}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[22px] font-bold leading-tight">Send a notice</h2>
          <p className="text-[14px] text-muted-foreground">Choose who receives it, personalise your message, then review before sending.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Step n={1} label="Audience" done={audienceOk} on={!audienceOk} />
          <Step n={2} label="Message" done={messageOk} on={audienceOk && !messageOk} />
          <Step n={3} label="Review & send" done={false} on={ready} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[16px] font-semibold">Audience</h3>
                {fresh && p ? <Badge tone="primary">{`${p.count} ${p.count === 1 ? 'recipient' : 'recipients'}`}</Badge>
                  : counting ? <Badge>Counting</Badge>
                  : <span className="text-[13px] text-muted-foreground">Count shows once the message is filled</span>}
              </div>
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
              {!staff && <Field label="Which parent"><Select value={relation} onChange={(v) => setRelation(v as ConnectRelation)} options={RELATIONS} /></Field>}
            </div>
          </Card>

          <Card>
            <div className="space-y-3 p-4">
              <h3 className="text-[16px] font-semibold">Message</h3>
              <Compose templates={templates} code={code} setCode={setCode} values={values} setValues={setValues} image={image} setImage={setImage} />
              {t && (
                <details className="text-[14px]">
                  <summary className="cursor-pointer font-medium text-primary">View approved template text</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3">{t.body}</p>
                </details>
              )}
              <Field label="Notice title" hint="For your records under Campaigns. Parents do not see it.">
                <Input value={name} onChange={setName} placeholder="Sports day notice" />
              </Field>
            </div>
          </Card>

          <Card>
            <div className="space-y-3 p-4">
              <h3 className="text-[16px] font-semibold">Send later (optional)</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Date and time"><Input type="datetime-local" value={runAt} onChange={setRunAt} /></Field>
                <Field label="Repeat"><Select value={repeat} onChange={(v) => setRepeat(v as ConnectRepeat)} options={REPEATS} /></Field>
              </div>
            </div>
          </Card>
        </div>

        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <Card>
            <div className="px-4 pb-2 pt-4 text-[12px] font-bold uppercase tracking-[0.06em] text-muted-foreground">Live preview</div>
            <div className="flex items-center gap-2 px-4 pb-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                {(school || 'S').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
              </span>
              <span className="min-w-0 truncate font-semibold">{school || 'School'}</span>
            </div>
            <div className="bg-[#e5ddd5] p-4 dark:bg-[#0b141a]">
              <div className="max-w-full rounded-[10px] rounded-tl-[2px] bg-white p-3 text-[14px] text-[#111] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
                {image.trim() && <img src={image} alt="" className="mb-2 max-h-48 w-full rounded-md object-cover" />}
                {t ? (
                  <p className="whitespace-pre-wrap break-words"><LiveText text={t.body} values={values} sample={staff ? SAMPLE_STAFF : SAMPLE_PARENT} /></p>
                ) : <p className="text-[#667781]">Pick a template to see the message here.</p>}
                <div className="mt-1 text-right text-[11px] text-[#667781]">Preview, not sent</div>
              </div>
            </div>
            <p className="px-4 py-3 text-[13px] text-muted-foreground">
              Highlighted parts are filled for each recipient. Your message is sent only after the final review.
            </p>
          </Card>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
          <div className="min-w-0 flex-1 text-[14px]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[26px] font-extrabold tabular-nums">{fresh && p ? p.count : '-'}</span>
              <span>{fresh && p && p.count === 1 ? 'recipient' : 'recipients'}</span>
              <span className="min-w-0 break-words text-muted-foreground">{audienceText}{fresh && leftOut ? ` · ${leftOut}` : ''}</span>
            </div>
            {!ready ? <p className="text-muted-foreground">Still needed: {needed}.</p>
              : preview.error ? <ErrorState error={preview.error} />
              : !fresh ? <Loading shape="inline" />
              : p && p.count === 0 ? <p className="text-muted-foreground">Nobody in this audience can receive it.</p> : null}
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Button variant="secondary" className="max-sm:flex-1" disabled={!canGo || !runAt || pending}
              title={runAt ? undefined : 'Choose a date and time under Send later'} onClick={() => open(true)}>
              <Clock className="me-1.5 inline size-4 align-[-0.15em]" aria-hidden />Schedule
            </Button>
            <Button className="max-sm:flex-1" disabled={!canGo || pending} onClick={() => open(false)}>Review &amp; Send</Button>
          </div>
        </div>
      </Card>
      <FormNotice error={queue.error ?? schedule.error} ok={done || undefined} />

      {frozen && p && t && (
        <CheckBeforeSending onClose={() => { if (!busy.current) setFrozen(null) }} pending={pending}
          action={frozen.later ? 'Schedule it' : `Send now to ${p.count}`}
          onSend={confirm}
          text={p.sample || fill(t, values, TEST_WHO)} sampleTo={p.sample_to || undefined} count={p.count} audience={p.audience_label}
          when={whenLabel(frozen)} template={t.name ?? t.code} image={frozen.body.header_image_url ?? undefined} leftOut={leftOut} />
      )}
    </div>
  )
}
