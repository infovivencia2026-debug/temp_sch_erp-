import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Badge, Button, Card, ConfirmButton, Dialog, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select, Textarea, SEG_BAR, segClass,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { cn } from '@/lib/utils'

/* Yajur Connect → Templates (worker/src/routes/comms/yajur_connect_templates.ts):
   every WhatsApp template on the school's own account, with Meta's status,
   the wording parents read and which ERP message uses it; "Use this template"
   opens Send with it chosen; New and Edit send a template to Meta for
   approval. Nothing here sends a message to a parent. */

interface TplButton { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url?: string; phone_number?: string }
interface TplItem {
  id: string | null; name: string; label: string; code: string | null; language: string; category: string; status: string; rejected_reason: string | null
  header: { format: string; text: string | null } | null; body: string; footer: string | null; buttons: TplButton[]
  fields: { key: string; label: string; sample: string }[]; used_for: string[]; sendable: boolean; on_meta: boolean
}
interface TplList { items: TplItem[]; live: boolean; reason: string; can_write: boolean }

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  APPROVED: { label: 'Approved', tone: 'success' }, PENDING: { label: 'Waiting for approval', tone: 'warning' }, IN_APPEAL: { label: 'In appeal', tone: 'warning' },
  REJECTED: { label: 'Rejected', tone: 'danger' }, PAUSED: { label: 'Paused', tone: 'danger' }, DISABLED: { label: 'Disabled', tone: 'danger' },
  NOT_CHECKED: { label: 'Status not checked', tone: 'neutral' }, UNKNOWN: { label: 'Unknown', tone: 'neutral' },
}
const CATEGORY: Record<string, string> = { UTILITY: 'Utility', MARKETING: 'Marketing', AUTHENTICATION: 'Authentication' }
const CATEGORY_HINT: Record<string, string> = {
  UTILITY: 'Tied to something the parent already has with the school: fees, attendance, exams, results, PTM, transport. Cheaper and approved fastest. No promotion.',
  MARKETING: 'Promotional: admissions, events, newsletters. Parents can opt out, and it costs more.',
  AUTHENTICATION: 'One-time codes and sign-in only.',
}
const RULES = [
  'Variables are numbered {{1}}, {{2}}… in order, with no gaps.',
  'Do not start or end the body with a variable.',
  'The footer is fixed text: no variables.',
  'One clear purpose per template. Promotion in a Utility template is rejected.',
  'Give a realistic sample for each variable; Meta reviews the message with it.',
]

/** The body with {{n}} shown as the field's friendly name. */
function Body({ t }: { t: Pick<TplItem, 'body' | 'fields'> }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of t.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    parts.push(t.body.slice(last, m.index))
    const f = t.fields[Number(m[1]) - 1]
    parts.push(<span key={m.index} className="rounded bg-primary/10 px-1 font-medium text-primary">[{f?.label ?? `field ${m[1]}`}]</span>)
    last = m.index! + m[0].length
  }
  parts.push(t.body.slice(last))
  return <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{parts}</p>
}

