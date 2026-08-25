import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Loading, ErrorState, FormNotice, EmptyState, ExportButton,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { useCan } from '@/lib/session'
import { formatPaise, formatDate, cn } from '@/lib/utils'

/* The library, as the counter actually works it.
 *
 * Three questions get asked here and nothing else: do we have this book, who
 * has it, and what do they owe. The issue and return endpoints already
 * existed; there was no way to answer the first question, which is the one a
 * child standing at the desk with a slip is asking.
 *
 * Availability is computed from open loans rather than read off
 * library_copies.status — the status column drifts the moment anything writes
 * a loan without updating it, and the loan row is the record that decides.
 */

interface Title {
  id: string
  title: string
  author?: string
  isbn?: string
  category?: string
  copies: number
  available: number
}

interface Copy {
  id: string
  accession_no: string
  barcode?: string
  rack?: string
  on_loan_to?: string
  due_on?: string
}

interface Loan {
  id: string
  title: string
  borrower: string
  issued_on: string
  due_on: string
  returned_on?: string
  fine_paise: number
  overdue: boolean
}

type Tab = 'catalogue' | 'circulation' | 'overdue'

export default function Library() {
  const qc = useQueryClient()
  const can = useCan()
  const mayIssue = can('operations.library.write')

  const [tab, setTab] = useState<Tab>('catalogue')
  const [search, setSearch] = useState('')
  const [openTitle, setOpenTitle] = useState<Title | null>(null)
  const [note, setNote] = useState('')

  const titles = useQuery({
    queryKey: ['library-titles', search],
    queryFn: () =>
      api.get<List<Title>>(`/api/v1/ops/library/titles?q=${encodeURIComponent(search)}`),
    placeholderData: keepPreviousData,
  })

  const copies = useQuery({
    queryKey: ['library-copies', openTitle?.id],
    queryFn: () => api.get<List<Copy>>(`/api/v1/ops/library/titles/${openTitle!.id}/copies`),
    enabled: !!openTitle,
  })

  const loans = useQuery({
    queryKey: ['library-loans'],
    queryFn: () => api.get<List<Loan>>('/api/v1/ops/library/loans'),
  })

  const ret = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/ops/library/loans/${id}/return`, { fine_per_day_paise: 100 }),
    onSuccess: () => {
      setNote('Returned. Any overdue fine has been recorded against the loan.')
      qc.invalidateQueries({ queryKey: ['library-loans'] })
      qc.invalidateQueries({ queryKey: ['library-titles'] })
      qc.invalidateQueries({ queryKey: ['library-copies'] })
    },
  })

  const allLoans = loans.data?.items ?? []
  const open = allLoans.filter((l) => !l.returned_on)
  const overdue = open.filter((l) => l.overdue)
  const finesOwed = allLoans.reduce((n, l) => n + (l.fine_paise || 0), 0)
  const stock = titles.data?.items ?? []
  const onShelf = stock.reduce((n, t) => n + t.available, 0)

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'catalogue', label: 'Catalogue', count: stock.length },
    { key: 'circulation', label: 'On loan', count: open.length },
    { key: 'overdue', label: 'Overdue', count: overdue.length },
  ]

  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Library"
        description="What the school holds, who has it, and what is overdue."
      actions={<><ExportButton report="library-loans" /></>}
        />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Titles" value={stock.length} />
          <Stat label="On the shelf" value={onShelf} hint={`${stock.reduce((n, t) => n + t.copies, 0)} copies total`} />
          <Stat label="On loan" value={open.length} />
          <Stat
            label="Overdue"
            value={overdue.length}
            hint={finesOwed ? `${formatPaise(finesOwed)} in fines` : undefined}
          />
        </CellGrid>

        <div className="flex gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] transition-colors',
                tab === t.key
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {t.count != null && (
                <span className="tabular-nums text-muted-foreground">{t.count}</span>
              )}
            </button>
          ))}
        </div>

        <FormNotice error={ret.error} ok={note} />

        {tab === 'catalogue' && (
          <Card>
            <CardHeader
              title="Catalogue"
              description="Availability is counted from open loans, not from a status flag"
              action={
                <span className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <span className="[&_input]:pl-8">
                    <Input value={search} onChange={setSearch} placeholder="Title, author or ISBN" />
                  </span>
                </span>
              }
            />
            {titles.isLoading ? (
              <Loading />
            ) : titles.error ? (
              <ErrorState error={titles.error} />
            ) : (
              <Table
                head={['Title', 'Author', 'Category', 'Copies', 'On shelf', '']}
                empty={!stock.length}
                emptyLabel={search ? 'Nothing matches that.' : 'The catalogue is empty.'}
              >
                {stock.map((t) => (
                  <tr key={t.id}>
                    <Td className="font-medium">
                      {t.title}
                      {t.isbn && (
                        <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                          {t.isbn}
                        </span>
                      )}
                    </Td>
                    <Td className="text-muted-foreground">{t.author ?? '—'}</Td>
                    <Td className="text-muted-foreground">{t.category ?? '—'}</Td>
                    <Td className="tabular-nums">{t.copies}</Td>
                    <Td>
                      <span className={cn('tabular-nums', t.available === 0 && 'text-destructive')}>
                        {t.available}
                      </span>
                    </Td>
                    <Td>
                      <Button size="sm" variant="secondary" onClick={() => setOpenTitle(t)}>
                        Copies
                      </Button>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {tab === 'catalogue' && openTitle && (
          <Card>
            <CardHeader
              title={`Copies — ${openTitle.title}`}
              description="Each physical copy, its rack, and who holds it"
              action={<Button variant="ghost" onClick={() => setOpenTitle(null)}>Close</Button>}
            />
            {copies.isLoading ? (
              <Loading />
            ) : (
              <Table
                head={['Accession no.', 'Barcode', 'Rack', 'Status', 'Due']}
                empty={!copies.data?.items.length}
                emptyLabel="No copies recorded against this title."
              >
                {(copies.data?.items ?? []).map((c) => (
                  <tr key={c.id}>
                    <Td className="font-mono text-[12px]">{c.accession_no}</Td>
                    <Td className="font-mono text-[12px] text-muted-foreground">{c.barcode ?? '—'}</Td>
                    <Td className="text-muted-foreground">{c.rack ?? '—'}</Td>
                    <Td>
                      {c.on_loan_to
                        ? <span className="text-[13px]">Issued to {c.on_loan_to}</span>
                        : <StatusPill status="available" />}
                    </Td>
                    <Td className="text-muted-foreground">
                      {c.due_on ? formatDate(c.due_on) : '—'}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {(tab === 'circulation' || tab === 'overdue') && (
          <Card>
            <CardHeader
              title={tab === 'overdue' ? 'Overdue' : 'On loan'}
              description={
                tab === 'overdue'
                  ? 'Past the due date and not yet returned'
                  : 'Everything currently out'
              }
            />
            {loans.isLoading ? (
              <Loading />
            ) : loans.error ? (
              <ErrorState error={loans.error} />
            ) : (tab === 'overdue' ? overdue : open).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title={tab === 'overdue' ? 'Nothing overdue' : 'Nothing on loan'}
                  body={tab === 'overdue' ? 'Every book is back or still within its term.' : undefined}
                />
              </div>
            ) : (
              <Table head={['Title', 'Borrower', 'Issued', 'Due', 'Fine', '']}>
                {(tab === 'overdue' ? overdue : open).map((l) => (
                  <tr key={l.id}>
                    <Td className="font-medium">{l.title}</Td>
                    <Td>{l.borrower}</Td>
                    <Td className="text-muted-foreground">{formatDate(l.issued_on)}</Td>
                    <Td className={l.overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                      {formatDate(l.due_on)}
                      {l.overdue && ' · overdue'}
                    </Td>
                    <Td className="tabular-nums">
                      {l.fine_paise ? formatPaise(l.fine_paise) : '—'}
                    </Td>
                    <Td>
                      {mayIssue && (
                        <Button
                          size="sm"
                          disabled={ret.isPending}
                          onClick={() => ret.mutate(l.id)}
                        >
                          Return
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
