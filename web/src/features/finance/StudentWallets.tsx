import { useState } from 'react'
import { rupeesToPaise } from '@/lib/money'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Wallet } from 'lucide-react'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Input, EmptyState, ErrorState, FormNotice,
} from '@/components/ui'
import { formatPaise, formatDate, cn } from '@/lib/utils'
import { useToast } from '@/components/Toast'
import { useDebouncedValue } from '@/lib/debounce'
import { useCan } from '@/lib/session'

/* Student wallets: the office side of digital money.

   A wallet is a prepaid balance the school holds for a child. The office does
   three things here: find the student, record money the family has ALREADY
   paid in as a top-up, and read the ledger. No money moves in this screen —
   a top-up is the office writing down a credit it has banked (cash at the
   desk, a UPI transfer matched on the statement), the same way the counter
   records a fee a parent already paid.

   The balance shown is derived by the server from the ledger and can never go
   below zero; a correction is a new signed row with a reason, never an edit.
   Spending the wallet against fees or at the canteen is a later phase. */

interface WalletTxn {
  id: string
  kind: 'top_up' | 'spend' | 'refund' | 'adjustment' | string
  delta_paise: number
  source_mode?: string | null
  reference_no?: string | null
  payment_id?: string | null
  note?: string | null
  recorded_by?: string | null
  created_at: string
}
interface StudentWallet {
  student_id: string
  admission_no: string
  full_name: string
  wallet_id?: string | null
  status: 'none' | 'active' | 'frozen' | 'closed' | string
  balance_paise: number
  transactions: WalletTxn[]
}

const SOURCES = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'neft', label: 'NEFT / IMPS' },
  { value: 'gateway', label: 'Online (gateway)' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'dd', label: 'Demand draft' },
]
// A bank credit with no reference cannot be matched to the statement, and an
// unmatched credit is exactly the kind that gets recorded twice.
const NEEDS_REF = new Set(['upi', 'neft', 'cheque', 'dd'])

const KIND_LABEL: Record<string, string> = {
  top_up: 'Top-up', spend: 'Spent', refund: 'Refund', adjustment: 'Adjustment',
}
const KIND_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  top_up: 'success', refund: 'success', spend: 'danger', adjustment: 'warning',
}
const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  active: 'success', frozen: 'warning', closed: 'neutral', none: 'neutral',
}

// Rupees in the box, paise on the wire — the API never sees a decimal.
const toPaise = (rupees: string) => rupeesToPaise(rupees)

