import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlignLeft, ArrowDown, ArrowUp, Calendar, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, Copy, ExternalLink, FileText, Hash, Inbox,
  Link2, Mail, Paperclip, Phone, Plus, Trash2, Type, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useToast } from '@/components/Toast'
import {
  PageHead, PageBody, EmptyState, ErrorState, Card, Button, ConfirmButton, Input, Textarea, Select, Field, FormNotice, Badge,
  Table, Td, Switch, SkeletonTable, Stat, CellGrid, Dialog, TAB_BAR, tabClass,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* WEBSITE FORMS (owner, 2026-11-05): forms like Google Forms for the school's
   website (careers, contact, events and more). Build the questions here with
   a live preview, put the form on the website by embed or the website's own
   form, and read every response with its date, time and files. */

type FieldType = 'text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'dropdown' | 'checkbox' | 'file'
interface FormField { key: string; label: string; type: FieldType; required: boolean; options?: string[]; show_if?: { key: string; value: string } }
interface Form {
  id: string; slug: string; title: string; description: string; fields: FormField[]; submit_label: string; thanks_message: string
  is_open: boolean; created_at: string; responses?: number; unread?: number
}
interface Resp { id: string; data: Record<string, string>; files: { key: string; file_id: string; name: string }[]; source: string; page_url: string; is_read: boolean; created_at: string }
type Tab = 'questions' | 'responses' | 'share'

const TYPES: { value: FieldType; label: string; icon: typeof Type }[] = [
  { value: 'text', label: 'Short answer', icon: Type },
  { value: 'long_text', label: 'Paragraph', icon: AlignLeft },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'phone', label: 'Mobile number', icon: Phone },
  { value: 'number', label: 'Number', icon: Hash },
  { value: 'date', label: 'Date', icon: Calendar },
  { value: 'dropdown', label: 'Dropdown', icon: ChevronDown },
  { value: 'checkbox', label: 'Tick box', icon: CheckSquare },
  { value: 'file', label: 'File upload', icon: Paperclip },
]
const typeOf = (t: FieldType) => TYPES.find((x) => x.value === t)!
const when = (iso: string) => `${formatDate(iso.slice(0, 10))}, ${new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`

export default function WebsiteForms() {
  const q = useQuery({ queryKey: ['website-forms'], queryFn: () => api.get<{ school: string; items: Form[] }>('/api/v1/comms/website-forms') })
  const [openId, setOpenId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('responses')
  const [creating, setCreating] = useState(false)
  const open = q.data?.items.find((f) => f.id === openId) ?? null

  if (q.isError) return <ErrorState error={q.error} />
  return (
    <>
      {open ? (
        <FormDetail form={open} school={q.data!.school} tab={tab} setTab={setTab} onBack={() => setOpenId(null)} />
      ) : (
        <>
          <PageHead eyebrow="Communication" title="Website forms"
            description="Forms for the school website. Every response lands here with its date and time."
            /* Once only (owner, 2026-11-05): with no forms the empty card has the button. */
            actions={q.data?.items.length ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New form</Button> : undefined} />
          <PageBody>
            {q.isPending ? <SkeletonTable /> : !q.data.items.length ? (
              <EmptyState title="No forms yet" body="Create a form such as Careers or Contact us, add its questions, then put it on the school website."
                action={<Button onClick={() => setCreating(true)}><Plus className="size-4" />New form</Button>} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {q.data.items.map((f) => (
                  <button key={f.id} type="button" onClick={() => { setOpenId(f.id); setTab(f.fields.length ? 'responses' : 'questions') }}
                    className="group text-left">
                    <Card className="h-full p-5 transition-all group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md">
                      <div className="flex items-start justify-between gap-3">
                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileText className="size-5" /></span>
                        <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-medium', f.is_open ? 'text-success' : 'text-muted-foreground')}>
                          <span className={cn('size-2 rounded-full', f.is_open ? 'bg-success' : 'bg-muted-foreground/50')} />{f.is_open ? 'Taking responses' : 'Closed'}
                        </span>
                      </div>
                      <p className="mt-4 truncate text-[16px] font-semibold">{f.title}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{f.fields.length} {f.fields.length === 1 ? 'question' : 'questions'}</p>
                      <div className="mt-4 flex items-center gap-2 border-t pt-3 text-[13px]">
                        <Inbox className="size-4 text-muted-foreground" />
                        <span className="font-medium tabular-nums">{f.responses ?? 0}</span>
                        <span className="text-muted-foreground">responses</span>
                        {(f.unread ?? 0) > 0 && <Badge tone="primary" className="ml-auto">{f.unread} new</Badge>}
                      </div>
                    </Card>
                  </button>
                ))}
              </div>
            )}
          </PageBody>
        </>
      )}
      {creating && <NewForm onClose={() => setCreating(false)} onMade={(f) => { setCreating(false); setOpenId(f.id); setTab('questions') }} />}
    </>
  )
}

function NewForm({ onClose, onMade }: { onClose: () => void; onMade: (f: Form) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const make = useMutation({
    mutationFn: () => api.post<Form>('/api/v1/comms/website-forms', { title: name.trim() }),
    onSuccess: (f) => { qc.invalidateQueries({ queryKey: ['website-forms'] }); onMade(f) },
  })
  return (
    <Dialog open onClose={onClose} title="New form" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => make.mutate()} pending={make.isPending} disabled={!name.trim()}>Create</Button></>}>
      <Field label="Form name"><Input value={name} onChange={setName} placeholder="Careers, Contact us, Event registration" /></Field>
      <div className="mt-3 flex flex-wrap gap-2">
        {['Careers', 'Contact us', 'Event registration', 'Feedback'].map((s) => (
          <button key={s} type="button" onClick={() => setName(s)} className="rounded-full border px-3 py-1 text-[13px] text-muted-foreground transition-colors hover:border-primary hover:text-primary">{s}</button>
        ))}
      </div>
      <FormNotice error={make.error} />
    </Dialog>
  )
}

