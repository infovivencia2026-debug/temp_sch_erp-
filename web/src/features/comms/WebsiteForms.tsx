import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlignLeft, ArrowDown, ArrowUp, Calendar, CheckSquare, ChevronDown, CircleDot, ChevronRight, Copy, ExternalLink, FileText, Hash, Inbox,
  Link2, Mail, Paperclip, Phone, Plus, Trash2, Type, X, FolderOpen, BellDot, CalendarClock, Pencil,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useToast } from '@/components/Toast'
import {
  PageHead, PageBody, EmptyState, ErrorState, Card, Button, Checkbox, ConfirmButton, Input, Textarea, Select, Field, FormNotice, Badge,
  Table, Td, Switch, SkeletonTable, Stat, CellGrid, Dialog, TAB_BAR, tabClass,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* WEBSITE FORMS (owner, 2026-11-05): forms like Google Forms for the school's
   website (careers, contact, events and more). Build the questions here with
   a live preview, put the form on the website by embed or the website's own
   form, and read every response with its date, time and files. */

type FieldType = 'text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'dropdown' | 'choice' | 'checkbox' | 'file'
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
  { value: 'choice', label: 'Choose one', icon: CircleDot },
  { value: 'checkbox', label: 'Tick box', icon: CheckSquare },
  { value: 'file', label: 'File upload', icon: Paperclip },
]
const typeOf = (t: FieldType) => TYPES.find((x) => x.value === t)!
const when = (iso: string) => `${formatDate(iso.slice(0, 10))}, ${new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`

