import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan } from '@/lib/session'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Button,
  FormNotice, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise, formatDate } from '@/lib/utils'

/* WHAT THE LIBRARY IS OWED.

   Two totals — collected and still outstanding — and the list behind the
   second one, oldest first, so it can be worked through at the counter. A
   fine is fixed when the book comes back; this screen only records that it
   was paid. */

interface FineRow {
  loan_id: string
  borrower: string
  title: string
  accession_no: string
  due_on: string
  returned_on?: string
  fine_paise: number
}
interface Summary {
  collected_paise: number
  collected_count: number
  outstanding_paise: number
  outstanding_count: number
  overdue_open_loans: number
  outstanding: FineRow[]
  collected: FineRow[]
}

export default function LibraryFines() {
  const qc = useQueryClient()
  const can = useCan()
  const canWrite = can('operations.library.write')
  const [tab, setTab] = useState<'outstanding' | 'collected'>('outstanding')
  const [note, setNote] = useState<{ error?: unknown; ok?: string }>({})

  const q = useQuery({
    queryKey: ['library-fines'],
    queryFn: () => api.get<Summary>('/api/v1/ops/library/fines/summary'),
  })
  const collect = useMutation({
    mutationFn: (loanId: string) =>
      api.post<{ collected_paise: number }>(`/api/v1/ops/library/loans/${loanId}/fine/collect`),
    onSuccess: (r) => {
      setNote({ ok: `${formatPaise(r.collected_paise)} collected.` })
      qc.invalidateQueries({ queryKey: ['library-fines'] })
    },
    onError: (error) => setNote({ error }),
  })

  const rows = tab === 'outstanding' ? q.data?.outstanding ?? [] : q.data?.collected ?? []

  return (
    <>
      <PageHead eyebrow="Library" title="Fines" />
      <PageBody>
        {q.isLoading ? (
          <SkeletonTiles count={3} label="Adding up fines…" />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat
                label="Still owed"
                value={formatPaise(q.data!.outstanding_paise)}
                hint={`${q.data!.outstanding_count} fine${q.data!.outstanding_count === 1 ? '' : 's'}`}
                onClick={() => setTab('outstanding')}
                active={tab === 'outstanding'}
              />
              <Stat
                label="Collected"
                value={formatPaise(q.data!.collected_paise)}
                hint={`${q.data!.collected_count} fine${q.data!.collected_count === 1 ? '' : 's'}`}
                onClick={() => setTab('collected')}
                active={tab === 'collected'}
              />
              <Stat
                label="Overdue, not yet back"
                value={q.data!.overdue_open_loans}
                hint="Fined on return"
              />
            </CellGrid>

            <FormNotice error={note.error} ok={note.ok} />

            <Card>
              <CardHeader title={tab === 'outstanding' ? 'Still owed' : 'Collected'} />
              {rows.length === 0 ? (
                <EmptyState
                  title={tab === 'outstanding' ? 'Nothing owed' : 'Nothing collected yet'}
                  body={tab === 'outstanding' ? 'Every recorded fine has been paid.' : 'Fines appear here once they are marked paid.'}
                />
              ) : (
                <Table head={['Borrower', 'Book', 'Due', 'Returned', 'Fine', '']}>
                  {rows.map((r) => (
                    <tr key={r.loan_id}>
                      <Td className="font-medium">{r.borrower}</Td>
                      <Td>
                        {r.title}
                        <span className="ml-2 text-muted-foreground">{r.accession_no}</span>
                      </Td>
                      <Td>{formatDate(r.due_on)}</Td>
                      <Td>{formatDate(r.returned_on)}</Td>
                      <Td className="tabular-nums">{formatPaise(r.fine_paise)}</Td>
                      <Td className="text-right">
                        {tab === 'outstanding' && canWrite && (
                          <Button size="sm" variant="secondary" disabled={collect.isPending}
                            onClick={() => collect.mutate(r.loan_id)}>
                            Mark paid
                          </Button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