function FormDetail({ form, school, tab, setTab, onBack }: { form: Form; school: string; tab: Tab; setTab: (t: Tab) => void; onBack: () => void }) {
  const qc = useQueryClient()
  const toggle = useMutation({
    mutationFn: (v: boolean) => api.put(`/api/v1/comms/website-forms/${form.id}`, { is_open: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['website-forms'] }),
  })
  const del = useMutation({
    mutationFn: () => api.del(`/api/v1/comms/website-forms/${form.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['website-forms'] }); onBack() },
  })
  const tabs: { key: Tab; label: string }[] = [
    { key: 'questions', label: 'Questions' },
    { key: 'responses', label: `Responses${form.responses ? ` (${form.responses})` : ''}` },
    { key: 'share', label: 'Put on website' },
  ]
  return (
    <>
      <PageHead eyebrow="Website forms" title={form.title}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={onBack}><ChevronLeft className="size-4" />All forms</Button>
            {/* A dropdown, not an on/off switch (owner, 2026-11-05). */}
            <div className="w-56">
              <Select value={form.is_open ? 'open' : 'closed'} onChange={(v) => toggle.mutate(v === 'open')}
                options={[{ value: 'open', label: 'Taking responses' }, { value: 'closed', label: 'Closed' }]} />
            </div>
            <ConfirmButton tone="danger" size="md" confirmLabel="Delete form" label="Delete form"
              question={`Delete ${form.title} and all its responses? The form on the website stops working.`}
              onConfirm={() => del.mutate()} disabled={del.isPending}><Trash2 className="size-4" /></ConfirmButton>
          </div>
        } />
      <PageBody>
        <div className={TAB_BAR} role="tablist">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tabClass(tab === t.key)} onClick={() => setTab(t.key)}>
              {t.label}{t.key === 'responses' && (form.unread ?? 0) > 0 && <Badge tone="primary">{form.unread} new</Badge>}
            </button>
          ))}
        </div>
        <FormNotice error={toggle.error ?? del.error} />
        {tab === 'questions' ? <Builder key={form.id} form={form} /> : tab === 'responses' ? <Responses form={form} /> : <Share form={form} school={school} />}
      </PageBody>
    </>
  )
}

/* ---- Questions ------------------------------------------------------- */

function Builder({ form }: { form: Form }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [title, setTitle] = useState(form.title)
  const [description, setDescription] = useState(form.description)
  const [fields, setFields] = useState<FormField[]>(form.fields)
  const [submitLabel, setSubmitLabel] = useState(form.submit_label)
  const [thanks, setThanks] = useState(form.thanks_message)
  const [active, setActive] = useState(0)
  const [savedAt, setSavedAt] = useState(0)
  const dirty = useMemo(() => JSON.stringify([title, description, fields, submitLabel, thanks])
    !== JSON.stringify([form.title, form.description, form.fields, form.submit_label, form.thanks_message]), [title, description, fields, submitLabel, thanks, form])
  const save = useMutation({
    mutationFn: () => api.put<Form>(`/api/v1/comms/website-forms/${form.id}`, {
      title, description, submit_label: submitLabel, thanks_message: thanks,
      fields: fields.map((f) => ({ ...f, options: f.type === 'dropdown' ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined })),
    }),
    onSuccess: (f) => { setFields(f.fields); setSavedAt(Date.now()); qc.invalidateQueries({ queryKey: ['website-forms'] }); toast.ok(`${f.title} saved. The website shows it now.`) },
    onError: (e) => toast.error((e as Error).message || 'Could not save the form'),
  })
  const upd = (i: number, p: Partial<FormField>) => setFields((l) => l.map((f, j) => (j === i ? { ...f, ...p } : f)))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= fields.length) return
    setFields((l) => { const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n })
    setActive(j)
  }
  const add = (type: FieldType) => {
    setFields((l) => [...l, { key: '', label: '', type, required: false, ...(type === 'dropdown' ? { options: [''] } : {}) }])
    setActive(fields.length)
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-3">
        <Card className="overflow-hidden">
          <div className="h-1.5 bg-primary" />
          <div className="space-y-3 p-5">
            <Input value={title} onChange={setTitle} placeholder="Form name" srLabel="Form name" />
            <Textarea value={description} onChange={setDescription} placeholder="A line for the visitor, for example: Apply for a role at our school." />
          </div>
        </Card>

        {fields.map((f, i) => {
          const T = typeOf(f.type).icon
          const on = active === i
          return (
            <Card key={i} className={cn('relative overflow-hidden transition-shadow', on && 'shadow-md ring-1 ring-primary/30')}>
              <span className={cn('absolute inset-y-0 left-0 w-1 transition-colors', on ? 'bg-primary' : 'bg-transparent')} />
              <div className="p-5" onFocus={() => setActive(i)} onClick={() => setActive(i)}>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
                  <Input value={f.label} onChange={(v) => upd(i, { label: v })} placeholder={`Question ${i + 1}`} srLabel={`Question ${i + 1}`} />
                  <Select value={f.type} onChange={(v) => upd(i, { type: v as FieldType, options: v === 'dropdown' ? (f.options?.length ? f.options : ['']) : undefined })}
                    options={TYPES.map((t) => ({ value: t.value, label: t.label }))} />
                </div>
                {f.type === 'dropdown' ? (
                  <div className="mt-3 space-y-2">
                    {(f.options ?? []).map((o, k) => (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-5 text-right text-[13px] tabular-nums text-muted-foreground">{k + 1}.</span>
                        <div className="min-w-0 flex-1"><Input value={o} onChange={(v) => upd(i, { options: (f.options ?? []).map((x, m) => (m === k ? v : x)) })} placeholder={`Choice ${k + 1}`} srLabel={`Choice ${k + 1}`} /></div>
                        <Button size="sm" variant="ghost" onClick={() => upd(i, { options: (f.options ?? []).filter((_, m) => m !== k) })} disabled={(f.options ?? []).length <= 1}><X className="size-4" /><span className="sr-only">Remove choice</span></Button>
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => upd(i, { options: [...(f.options ?? []), ''] })}><Plus className="size-4" />Add choice</Button>
                  </div>
                ) : (
                  <p className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground"><T className="size-4" />{typeOf(f.type).label}{f.type === 'file' && ': PDF, Word or an image, up to 8 MB'}</p>
                )}
                <ShowIf field={f} others={fields.slice(0, i)} onChange={(v) => upd(i, { show_if: v })} />
                <div className="mt-4 flex flex-wrap items-center gap-1 border-t pt-3">
                  <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Switch on={f.required} onChange={(v) => upd(i, { required: v })} label="Required" /><span aria-hidden>Required</span>
                  </span>
                  <span className="ml-auto" />
                  <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="size-4" /><span className="sr-only">Move up</span></Button>
                  <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === fields.length - 1}><ArrowDown className="size-4" /><span className="sr-only">Move down</span></Button>
                  <Button size="sm" variant="ghost" onClick={() => { setFields((l) => [...l.slice(0, i + 1), { ...f, key: '' }, ...l.slice(i + 1)]); setActive(i + 1) }}><Copy className="size-4" /><span className="sr-only">Copy question</span></Button>
                  <Button size="sm" variant="ghost" onClick={() => setFields((l) => l.filter((_, j) => j !== i))}><Trash2 className="size-4" /><span className="sr-only">Remove question</span></Button>
                </div>
              </div>
            </Card>
          )
        })}

        <div className="rounded-2xl border border-dashed p-4">
          <p className="mb-3 text-[13px] font-medium text-muted-foreground">Add a question</p>
          <div className="flex flex-wrap gap-2">
            {TYPES.map((t) => (
              <button key={t.value} type="button" onClick={() => add(t.value)}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-[13px] transition-colors hover:border-primary hover:text-primary">
                <t.icon className="size-4" />{t.label}
              </button>
            ))}
          </div>
        </div>

        <Card className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Button text"><Input value={submitLabel} onChange={setSubmitLabel} placeholder="Submit" /></Field>
          <Field label="Message after sending"><Input value={thanks} onChange={setThanks} placeholder="Thank you. Your response has been received." /></Field>
        </Card>

        <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-2xl border bg-card/90 p-3 shadow-lg backdrop-blur">
          <span className="text-[13px] text-muted-foreground">
            {save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : savedAt ? 'Saved. The website shows it at once.' : 'All changes saved'}
          </span>
          <Button className="ml-auto" onClick={() => save.mutate()} pending={save.isPending} disabled={!dirty || !title.trim()}>Save form</Button>
          <FormNotice error={save.error} />
        </div>
      </div>

      <div className="hidden lg:sticky lg:top-4 lg:block">
        <p className="eyebrow mb-2">Preview</p>
        <Preview title={title} description={description} fields={fields} submit={submitLabel || 'Submit'} />
      </div>
    </div>
  )
}

/** How the visitor sees it: the same order and labels. */
function Preview({ title, description, fields, submit }: { title: string; description: string; fields: FormField[]; submit: string }) {
  const box = 'mt-1.5 h-10 w-full rounded-lg border bg-background/60'
  return (
    <Card className="max-h-[calc(100dvh-140px)] overflow-y-auto p-5">
      <p className="text-[18px] font-semibold">{title || 'Form name'}</p>
      {description && <p className="mt-1 whitespace-pre-line text-[13px] text-muted-foreground">{description}</p>}
      <div className="mt-4 space-y-4">
        {fields.map((f, i) => (
          <div key={i}>
            {f.type === 'checkbox' ? (
              <p className="flex items-start gap-2 text-[14px]"><span className="mt-0.5 size-4 shrink-0 rounded border" />{f.label || 'Tick box'}{f.required && <span className="text-destructive">*</span>}</p>
            ) : (
              <>
                <p className="text-[13px] font-medium">{f.label || `Question ${i + 1}`}{f.required && <span className="text-destructive"> *</span>}</p>
                {f.type === 'long_text' ? <div className={cn(box, 'h-20')} />
                  : f.type === 'file' ? <div className="mt-1.5 grid h-16 place-items-center rounded-lg border border-dashed text-[12px] text-muted-foreground">Choose a file or drop it here</div>
                  : f.type === 'dropdown' ? <div className={cn(box, 'flex items-center justify-between px-3 text-[13px] text-muted-foreground')}>Select<ChevronDown className="size-4" /></div>
                  : <div className={box} />}
              </>
            )}
          </div>
        ))}
        {!fields.length && <p className="text-[13px] text-muted-foreground">Add a question and it appears here.</p>}
      </div>
      <div className="mt-5 inline-flex h-10 items-center rounded-lg bg-primary px-5 text-[14px] font-semibold text-primary-foreground">{submit}</div>
    </Card>
  )
}

/* ---- Responses ------------------------------------------------------- */

function Responses({ form }: { form: Form }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['website-form-responses', form.id],
    queryFn: () => api.get<{ form: Form; items: Resp[] }>(`/api/v1/comms/website-forms/${form.id}/responses`),
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const seen = useMutation({
    mutationFn: () => api.post(`/api/v1/comms/website-forms/${form.id}/responses/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['website-forms'] }),
  })
  const del = useMutation({
    mutationFn: (rid: string) => api.del(`/api/v1/comms/website-forms/${form.id}/responses/${rid}`),
    onSuccess: () => { setOpenId(null); qc.invalidateQueries({ queryKey: ['website-form-responses', form.id] }); qc.invalidateQueries({ queryKey: ['website-forms'] }) },
  })
  /* An application brought over from the old careers page keeps the date it was first sent (its "Submitted" answer). */
  const items = [...(q.data?.items ?? [])].map((r) => ({ ...r, created_at: sentAt(r) })).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const unread = items.filter((r) => !r.is_read).length
  // Marked read once shown; the New tags stay for this visit.
  useEffect(() => { if (unread) seen.mutate() }, [unread > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isError) return <ErrorState error={q.error} />
  if (q.isPending) return <SkeletonTable />
  if (!items.length) return <EmptyState title="No responses yet" body="When someone fills this form on the website, it shows here with the date and time." />

  /* OLD AND NEW NAMES, ONE QUESTION (owner, 2026-11-08: "map them old and new").
     The school's own careers page posts its own names (Name, Phone, post ...);
     each is shown under the matching question of this form. */
  const known = form.fields.map((f) => f.key)
  const aliasOf = (k: string) => known.find((f) => (ALIASES[f] ?? []).includes(k))
  const val = (r: Resp, k: string) => show(r, k) || (ALIASES[k] ?? []).map((a) => show(r, a)).find(Boolean) || ''
  const fileOf = (r: Resp, k: string) => r.files.find((x) => x.key === k) ?? r.files.find((x) => (ALIASES[k] ?? []).includes(x.key))
  const extra = [...new Set(items.flatMap((r) => [...Object.keys(r.data), ...r.files.map((x) => x.key)]))].filter((k) => !known.includes(k) && !aliasOf(k))
  const cols = [...form.fields.map((f) => ({ key: f.key, label: f.label })), ...extra.map((k) => ({ key: k, label: k }))]
  const filled = (r: Resp, k: string) => !!val(r, k) || !!fileOf(r, k)
  const shownCols = cols.filter((c) => items.some((r) => filled(r, c.key))).slice(0, 4)
  const week = Date.now() - 7 * 86400000
  const open = items.find((r) => r.id === openId) ?? null
  const cell = (r: Resp, k: string) => fileOf(r, k)?.name ?? val(r, k)
  const rowsOf = (r: Resp): [string, string][] => cols.filter((c) => filled(r, c.key)).map((c) => [c.label, cell(r, c.key)])
  const allRows = () => {
    const use = cols.filter((c) => items.some((r) => filled(r, c.key)))
    return [['Received', ...use.map((c) => c.label)], ...items.map((r) => [when(r.created_at), ...use.map((c) => cell(r, c.key))])]
  }

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => saveExcel(form.title + ' responses', allRows())}>Export Excel</Button>
        <Button variant="secondary" onClick={() => saveCsv(form.title + ' responses', allRows())}>Export CSV</Button>
      </div>
      <CellGrid cols={3}>
        <Stat label="Responses" value={items.length} tint />
        <Stat label="New" value={unread} tint />
        <Stat label="Last 7 days" value={items.filter((r) => Date.parse(r.created_at) >= week).length} tint />
      </CellGrid>
      <Table head={['Received', ...shownCols.map((c) => c.label), 'Files', '']}>
        {items.map((r) => (
          <tr key={r.id} className="cursor-pointer transition-colors hover:bg-muted/40" onClick={() => setOpenId(r.id)}>
            <Td className="whitespace-nowrap tabular-nums">{when(r.created_at)}{!r.is_read && <Badge tone="primary" className="ml-2">New</Badge>}</Td>
            {shownCols.map((c) => <Td key={c.key} className="max-w-[260px] truncate">{cell(r, c.key)}</Td>)}
            <Td>{r.files.length ? <span className="inline-flex items-center gap-1 text-[13px] text-muted-foreground"><Paperclip className="size-4" />{r.files.length}</span> : null}</Td>
            <Td className="text-right"><span className="row-open">Open<ChevronRight className="size-3.5" aria-hidden /></span></Td>
          </tr>
        ))}
      </Table>
      {open && (() => {
        /* The owner's response card (2026-11-08): who and what for on top, the
           answers in titled cards, files as attachments; Delete and Export. */
        const rows = cols.filter((c) => (open.source === 'embed' || filled(open, c.key)) && !fileOf(open, c.key))
        const name = val(open, 'full_name') || val(open, 'Name') || val(open, 'name')
        const role = val(open, 'role_you_are_interested_in') || val(open, 'post')
        const used = new Set<string>(['full_name', 'role_you_are_interested_in', 'Name', 'name', 'post', 'Post / subject'])
        const groups: [string, RegExp][] = [
          ['Contact information', /phone|mobile|email|address|city|town|state|place|emergency/i],
          ['Experience and salary', /experience|job|gap|salary|notice|benefit|fresher/i],
          ['Qualifications', /qualif|academ|year|institution|subject|marks|digital/i],
        ]
        const sections = groups.map(([t, re]) => {
          const list = rows.filter((c) => !used.has(c.key) && re.test(c.key + ' ' + c.label))
          list.forEach((c) => used.add(c.key)); return { t, list }
        })
        sections.push({ t: 'Other details', list: rows.filter((c) => !used.has(c.key)) })
        const initials = (name || 'R').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
        const fname = (name || 'response') + ' ' + open.created_at.slice(0, 10)
        const table = (): string[][] => [['Question', 'Answer'], ['Submitted', when(open.created_at)], ...rowsOf(open)]
        const files = cols.map((c) => ({ c, f: fileOf(open, c.key) })).filter((x) => x.f)
        return (
          <Dialog open onClose={() => setOpenId(null)} title={name || 'Response'}
            description={`${open.source === 'embed' ? 'Embedded form' : 'Website form'} · Submitted ${when(open.created_at)}`}
            footer={<>
              <ConfirmButton tone="danger" confirmLabel="Delete" question="Delete this response and its files?" onConfirm={() => del.mutate(open.id)}><Trash2 className="size-4" aria-hidden />Delete</ConfirmButton>
              <span className="flex-1" />
              <Button variant="secondary" onClick={() => saveExcel(fname, table())}>Excel</Button>
              <Button variant="secondary" onClick={() => printResponse(name || form.title, when(open.created_at), rowsOf(open))}>PDF</Button>
              <Button variant="secondary" onClick={() => saveCsv(fname, table())}>CSV</Button>
              <Button variant="secondary" onClick={() => setOpenId(null)}>Close</Button>
            </>}>
            <div className="flex flex-col gap-4 rounded-2xl bg-muted/40 p-3 sm:p-4">
              <div className="flex items-center gap-4 rounded-2xl border bg-card p-4">
                <div className="grid size-14 shrink-0 place-items-center rounded-[14px] bg-primary/10 text-[20px] font-bold text-primary">{initials}</div>
                <div className="min-w-0">
                  <h3 className="truncate text-[18px] font-bold text-foreground">{name || 'Response'}</h3>
                  {role && <p className="text-[13.5px] text-muted-foreground">Applied for <strong className="text-foreground">{role}</strong></p>}
                </div>
              </div>
              {sections.filter((s) => s.list.length).map((s) => (
                <div key={s.t} className="rounded-2xl border bg-card p-4">
                  <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{s.t}</div>
                  <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                    {s.list.map((c) => {
                      const v = val(open, c.key)
                      return (
                        <div key={c.key} className={cn('min-w-0', (v.length > 40 || /address|experience|reference|other/i.test(c.label)) && 'sm:col-span-2')}>
                          <div className="mb-1 text-[12.5px] font-medium text-muted-foreground">{c.label}</div>
                          <div className="whitespace-pre-line break-words text-[14.5px] font-semibold text-foreground">{v || <span className="font-normal text-muted-foreground">Not given</span>}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {files.length > 0 && (
                <div className="rounded-2xl border bg-card p-4">
                  <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Uploaded documents</div>
                  <div className="flex flex-col gap-2">
                    {files.map(({ c, f }) => (
                      <div key={c.key} className="flex items-center justify-between gap-3 rounded-xl border border-dashed bg-muted/40 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-primary/10 text-[11px] font-bold uppercase text-primary">{(f!.name.split('.').pop() || 'file').slice(0, 4)}</div>
                          <div className="min-w-0"><div className="truncate text-[14px] font-semibold">{f!.name}</div><div className="truncate text-[12px] text-muted-foreground">{c.label}</div></div>
                        </div>
                        <a href={`/api/v1/files/${f!.file_id}?inline=1`} target="_blank" rel="noreferrer" className="row-open shrink-0">View<ExternalLink className="size-3.5" aria-hidden /></a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <FormNotice error={del.error} />
          </Dialog>
        )
      })()}
    </>
  )
}
const show = (r: Resp, k: string) => { const v = r.data[k]; return v === 'true' ? 'Yes' : v === 'false' ? 'No' : v ?? '' }
/* The careers page's own names for this form's questions (old row labels, then its field names). */
const ALIASES: Record<string, string[]> = {
  role_you_are_interested_in: ['Post / subject', 'post'],
  full_name: ['Name', 'name'],
  mobile_number: ['Phone', 'phone'],
  email_address: ['Email', 'email'],
  your_resume_cv_pdf_word_or_a_clear_photo: ['resume', 'Resume'],
  current_address: ['Temporary address', 'tempAddress'],
  permanent_address: ['Permanent address', 'permAddress'],
  current_in_hand_salary_per_month: ['Current net salary', 'netSalary'],
  current_gross_salary_per_month: ['Current gross salary', 'grossSalary'],
  expected_monthly_salary: ['Minimum expected salary', 'expectedSalary'],
  notice_period_e_g_1_month: ['Notice period', 'noticePeriod'],
  other_benefits_e_g_pf_transport: ['Other benefits', 'otherBenefits'],
  gaps_between_jobs_if_any: ['Gap reasons', 'gapReason'],
  languages_known_for_each_read_write_spea: ['Languages (R/W/S/U)', 'languages'],
  work_experience_most_recent_first_from_t: ['Prior experience', 'jobs'],
  photo_recent_and_clear_jpg_png_or_webp_u: ['photo', 'Photo'],
  professional_references_name_designation: ['references'],
}

/* ---- Put on website ---------------------------------------------------- */

function CopyBox({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1800); return () => clearTimeout(t) }, [done])
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-xl border bg-muted/40 px-3 py-2.5 text-[13px]">{text}</pre>
      <Button variant={done ? 'primary' : 'secondary'} onClick={() => { void navigator.clipboard.writeText(text); setDone(true) }}>
        <Copy className="size-4" />{done ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function Step({ n, title, body, children }: { n: number; title: string; body: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex gap-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[14px] font-semibold text-primary-foreground">{n}</span>
        <div className="min-w-0 flex-1 space-y-3">
          <div><p className="font-semibold">{title}</p><p className="text-[14px] text-muted-foreground">{body}</p></div>
          {children}
        </div>
      </div>
    </Card>
  )
}

function Share({ form, school }: { form: Form; school: string }) {
  const origin = window.location.origin
  const page = `${origin}/f/${school}/${form.slug}`
  const post = `${origin}/api/v1/public/forms/${school}/${form.slug}`
  const embed = `<iframe src="${page}" id="xulo-form-${form.slug}" style="width:100%;min-height:600px;border:0" title="${form.title.replace(/"/g, '')}"></iframe>
<script>addEventListener('message',function(e){if(e.data&&e.data.type==='xulo-form-height'&&e.data.form==='${form.slug}'){document.getElementById('xulo-form-${form.slug}').style.height=e.data.height+'px'}})</script>`
  const keys = form.fields.map((f) => `${f.key}  =  ${f.label}${f.type === 'file' ? ' (file)' : ''}`).join('\n')
  return (
    <div className="space-y-4">
      {!form.is_open && <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-[14px]">This form is closed, so the website shows "not taking responses". Choose Taking responses at the top.</p>}
      <Step n={1} title="Embed in the website's own style" body="The questions take the website's own fonts, boxes and buttons. Paste this where the form should appear.">
        <CopyBox text={`<div data-xulo-form="${post}"></div>
<script src="${origin}/api/v1/public/forms/embed.js" async></script>`} />
      </Step>
      <Step n={2} title="Or embed in our style" body="Give this to your website person. They paste it where the form should appear, for example on the Careers page. It grows to fit.">
        <CopyBox text={embed} />
      </Step>
      <Step n={3} title="Or share a link" body="Put it behind a button such as Apply now, or send it on WhatsApp.">
        <CopyBox text={page} />
        <a href={page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[14px] font-medium text-primary"><Link2 className="size-4" />Open the form</a>
      </Step>
      <Step n={4} title="Or keep the website's own form" body="The website's form can send its data here. POST to this address as form data, multipart (for files) or JSON. Every field sent is saved. Add a hidden _redirect to send the visitor to a thank-you page.">
        <CopyBox text={post} />
        {keys && <><p className="text-[13px] font-medium">Field names</p><CopyBox text={keys} /></>}
      </Step>
    </div>
  )
}

/* "Show only when": this question appears only when an earlier question's
   answer is one value (for example "Please specify" when Role is Other). */
function ShowIf({ field, others, onChange }: { field: FormField; others: FormField[]; onChange: (v: FormField['show_if']) => void }) {
  const choosable = others.filter((o) => (o.type === 'dropdown' && (o.options ?? []).some((x) => x.trim())) || o.type === 'checkbox')
  const [on, setOn] = useState(!!field.show_if)
  if (!choosable.length) return null
  const src = choosable.find((o) => (o.key || o.label) === field.show_if?.key) ?? null
  const values = src?.type === 'checkbox' ? [{ value: 'true', label: 'Ticked' }] : (src?.options ?? []).filter((x) => x.trim()).map((x) => ({ value: x, label: x }))
  return (
    <div className="mt-3 rounded-xl border border-dashed p-3">
      <label className="flex items-center gap-2 text-[13px] font-medium">
        <Switch on={on} onChange={(v) => { setOn(v); if (!v) onChange(undefined) }} label="Show only when" />
        <span aria-hidden>Show only when another answer is chosen</span>
      </label>
      {on && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Select value={field.show_if?.key ?? ''} placeholder="Which question"
            onChange={(k) => onChange({ key: k, value: '' })}
            options={choosable.map((o) => ({ value: o.key || o.label, label: o.label || 'Untitled question' }))} />
          <Select value={field.show_if?.value ?? ''} placeholder={src ? 'Is' : 'Choose a question first'}
            onChange={(v) => onChange({ key: field.show_if!.key, value: v })} options={values} />
        </div>
      )}
    </div>
  )
}

/* Export (owner, 2026-11-08: "for each one let them export the details"). CSV opens in Excel. */
const csvCell = (v: string) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
function saveCsv(name: string, rows: string[][]) {
  const blob = new Blob(['\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name.replace(/[^\w .-]+/g, '_') + '.csv'
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
function saveExcel(name: string, rows: string[][]) {
  const esc = (v: string) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
  const html = '<html><head><meta charset="utf-8"></head><body><table border="1">' + rows.map((r, i) => '<tr>' + r.map((c) => (i ? '<td>' : '<th>') + esc(c) + (i ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table></body></html>'
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'application/vnd.ms-excel' })); a.download = name.replace(/[^\w .-]+/g, '_') + '.xls'
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
function printResponse(title: string, received: string, rows: [string, string][]) {
  const w = window.open('', '_blank'); if (!w) return
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px system-ui,sans-serif;margin:32px;color:#111}h1{font-size:20px;margin:0 0 4px}p{color:#555;margin:0 0 18px}table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:8px 10px;vertical-align:top;white-space:pre-line}td:first-child{width:34%;color:#555;background:#fafafa}</style><h1>${esc(title)}</h1><p>Received ${esc(received)}</p><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table><script>onload=()=>print()</script>`)
  w.document.close()
}
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }
/** "07-Oct-2026 14:39" (India time) from the old careers page, else when it reached us. */
function sentAt(r: Resp): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec((r.data.Submitted ?? '').trim())
  const mo = m && MON[m[2].toLowerCase()]
  if (!m || !mo) return r.created_at
  const d = new Date(`${m[3]}-${mo}-${m[1].padStart(2, '0')}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:00+05:30`)
  return Number.isNaN(d.getTime()) ? r.created_at : d.toISOString()
}