export default function StudentWallets() {
  const toast = useToast()
  const can = useCan()
  const qc = useQueryClient()
  const mayManage = can('finance.wallet.manage')

  const [search, setSearch] = useState('')
  const [studentId, setStudentId] = useState<string | null>(null)

  const [amount, setAmount] = useState('')
  const [source, setSource] = useState('cash')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')

  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')

  const needle = useDebouncedValue(search.trim())
  const results = useQuery({
    queryKey: ['wallet-search', needle],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(needle)}&limit=15`),
    enabled: needle.length >= 2,
    placeholderData: keepPreviousData,
  })

  const wallet = useQuery({
    queryKey: ['wallet', studentId],
    queryFn: () => api.get<StudentWallet>(`/api/v1/fees/students/${studentId}/wallet`),
    enabled: !!studentId,
  })

  const pick = (id: string) => {
    setStudentId(id)
    setSearch('')
    setAmount(''); setReference(''); setNote('')
    setDelta(''); setReason('')
  }

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['wallet', studentId] })
    qc.invalidateQueries({ queryKey: ['finance-dashboard'] })
  }

  const topUp = useMutation({
    mutationFn: () =>
      api.post<{ transaction_id: string; balance_paise: number }>('/api/v1/fees/wallet/topups', {
        student_id: studentId,
        amount_paise: toPaise(amount),
        source_mode: source,
        reference_no: reference.trim() || undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: (res) => {
      // The new balance, read back across the counter — an unconfirmed credit
      // is the one that gets entered twice.
      toast.ok(`Topped up ${formatPaise(toPaise(amount))}. Balance is now ${formatPaise(res.balance_paise)}.`)
      setAmount(''); setReference(''); setNote('')
      refresh()
    },
  })

  const adjust = useMutation({
    mutationFn: () =>
      api.post<{ transaction_id: string; balance_paise: number }>('/api/v1/fees/wallet/adjustments', {
        student_id: studentId,
        delta_paise: toPaise(delta),
        note: reason.trim(),
      }),
    onSuccess: (res) => {
      toast.ok(`Balance adjusted. It is now ${formatPaise(res.balance_paise)}.`)
      setDelta(''); setReason('')
      refresh()
    },
  })

  const w = wallet.data
  const topUpReady = toPaise(amount) > 0 && (!NEEDS_REF.has(source) || reference.trim().length > 0)
  const adjustReady = toPaise(delta) !== 0 && reason.trim().length > 0

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Student wallets"
        description="Digital money: a prepaid balance the school holds for each child. Record a top-up the family has paid in, correct a balance with a reason, and read the ledger."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Find the student"
            description="Type at least two letters of the name or the admission number."
          />
          <div className="flex flex-col gap-3 p-5">
            <Input value={search} onChange={setSearch}
              placeholder="Search by name or admission no." srLabel="Search students" />
            {needle.length >= 2 && (
              <ul className="divide-y rounded-md border">
                {(results.data?.items ?? []).map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => pick(s.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-accent',
                        'min-h-[40px] [@media(pointer:coarse)]:min-h-[44px]',
                        s.id === studentId && 'bg-accent font-medium',
                      )}
                    >
                      <span className="min-w-0 truncate">{s.full_name}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {s.admission_no}{s.class_name ? ` · ${s.class_name}${s.section_name ? '-' + s.section_name : ''}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
                {results.data && results.data.items.length === 0 && (
                  <li className="px-3 py-2 text-[13px] text-muted-foreground">No student matches.</li>
                )}
              </ul>
            )}
          </div>
        </Card>

        {!studentId && (
          <EmptyState
            title="Pick a student to see their wallet"
            body="The balance, every top-up the family has paid in, and everything it has been spent on."
          />
        )}

        {studentId && wallet.error && <ErrorState error={wallet.error} />}

        {w && (
          <>
            <CellGrid cols={3}>
              <Stat label="Balance" value={formatPaise(w.balance_paise)} icon={Wallet}
                hint={`${w.full_name} · ${w.admission_no}`} />
              <Stat label="Wallet" value={<Badge tone={STATUS_TONE[w.status] ?? 'neutral'}>
                {w.status === 'none' ? 'Not opened yet' : w.status}
              </Badge>} hint={w.status === 'none' ? 'Opens on the first top-up' : undefined} />
              <Stat label="Entries" value={w.transactions.length} />
            </CellGrid>

            {mayManage && (
              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader
                    title="Record a top-up"
                    description="Money the family has already paid in. Nothing is charged from here."
                  />
                  <div className="flex flex-col gap-3 p-5">
                    <Input value={amount} onChange={setAmount} type="number"
                      placeholder="Amount in rupees" srLabel="Top-up amount in rupees" />
                    <Select value={source} onChange={setSource} options={SOURCES} />
                    <Input value={reference} onChange={setReference}
                      placeholder={NEEDS_REF.has(source) ? 'UTR / instrument number (required)' : 'Reference (optional)'}
                      srLabel="Bank or instrument reference" />
                    <Input value={note} onChange={setNote} placeholder="Note (optional)" srLabel="Note" />
                    <FormNotice error={topUp.error ?? undefined} />
                    <Button onClick={() => topUp.mutate()} pending={topUp.isPending}
                      disabled={!topUpReady || w.status === 'frozen' || w.status === 'closed'}>
                      Add {toPaise(amount) > 0 ? formatPaise(toPaise(amount)) : 'to wallet'}
                    </Button>
                  </div>
                </Card>

                <Card>
                  <CardHeader
                    title="Adjust the balance"
                    description="A correction, up or down, with the reason written down. It cannot take the balance below zero."
                  />
                  <div className="flex flex-col gap-3 p-5">
                    <Input value={delta} onChange={setDelta} type="number"
                      placeholder="Amount in rupees, use a minus sign to reduce"
                      srLabel="Adjustment amount in rupees, negative to reduce" />
                    <Input value={reason} onChange={setReason}
                      placeholder="Why the balance is being changed (required)" srLabel="Reason" />
                    <FormNotice error={adjust.error ?? undefined} />
                    <Button variant="secondary" onClick={() => adjust.mutate()}
                      pending={adjust.isPending} disabled={!adjustReady}>
                      Apply adjustment
                    </Button>
                  </div>
                </Card>
              </div>
            )}

            <Card>
              <CardHeader title="Ledger" description="Newest first. Every entry is permanent; corrections appear as new rows." />
              <Table
                head={['When', 'Type', { label: 'Amount', align: 'right' }, 'Mode / reference', 'Note', 'Recorded by']}
                empty={w.transactions.length === 0}
                emptyLabel="No entries yet. The first top-up opens the wallet."
              >
                {w.transactions.map((t) => (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap text-muted-foreground">{formatDate(t.created_at)}</Td>
                    <Td><Badge tone={KIND_TONE[t.kind] ?? 'neutral'}>{KIND_LABEL[t.kind] ?? t.kind}</Badge></Td>
                    <Td className={cn('text-right tabular-nums font-medium',
                      t.delta_paise < 0 ? 'text-destructive' : 'text-success')}>
                      {t.delta_paise < 0 ? '−' : '+'}{formatPaise(Math.abs(t.delta_paise))}
                    </Td>
                    <Td className="text-muted-foreground">
                      {[t.source_mode, t.reference_no].filter(Boolean).join(' · ') || '-'}
                    </Td>
                    <Td className="max-w-[28ch]">
                      <span className="block truncate" title={t.note ?? undefined}>{t.note || '-'}</span>
                    </Td>
                    <Td className="text-muted-foreground">{t.recorded_by || '-'}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
