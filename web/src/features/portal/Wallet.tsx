import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Wallet as WalletIcon } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Select, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate, formatPaise, cn } from '@/lib/utils'

/* The family's view of their child's digital money.

   Two numbers and one list: what is in the wallet, whether it is open, and
   every entry — each top-up the family paid in, and everything the school has
   drawn from it. Read-only on purpose: money goes IN at the school office,
   which records what the family has already paid (cash, UPI, transfer), so a
   parent never sees a "pay" button here that could be mistaken for one that
   moves money. The same endpoint the office reads, narrowed by the server to
   this family's own children. */

interface WalletTxn {
  id: string
  kind: string
  delta_paise: number
  source_mode?: string | null
  reference_no?: string | null
  note?: string | null
  created_at: string
}
interface StudentWallet {
  student_id: string
  full_name: string
  status: string
  balance_paise: number
  transactions: WalletTxn[]
}
interface Child {
  student_id: string
  full_name: string
  class_name?: string
  section_name?: string
}

const KIND_LABEL: Record<string, string> = {
  top_up: 'Money added', spend: 'Spent', refund: 'Refund', adjustment: 'Adjusted by school',
}
const KIND_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  top_up: 'success', refund: 'success', spend: 'danger', adjustment: 'warning',
}

export default function PortalWallet() {
  const children = useQuery({
    queryKey: ['portal-children'],
    queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
  })
  const kids = children.data?.items ?? []
  const [picked, setPicked] = useState('')
  const child = picked || kids[0]?.student_id || ''

  const wallet = useQuery({
    queryKey: ['portal-wallet', child],
    queryFn: () => api.get<StudentWallet>(`/api/v1/fees/students/${child}/wallet`),
    enabled: !!child,
  })

  // The children request is a state of this screen too: a parent linked to
  // nobody must see that, not a spinner that never resolves.
  if (children.isLoading) return <ScreenSkeleton label="Loading your children" />
  if (children.error) return <ScreenError error={children.error} />
  if (kids.length === 0) {
    return (
      <EmptyState
        title="No child is linked to this account"
        body="Ask the school office to link your child, and their wallet will appear here."
      />
    )
  }

  const w = wallet.data
  const open = w && w.status !== 'none'

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Wallet"
        description="Your child's digital money: the prepaid balance the school holds, every top-up you have paid in and everything it has been spent on."
        actions={kids.length > 1 ? (
          <Select
            value={child}
            onChange={setPicked}
            options={kids.map((k) => ({
              value: k.student_id,
              label: `${k.full_name}${k.class_name ? ` · ${k.class_name}${k.section_name ? '-' + k.section_name : ''}` : ''}`,
            }))}
          />
        ) : undefined}
      />
      <PageBody>
        {wallet.error && <ScreenError error={wallet.error} />}
        {wallet.isLoading && !w && <ScreenSkeleton rows={3} label="Loading the wallet" />}

        {w && (
          <>
            <Freshness query={wallet} />
            <CellGrid cols={2}>
              <Stat label="Balance" value={formatPaise(w.balance_paise)} icon={WalletIcon}
                hint={w.full_name} />
              <Stat
                label="Wallet"
                value={<Badge tone={open ? 'success' : 'neutral'}>{open ? w.status : 'Not opened yet'}</Badge>}
                hint={open
                  ? 'Money is added at the school office once you have paid it in.'
                  : 'It opens the first time the office records a top-up.'}
              />
            </CellGrid>

            <Card>
              <CardHeader title="History" description="Newest first." />
              <Table
                head={['When', 'What', { label: 'Amount', align: 'right' }, 'Note']}
                empty={w.transactions.length === 0}
                emptyLabel="Nothing yet. Once the office records a top-up, it appears here."
              >
                {w.transactions.map((t) => (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap text-muted-foreground">{formatDate(t.created_at)}</Td>
                    <Td>
                      <Badge tone={KIND_TONE[t.kind] ?? 'neutral'}>{KIND_LABEL[t.kind] ?? t.kind}</Badge>
                      {t.source_mode && t.kind === 'top_up' && (
                        <span className="ml-2 text-xs text-muted-foreground">via {t.source_mode.toUpperCase()}</span>
                      )}
                    </Td>
                    <Td className={cn('text-right tabular-nums font-medium',
                      t.delta_paise < 0 ? 'text-destructive' : 'text-success')}>
                      {t.delta_paise < 0 ? '−' : '+'}{formatPaise(Math.abs(t.delta_paise))}
                    </Td>
                    <Td className="max-w-[32ch] text-muted-foreground">
                      <span className="block truncate" title={t.note ?? undefined}>
                        {t.note || (t.reference_no ? `Ref ${t.reference_no}` : '—')}
                      </span>
                    </Td>
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