export default function WebsiteForms() {
  const q = useQuery({ queryKey: ['website-forms'], queryFn: () => api.get<{ school: string; items: Form[] }>('/api/v1/comms/website-forms') })
  /* The open form, its tab and an open response live in the address (owner,
     2026-11-21): Back, the browser's or a mouse/keyboard back button, goes one
     screen back, response, then form, then the list, not out of the page. */
  const [sp, setSp] = useSearchParams()
  const loc = useLocation()
  const openId = sp.get('form')
  const tab = (sp.get('tab') as Tab | null) ?? 'responses'
  const setOpenId = (v: string | null) => setSp((prev) => {
    const n = new URLSearchParams(prev)
    if (v) n.set('form', v); else { n.delete('form'); n.delete('tab'); n.delete('r') }
    return n
  })
  const setTab = (t: Tab) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('tab', t); return n }, { replace: true })
  const [creating, setCreating] = useState(false)
  const open = q.data?.items.find((f) => f.id === openId) ?? null

  if (q.isError) return <ErrorState error={q.error} />
  return (
    <>
      {open ? (
        <FormDetail form={open} school={q.data!.school} tab={tab} setTab={setTab} onBack={() => (loc.key !== 'default' ? window.history.back() : setOpenId(null))} />
      ) : (
        <>
          <PageHead eyebrow="Communication" title="Website forms"
            description="Website forms and responses."
            /* Once only (owner, 2026-11-05): with no forms the empty card has the button. */
            actions={q.data?.items.length ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New form</Button> : undefined} />
          <PageBody>
            {q.isPending ? <SkeletonTable /> : !q.data.items.length ? (
              <EmptyState title="No forms yet" body="No forms yet. Create one (e.g. Careers)."
                action={<Button onClick={() => setCreating(true)}><Plus className="size-4" />New form</Button>} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {q.data.items.map((f) => (
                  <button key={f.id} type="button" onClick={() => setSp((prev) => { const n = new URLSearchParams(prev); n.set('form', f.id); n.set('tab', f.fields.length ? 'responses' : 'questions'); return n })}
                    className="group text-left">
                    <Card className="h-full p-5 transition-all group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md">
                      <div className="flex items-start justify-between gap-3">
                        <span className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileText className="size-5" />
                          {/* Unopened applications, counted like the bell (owner, 2026-11-10). */}
                          {(f.unread ?? 0) > 0 && <span aria-label={`${f.unread} new`} className="absolute -right-2 -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1.5 text-[11px] font-bold leading-none text-white ring-2 ring-background tabular-nums">{f.unread! > 99 ? '99+' : f.unread}</span>}
                        </span>
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
      {creating && <NewForm onClose={() => setCreating(false)} onMade={(f) => { setCreating(false); setSp((prev) => { const n = new URLSearchParams(prev); n.set('form', f.id); n.set('tab', 'questions'); return n }) }} />}
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
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <PageHead eyebrow="Website forms" onEyebrow={onBack} title={form.title} />
      <PageBody>
        {/* Tabs and the form's actions on one line (owner, 2026-11-27); they wrap on a phone. */}
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className={cn(TAB_BAR, 'min-w-0')} role="tablist">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tabClass(tab === t.key)} onClick={() => setTab(t.key)}>
              {t.label}{t.key === 'responses' && (form.unread ?? 0) > 0 && <Badge tone="primary">{form.unread} new</Badge>}
            </button>
          ))}
        </div>
          <div className="flex flex-wrap items-center gap-3">
          {/* Export sits where "All forms" was (owner, 2026-11-21); the
              Responses tab fills this slot with what it is showing. */}
          <div ref={setSlot} className="contents" />
          {/* A dropdown, not an on/off switch (owner, 2026-11-05). */}
          <div className="w-56">
            <Select value={form.is_open ? 'open' : 'closed'} onChange={(v) => toggle.mutate(v === 'open')}
              options={[{ value: 'open', label: 'Taking responses' }, { value: 'closed', label: 'Closed' }]} />
          </div>
          <ConfirmButton tone="danger" size="md" confirmLabel="Delete form" label="Delete form"
            question={`Delete ${form.title} and all its responses? The form on the website stops working.`}
            onConfirm={() => del.mutate()} disabled={del.isPending}><Trash2 className="size-4" /></ConfirmButton>
          </div>
        </div>
        <FormNotice error={toggle.error ?? del.error} />
        {tab === 'questions' ? <Builder key={form.id} form={form} /> : tab === 'responses' ? <Responses form={form} slot={slot} /> : <Share form={form} school={school} />}
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
      fields: fields.map((f) => ({ ...f, options: f.type === 'dropdown' || f.type === 'choice' ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined })),
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
    setFields((l) => [...l, { key: '', label: '', type, required: false, ...(type === 'dropdown' || type === 'choice' ? { options: [''] } : {}) }])
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
                  <Select value={f.type} onChange={(v) => upd(i, { type: v as FieldType, options: v === 'dropdown' || v === 'choice' ? (f.options?.length ? f.options : ['']) : undefined })}
                    options={TYPES.map((t) => ({ value: t.value, label: t.label }))} />
                </div>
                {f.type === 'dropdown' || f.type === 'choice' ? (
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
                  : f.type === 'choice' ? <div className="mt-1.5 flex flex-wrap gap-2">{(f.options ?? []).filter((o) => o.trim()).map((o) => <span key={o} className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px]"><span className="size-3.5 rounded-full border" />{o}</span>)}</div>
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

function Responses({ form, slot }: { form: Form; slot: HTMLDivElement | null }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['website-form-responses', form.id],
    queryFn: () => api.get<{ form: Form; items: Resp[] }>(`/api/v1/comms/website-forms/${form.id}/responses`),
  })
  const [rsp, setRsp] = useSearchParams()
  const rloc = useLocation()
  const openId = rsp.get('r')
  const setOpenId = (v: string | null) => {
    if (!v && openId && rloc.key !== 'default') { window.history.back(); return }
    setRsp((prev) => { const n = new URLSearchParams(prev); if (v) n.set('r', v); else n.delete('r'); return n })
  }
  /* Opening one application reads that one only, so the count on the form
     card drops by one each time, as the bell's does. */
  const seen = useMutation({
    mutationFn: (rid: string) => api.post(`/api/v1/comms/website-forms/${form.id}/responses/${rid}/read`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['website-forms'] }); qc.invalidateQueries({ queryKey: ['website-form-responses', form.id] }) },
  })
  const del = useMutation({
    mutationFn: (rid: string) => api.del(`/api/v1/comms/website-forms/${form.id}/responses/${rid}`),
    onSuccess: () => { setOpenId(null); qc.invalidateQueries({ queryKey: ['website-form-responses', form.id] }); qc.invalidateQueries({ queryKey: ['website-forms'] }) },
  })
  /* Shortcuts: tick applications, put them in a named group, and open that
     group from a round chip above the list (owner, 2026-11-16, "like Snapchat"). */
  const toast = useToast()
  const sq = useQuery({
    queryKey: ['website-form-shortcuts', form.id],
    queryFn: () => api.get<{ items: Shortcut[] }>(`/api/v1/comms/website-forms/${form.id}/shortcuts`),
  })
  const shortcuts = sq.data?.items ?? []
  const saveShortcuts = useMutation({
    mutationFn: (list: Shortcut[]) => api.put<{ items: Shortcut[] }>(`/api/v1/comms/website-forms/${form.id}/shortcuts`, { items: list }),
    onSuccess: (r) => qc.setQueryData(['website-form-shortcuts', form.id], r),
  })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [view, setView] = useState<string | null>(null)
  /* The number cards filter the list (owner, 2026-11-21): Responses = not yet
     moved into a shortcut, New = unopened, Last 7 days = recent. */
  const [quick, setQuick] = useState<'' | 'all' | 'new' | 'week'>('')
  const [naming, setNaming] = useState(false)
  const [editing, setEditing] = useState<Shortcut | null>(null)
  const [editName, setEditName] = useState('')
  const [newName, setNewName] = useState('')
  const [fGrade, setFGrade] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fScore, setFScore] = useState('')
  const [fSearch, setFSearch] = useState('')
  const togglePick = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  /* + makes an empty shortcut with a name; applications are MOVED into one,
     by ticking rows or from inside an application (owner, 2026-11-16). */
  const createShortcut = () => {
    const name = newName.trim()
    if (!name) return
    saveShortcuts.mutate([...shortcuts, { id: '', name, ids: [] }], { onSuccess: () => { setNaming(false); setNewName('') } })
  }
  const moveTo = (sid: string, ids: string[]) => {
    const target = shortcuts.find((x) => x.id === sid)
    if (!target || !ids.length) return
    const list = shortcuts.map((x) => (x.id === sid ? { ...x, ids: [...new Set([...x.ids, ...ids])] } : { ...x, ids: x.ids.filter((i) => !ids.includes(i)) }))
    saveShortcuts.mutate(list, { onSuccess: () => { setPicked(new Set()); toast.ok(`Moved to ${target.name}`) } })
  }
  const removeFromView = () => {
    if (!view) return
    saveShortcuts.mutate(shortcuts.map((x) => (x.id === view ? { ...x, ids: x.ids.filter((i) => !picked.has(i)) } : x)), { onSuccess: () => setPicked(new Set()) })
  }
  const deleteShortcut = (sid: string) => saveShortcuts.mutate(shortcuts.filter((s) => s.id !== sid), { onSuccess: () => setView(null) })

  /* An application brought over from the old careers page keeps the date it was first sent (its "Submitted" answer). */
  const items = [...(q.data?.items ?? [])].map((r) => ({ ...r, created_at: sentAt(r) })).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const unread = items.filter((r) => !r.is_read).length
  useEffect(() => { if (openId && items.find((r) => r.id === openId && !r.is_read)) seen.mutate(openId) }, [openId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isError) return <ErrorState error={q.error} />
  if (q.isPending) return <SkeletonTable />
  if (!items.length) return <EmptyState title="No responses yet" body="No responses yet." />

  /* OLD AND NEW NAMES, ONE QUESTION (owner, 2026-11-08: "map them old and new").
     The school's own careers page posts its own names (Name, Phone, post ...);
     each is shown under the matching question of this form. */
  const known = form.fields.map((f) => f.key)
  const aliasOf = (k: string) => known.find((f) => (ALIASES[f] ?? []).includes(k))
  const val = (r: Resp, k: string) => show(r, k) || (ALIASES[k] ?? []).map((a) => show(r, a)).find(Boolean) || ''
  const fileOf = (r: Resp, k: string) => r.files.find((x) => x.key === k) ?? r.files.find((x) => (ALIASES[k] ?? []).includes(x.key))
  const extra = [...new Set(items.flatMap((r) => [...Object.keys(r.data), ...r.files.map((x) => x.key)]))].filter((k) => !known.includes(k) && !aliasOf(k))
  const cols = [...form.fields.map((f) => ({ key: f.key, label: f.label })), ...extra.map((k) => ({ key: k, label: niceKey(k) }))]
  const filled = (r: Resp, k: string) => !!val(r, k) || !!fileOf(r, k)
  const shownCols = cols.filter((c) => items.some((r) => filled(r, c.key))).slice(0, 4)
  const todayIso = new Date().toLocaleDateString('en-CA')
  /* A response moved into a shortcut lives there, not under Responses again
     (owner, 2026-11-21: "they are going to the same again and again"). */
  const sorted = new Set(shortcuts.flatMap((x) => x.ids))
  const inView = (r: Resp) =>
    quick === 'all' ? true
      : quick === 'new' ? !r.is_read
      : quick === 'week' ? new Date(r.created_at).toLocaleDateString('en-CA') === todayIso
      : view ? (shortcuts.find((x) => x.id === view)?.ids ?? []).includes(r.id)
      : !sorted.has(r.id)
  const shown = items.filter(inView)
  const pickCard = (k: '' | 'all' | 'new' | 'week') => { setQuick(k); setView(null); setPicked(new Set()) }
  const open = items.find((r) => r.id === openId) ?? null
  const cell = (r: Resp, k: string) => fileOf(r, k)?.name ?? val(r, k)
  const allRows = () => {
    const use = cols.filter((c) => !INTERNAL.has(c.key) && items.some((r) => filled(r, c.key)))
    return [['Received', ...use.map((c) => c.label)], ...shown.map((r) => [when(r.created_at), ...use.map((c) => cell(r, c.key))])]
  }

  /* SCORED TEST VIEW (owner, 2026-11-20: Yajur Quest "like the preview").
     A form whose responses carry a test code is an online test: the school
     reads it as a results board, one row per student, with the score and the
     subject marks the website sends back. Shortcuts work the same. */
  const scored = items.some((r) => !!r.data.test_code)
  const num = (r: Resp, k: string) => { const t = r.data[k]; if (t == null || t === '') return null; const v = Number(t); return Number.isFinite(v) ? v : null }
  const stateOf = (r: Resp) => {
    const st = (r.data.status || '').toLowerCase(), pct = num(r, 'pct')
    if (st === 'submitted' || st === 'finished') return pct != null && pct >= 50 ? 'stage2' : 'finished'
    if (st === 'started') return 'started'
    return 'pending'
  }
  const STATE: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' | 'primary' }> = {
    stage2: { label: 'Stage 2', tone: 'success' }, finished: { label: 'Finished', tone: 'primary' },
    started: { label: 'Started, not submitted', tone: 'warning' }, pending: { label: 'Not taken yet', tone: 'neutral' },
  }
  const done = items.filter((r) => num(r, 'score') != null)
  const grades = [...new Set(items.map((r) => r.data.applying_for_grade).filter(Boolean))].sort((a, b) => Number(a) - Number(b))
  const rankOf = (r: Resp) => {
    const sc = num(r, 'score')
    if (sc == null) return 0
    return 1 + done.filter((x) => x.data.applying_for_grade === r.data.applying_for_grade && (num(x, 'score') ?? -1) > sc).length
  }
  const q2 = fSearch.trim().toLowerCase()
  const board = items
    .filter(inView)
    .filter((r) => !fGrade || r.data.applying_for_grade === fGrade)
    .filter((r) => !fStatus || stateOf(r) === fStatus)
    .filter((r) => !fScore || (num(r, 'pct') ?? -1) >= 50)
    .filter((r) => !q2 || [r.data.student_name, r.data.mobile_number, r.data.test_code, r.data.father_s_name].some((v) => (v || '').toLowerCase().includes(q2)))
    .sort((a, b) => Number(a.data.applying_for_grade || 0) - Number(b.data.applying_for_grade || 0) || (num(b, 'score') ?? -1) - (num(a, 'score') ?? -1))
  const pcts = done.map((r) => num(r, 'pct') ?? 0)
  const top = done.reduce((m, r) => Math.max(m, num(r, 'score') ?? 0), 0)
  const boardRows = () => [['Student', 'Father name', 'Test code', 'Grade', 'Mobile', 'Score', '%', 'Maths', 'English', 'Science', 'Social', 'Minutes', 'Status'],
    ...board.map((r) => [r.data.student_name || '', r.data.father_s_name || '', r.data.test_code || '', r.data.applying_for_grade || '', r.data.mobile_number || '',
      r.data.score || '', r.data.pct || '', r.data.maths || '', r.data.english || '', r.data.science || '', r.data.social || '', r.data.minutes || '', STATE[stateOf(r)].label])]

  return (
    <>
      {/* The long blue title bar is gone (owner, 2026-11-27): the page head already names the form. */}
      {slot && createPortal(
        <div className="w-44"><Select value="" placeholder={`Export ${scored ? board.length : shown.length}`} onChange={(v) => { const rows = scored ? boardRows() : allRows(); if (v === 'xlsx') saveExcel(form.title + ' responses', rows); else if (v === 'csv') saveCsv(form.title + ' responses', rows) }}
          options={[{ value: 'xlsx', label: 'Excel' }, { value: 'csv', label: 'CSV' }]} /></div>, slot)}
      {scored ? (
        <CellGrid cols={4}>
          <Stat label="Registered" icon={Inbox} value={items.length} hint={sorted.size ? `${sorted.size} in shortcuts` : undefined} tint onClick={() => pickCard('all')} active={quick === 'all'} />
          <Stat label="Finished" value={done.length} tint />
          <Stat label="Above 50%" value={pcts.filter((x) => x >= 50).length} tint />
          <Stat label="Average · top" value={pcts.length ? `${Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length)}% · ${top}/60` : '-'} tint />
        </CellGrid>
      ) : (
        <CellGrid cols={3}>
          <Stat label="Responses" icon={Inbox} value={items.length} hint={sorted.size ? `${items.filter((x) => !sorted.has(x.id)).length} to sort · ${sorted.size} in shortcuts` : 'All received'} tint onClick={() => pickCard('all')} active={quick === 'all'} />
          <Stat label="New" icon={BellDot} value={unread} hint={unread ? `Oldest unopened ${when(items.filter((x) => !x.is_read).at(-1)!.created_at)}` : 'All opened'} tint onClick={() => pickCard('new')} active={quick === 'new'} />
          {/* Today, with when the last one came in (owner, 2026-11-21: a date in
              place of Last 7 days). */}
          {/* When the newest response came in (owner, 2026-11-21). Click: today's. */}
          <Stat label="Last received" icon={CalendarClock} value={items[0] ? formatDate(items[0].created_at) : '-'}
            hint={`${items.filter((r) => new Date(r.created_at).toLocaleDateString('en-CA') === todayIso).length} today`} tint onClick={() => pickCard('week')} active={quick === 'week'} />
        </CellGrid>
      )}
      {/* The shortcut chips: All, then each group with its count. */}
      <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 gap-3 overflow-x-auto pb-1 [scrollbar-width:none]" role="tablist" aria-label="Shortcuts">
        {/* Shortcuts as full-name chips with their count (owner, 2026-11-21: the
            names were cut to a few letters). "All" is the Responses card now. */}
        {/* All = the responses not moved into any shortcut (owner, 2026-11-21). */}
        <button type="button" role="tab" aria-selected={!view && !quick} onClick={() => pickCard('')}
          className={cn('flex min-h-12 shrink-0 items-center gap-2.5 rounded-xl border-2 px-3.5 py-2 text-left transition-colors',
            !view && !quick ? 'border-primary bg-primary text-primary-foreground' : 'border-primary/30 bg-primary/5 text-foreground hover:border-primary/60')}>
          <Inbox className={cn('size-5 shrink-0', !view && !quick ? '' : 'text-primary')} aria-hidden />
          <span className="whitespace-nowrap text-[14px] font-semibold">Yet to review</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-bold tabular-nums', !view && !quick ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary')}>{items.filter((x) => !sorted.has(x.id)).length}</span>
        </button>
        {shortcuts.map((s) => {
          const on = view === s.id
          const n = s.ids.filter((x) => items.some((r) => r.id === x)).length
          return (
            <button key={s.id} type="button" role="tab" aria-selected={on} onClick={() => { setQuick(''); setView(on ? null : s.id); setPicked(new Set()) }}
              className={cn('flex min-h-12 shrink-0 items-center gap-2.5 rounded-xl border-2 px-3.5 py-2 text-left transition-colors',
                on ? 'border-primary bg-primary text-primary-foreground' : 'border-primary/30 bg-primary/5 text-foreground hover:border-primary/60')}>
              <FolderOpen className={cn('size-5 shrink-0', on ? '' : 'text-primary')} aria-hidden />
              <span className="whitespace-nowrap text-[14px] font-semibold">{s.name}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-bold tabular-nums', on ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary')}>{n}</span>
              <span role="button" tabIndex={0} aria-label={`Rename or delete ${s.name}`}
                onClick={(e) => { e.stopPropagation(); setEditName(s.name); setEditing(s) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setEditName(s.name); setEditing(s) } }}
                className={cn('-mr-1 grid size-8 place-items-center rounded-lg', on ? 'hover:bg-primary-foreground/20' : 'text-muted-foreground hover:bg-primary/10 hover:text-primary')}>
                <Pencil className="size-4" aria-hidden />
              </span>
            </button>
          )
        })}
        <button type="button" onClick={() => setNaming(true)} aria-label="Add a shortcut"
          className="flex min-h-12 shrink-0 items-center gap-2 rounded-xl border-2 border-dashed border-primary/50 px-3.5 py-2 text-[14px] font-medium text-primary hover:bg-primary/5">
          <Plus className="size-5" aria-hidden />New shortcut
        </button>
      </div>
      {/* Ticked rows: actions sit in the free space beside the chips (owner, 2026-11-17). */}
      {picked.size > 0 && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium">{picked.size} selected</span>
          {/* Move to any other shortcut, or back to Yet to review (owner, 2026-11-27). */}
          {(view || shortcuts.length > 0) && (
            <div className="w-48"><Select value="" placeholder="Move to" onChange={(v) => { if (v === UNSORTED) removeFromView(); else if (v) moveTo(v, [...picked]) }}
              options={[...(view ? [{ value: UNSORTED, label: 'Yet to review' }] : []), ...shortcuts.filter((x) => x.id !== view).map((x) => ({ value: x.id, label: x.name }))]} /></div>
          )}
          <ConfirmButton tone="danger" confirmLabel="Delete" question={`Delete ${picked.size} response${picked.size > 1 ? 's' : ''} and their files?`}
            onConfirm={async () => { for (const id of picked) await del.mutateAsync(id); setPicked(new Set()) }}>
            <Trash2 className="size-4" aria-hidden />Delete
          </ConfirmButton>
          <Button variant="ghost" title="Clear selection" onClick={() => setPicked(new Set())}><X className="size-4" aria-hidden /></Button>
        </div>
      )}
      </div>
      {naming && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
          <div className="min-w-0 flex-1 sm:max-w-xs"><Input value={newName} onChange={setNewName} placeholder="Shortcut name, e.g. Shortlist" autoFocus /></div>
          <Button variant="ghost" onClick={() => { setNaming(false); setNewName('') }}>Cancel</Button>
          <Button pending={saveShortcuts.isPending} disabled={!newName.trim()} onClick={createShortcut}>Create</Button>
        </div>
      )}
      {/* Pencil on a shortcut: rename it or delete it (owner, 2026-11-21). */}
      {editing && (
        <Dialog open size="sm" onClose={() => setEditing(null)} title="Edit shortcut"
          footer={<>
            <ConfirmButton tone="danger" confirmLabel="Delete" question={`Delete ${editing.name}? The applications go back to All.`}
              onConfirm={() => { deleteShortcut(editing.id); setEditing(null) }}><Trash2 className="size-4" aria-hidden />Delete</ConfirmButton>
            <Button pending={saveShortcuts.isPending} disabled={!editName.trim()}
              onClick={() => saveShortcuts.mutate(shortcuts.map((x) => (x.id === editing.id ? { ...x, name: editName.trim() } : x)), { onSuccess: () => setEditing(null) })}>Save</Button>
          </>}>
          <Input value={editName} onChange={setEditName} placeholder="Shortcut name" autoFocus />
        </Dialog>
      )}
      <FormNotice error={saveShortcuts.error ?? sq.error} />
      {scored ? (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select value={fGrade} onChange={setFGrade} placeholder="All grades" options={[{ value: '', label: 'All grades' }, ...grades.map((g) => ({ value: g, label: `Grade ${g}` }))]} />
            <Select value={fStatus} onChange={setFStatus} placeholder="Any status" options={[{ value: '', label: 'Any status' }, ...Object.entries(STATE).map(([k, v]) => ({ value: k, label: v.label }))]} />
            <Select value={fScore} onChange={setFScore} placeholder="All scores" options={[{ value: '', label: 'All scores' }, { value: '50', label: 'Above 50% only' }]} />
            <Input value={fSearch} onChange={setFSearch} placeholder="Search name, mobile, code" />
          </div>
          <Table head={['', '#', 'Student', 'Grade', 'Mobile', 'Score', 'Maths', 'English', 'Science', 'Social', 'Time', 'Status']}>
            {board.map((r) => {
              const rk = rankOf(r), st = STATE[stateOf(r)], sc = num(r, 'score')
              return (
                <tr key={r.id} className="cursor-pointer transition-colors hover:bg-muted/40" onClick={() => setOpenId(r.id)}>
                  <Td className="w-10"><span onClick={(e) => e.stopPropagation()}><Checkbox label="" srLabel="Select this student" checked={picked.has(r.id)} onChange={() => togglePick(r.id)} /></span></Td>
                  <Td className="w-12">{rk >= 1 && rk <= 3
                    ? <Badge tone={rk === 1 ? 'warning' : rk === 2 ? 'info' : 'neutral'}>{rk}</Badge>
                    : <span className="text-muted-foreground">{rk || '-'}</span>}</Td>
                  <Td className="min-w-[160px]"><div className="font-semibold">{r.data.student_name}{!r.is_read && <Badge tone="primary" className="ml-2">New</Badge>}</div>
                    <div className="text-[12.5px] text-muted-foreground">{[r.data.father_s_name, r.data.test_code].filter(Boolean).join(' · ')}</div></Td>
                  <Td className="tabular-nums">{r.data.applying_for_grade}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{r.data.mobile_number}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{sc != null ? <><b>{sc}</b> <span className="text-muted-foreground">({num(r, 'pct') ?? '-'}%)</span></> : '-'}</Td>
                  {['maths', 'english', 'science', 'social'].map((k) => <Td key={k} className="tabular-nums">{r.data[k] || '-'}</Td>)}
                  <Td className="whitespace-nowrap tabular-nums">{r.data.minutes ? `${r.data.minutes}m` : '-'}</Td>
                  <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                </tr>
              )
            })}
          </Table>
          {!board.length && <EmptyState title="No students match" body="Change the grade, status or search above." />}
        </>
      ) : (
      <Table head={['', 'Received', ...shownCols.map((c) => c.label), 'Files', '']}>
        {shown.map((r) => (
          <tr key={r.id} className="cursor-pointer transition-colors hover:bg-muted/40" onClick={() => setOpenId(r.id)}>
            <Td className="w-10" ><span onClick={(e) => e.stopPropagation()}><Checkbox label="" srLabel="Select this application" checked={picked.has(r.id)} onChange={() => togglePick(r.id)} /></span></Td>
            <Td className="whitespace-nowrap tabular-nums">{when(r.created_at)}{!r.is_read && <Badge tone="primary" className="ml-2">New</Badge>}</Td>
            {shownCols.map((c) => <Td key={c.key} className="max-w-[260px] truncate">{cell(r, c.key)}</Td>)}
            <Td>{r.files.length ? <span className="inline-flex items-center gap-1 text-[13px] text-muted-foreground"><Paperclip className="size-4" />{r.files.length}</span> : null}</Td>
            <Td className="text-right"><span className="row-open">Open<ChevronRight className="size-3.5" aria-hidden /></span></Td>
          </tr>
        ))}
      </Table>
      )}
      {open && (() => {
        /* The owner's response card (2026-11-08): who and what for on top, the
           answers in titled cards, files as attachments; Delete and Export. */
        const rows = cols.filter((c) => (open.source === 'embed' || filled(open, c.key)) && !fileOf(open, c.key) && !INTERNAL.has(c.key))
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
        const doc: DocSection[] = [
          { t: 'Application', items: [['Name', name], ['Applied for', role], ['Submitted', when(open.created_at)]].filter(([, v]) => v) as [string, string][] },
          ...sections.filter((s) => s.list.length).map((s) => ({ t: s.t, items: s.list.map((c) => [c.label, val(open, c.key)] as [string, string]).filter(([, v]) => v) })),
        ]
        const docFiles = cols.map((c) => ({ c, f: fileOf(open, c.key) })).filter((x) => x.f).map((x) => [x.c.label, x.f!.name] as [string, string])
        if (docFiles.length) doc.push({ t: 'Uploaded documents', items: docFiles })
        const table = (): string[][] => [['Section', 'Question', 'Answer'], ...doc.flatMap((s) => s.items.map(([k, v]) => [s.t, k, v]))]
        const files = cols.map((c) => ({ c, f: fileOf(open, c.key) })).filter((x) => x.f)
        return (
          <Dialog open size="xl" initialFocus="panel" onClose={() => setOpenId(null)} title={name || 'Response'}
            description={`${open.source === 'embed' ? 'Embedded form' : 'Website form'} · Submitted ${when(open.created_at)}`}
            footer={<>
              <ConfirmButton tone="danger" confirmLabel="Delete" question="Delete this response and its files?" onConfirm={() => del.mutate(open.id)}><Trash2 className="size-4" aria-hidden />Delete</ConfirmButton>
              <span className="flex-1" />
              {shortcuts.length > 0 && (
                <div className="w-full sm:w-44"><Select value={shortcuts.find((x) => x.ids.includes(open.id))?.id ?? ''} placeholder="Move to"
                  onChange={(v) => v && moveTo(v, [open.id])} options={shortcuts.map((x) => ({ value: x.id, label: x.name }))} /></div>
              )}
              <div className="w-full sm:w-36"><Select value="" placeholder="Export" onChange={(v) => {
                if (v === 'xlsx') saveExcel(fname, table()); else if (v === 'pdf') printResponse(form.title, name || 'Response', role, when(open.created_at), doc); else if (v === 'csv') saveCsv(fname, table())
              }} options={[{ value: 'xlsx', label: 'Excel' }, { value: 'pdf', label: 'PDF' }, { value: 'csv', label: 'CSV' }]} /></div>
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
interface Shortcut { id: string; name: string; ids: string[] }
const show = (r: Resp, k: string) => {
  let v = r.data[k]
  if (Array.isArray(v)) v = v.join(', ')
  if (v === 'true') return 'Yes'
  if (v === 'false') return 'No'
  if (v == null) return ''
  /* An unanswered multi-value field arrives as the empty array's text, "[]"
     (or "{}"/"null"): show nothing rather than the brackets. */
  const s = String(v).trim()
  if (s === '[]' || s === '{}' || s === 'null') return ''
  /* The new careers page sends lists (jobs, academics, languages, children ...)
     as JSON text; shown raw it was brackets and quotes (owner, 2026-11-21).
     Each entry becomes one readable line. */
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(s)
      const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((x) => x != null)
      return list.map((x) => entryLine(k, x)).filter(Boolean).join('\n')
    } catch { /* not JSON: shown as typed */ }
  }
  return s
}
const fieldOf = (o: Record<string, unknown>, k: string) => (o[k] == null ? '' : String(o[k]).trim())
function entryLine(key: string, x: unknown): string {
  if (typeof x !== 'object') return String(x)
  const o = x as Record<string, unknown>
  const join = (...p: string[]) => p.filter(Boolean).join(', ')
  if (key === 'jobs' || 'organisation' in o) {
    const span = [fieldOf(o, 'from'), o.current ? 'present' : fieldOf(o, 'to')].filter(Boolean).join(' to ')
    const pay = fieldOf(o, 'grossSalary') || fieldOf(o, 'salary')
    const why = fieldOf(o, 'reason')
    return join(span, fieldOf(o, 'position'), fieldOf(o, 'organisation'), pay ? `Rs ${pay}` : '') + (why ? ` (left: ${why})` : '')
  }
  if (key === 'academics' || 'exam' in o) {
    const pct = fieldOf(o, 'percent')
    return join(fieldOf(o, 'exam'), fieldOf(o, 'institution'), fieldOf(o, 'year'), fieldOf(o, 'subjects'), fieldOf(o, 'division'), pct ? `${pct}%` : '')
  }
  if (key === 'languages' || ('read' in o && 'write' in o)) {
    const can = ['read', 'write', 'speak', 'understand'].filter((c) => o[c] === true || o[c] === 'true')
    return `${fieldOf(o, 'name')}${can.length ? ` (${can.join(', ')})` : ''}`
  }
  return Object.entries(o)
    .filter(([, v]) => v !== '' && v != null && v !== false && v !== 'false')
    .map(([k2, v]) => (v === true || v === 'true' ? k2 : `${k2}: ${String(v)}`))
    .join(', ')
}
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
      <Step n={2} title="Or embed in our style" body="Give this code to your website person.">
        <CopyBox text={embed} />
      </Step>
      <Step n={3} title="Or share a link" body="Use on a button or share on WhatsApp.">
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
  const choosable = others.filter((o) => ((o.type === 'dropdown' || o.type === 'choice') && (o.options ?? []).some((x) => x.trim())) || o.type === 'checkbox')
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

const UNSORTED = '__yet_to_review'
/* Export (owner, 2026-11-08: "for each one let them export the details"). CSV opens in Excel. */
const csvCell = (v: string) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
function saveCsv(name: string, rows: string[][]) {
  const blob = new Blob(['\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name.replace(/[^\w .-]+/g, '_') + '.csv'
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
function saveExcel(name: string, rows: string[][]) {
  const esc = (v: string) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
  const html = '<html><head><meta charset="utf-8"><style>td,th{mso-number-format:"\\@";vertical-align:top}th{background:#eef2ff}</style></head><body><table border="1">' + rows.map((r, i) => '<tr>' + r.map((c) => (i ? '<td>' : '<th>') + esc(c) + (i ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table></body></html>'
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'application/vnd.ms-excel' })); a.download = name.replace(/[^\w .-]+/g, '_') + '.xls'
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
type DocSection = { t: string; items: [string, string][] }
/* Print / save as PDF in the response card's design (owner, 2026-11-09). */
function printResponse(formTitle: string, name: string, role: string, received: string, doc: DocSection[]) {
  const w = window.open('', '_blank'); if (!w) return
  const esc = (s: string) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
  const initials = name.trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase()
  const css = `*{box-sizing:border-box}body{font:13.5px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;margin:0;padding:28px;background:#fff}
.top{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#64748b;margin-bottom:14px}.tag{background:#ecfdf5;color:#047857;border-radius:99px;padding:3px 10px;font-weight:600}
.hero{display:flex;gap:14px;align-items:center;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:12px}.av{width:50px;height:50px;border-radius:12px;background:#eef2ff;color:#4338ca;display:grid;place-items:center;font-weight:700;font-size:18px}
h1{font-size:19px;margin:0}.role{color:#64748b;margin-top:2px}.role b{color:#0f172a}
.card{border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px;margin-bottom:12px;break-inside:avoid}.ct{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin-bottom:10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px}.it{min-width:0}.it.w{grid-column:span 2}.l{font-size:11.5px;color:#64748b}.v{font-weight:600;white-space:pre-line;word-break:break-word}
@page{margin:14mm}@media print{body{padding:0}}`
  const body = doc.filter((s) => s.t !== 'Application').map((s) => `<div class="card"><div class="ct">${esc(s.t)}</div><div class="grid">${s.items.map(([k, v]) => `<div class="it${v.length > 40 || /address|experience|reference|academ/i.test(k) ? ' w' : ''}"><div class="l">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div></div>`).join('')
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)} · ${esc(formTitle)}</title><style>${css}</style></head><body>
<div class="top"><span class="tag">${esc(formTitle)}</span><span>Submitted ${esc(received)}</span></div>
<div class="hero"><div class="av">${esc(initials || 'R')}</div><div><h1>${esc(name)}</h1>${role ? `<div class="role">Applied for <b>${esc(role)}</b></div>` : ''}</div></div>
${body}<script>onload=()=>setTimeout(()=>print(),300)</script></body></html>`)
  w.document.close()
}
/* The old careers system's own bookkeeping: not part of the application. */
const INTERNAL = new Set(['Stage', 'Profile', 'Profile steps'])
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }
/** "07-Oct-2026 14:39" (India time) from the old careers page, else when it reached us. */
function sentAt(r: Resp): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec((r.data.Submitted ?? '').trim())
  const mo = m && MON[m[2].toLowerCase()]
  if (!m || !mo) return r.created_at
  const d = new Date(`${m[3]}-${mo}-${m[1].padStart(2, '0')}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:00+05:30`)
  return Number.isNaN(d.getTime()) ? r.created_at : d.toISOString()
}

/* A question the form does not know by name shows a readable label, not the
   website's field name (owner, 2026-11-21: "sameAddress", "place"). */
const KEY_LABELS: Record<string, string> = { sameAddress: 'Same as current address', place: 'Place' }
function niceKey(k: string): string {
  if (KEY_LABELS[k]) return KEY_LABELS[k]
  const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : k
}