export function TemplatesTab({ onUse }: { onUse: (code: string) => void }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['connect', 'templates'], queryFn: () => api.get<TplList>('/api/v1/comms/yajur-connect/templates'), staleTime: 30_000 })
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [editing, setEditing] = useState<TplItem | 'new' | null>(null)
  const del = useMutation({
    mutationFn: (t: TplItem) => api.del(`/api/v1/comms/yajur-connect/templates/${encodeURIComponent(t.name)}${t.id ? `?id=${t.id}` : ''}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['connect'] }) },
  })
  const items = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (list.data?.items ?? []).filter((t) => (status === 'all' || t.status === status || (status === 'PENDING' && t.status === 'IN_APPEAL'))
      && (!term || `${t.label} ${t.name} ${t.body} ${t.used_for.join(' ')}`.toLowerCase().includes(term)))
  }, [list.data, q, status])

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const d = list.data!
  const count = (st: string) => d.items.filter((t) => t.status === st).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold">Message templates</h2>
          <p className="text-[13px] text-muted-foreground">Approved starting points for school notices. Choose a template to use it, or make a new one and send it to WhatsApp for approval.</p>
        </div>
        {d.can_write && <Button onClick={() => setEditing('new')}>New template</Button>}
      </div>
      {!d.live && <FormNotice error={d.reason || 'The live status from WhatsApp could not be read; the school’s saved templates are shown.'} />}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 sm:max-w-sm"><Input value={q} onChange={setQ} placeholder="Search templates" srLabel="Search templates" /></div>
        <div className="w-full sm:w-56">
          <Select value={status} onChange={setStatus} options={[
            { value: 'all', label: `All (${d.items.length})` }, { value: 'APPROVED', label: `Approved (${count('APPROVED')})` },
            { value: 'PENDING', label: `Waiting (${count('PENDING') + count('IN_APPEAL')})` }, { value: 'REJECTED', label: `Rejected (${count('REJECTED')})` },
            { value: 'PAUSED', label: `Paused (${count('PAUSED')})` },
          ]} />
        </div>
      </div>
      {items.length === 0 ? <EmptyState title="No templates here" body={q || status !== 'all' ? 'Try another search or status.' : 'Make the first one with New template.'} /> : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((t) => {
            const st = STATUS[t.status] ?? STATUS.UNKNOWN
            return (
              <Card key={`${t.name}-${t.language}`} className="flex min-w-0 flex-col gap-3 p-4">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold">{t.label}</div>
                    <div className="truncate font-mono text-[12px] text-muted-foreground">{t.name}{t.language ? ` · ${t.language}` : ''}</div>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {t.category && <Badge tone="info">{CATEGORY[t.category] ?? t.category}</Badge>}
                  {t.header?.format === 'IMAGE' && <Badge>Picture header</Badge>}
                  {t.header?.format === 'DOCUMENT' && <Badge>Document header</Badge>}
                  {t.used_for.map((u) => <Badge key={u} tone="primary">{`Used for: ${u}`}</Badge>)}
                </div>
                {t.rejected_reason && <p className="text-[13px] text-destructive">Rejected: {t.rejected_reason.replace(/_/g, ' ').toLowerCase()}</p>}
                <div className="rounded-xl bg-muted/50 p-3">
                  {t.header?.text && <p className="mb-1 text-[14px] font-semibold">{t.header.text}</p>}
                  <Body t={t} />
                  {t.footer && <p className="mt-1 text-[12px] text-muted-foreground">{t.footer}</p>}
                  {t.buttons.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {t.buttons.map((b, i) => <span key={i} className="rounded-full border bg-card px-2.5 py-1 text-[12px] font-medium text-primary">{b.text}</span>)}
                    </div>
                  )}
                </div>
                {t.fields.length > 0 && (
                  <div className="text-[12.5px] text-muted-foreground">
                    Fields: {t.fields.map((f, i) => <span key={f.key}>{i ? ', ' : ''}{f.label}{f.sample ? ` (e.g. ${f.sample})` : ''}</span>)}
                  </div>
                )}
                <details className="text-[13px]">
                  <summary className="cursor-pointer text-primary">View approved template text</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border bg-card p-2 font-mono text-[12px]">{[t.header?.text, t.body, t.footer].filter(Boolean).join('\n\n')}</pre>
                </details>
                <div className="mt-auto flex flex-wrap gap-2">
                  {t.sendable && t.code && d.can_write && <Button size="sm" onClick={() => onUse(t.code!)}>Use this template</Button>}
                  {d.can_write && t.on_meta && t.id && <Button size="sm" variant="secondary" onClick={() => setEditing(t)}>Edit</Button>}
                  {d.can_write && t.on_meta && (
                    <ConfirmButton size="sm" tone="danger" confirmLabel="Delete" question={`Delete ${t.name} from WhatsApp? Messages using it stop sending on WhatsApp.`}
                      onConfirm={() => del.mutate(t)}>Delete</ConfirmButton>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
      <FormNotice error={del.error} />
      {editing && <TemplateForm editing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

interface FieldRow { name: string; sample: string }

function TemplateForm({ editing, onClose }: { editing: TplItem | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(editing?.name ?? '')
  const [category, setCategory] = useState(editing?.category || 'UTILITY')
  const [language, setLanguage] = useState(editing?.language || 'en')
  const [headerType, setHeaderType] = useState<'none' | 'text' | 'image'>(editing?.header ? (editing.header.format === 'IMAGE' ? 'image' : 'text') : 'none')
  const [headerText, setHeaderText] = useState(editing?.header?.text ?? '')
  const [picture, setPicture] = useState<UploadedFile | null>(null)
  const [body, setBody] = useState(editing?.body ?? '')
  const [rows, setRows] = useState<FieldRow[]>(editing?.fields.map((f) => ({ name: f.label, sample: f.sample })) ?? [])
  const [footer, setFooter] = useState(editing?.footer ?? '')
  const [buttons, setButtons] = useState<TplButton[]>(editing?.buttons ?? [])
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))
  const count = nums.length ? Math.max(...nums) : 0
  const fields: FieldRow[] = Array.from({ length: count }, (_, i) => rows[i] ?? { name: '', sample: '' })
  const setField = (i: number, patch: Partial<FieldRow>) => setRows(fields.map((f, k) => (k === i ? { ...f, ...patch } : f)))
  const addVar = () => setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}{{${count + 1}}}`)
  const preview = { body, fields: fields.map((f, i) => ({ key: String(i), label: f.sample || f.name || `field ${i + 1}`, sample: f.sample })) }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name, category, language, body, footer, buttons, fields,
        header: headerType === 'none' ? null : { type: headerType, text: headerText }, header_file_id: picture?.file_id,
      }
      return editing?.id ? api.put(`/api/v1/comms/yajur-connect/templates/${editing.id}`, payload) : api.post('/api/v1/comms/yajur-connect/templates', payload)
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['connect'] }); onClose() },
  })

  return (
    <Dialog open onClose={onClose} size="xl" title={editing ? `Edit ${editing.name}` : 'New template'}
      description="Sent to WhatsApp for approval. It can be used from Send once WhatsApp approves it, usually within minutes to a day."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Sending…' : 'Send for approval'}</Button>
      </>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name" hint="lowercase_with_underscores">
              <Input value={name} onChange={(v) => setName(v.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder="fee_reminder_term2" disabled={!!editing} />
            </Field>
            <Field label="Category">
              <Select value={category} onChange={setCategory} options={Object.entries(CATEGORY).map(([value, label]) => ({ value, label }))} />
            </Field>
            <Field label="Language">
              <Select value={language} onChange={(v) => { if (!editing) setLanguage(v) }} options={[
                { value: 'en', label: 'English' }, { value: 'en_US', label: 'English (US)' }, { value: 'te', label: 'Telugu' }, { value: 'hi', label: 'Hindi' },
              ]} />
            </Field>
          </div>
          <p className="text-[13px] text-muted-foreground">{CATEGORY_HINT[category]}</p>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Header (optional)</div>
            <div className={SEG_BAR} role="tablist">
              {(['none', 'text', 'image'] as const).map((h) => (
                <button key={h} type="button" role="tab" aria-selected={headerType === h} className={segClass(headerType === h)} onClick={() => setHeaderType(h)}>
                  {h === 'none' ? 'None' : h === 'text' ? 'Text' : 'Picture'}
                </button>
              ))}
            </div>
            {headerType === 'text' && <div className="mt-2"><Input value={headerText} onChange={setHeaderText} placeholder="School notice" srLabel="Header text" /></div>}
            {headerType === 'image' && (
              <div className="mt-2">
                <FilePicker value={picture} onChange={setPicture} accept="image/jpeg,image/png" label="Sample picture" hint="JPG or PNG. WhatsApp reviews the template with it; each message can carry its own picture." maxBytes={5_000_000} />
              </div>
            )}
          </div>
          <Field label="Message body" hint="Use {{1}}, {{2}}… where the details change for each parent.">
            <Textarea value={body} onChange={setBody} rows={5} placeholder="Dear {{1}}, the {{2}} fee for {{3}} is due on {{4}}. Kindly pay before the due date." />
          </Field>
          <Button size="sm" variant="secondary" onClick={addVar}>Add a variable</Button>
          {fields.length > 0 && (
            <div className="space-y-2">
              <div className="text-[13px] font-medium">What each variable is</div>
              {fields.map((f, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                  <span className="font-mono text-[13px] text-primary">{`{{${i + 1}}}`}</span>
                  <Input value={f.name} onChange={(v) => setField(i, { name: v })} placeholder="e.g. Parent name" srLabel={`Name of variable ${i + 1}`} />
                  <Input value={f.sample} onChange={(v) => setField(i, { sample: v })} placeholder="Sample, e.g. Mr. Suresh" srLabel={`Sample for variable ${i + 1}`} />
                </div>
              ))}
              <p className="text-[12.5px] text-muted-foreground">Name a variable Parent name, Student name or Class and it is filled in for each parent automatically.</p>
            </div>
          )}
          <Field label="Footer (optional)" hint="Fixed text, up to 60 characters">
            <Input value={footer} onChange={setFooter} placeholder="Yajur Public School" />
          </Field>
          <div className="space-y-2">
            <div className="text-[13px] font-medium">Buttons (optional)</div>
            {buttons.map((b, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                <Select value={b.type} onChange={(v) => setButtons(buttons.map((x, k) => (k === i ? { ...x, type: v as TplButton['type'] } : x)))}
                  options={[{ value: 'QUICK_REPLY', label: 'Quick reply' }, { value: 'URL', label: 'Website' }, { value: 'PHONE_NUMBER', label: 'Call' }]} />
                <Input value={b.text} onChange={(v) => setButtons(buttons.map((x, k) => (k === i ? { ...x, text: v } : x)))} placeholder="Button text" srLabel={`Button ${i + 1} text`} />
                {b.type === 'URL' ? <Input value={b.url ?? ''} onChange={(v) => setButtons(buttons.map((x, k) => (k === i ? { ...x, url: v } : x)))} placeholder="https://…" srLabel={`Button ${i + 1} link`} />
                  : b.type === 'PHONE_NUMBER' ? <Input value={b.phone_number ?? ''} onChange={(v) => setButtons(buttons.map((x, k) => (k === i ? { ...x, phone_number: v } : x)))} placeholder="+918886663636" srLabel={`Button ${i + 1} phone`} />
                    : <span className="hidden sm:block" />}
                <Button size="sm" variant="ghost" onClick={() => setButtons(buttons.filter((_, k) => k !== i))}>Remove</Button>
              </div>
            ))}
            {buttons.length < 10 && <Button size="sm" variant="secondary" onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])}>Add a button</Button>}
          </div>
          <FormNotice error={save.error} />
        </div>
        <aside className="space-y-4">
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Preview</div>
            <div className="rounded-2xl bg-[#e7f6e2] p-3 dark:bg-muted">
              <div className="rounded-xl bg-card p-3 shadow-sm">
                {headerType === 'text' && headerText && <p className="mb-1 text-[14px] font-semibold">{headerText}</p>}
                {headerType === 'image' && <div className="mb-2 grid h-24 place-items-center rounded-lg bg-muted text-[12px] text-muted-foreground">Picture</div>}
                {body ? <Body t={preview} /> : <p className="text-[13px] text-muted-foreground">The message appears here as you type.</p>}
                {footer && <p className="mt-1 text-[12px] text-muted-foreground">{footer}</p>}
                {buttons.filter((b) => b.text).map((b, i) => <div key={i} className="mt-2 border-t pt-2 text-center text-[13px] font-medium text-primary">{b.text}</div>)}
              </div>
            </div>
          </div>
          <div className={cn('rounded-xl border p-3 text-[12.5px] text-muted-foreground')}>
            <div className="mb-1 font-medium text-foreground">WhatsApp’s rules</div>
            <ul className="list-disc space-y-1 pl-4">{RULES.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        </aside>
      </div>
    </Dialog>
  )
}
