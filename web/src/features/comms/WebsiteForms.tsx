import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, EmptyState, ErrorState, Card, Button, Input, Textarea, Select, Field, FormNotice, Badge, Table, Td, Switch, Checkbox, SkeletonTable,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* WEBSITE FORMS (owner, 2026-11-05): forms like Google Forms for the school's
   website (careers, contact, events and more). Build the questions here, copy
   the embed code or the POST address to the website, and read every response
   with its date and time. */

type FieldType = 'text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'dropdown' | 'checkbox' | 'file'
interface FormField { key: string; label: string; type: FieldType; required: boolean; options?: string[] }
interface Form {
  id: string; slug: string; title: string; description: string; fields: FormField[]; submit_label: string; thanks_message: string
  is_open: boolean; created_at: string; responses?: number; unread?: number
}
interface Resp { id: string; data: Record<string, string>; files: { key: string; file_id: string; name: string }[]; source: string; page_url: string; is_read: boolean; created_at: string }

const TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Short answer' }, { value: 'long_text', label: 'Paragraph' }, { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Mobile number' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' },
  { value: 'dropdown', label: 'Dropdown' }, { value: 'checkbox', label: 'Tick box' }, { value: 'file', label: 'File upload' },
]
const when = (iso: string) => `${formatDate(iso.slice(0, 10))} ${new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`

