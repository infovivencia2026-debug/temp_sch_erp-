import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, MessageCircle, Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Badge, Button, ConfirmButton, Dialog, EmptyState, ErrorState, Field, FormGrid, FormNotice, Input, Select, Stat, CellGrid, Textarea,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* ENQUIRY LINKS: where a family that asks is sent.

   "Send me the details" used to end in a phone number and a promise. A link
   here opens a short form the family fills in itself; it arrives in the
   enquiry list as a lead due today. A school makes one per place it hands
   the link out (the website, a WhatsApp reply, the banner at the gate), and
   the count beside each says which of them is working.

   What the form asks is chosen per link. The child's name, a parent's name
   and a phone number are always asked; each of the rest is off, optional or
   required. The address never changes once made, because a poster cannot be
   reprinted; a link that should stop taking enquiries is closed, not deleted.

   Opened from the Enquiries screen. Admissions writes wait for the server
   (CLAUDE.md): nothing here is shown before it is saved. */

type Level = 'off' | 'optional' | 'required'
interface LinkItem {
  id: string; name: string; slug: string; source: string; is_open: boolean; heading: string; intro: string; thanks: string
  ask: Record<string, Level>; apply_form_id: string; apply_form?: string; url: string; path: string; enquiries: number; last_enquiry_at?: string
}
/* The address a family opens is this site's, whatever host the API answered from. */
const addr = (l: LinkItem) => window.location.origin + l.path
interface Payload {
  items: LinkItem[]
  forms: { id: string; name: string; slug: string; is_open: boolean }[]
  questions: { key: string; label: string }[]
  sources: string[]
}
const SOURCE_NAME: Record<string, string> = { website: 'Website', campaign: 'Campaign', referral: 'Referral', phone: 'Phone', walk_in: 'Walk-in', other: 'Other' }
const LEVELS: { value: Level; label: string }[] = [{ value: 'off', label: 'Not asked' }, { value: 'optional', label: 'Optional' }, { value: 'required', label: 'Required' }]

