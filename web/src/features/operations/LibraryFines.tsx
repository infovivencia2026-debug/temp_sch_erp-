import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan } from '@/lib/session'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Button,
  FormNotice, Field, Input, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise, formatDate } from '@/lib/utils'

/* WHAT THE LIBRARY IS OWED.

   Two totals — collected and still outstanding — and the list behind the
   second one, oldest first, so it can be worked through at the counter. A
   fine is fixed when the book comes back, at the school's own daily rate
   (set here); this screen records that it was paid, or waived. */

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
  waived_paise: number
  waived_count: number
  fine_per_day_paise: number
  outstanding: FineRow[]
  collected: FineRow[]
  waived: FineRow[]
}

type Tab = 'outstanding' | 'collected' | 'waived'

export default function LibraryFines() {
  const qc = useQueryClient()
  const can = useCan()
  const canWrite = can('operations.library.write')
  const [tab, setTab] = useState<Tab>('outstanding')
  const [rate, setRate] = useState<string | null>(null)
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
  const waive = useMutation({
    mutationFn: (loanId: string) =>
      api.post<{ waived_paise: number }>(`/api/v1/ops/library/loans/${loanId}/fine/waive`),
    onSuccess: (r) => {
      setNote({ ok: `${formatPaise(r.waived_paise)} waived.` })
      qc.invalidateQueries({ queryKey: ['library-fines'] })
    },
    onError: (error) => setNote({ error }),
  })
  const saveRate = useMutation({
    mutationFn: (paise: number) =>
      api.put<{ fine_per_day_paise: number }>('/api/v1/ops/library/fines/settings', { fine_per_day_paise: paise }),
    onSuccess: (r) => {
      setRate(null)
      setNote({ ok: r.fine_per_day_paise ? `Books returned late now cost ${formatPaise(r.fine_per_day_paise)} a day.` : 'Late returns are no longer fined.' })
      qc.invalidateQueries({ queryKey: ['library-fines'] })
    },
    onError: (error) => setNote({ error }),
  })

  const rows = q.data?.[tab] ?? []
  const TITLES: Record<Tab, string> = { outstanding: 'Still owed', collected: 'Collected', waived: 'Waived' }

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
            <CellGrid cols={4}>
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
                label="Waived"
                value={formatPaise(q.data!.waived_paise)}
                hint={`${q.data!.waived_count} fine${q.data!.waived_count === 1 ? '' : 's'}`}
                onClick={() => setTab('waived')}
                active={tab === 'waived'}
              />
              <Stat
                label="Overdue, not yet back"
                value={q.data!.overdue_open_loans}
                hint="Fined on return"
              />
            </CellGrid>

            <FormNotice error={note.error} ok={note.ok} />

            <Card>
              <CardHeader title="Fine rate" />
              <div className="flex flex-wrap items-end gap-3 p-4">
                <Field label="Rupees per day late" hint="Applied when a late book comes back. 0 means the library does not fine.">
                  <Input
                    type="number"
                    value={rate ?? String(q.data!.fine_per_day_paise / 100)}
                    onChange={setRate}
                  />
                </Field>
                {canWrite && rate !== null && (
                  <Button
                    size="sm"
                    disabled={saveRate.isPending || !(Number(rate) >= 0)}
                    onClick={() => saveRate.mutate(Math.round(Number(rate) * 100))}
                  >
                    Save rate
                  </Button>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title={TITLES[tab]} />
              {rows.length === 0 ? (
                <EmptyState
                  title={tab === 'outstanding' ? 'Nothing owed' : tab === 'collected' ? 'Nothing collected yet' : 'Nothing waived'}
                  body={tab === 'outstanding' ? 'Every recorded fine has been paid or waived.' : tab === 'collected' ? 'Fines appear here once they are marked paid.' : 'Fines appear here once they are waived.'}
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
                        {tab === 'outstanding' && canWrite && (
                          <Button size="sm" variant="ghost" className="ml-2" disabled={waive.isPending}
                            onClick={() => waive.mutate(r.loan_id)}>
                            Waive
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