export default function WebsiteForms() {
  const q = useQuery({ queryKey: ['website-forms'], queryFn: () => api.get<{ school: string; items: Form[] }>('/api/v1/comms/website-forms') })
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)
  const [tab, setTab] = useState<'responses' | 'build' | 'share'>('responses')
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => api.post<Form>('/api/v1/comms/website-forms', { title: name.trim() }),
    onSuccess: (f) => { setName(''); setOpenId(f.id); setTab('build'); qc.invalidateQueries({ queryKey: ['website-forms'] }) },
  })
  const open = q.data?.items.find((f) => f.id === openId) ?? null

  return (
    <>
      <PageHead eyebrow="Communication" title="Website forms" />
      <PageBody>
        {q.isError ? <ErrorState error={q.error} /> : q.isPending ? <SkeletonTable /> : open ? (
          <FormDetail form={open} school={q.data.school} tab={tab} setTab={setTab} onBack={() => setOpenId(null)} />
        ) : (
          <>
            <Card className="p-4 sm:p-5">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1">
                  <Field label="New form"><Input value={name} onChange={setName} placeholder="For example: Careers, Contact us, Event registration" /></Field>
                </div>
                <Button onClick={() => create.mutate()} pending={create.isPending} disabled={!name.trim()}>Create form</Button>
              </div>
              <FormNotice error={create.error} />
            </Card>
            {!q.data.items.length ? (
              <EmptyState title="No forms yet" body="Create a form, add its questions, then put it on the school website." />
            ) : (
              <Table head={['Form', 'Responses', 'Status', 'Created']} noExport>
                {q.data.items.map((f) => (
                  <tr key={f.id} className="cursor-pointer hover:bg-muted/40" onClick={() => { setOpenId(f.id); setTab('responses') }}>
                    <Td className="font-semibold">{f.title}</Td>
                    <Td className="tabular-nums">{f.responses ?? 0}{(f.unread ?? 0) > 0 && <Badge tone="primary" className="ml-2">{f.unread} new</Badge>}</Td>
                    <Td><Badge tone={f.is_open ? 'success' : 'neutral'}>{f.is_open ? 'Open' : 'Closed'}</Badge></Td>
                    <Td>{formatDate(f.created_at.slice(0, 10))}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}

function FormDetail({ form, school, tab, setTab, onBack }: {
  form: Form; school: string; tab: 'responses' | 'build' | 'share'; setTab: (t: 'responses' | 'build' | 'share') => void; onBack: () => void
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>All forms</Button>
        <h2 className="mr-auto text-[18px] font-semibold">{form.title}</h2>
        {(['responses', 'build', 'share'] as const).map((t) => (
          <Button key={t} variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>
            {t === 'responses' ? 'Responses' : t === 'build' ? 'Questions' : 'Put on website'}
          </Button>
        ))}
      </div>
      {tab === 'responses' ? <Responses form={form} /> : tab === 'build' ? <Builder form={form} /> : <Share form={form} school={school} />}
    </>
  )
}

function Responses({ form }: { form: Form }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['website-form-responses', form.id],
    queryFn: () => api.get<{ form: Form; items: Resp[] }>(`/api/v1/comms/website-forms/${form.id}/responses`),
  })
  const seen = useMutation({
    mutationFn: () => api.post(`/api/v1/comms/website-forms/${form.id}/responses/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['website-forms'] }),
  })
  const unread = (q.data?.items ?? []).some((r) => !r.is_read)
  useEffect(() => { if (unread) seen.mutate() }, [unread]) // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isError) return <ErrorState error={q.error} />
  if (q.isPending) return <SkeletonTable />
  const items = q.data.items
  if (!items.length) return <EmptyState title="No responses yet" body="Responses from the website show here with the date and time they came in." />
  // Columns: the form's questions first, then anything else a website sent.
  const known = form.fields.map((f) => f.key)
  const extra = [...new Set(items.flatMap((r) => [...Object.keys(r.data), ...r.files.map((x) => x.key)]))].filter((k) => !known.includes(k))
  const cols = [...form.fields.map((f) => ({ key: f.key, label: f.label })), ...extra.map((k) => ({ key: k, label: k }))]
  return (
    <Table head={['Received', ...cols.map((c) => c.label), 'From']}>
      {items.map((r) => (
        <tr key={r.id}>
          <Td className="whitespace-nowrap tabular-nums">{when(r.created_at)}{!r.is_read && <Badge tone="primary" className="ml-2">New</Badge>}</Td>
          {cols.map((c) => {
            const file = r.files.find((x) => x.key === c.key)
            return (
              <Td key={c.key} className="max-w-[320px] whitespace-normal">
                {file ? <a className="text-primary underline" href={`/api/v1/files/${file.file_id}?inline=1`} target="_blank" rel="noreferrer">{file.name}</a>
                  : r.data[c.key] === 'true' ? 'Yes' : r.data[c.key] ?? ''}
              </Td>
            )
          })}
          <Td className="text-[13px] text-muted-foreground">{r.source === 'embed' ? 'Embedded form' : 'Website POST'}</Td>
        </tr>
      ))}
    </Table>
  )
}

function Builder({ form }: { form: Form }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(form.title)
  const [description, setDescription] = useState(form.description)
  const [fields, setFields] = useState<FormField[]>(form.fields)
  const [submitLabel, setSubmitLabel] = useState(form.submit_label)
  const [thanks, setThanks] = useState(form.thanks_message)
  const [isOpen, setIsOpen] = useState(form.is_open)
  const save = useMutation({
    mutationFn: () => api.put<Form>(`/api/v1/comms/website-forms/${form.id}`, {
      title, description, submit_label: submitLabel, thanks_message: thanks, is_open: isOpen,
      fields: fields.map((f) => ({ ...f, options: f.type === 'dropdown' ? f.options : undefined })),
    }),
    onSuccess: (f) => { setFields(f.fields); qc.invalidateQueries({ queryKey: ['website-forms'] }) },
  })
  const upd = (i: number, p: Partial<FormField>) => setFields((l) => l.map((f, j) => (j === i ? { ...f, ...p } : f)))
  const move = (i: number, d: -1 | 1) => setFields((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n })

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4 sm:p-5">
        <Field label="Form name"><Input value={title} onChange={setTitle} /></Field>
        <Field label="Description" hint="Shown under the name on the website."><Textarea value={description} onChange={setDescription} /></Field>
        <Switch on={isOpen} onChange={setIsOpen} label={isOpen ? 'Taking responses' : 'Closed: not taking responses'} />
      </Card>
      {fields.map((f, i) => (
        <Card key={i} className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
            <Field label={`Question ${i + 1}`}><Input value={f.label} onChange={(v) => upd(i, { label: v })} /></Field>
            <Field label="Type"><Select value={f.type} onChange={(v) => upd(i, { type: v as FieldType, options: v === 'dropdown' ? (f.options ?? []) : undefined })} options={TYPES} /></Field>
          </div>
          {f.type === 'dropdown' && (
            <Field label="Choices" hint="One per line.">
              <Textarea value={(f.options ?? []).join('\n')} onChange={(v) => upd(i, { options: v.split('\n') })} />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox checked={f.required} onChange={(v) => upd(i, { required: v })} label="Required" />
            <span className="mr-auto" />
            <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>Up</Button>
            <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === fields.length - 1}>Down</Button>
            <Button size="sm" variant="ghost" onClick={() => setFields((l) => l.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        </Card>
      ))}
      <Button variant="secondary" onClick={() => setFields((l) => [...l, { key: '', label: '', type: 'text', required: false }])}>Add a question</Button>
      <Card className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
        <Field label="Button text"><Input value={submitLabel} onChange={setSubmitLabel} placeholder="Submit" /></Field>
        <Field label="Message after sending"><Input value={thanks} onChange={setThanks} placeholder="Thank you. Your response has been received." /></Field>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} pending={save.isPending}>Save form</Button>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Saved. The website shows the new questions at once.' : undefined} />
      </div>
    </div>
  )
}

function Copy({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Field label={label}>
      <div className="space-y-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-[13px]">{text}</pre>
        <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(text); setDone(true) }}>{done ? 'Copied' : 'Copy'}</Button>
      </div>
    </Field>
  )
}

function Share({ form, school }: { form: Form; school: string }) {
  const origin = window.location.origin
  const page = `${origin}/f/${school}/${form.slug}`
  const post = `${origin}/api/v1/public/forms/${school}/${form.slug}`
  const embed = `<iframe src="${page}" id="xulo-form-${form.slug}" style="width:100%;min-height:600px;border:0" title="${form.title.replace(/"/g, '')}"></iframe>
<script>addEventListener('message',function(e){if(e.data&&e.data.type==='xulo-form-height'&&e.data.form==='${form.slug}'){document.getElementById('xulo-form-${form.slug}').style.height=e.data.height+'px'}})</script>`
  const keys = form.fields.map((f) => `  ${f.key}  (${f.label}${f.type === 'file' ? ', a file' : ''})`).join('\n')
  const html = `<form action="${post}" method="POST" enctype="multipart/form-data">
  ...your own inputs, each with name= one of the field names below...
  <input type="hidden" name="_redirect" value="https://your-site/thank-you">
  <button type="submit">Submit</button>
</form>`
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5">
        <p className="eyebrow">1. Embed (easiest)</p>
        <p className="text-[14px] text-muted-foreground">Paste this where the form should appear, for example behind the Careers button. It shows this form and grows to fit.</p>
        <Copy label="Embed code" text={embed} />
        <Copy label="Or link to the form" text={page} />
      </Card>
      <Card className="space-y-4 p-4 sm:p-5">
        <p className="eyebrow">2. Your website's own form</p>
        <p className="text-[14px] text-muted-foreground">
          Keep the website's design and send its form here. POST to this address as form data, multipart (for files) or JSON.
          Every field sent is saved, with the date and time. Add a hidden <code>_redirect</code> to send the visitor back to a thank-you page.
        </p>
        <Copy label="POST address" text={post} />
        {keys && <Copy label="Field names this form expects" text={keys} />}
        <Copy label="Example" text={html} />
      </Card>
    </div>
  )
}