export default function EnquiryLinks({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['enquiry-links'], queryFn: () => api.get<Payload>('/api/v1/admissions/enquiry-links') })
  const [editing, setEditing] = useState<LinkItem | 'new' | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['enquiry-links'] })

  const toggle = useMutation({
    mutationFn: (l: LinkItem) => api.post(`/api/v1/admissions/enquiry-links/${l.id}`, { is_open: !l.is_open }),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/v1/admissions/enquiry-links/${id}`), onSuccess: refresh })

  const copy = (l: LinkItem) => {
    void navigator.clipboard?.writeText(addr(l))
    setCopied(l.id)
    setTimeout(() => setCopied((c) => (c === l.id ? null : c)), 1800)
  }
  const share = (l: LinkItem) =>
    `https://wa.me/?text=${encodeURIComponent(`Thank you for your interest. Please fill in this short enquiry form and we will call you: ${addr(l)}`)}`

  const items = q.data?.items ?? []
  const total = items.reduce((n, l) => n + l.enquiries, 0)
  const best = items.reduce<LinkItem | null>((a, l) => (!a || l.enquiries > a.enquiries ? l : a), null)

  /* The editor opens OVER this dialog rather than in place of it: two
     dialogs swapped in one render hand the same Back entry to each other,
     and the second closed as it opened. */
  return (
    <>
    {editing && q.data && (
      <LinkEditor link={editing === 'new' ? null : editing} data={q.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />
    )}
    <Dialog
      onClose={onClose}
      size="lg"
      title="Enquiry links"
      description="A short form a family fills in itself. Each one that comes back is a lead in this list, due a call today."
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button onClick={() => setEditing('new')}><Plus className="h-3.5 w-3.5" /> New link</Button></>}
    >
      {q.isLoading && !q.data ? <p className="text-sm text-muted-foreground">Loading…</p> : q.error ? <ErrorState error={q.error} /> : items.length === 0 ? (
        <EmptyState
          title="No links yet"
          body="Make one for each place you hand it out: the website, a WhatsApp reply, a poster. The count beside each shows which brings families in."
        />
      ) : (
        <>
          <CellGrid cols={2}>
            <Stat
              label="Enquiries through links"
              value={total}
              detail={total && best ? <>Most from <b className="font-semibold text-foreground">{best.name}</b>: {best.enquiries} of {total}.</> : 'None yet. Share a link to start.'}
              parts={items.map((l, i) => ({ key: l.id, label: l.name, value: l.enquiries, tone: (['primary', 'info', 'success', 'warning', 'neutral'] as const)[i % 5] }))}
            />
            <Stat
              label="Links taking enquiries"
              value={`${items.filter((l) => l.is_open).length} of ${items.length}`}
              detail={items.some((l) => !l.is_open) ? 'A closed link tells the family to contact the office instead.' : 'All open.'}
            />
          </CellGrid>
          <ul className="mt-4 grid gap-3">
            {items.map((l) => (
              <li key={l.id} className="rounded-[var(--radius-card)] border bg-card px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold">{l.name}</span>
                  <Badge tone={l.is_open ? 'success' : 'neutral'}>{l.is_open ? 'Open' : 'Closed'}</Badge>
                  <span className="text-[12.5px] text-muted-foreground">
                    {SOURCE_NAME[l.source] ?? l.source} · {l.enquiries} {l.enquiries === 1 ? 'enquiry' : 'enquiries'}
                    {l.last_enquiry_at ? ` · last ${formatDate(l.last_enquiry_at)}` : ''}
                  </span>
                </div>
                <p className="mt-1.5 break-all font-mono text-[12.5px] text-muted-foreground">{addr(l)}</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <Button size="sm" onClick={() => copy(l)}>
                    {copied === l.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === l.id ? 'Copied' : 'Copy link'}
                  </Button>
                  <a href={share(l)} target="_blank" rel="noreferrer" className={cn('inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-[13px] font-medium hover:bg-accent')}>
                    <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
                  </a>
                  <a href={l.path} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
                    <ExternalLink className="h-3.5 w-3.5" /> Preview
                  </a>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setEditing(l)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                  <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(l)}>{l.is_open ? 'Close' : 'Open'}</Button>
                  {l.enquiries === 0 && (
                    <ConfirmButton variant="ghost" confirmLabel="Delete link" question="The address stops working for anyone who has it." onConfirm={() => remove.mutate(l.id)} label="Delete link">
                      <Trash2 className="h-3.5 w-3.5" />
                    </ConfirmButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <FormNotice error={toggle.error ?? remove.error} />
        </>
      )}
    </Dialog>
    </>
  )
}

function LinkEditor({ link, data, onClose, onSaved }: { link: LinkItem | null; data: Payload; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: link?.name ?? '', source: link?.source ?? 'website', heading: link?.heading ?? '', intro: link?.intro ?? '', thanks: link?.thanks ?? '',
    apply_form_id: link?.apply_form_id ?? '',
    ask: { class_sought: 'required', email: 'optional', date_of_birth: 'off', current_school: 'off', how_heard: 'optional', visit_date: 'off', message: 'optional', ...(link?.ask ?? {}) } as Record<string, Level>,
  })
  const save = useMutation({
    mutationFn: () => api.post(link ? `/api/v1/admissions/enquiry-links/${link.id}` : '/api/v1/admissions/enquiry-links', f),
    onSuccess: onSaved,
  })
  return (
    <Dialog
      raised
      onClose={onClose}
      size="lg"
      title={link ? `Edit ${link.name}` : 'New enquiry link'}
      description={link ? 'The address stays the same; only what the form says and asks changes.' : 'Name it after where it will be handed out.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={save.isPending || f.name.trim() === ''} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : link ? 'Save' : 'Create link'}</Button></>}
    >
      <FormGrid>
        <Field label="Where it is handed out" required hint="Shown beside each lead it brings, so you can tell channels apart.">
          <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="WhatsApp reply" />
        </Field>
        <Field label="Counts as" hint="The source recorded on each lead.">
          <Select value={f.source} onChange={(v) => setF({ ...f, source: v || 'website' })} options={data.sources.map((s) => ({ value: s, label: SOURCE_NAME[s] ?? s }))} />
        </Field>
        <Field label="Heading" wide hint="Leave empty for “Enquire about admission”.">
          <Input value={f.heading} onChange={(v) => setF({ ...f, heading: v })} placeholder="Admissions 2027–28" />
        </Field>
        <Field label="A line or two above the form" wide>
          <Textarea value={f.intro} onChange={(v) => setF({ ...f, intro: v })} placeholder="Tell us a little about your child and we will call you to arrange a visit." />
        </Field>
      </FormGrid>

      <fieldset className="mt-5">
        <legend className="text-[13px] font-medium text-secondary-foreground">What the form asks</legend>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">The child’s name, your name and a phone number are always asked.</p>
        <ul className="mt-2.5 grid gap-2">
          {data.questions.map((qn) => (
            <li key={qn.key} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[14px]">{qn.label}</span>
              <span className="inline-flex gap-1 rounded-full bg-muted p-1" role="radiogroup" aria-label={qn.label}>
                {LEVELS.map((lv) => {
                  const on = (f.ask[qn.key] ?? 'off') === lv.value
                  return (
                    <button key={lv.value} type="button" role="radio" aria-checked={on} onClick={() => setF({ ...f, ask: { ...f.ask, [qn.key]: lv.value } })}
                      className={cn('tap-inline rounded-full px-2.5 py-1 text-[12.5px] font-medium transition-colors', on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      {lv.label}
                    </button>
                  )
                })}
              </span>
            </li>
          ))}
        </ul>
      </fieldset>

      <FormGrid>
        <Field label="After they send it, say" wide hint="Leave empty for “Thank you. The school has your enquiry and will call you.”">
          <Input value={f.thanks} onChange={(v) => setF({ ...f, thanks: v })} placeholder="Thank you. Our admissions office will call you today." />
        </Field>
        <Field label="Then offer the application" wide hint="The family can go straight on to this form, with what they just typed already filled in. Only a published, open form is offered to them.">
          <Select value={f.apply_form_id} onChange={(v) => setF({ ...f, apply_form_id: v })}
            options={[{ value: '', label: 'Do not offer it' }, ...data.forms.map((x) => ({ value: x.id, label: x.is_open ? x.name : `${x.name} (closed)` }))]} />
        </Field>
      </FormGrid>
      <FormNotice error={save.error} />
    </Dialog>
  )
}
