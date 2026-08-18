import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Select, Input, Button } from '@/components/ui'
import { useCan } from '@/lib/session'

/* A dropdown a school is allowed to disagree with.
 *
 * The lists in setup were fixed in the binary, so a school affiliated to a
 * board nobody had thought of could not record the fact. Their workaround was
 * to pick the nearest wrong option, which is worse than leaving it blank: a
 * blank reads as "not filled in yet", a wrong board reads as a fact and is
 * carried into the state return.
 *
 * The add box is inline rather than a trip to a settings screen. Somebody
 * filling in their school's details has the right answer in their head at that
 * moment; making them leave the form to record it is how the nearest wrong
 * option gets picked instead.
 *
 * Adding is gated on settings.write. A clerk choosing from the list is an
 * ordinary act; changing what the whole school may record is not, and a
 * dropdown that quietly grows every time somebody mistypes is a list nobody
 * can group by afterwards.
 */

export interface OptionItem {
  value: string
  label: string
  custom?: boolean
}

export function OptionSelect({
  kind,
  value,
  onChange,
  placeholder,
  addLabel = 'Add your own',
}: {
  /** One of the kinds the server publishes at /api/v1/setup/option-kinds. */
  kind: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  addLabel?: string
}) {
  const qc = useQueryClient()
  const can = useCan()
  const mayAdd = can('institution.settings.write')

  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const list = useQuery({
    queryKey: ['options', kind],
    queryFn: () => api.get<List<OptionItem>>(`/api/v1/setup/options?kind=${encodeURIComponent(kind)}`),
    // These change perhaps twice a year. Refetching them on every form mount
    // is a request per dropdown per screen for an answer that has not moved.
    staleTime: 5 * 60_000,
  })

  const add = useMutation({
    mutationFn: (label: string) =>
      api.post<OptionItem>('/api/v1/setup/options', { kind, label }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['options', kind] })
      // Select what they just added. Making them find it in the list they have
      // this second watched themselves create is a small insult.
      onChange(created.value)
      setAdding(false)
      setDraft('')
    },
  })

  const items = list.data?.items ?? []

  if (adding) {
    return (
      <div className="flex flex-wrap items-start gap-2">
        <Input
          value={draft}
          onChange={setDraft}
          placeholder="Type it as it should appear"
          className="min-w-[200px] flex-1"
        />
        <Button
          size="sm"
          disabled={add.isPending || !draft.trim()}
          onClick={() => add.mutate(draft.trim())}
        >
          {add.isPending ? 'Adding…' : 'Add'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => { setAdding(false); setDraft('') }}>
          Cancel
        </Button>
        {add.error ? (
          <p className="w-full text-[12px] text-destructive">
            {(add.error as Error).message}
          </p>
        ) : (
          <p className="w-full text-[12px] text-muted-foreground">
            It joins the list for everyone at this school.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={value}
        onChange={(v) => {
          if (v === '__add__') { setAdding(true); return }
          onChange(v)
        }}
        placeholder={list.isLoading ? 'Loading…' : placeholder}
        options={[
          ...items.map((o) => ({ value: o.value, label: o.custom ? `${o.label} ·` : o.label })),
          ...(mayAdd ? [{ value: '__add__', label: `+ ${addLabel}…` }] : []),
        ]}
      />
    </div>
  )
}
