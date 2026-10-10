import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button, Dialog, FormNotice } from '@/components/ui'

/* FEATURES OFF IN BULK (owner, 2026-10-10: "let them choose to remove for a
   single person, whole school or class wise ... filter for feature, not to
   select children or parents one by one"). Pick the features first, then who:
   the children (or parents) ticked in the list, this whole class or section,
   or the whole school. Stored as feature_blocks; sign-in takes the keys away. */

type FeatureItem = { name: string; summary: string; keys: string[] }
type Block = { id: string; portal: 'student' | 'parent'; feature_key: string; scope: string; target_id: string; target_name: string }
type Who = 'selected' | 'here' | 'school'

export function BulkFeatures({
  portal, selected, here, onClose,
}: {
  portal: 'student' | 'parent'
  /** Student or guardian record ids ticked in the list. */
  selected: { id: string; name: string }[]
  /** The class or section the list is showing, if any. */
  here: { scope: 'class' | 'section'; id: string; name: string } | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const ns = portal + '.'
  const people = portal === 'student' ? 'children' : 'parents'
  const features = useQuery({ queryKey: ['feature-catalog'], queryFn: () => api.get<{ items: FeatureItem[] }>('/api/v1/admin/features') })
  const blocks = useQuery({ queryKey: ['feature-blocks'], queryFn: () => api.get<{ items: Block[] }>('/api/v1/admin/feature-blocks') })
  const [who, setWho] = useState<Who>(selected.length ? 'selected' : here ? 'here' : 'school')
  const [search, setSearch] = useState('')
  const [keys, setKeys] = useState<Set<string>>(new Set())

  /* Only this portal's features; the key turned off is this portal's variant. */
  const all = useMemo(() => (features.data?.items ?? [])
    .map((f) => ({ f, key: f.keys.find((k) => k.startsWith(ns)) }))
    .filter((x): x is { f: FeatureItem; key: string } => Boolean(x.key))
    .sort((a, b) => a.f.name.localeCompare(b.f.name)), [features.data, ns])
  const q = search.trim().toLowerCase()
  const shown = q ? all.filter((x) => x.f.name.toLowerCase().includes(q) || x.f.summary.toLowerCase().includes(q)) : all
  const nameOf = (k: string) => all.find((x) => x.f.keys.includes(k))?.f.name ?? k
  const allShownOn = shown.length > 0 && shown.every((x) => keys.has(x.key))
  const toggleAll = () => setKeys((prev) => {
    const n = new Set(prev)
    for (const x of shown) { if (allShownOn) n.delete(x.key); else n.add(x.key) }
    return n
  })
  const toggle = (k: string) => setKeys((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })

  const save = useMutation({
    mutationFn: () => api.post('/api/v1/admin/feature-blocks', who === 'selected'
      ? { portal, keys: [...keys], scope: 'person', record_ids: selected.map((s) => s.id) }
      : who === 'here' && here
        ? { portal, keys: [...keys], scope: here.scope, target_ids: [here.id] }
        : { portal, keys: [...keys], scope: 'school' }),
    onSuccess: () => { setKeys(new Set()); void qc.invalidateQueries({ queryKey: ['feature-blocks'] }) },
  })
  const remove = useMutation({
    mutationFn: (ids: string[]) => api.post('/api/v1/admin/feature-blocks/remove', { ids }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['feature-blocks'] }),
  })

  const off = (blocks.data?.items ?? []).filter((b) => b.portal === portal)
  const whoLabel = who === 'selected' ? `${selected.length} ticked ${people}` : who === 'here' && here ? `all of ${here.name}` : `every ${portal === 'student' ? 'child' : 'parent'} in the school`

  return (
    <Dialog open onClose={onClose} size="lg"
      title={`Turn features off for ${people}`}
      description="Choose the features, then who loses them. They lose them the next time they open the app; turn them back on below."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button tone="danger" disabled={!keys.size || save.isPending || (who === 'selected' && !selected.length)} onClick={() => save.mutate()}>
            {save.isPending ? 'Turning off…' : `Turn off ${keys.size || ''} for ${whoLabel}`}
          </Button>
        </div>
      }>
      <div className="space-y-4">
        {/* Who */}
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Who</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Who">
            {([
              ['selected', `Ticked ${people} (${selected.length})`, !selected.length],
              ['here', here ? `Whole ${here.name}` : 'This class', !here],
              ['school', 'Whole school', false],
            ] as const).map(([v, label, disabled]) => (
              <button key={v} type="button" role="radio" aria-checked={who === v} disabled={disabled} onClick={() => setWho(v)}
                className={cn('min-h-[38px] rounded-full border px-4 text-[13.5px] font-medium transition-colors disabled:opacity-40',
                  who === v ? 'border-[#007aff] bg-[#007aff]/10 text-[#007aff]' : 'hover:bg-muted/60')}>
                {label}
              </button>
            ))}
          </div>
          {who === 'selected' && selected.length > 0 && (
            <p className="mt-1.5 truncate text-[12px] text-muted-foreground">{selected.map((s) => s.name).join(', ')}</p>
          )}
        </div>

        {/* Which features */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <p className="text-[13px] font-medium">Features</p>
            <span className="text-[12px] text-muted-foreground">{keys.size} chosen</span>
            <button type="button" onClick={toggleAll} disabled={!shown.length} className="ml-auto text-[12.5px] font-medium text-[#007aff] disabled:opacity-40">
              {allShownOn ? 'Clear shown' : `Choose all ${shown.length}`}
            </button>
          </div>
          <label className="mb-2 flex min-h-[40px] items-center gap-2 rounded-xl border px-3">
            <Search className="size-4 text-muted-foreground" aria-hidden="true" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter features: fees, marks, bus…"
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
          </label>
          <ul className="max-h-[300px] divide-y overflow-y-auto rounded-xl border">
            {features.isLoading && <li className="px-3 py-3 text-[13px] text-muted-foreground">Loading features…</li>}
            {shown.map((x) => {
              const on = keys.has(x.key)
              return (
                <li key={x.key}>
                  <button type="button" onClick={() => toggle(x.key)} aria-pressed={on}
                    className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/40">
                    <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border', on ? 'border-[#dc2626] bg-[#dc2626] text-white' : 'bg-background')}>
                      {on && <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px]">{x.f.name}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">{x.f.summary}</span>
                    </span>
                  </button>
                </li>
              )
            })}
            {!features.isLoading && !shown.length && <li className="px-3 py-3 text-[13px] text-muted-foreground">No feature matches “{search}”.</li>}
          </ul>
        </div>

        <FormNotice error={features.error ?? save.error ?? remove.error} />

        {/* What is off now */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <p className="text-[13px] font-medium">Off now for {people}</p>
            <span className="text-[12px] text-muted-foreground">{off.length}</span>
            {off.length > 1 && (
              <button type="button" disabled={remove.isPending} onClick={() => remove.mutate(off.map((b) => b.id))}
                className="ml-auto text-[12.5px] font-medium text-[#007aff] disabled:opacity-40">Turn all back on</button>
            )}
          </div>
          {off.length === 0 ? (
            <p className="rounded-xl bg-muted/50 px-3 py-2.5 text-[13px] text-muted-foreground">Nothing is turned off.</p>
          ) : (
            <ul className="max-h-[220px] divide-y overflow-y-auto rounded-xl border">
              {off.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px]">{nameOf(b.feature_key)}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {b.scope === 'school' ? 'Whole school' : b.scope === 'person' ? b.target_name : `${b.scope === 'class' ? 'Class' : 'Section'} ${b.target_name}`}
                    </span>
                  </span>
                  <Button size="sm" variant="secondary" disabled={remove.isPending} onClick={() => remove.mutate([b.id])}>Turn on</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  )
}
