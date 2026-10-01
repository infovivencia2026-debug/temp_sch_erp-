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
import { useT, type MessageKey } from '@/lib/i18n'

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

const KIND_LABEL: Record<string, MessageKey> = {
  top_up: 'portal.wallet.kind_top_up', spend: 'portal.wallet.kind_spend',
  refund: 'portal.wallet.kind_refund', adjustment: 'portal.wallet.kind_adjustment',
}
const KIND_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  top_up: 'success', refund: 'success', spend: 'danger', adjustment: 'warning',
}

export default function PortalWallet() {
  const t = useT()
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
  if (children.isLoading) return <ScreenSkeleton label={t('portal.wallet.loading_children')} />
  if (children.error) return <ScreenError error={children.error} />
  if (kids.length === 0) {
    return (
      <EmptyState
        title={t('portal.wallet.unlinked_title')}
        body={t('portal.wallet.unlinked_body')}
      />
    )
  }

  const w = wallet.data
  const open = w && w.status !== 'none'

  return (
    <>
      <PageHead
        eyebrow={t('portal.wallet.eyebrow')}
        title={t('portal.wallet.title')}
        description={t('portal.wallet.description')}
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
        {wallet.isLoading && !w && <ScreenSkeleton rows={3} label={t('portal.wallet.loading_wallet')} />}

        {w && (
          <>
            <Freshness query={wallet} />
            <CellGrid cols={2}>
              <Stat label={t('portal.wallet.balance')} value={formatPaise(w.balance_paise)} icon={WalletIcon}
                hint={w.full_name} />
              <Stat
                label={t('portal.wallet.stat_wallet')}
                value={<Badge tone={open ? 'success' : 'neutral'}>{open ? w.status : t('portal.wallet.not_opened')}</Badge>}
                hint={open
                  ? t('portal.wallet.open_hint')
                  : t('portal.wallet.closed_hint')}
              />
            </CellGrid>

            <Card>
              <CardHeader title={t('portal.wallet.history')} description={t('portal.wallet.newest_first')} />
              <Table
                head={[t('portal.wallet.col_when'), t('portal.wallet.col_what'), { label: t('portal.wallet.col_amount'), align: 'right' }, t('portal.wallet.col_note')]}
                empty={w.transactions.length === 0}
                emptyLabel={t('portal.wallet.empty')}
              >
                {w.transactions.map((x) => (
                  <tr key={x.id}>
                    <Td className="whitespace-nowrap text-muted-foreground">{formatDate(x.created_at)}</Td>
                    <Td>
                      <Badge tone={KIND_TONE[x.kind] ?? 'neutral'}>{KIND_LABEL[x.kind] ? t(KIND_LABEL[x.kind]) : x.kind}</Badge>
                      {x.source_mode && x.kind === 'top_up' && (
                        <span className="ml-2 text-xs text-muted-foreground">{t('portal.wallet.via', { mode: x.source_mode.toUpperCase() })}</span>
                      )}
                    </Td>
                    <Td className={cn('text-right tabular-nums font-medium',
                      x.delta_paise < 0 ? 'text-destructive' : 'text-success')}>
                      {x.delta_paise < 0 ? '−' : '+'}{formatPaise(Math.abs(x.delta_paise))}
                    </Td>
                    <Td className="max-w-[32ch] text-muted-foreground">
                      <span className="block truncate" title={x.note ?? undefined}>
                        {x.note || (x.reference_no ? t('portal.wallet.ref', { ref: x.reference_no }) : '-')}
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
