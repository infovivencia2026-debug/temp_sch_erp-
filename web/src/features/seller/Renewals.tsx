import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, ErrorState, SEG_BAR, segClass } from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'
import { School360 } from './School360'

/* RENEWALS DUE (Subscriptions & Billing → Renewals).

   The schools whose plan renews in the next 30, 60 or 90 days, soonest first,
   with the churn-risk reasons the server read from real signals. The rule is
   printed above the table, because a flag nobody can explain is ignored. */

interface Renewal {
  institution_id: string
  name: string
  plan_code: string | null
  plan_name: string | null
  status: string
  renews_on: string
  renews_in_days: number
  value_paise: number | null
  balance_paise: number
  last_sign_in: string | null
  adoption_pct: number | null
  risk: string[]
}

export default function Renewals() {
  const [days, setDays] = useState<30 | 60 | 90>(30)
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['seller-renewals', days],
    queryFn: () => api.get<{ items: Renewal[]; rule: string }>(`/api/v1/seller/renewals?days=${days}`),
    placeholderData: (prev) => prev,
  })
  const rows = q.data?.items ?? []
  const atRisk = rows.filter((r) => r.risk.length).length

  return (
    <>
      <PageHead eyebrow="Subscriptions & billing" title="Renewals" description="Schools whose plan renews soon, and which of them may not." />
      <PageBody>
        <div role="tablist" aria-label="Window" className={SEG_BAR}>
          {([30, 60, 90] as const).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={days === d} className={segClass(days === d)} onClick={() => setDays(d)}>
              Next {d} days
            </button>
          ))}
        </div>
        {q.error ? <ErrorState error={q.error} /> : (
          <Card>
            <CardHeader
              title={`${rows.length} ${rows.length === 1 ? 'school renews' : 'schools renew'}${atRisk ? `, ${atRisk} at risk` : ''}`}
              description={q.data?.rule}
            />
            <Table
              loading={q.isPending && !q.data}
              head={['School', 'Renews', 'Plan', 'Worth', 'Owed', 'Risk', '']}
              empty={rows.length === 0}
              emptyLabel={`No school renews in the next ${days} days.`}
            >
              {rows.map((r) => (
                <tr key={r.institution_id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="num whitespace-nowrap">
                    {formatDate(r.renews_on)}
                    <span className="block text-[12px] text-muted-foreground">{r.renews_in_days === 0 ? 'today' : `in ${r.renews_in_days} days`}</span>
                  </Td>
                  <Td>{r.plan_name ?? r.plan_code ?? '-'}</Td>
                  <Td className="num">{r.value_paise ? formatPaise(r.value_paise) : '-'}</Td>
                  <Td className="num">{r.balance_paise ? formatPaise(r.balance_paise) : '-'}</Td>
                  <Td>
                    {r.risk.length ? (
                      <div className="flex flex-col items-start gap-1">
                        {r.risk.map((x) => <Badge key={x} tone="danger">{x}</Badge>)}
                      </div>
                    ) : <Badge tone="success">None</Badge>}
                  </Td>
                  <Td className="text-right">
                    <Button size="sm" variant="secondary" onClick={() => setOpen(r.institution_id)}>School 360</Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
      {open && <School360 id={open} onClose={() => setOpen(null)} />}
    </>
  )
}
