import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Card, Checkbox, Dialog, ErrorState, Field, FormNotice, Input, Loading, Textarea, SEG_BAR, segClass } from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'

/* Help content, written once for every school: articles, "What's new" tips,
   canned replies, request topics and the SLA policy. Shipped text is the
   default; an edit here replaces it everywhere within a minute, Hide takes it
   out, and Back to the original removes the edit. Routes:
   /admin/platform/help-content (worker/src/routes/help/desk.ts). */

type Kind = 'article' | 'tip' | 'canned' | 'category' | 'sla'
interface Entry { item: Record<string, unknown> & { key: string }; source: 'default' | 'edited' | 'added'; hidden: boolean; updated_at?: string; updated_by?: string }

const KINDS: { key: Kind; label: string; fields: { name: string; label: string; long?: boolean; hint?: string; number?: boolean }[]; title: string }[] = [
  { key: 'article', label: 'Articles', title: 'title', fields: [
    { name: 'title', label: 'Title' }, { name: 'topic', label: 'Topic', hint: 'The key of a request topic, for example sign_in or fees.' },
    { name: 'body', label: 'Text', long: true, hint: 'One paragraph per line. A line starting "1." is a step.' },
    { name: 'route', label: 'Screen it is about', hint: 'For Open, for example /account. Optional.' }, { name: 'anchor', label: 'Control to point at', hint: 'For Show me: a data-help-anchor name. Optional.' },
    { name: 'keywords', label: 'Words people type', hint: 'Optional.' } ] },
  { key: 'tip', label: 'Tips', title: 'title', fields: [
    { name: 'title', label: 'Title' }, { name: 'body', label: 'Text', long: true }, { name: 'since', label: 'Release', hint: 'Year and month, for example 2026-10. Newer shows first.' },
    { name: 'title_te', label: 'Title in Telugu', hint: 'Optional. Leave empty rather than guess.' }, { name: 'body_te', label: 'Text in Telugu', long: true, hint: 'Optional.' } ] },
  { key: 'canned', label: 'Canned replies', title: 'title', fields: [
    { name: 'title', label: 'Title' }, { name: 'body', label: 'Reply', long: true, hint: '{{name}}, {{school}} and {{agent}} are filled in before sending.' } ] },
  { key: 'category', label: 'Request topics', title: 'label', fields: [
    { name: 'label', label: 'Label' }, { name: 'hint', label: 'What to write', long: true }, { name: 'sort', label: 'Order', number: true },
    { name: 'label_te', label: 'Label in Telugu', hint: 'Optional.' }, { name: 'hint_te', label: 'What to write, in Telugu', long: true, hint: 'Optional.' } ] },
  { key: 'sla', label: 'SLA', title: 'key', fields: [
    { name: 'respond_hours', label: 'School helpdesk: first reply within (hours)', number: true },
    { name: 'resolve_hours', label: 'School helpdesk: answer within (hours)', number: true } ] },
]

export function HelpContent() {
  const [kind, setKind] = useState<Kind>('article')
  const [editing, setEditing] = useState<Entry | 'new' | null>(null)
  const def = KINDS.find((k) => k.key === kind)!
  const q = useQuery({ queryKey: ['help-content', kind], queryFn: () => api.get<{ items: Entry[] }>(`/api/v1/admin/platform/help-content/${kind}`) })
  return (
    <div className="space-y-4">
      <div className={cn(SEG_BAR, 'w-full')} role="tablist" aria-label="Content">
        {KINDS.map((k) => <button key={k.key} type="button" role="tab" aria-selected={kind === k.key} className={segClass(kind === k.key)} onClick={() => setKind(k.key)}>{k.label}</button>)}
      </div>
      {kind !== 'sla' && <div className="flex justify-end"><Button variant="secondary" onClick={() => setEditing('new')}>Add</Button></div>}
      {q.error ? <ErrorState error={q.error} /> : !q.data ? <Loading /> : (
        <Card>
          <ul className="divide-y">
            {q.data.items.map((e) => (
              <li key={e.item.key}>
                <button type="button" onClick={() => setEditing(e)} className="flex min-h-[44px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left hover:bg-surface-hover">
                  <span className={cn('min-w-0 flex-1 truncate font-medium', e.hidden && 'text-muted-foreground line-through')}>{String(e.item[def.title] ?? e.item.key)}</span>
                  {e.source !== 'default' && <Badge tone={e.source === 'added' ? 'info' : 'primary'}>{e.source === 'added' ? 'Added' : 'Edited'}</Badge>}
                  {e.hidden && <Badge>Hidden</Badge>}
                  {e.updated_at && <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">{e.updated_by} · {formatDate(e.updated_at)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && <Editor kind={kind} entry={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Editor({ kind, entry, onClose }: { kind: Kind; entry: Entry | null; onClose: () => void }) {
  const qc = useQueryClient()
  const def = KINDS.find((k) => k.key === kind)!
  const [key, setKey] = useState(entry?.item.key ?? '')
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(def.fields.map((f) => [f.name, entry?.item[f.name] === undefined ? '' : String(entry.item[f.name])])))
  const [hidden, setHidden] = useState(entry?.hidden ?? false)
  const done = () => { qc.invalidateQueries({ queryKey: ['help-content'] }); onClose() }
  const save = useMutation({
    mutationFn: () => {
      const data: Record<string, unknown> = { ...(entry?.item ?? {}) }
      for (const f of def.fields) { const v = vals[f.name].trim(); if (v === '') delete data[f.name]; else data[f.name] = f.number ? Number(v) : v }
      if (!('roles' in data)) data.roles = []
      return api.put(`/api/v1/admin/platform/help-content/${kind}/${key.trim()}`, { data, hidden })
    },
    onSuccess: done,
  })
  const reset = useMutation({ mutationFn: () => api.del(`/api/v1/admin/platform/help-content/${kind}/${key}`), onSuccess: done })
  return (
    <Dialog onClose={onClose} title={entry ? `Edit ${String(entry.item[def.title] ?? entry.item.key)}` : 'Add'} size="lg"
      description="Every school sees the change within a minute."
      footer={<>
        {entry && entry.source !== 'default' && (
          <Button variant="ghost" pending={reset.isPending} onClick={() => reset.mutate()}>{entry.source === 'added' ? 'Delete' : 'Back to the original'}</Button>
        )}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button pending={save.isPending} disabled={!key.trim()} onClick={() => save.mutate()}>Save</Button>
      </>}>
      <div className="space-y-4">
        {!entry && <Field label="Key" hint="Lowercase letters, digits and underscores. Cannot be changed later." required><Input value={key} onChange={setKey} /></Field>}
        {def.fields.map((f) => (
          <Field key={f.name} label={f.label} hint={f.hint}>
            {f.long ? <Textarea value={vals[f.name]} onChange={(v) => setVals((s) => ({ ...s, [f.name]: v }))} rows={4} aria-label={f.label} />
              : <Input value={vals[f.name]} onChange={(v) => setVals((s) => ({ ...s, [f.name]: v }))} type={f.number ? 'number' : 'text'} />}
          </Field>
        ))}
        {kind !== 'sla' && <Checkbox checked={hidden} onChange={setHidden} label="Hidden from every school" />}
        <FormNotice error={save.error ?? reset.error} />
      </div>
    </Dialog>
  )
}
