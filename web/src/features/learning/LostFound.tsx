import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, PackageSearch, PackageCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Item {
  id: string
  kind: 'lost' | 'found'
  title: string
  description?: string
  category?: string
  place?: string
  on_date: string
  reported_by: string
  reporter_class?: string
  status: string
  reported_by_me: boolean
  resolved_on?: string
  resolution_note?: string
}

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'lost', label: 'Lost' },
  { value: 'found', label: 'Found' },
]
const STATUS_FILTERS = [
  { value: '', label: 'All notices' },
  { value: 'open', label: 'Still open' },
  { value: 'claimed', label: 'Claimed, not collected' },
  { value: 'returned', label: 'Returned' },
]

/* The noticeboard by the staff room, which is where this lives today.

   Campus-wide rather than class-wide, because a bottle left in the hall is
   picked up by whoever walks past it. It carries no more about the person to
   go and see than a paper notice does: a name and a class, never a number. */
export default function LostFound() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('open')
  const [newKind, setNewKind] = useState('lost')
  const [title, setTitle] = useState('')
  const [place, setPlace] = useState('')
  const [category, setCategory] = useState('')
  const [onDate, setOnDate] = useState('')
  const [description, setDescription] = useState('')

  const board = useQuery({
    queryKey: ['lost-found', studentId, kind, status],
    queryFn: () =>
      api.get<List<Item>>(
        `/api/v1/portal/campus/lost-found${studentQuery(
          studentId,
          kind ? `kind=${kind}` : '',
          status ? `status=${status}` : '',
        )}`,
      ),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['lost-found'] })

  const report = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/campus/lost-found', {
        student_id: studentId || undefined,
        kind: newKind,
        title,
        place: place || undefined,
        category: category || undefined,
        on_date: onDate || undefined,
        description: description || undefined,
      }),
    onSuccess: () => {
      setTitle(''); setPlace(''); setCategory(''); setOnDate(''); setDescription('')
      refresh()
    },
  })

  const close = useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      api.post(`/api/v1/portal/campus/lost-found/${v.id}/resolve`, { status: v.status }),
    onSuccess: refresh,
  })

  if (board.isLoading && ready) return <Loading label="Reading the board…" />
  if (board.error) return <ErrorState error={board.error} />

  const rows = board.data?.items ?? []
  const open = rows.filter((r) => r.status === 'open')
  const found = open.filter((r) => r.kind === 'found')

  return (
    <>
      <PageHead
        eyebrow="Campus life"
        title="Lost and found"
        description="Everything reported missing or handed in around the campus."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="Notices are posted in a child's own name." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Open notices" value={open.length} icon={PackageSearch} />
              <Stat label="Waiting to be claimed" value={found.length} icon={Search}
                hint="Handed in and nobody has come" />
              <Stat label="Yours on the board" value={rows.filter((r) => r.reported_by_me).length}
                icon={PackageCheck} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Post a notice"
                description="Say what it is and where, so whoever has it can recognise it."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="Lost or found" required>
                    <Select
                      value={newKind}
                      onChange={setNewKind}
                      options={[
                        { value: 'lost', label: 'I have lost something' },
                        { value: 'found', label: 'I have found something' },
                      ]}
                    />
                  </Field>
                  <Field label="What is it" required>
                    <Input value={title} onChange={setTitle} placeholder="Blue steel water bottle" />
                  </Field>
                  <Field label="Where">
                    <Input value={place} onChange={setPlace} placeholder="Science block corridor" />
                  </Field>
                  <Field label="When" hint="Defaults to today.">
                    <Input value={onDate} onChange={setOnDate} type="date" />
                  </Field>
                  <Field label="Kind of thing">
                    <Input value={category} onChange={setCategory} placeholder="bottle, book, jumper" />
                  </Field>
                  <Field label="Anything that identifies it" wide
                    hint="Enough that the owner can prove it, not so much that anyone could.">
                    <Textarea value={description} onChange={setDescription} rows={2}
                      placeholder="Dented near the base, sticker of a red bus on the side." />
                  </Field>
                </FormGrid>
                <FormNotice error={report.error} ok={report.isSuccess ? 'Posted to the board.' : undefined} />
                <Button onClick={() => report.mutate()} disabled={!title.trim() || report.isPending}>
                  {report.isPending ? 'Posting…' : 'Post the notice'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="The board"
                description="Open notices first."
                action={
                  <div className="flex flex-wrap gap-3">
                    <div className="w-40">
                      <Field label="Kind">
                        <Select value={kind} onChange={setKind} options={FILTERS} />
                      </Field>
                    </div>
                    <div className="w-52">
                      <Field label="Status">
                        <Select value={status} onChange={setStatus} options={STATUS_FILTERS} />
                      </Field>
                    </div>
                  </div>
                }
              />
              {rows.length === 0 ? (
                <EmptyState
                  title="Nothing on the board"
                  body="Nothing has been reported lost or handed in under this filter."
                />
              ) : (
                <ul className="divide-y">
                  {rows.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">
                          {i.title}
                          <Badge tone={i.kind === 'found' ? 'success' : 'warning'}>{i.kind}</Badge>
                          {i.status !== 'open' && <Badge>{i.status}</Badge>}
                          {i.category && <Badge>{i.category}</Badge>}
                        </p>
                        {i.description && (
                          <p className="mt-1 text-[13px] text-muted-foreground">{i.description}</p>
                        )}
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {formatDate(i.on_date)}
                          {i.place ? ` · ${i.place}` : ''} · ask {i.reported_by_me ? 'yourself' : i.reported_by}
                          {i.reporter_class ? ` (${i.reporter_class})` : ''}
                        </p>
                        {i.resolution_note && (
                          <p className="mt-1 text-[12.5px] text-muted-foreground">
                            {i.resolution_note}
                          </p>
                        )}
                      </div>
                      {i.reported_by_me && (i.status === 'open' || i.status === 'claimed') && (
                        <div className="flex shrink-0 items-center gap-2">
                          {i.status === 'open' && (
                            <Button size="sm" variant="secondary" disabled={close.isPending}
                              onClick={() => close.mutate({ id: i.id, status: 'claimed' })}>
                              Someone has claimed it
                            </Button>
                          )}
                          <ConfirmButton
                            size="sm"
                            question="Take it off the board?"
                            confirmLabel="It is settled"
                            onConfirm={() => close.mutate({ id: i.id, status: 'returned' })}
                          >
                            Settled
                          </ConfirmButton>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={close.error} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
