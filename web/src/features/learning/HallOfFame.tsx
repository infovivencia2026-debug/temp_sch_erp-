import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trophy } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Field, FormGrid,
  Input, Select, Textarea, FormNotice, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { usePhone } from '@/lib/viewport'
import { useCan } from '@/lib/session'

/* The board in the foyer, on the phone.

   Two kinds of name share it. Entries the school keeps here — the 1994
   shield, the alumna who topped the state — and any current child's state or
   national placing, read straight from the achievement the office already
   recorded. Whoever publishes announcements adds and takes down the school's
   own entries; a placing is taken down from the child's record, not from
   here, so the board can never disagree with it. */

interface Entry {
  id: string
  category: string
  title: string
  holder: string
  year?: number
  detail?: string
  source: 'board' | 'achievement'
}

const CATEGORIES = [
  { value: 'academic', label: 'Academic' },
  { value: 'sports', label: 'Sports' },
  { value: 'arts', label: 'Arts & culture' },
  { value: 'service', label: 'Service' },
  { value: 'other', label: 'Other' },
]

const label = (c: string) => CATEGORIES.find((x) => x.value === c)?.label ?? c

export default function HallOfFame() {
  const phone = usePhone()
  const can = useCan()
  const keeper = can('comms.announcements.write')
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ category: 'academic', title: '', holder: '', year: '', detail: '' })

  const q = useQuery({
    queryKey: ['hall-of-fame'],
    queryFn: () => api.get<List<Entry>>('/api/v1/portal/campus/hall-of-fame'),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['hall-of-fame'] })
  const add = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/campus/hall-of-fame', {
        category: form.category,
        title: form.title.trim(),
        holder: form.holder.trim(),
        ...(form.year.trim() ? { year: Number(form.year) } : {}),
        ...(form.detail.trim() ? { detail: form.detail.trim() } : {}),
      }),
    onSuccess: () => {
      setForm({ category: 'academic', title: '', holder: '', year: '', detail: '' })
      setAdding(false)
      refresh()
    },
  })
  const retire = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/portal/campus/hall-of-fame/${id}/retire`),
    onSuccess: refresh,
  })

  if (q.isLoading) return <SkeletonTiles count={3} label="Reading the board…" />
  if (q.error) return <ErrorState error={q.error} />
  const all = q.data?.items ?? []
  const items = filter ? all.filter((e) => e.category === filter) : all
  const present = CATEGORIES.filter((c) => all.some((e) => e.category === c.value))

  const addForm = adding && (
    <Card>
      <CardHeader title="Add to the board" />
      <div className="space-y-5 px-5 py-4">
        <FormGrid>
          <Field label="Category">
            <Select value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={CATEGORIES} />
          </Field>
          <Field label="Year">
            <Input value={form.year} onChange={(v) => setForm({ ...form, year: v })} type="number" placeholder="1994" />
          </Field>
          <Field label="What" required>
            <Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="District cricket shield" />
          </Field>
          <Field label="Who" required>
            <Input value={form.holder} onChange={(v) => setForm({ ...form, holder: v })} placeholder="Under-16 team, 1994" />
          </Field>
          <Field label="Detail" wide>
            <Textarea value={form.detail} onChange={(v) => setForm({ ...form, detail: v })} rows={2} />
          </Field>
        </FormGrid>
        <FormNotice error={add.error} />
        <div className="flex gap-2">
          <Button disabled={!form.title.trim() || !form.holder.trim() || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
          <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
        </div>
      </div>
    </Card>
  )

  const filterBar = present.length > 1 && (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={filter === '' ? 'ink' : 'secondary'} onClick={() => setFilter('')}>All</Button>
      {present.map((c) => (
        <Button key={c.value} size="sm" variant={filter === c.value ? 'ink' : 'secondary'} onClick={() => setFilter(c.value)}>
          {c.label}
        </Button>
      ))}
    </div>
  )

  return (
    <>
      <PageHead
        eyebrow="Campus life"
        title="Hall of fame"
        actions={keeper && !adding ? <Button onClick={() => setAdding(true)}>Add</Button> : undefined}
      />
      <PageBody width={phone ? 'form' : 'operational'}>
        {addForm}
        {filterBar}
        {items.length === 0 ? (
          <EmptyState
            title="Nothing on the board yet"
            body={keeper ? 'Add the trophies in the cabinet and the names on the wall.' : 'The school has not put anything up yet.'}
          />
        ) : phone ? (
          <Card>
            <ul className="divide-y">
              {items.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-5 py-3">
                  <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium">{e.title}</p>
                    <p className="text-[13px]">{e.holder}{e.year ? ` · ${e.year}` : ''}</p>
                    {e.detail && <p className="text-[12.5px] text-muted-foreground">{e.detail}</p>}
                    <p className="mt-1 text-[12px] text-muted-foreground">{label(e.category)}</p>
                  </div>
                  {keeper && e.source === 'board' && (
                    <Button size="sm" variant="ghost" onClick={() => retire.mutate(e.id)}>Take down</Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card>
            <CardHeader title="On the board" action={<Badge tone="primary">{items.length}</Badge>} />
            <Table head={['Year', 'What', 'Who', 'Category', 'Detail', ...(keeper ? [''] : [])]}>
              {items.map((e) => (
                <tr key={e.id}>
                  <Td>{e.year ?? '—'}</Td>
                  <Td className="font-medium">{e.title}</Td>
                  <Td>{e.holder}</Td>
                  <Td>{label(e.category)}</Td>
                  <Td className="text-muted-foreground">{e.detail ?? ''}</Td>
                  {keeper && (
                    <Td>
                      {e.source === 'board' ? (
                        <Button size="sm" variant="ghost" onClick={() => retire.mutate(e.id)}>Take down</Button>
                      ) : (
                        <span className="text-[12.5px] text-muted-foreground">From the record</span>
                      )}
                    </Td>
                  )}
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}
