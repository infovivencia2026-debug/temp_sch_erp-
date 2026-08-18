import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Library, BookMarked, Hourglass } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormNotice, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Title {
  id: string
  title: string
  author?: string
  publisher?: string
  category?: string
  isbn?: string
  copies: number
  copies_on_shelf: number
  holds_waiting: number
  my_hold_status?: string
}
interface Hold {
  id: string
  title_id: string
  title: string
  author?: string
  status: string
  placed_at: string
  position: number
  ready_accession_no?: string
  collect_by?: string
  cancellable: boolean
}

const TONE: Record<string, 'info' | 'success' | 'neutral' | 'warning'> = {
  waiting: 'info',
  ready: 'success',
  collected: 'neutral',
  expired: 'warning',
  cancelled: 'neutral',
}

/* Reserving a book, from the reader's side of the same counter.

   This is not a second queue. The hold goes into the library's own
   reservations, the position is counted the way the librarian's screen counts
   it, and cancelling frees the copy and promotes whoever has waited longest —
   because it is the librarian's endpoint doing the work either way.

   "On the shelf" is the number that decides whether to queue at all, so it is
   next to the button rather than a click away. */
export default function LibraryHolds() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)
  const [q, setQ] = useState('')

  const catalogue = useQuery({
    queryKey: ['library-catalogue', studentId, q],
    queryFn: () =>
      api.get<List<Title>>(
        `/api/v1/portal/library/titles${studentQuery(studentId, q ? `q=${encodeURIComponent(q)}` : '')}`,
      ),
    enabled: ready,
  })

  const holds = useQuery({
    queryKey: ['library-holds', studentId],
    queryFn: () => api.get<List<Hold>>('/api/v1/portal/library/holds'),
    enabled: ready,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['library-holds'] })
    qc.invalidateQueries({ queryKey: ['library-catalogue'] })
  }

  const place = useMutation({
    mutationFn: (titleId: string) =>
      api.post('/api/v1/portal/library/holds', {
        student_id: studentId || undefined,
        title_id: titleId,
      }),
    onSuccess: refresh,
  })

  const cancel = useMutation({
    mutationFn: (holdId: string) =>
      api.post(`/api/v1/portal/library/holds/${holdId}/cancel`, {}),
    onSuccess: refresh,
  })

  if (catalogue.isLoading && ready) return <Loading label="Opening the catalogue…" />
  if (catalogue.error) return <ErrorState error={catalogue.error} />

  const titles = catalogue.data?.items ?? []
  const myHolds = holds.data?.items ?? []
  const waitingOn = myHolds.filter((h) => h.status === 'waiting').length
  const readyNow = myHolds.filter((h) => h.status === 'ready').length

  return (
    <>
      <PageHead
        eyebrow="Notices and calendar"
        title="Library holds"
        description="Reserve a book, and see where you are in the queue for it."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="A hold is placed in one reader's name." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Titles in the library" value={titles.length} icon={Library} />
              <Stat label="Waiting in a queue" value={waitingOn} icon={Hourglass} />
              <Stat
                label="Ready to collect"
                value={readyNow}
                icon={BookMarked}
                delta={readyNow > 0 ? { value: 'Go and get it', positive: true } : undefined}
              />
            </CellGrid>

            <Card>
              <CardHeader
                title="Your holds"
                description="Books held for you first, then the queues you are in."
              />
              <Table
                head={['Book', 'Status', { label: 'Position', align: 'right' }, 'Collect by', '']}
                empty={myHolds.length === 0}
                emptyLabel="You have not reserved anything."
              >
                {myHolds.map((h) => (
                  <tr key={h.id}>
                    <Td>
                      <span className="font-medium">{h.title}</span>
                      {h.author && (
                        <span className="block text-[12.5px] text-muted-foreground">{h.author}</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={TONE[h.status] ?? 'neutral'}>{h.status}</Badge>
                      {h.ready_accession_no && (
                        <span className="block font-mono text-[12px] text-muted-foreground">
                          {h.ready_accession_no}
                        </span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {h.status === 'waiting' ? h.position : '—'}
                    </Td>
                    <Td>{h.collect_by ? formatDate(h.collect_by) : '—'}</Td>
                    <Td className="text-right">
                      {h.cancellable && (
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          tone="danger"
                          question="Give up your place in the queue?"
                          confirmLabel="Cancel it"
                          onConfirm={() => cancel.mutate(h.id)}
                        >
                          Cancel
                        </ConfirmButton>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
              <div className="border-t px-5 py-3">
                <FormNotice error={cancel.error} />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="The catalogue"
                description="Reserve anything, whether or not a copy is in. A book on the shelf is held for you straight away."
                action={
                  <div className="w-64">
                    <Field label="Search">
                      <Input value={q} onChange={setQ} placeholder="Title, author or ISBN" />
                    </Field>
                  </div>
                }
              />
              <Table
                head={[
                  'Title', 'Author', 'Category',
                  { label: 'On the shelf', align: 'right' },
                  { label: 'Waiting', align: 'right' },
                  '',
                ]}
                empty={titles.length === 0}
                emptyLabel="Nothing in the catalogue matches that."
              >
                {titles.map((t) => (
                  <tr key={t.id}>
                    <Td>
                      <span className="font-medium">{t.title}</span>
                      {t.isbn && (
                        <span className="block font-mono text-[12px] text-muted-foreground">
                          {t.isbn}
                        </span>
                      )}
                    </Td>
                    <Td>{t.author ?? <span className="text-muted-foreground">—</span>}</Td>
                    <Td>{t.category ?? <span className="text-muted-foreground">—</span>}</Td>
                    <Td className="text-right tabular-nums">
                      {t.copies_on_shelf} / {t.copies}
                    </Td>
                    <Td className="text-right tabular-nums">{t.holds_waiting}</Td>
                    <Td className="text-right">
                      {t.my_hold_status ? (
                        <Badge tone={TONE[t.my_hold_status] ?? 'info'}>
                          {t.my_hold_status === 'ready' ? 'Held for you' : 'In the queue'}
                        </Badge>
                      ) : (
                        <Button size="sm" variant="secondary" disabled={place.isPending}
                          onClick={() => place.mutate(t.id)}>
                          {t.copies_on_shelf > 0 ? 'Reserve' : 'Join the queue'}
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
              <div className="border-t px-5 py-3">
                <FormNotice error={place.error} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
