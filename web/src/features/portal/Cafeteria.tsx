import { useQuery } from '@tanstack/react-query'
import { Utensils, Flame, Wallet } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Field,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

/* What the child bought at the canteen, and when.

   The timestamp is the whole feature. A daily total says the child spent
   ninety rupees; the timeline says it went on two fizzy drinks before half
   past eleven, and only the second is something a parent can act on.

   Allergens are shown on the line rather than summarised, because the parent
   who opens this screen most often is the one whose child must not eat
   peanuts, and a summary is exactly where that gets lost. */

interface Item {
  item_name: string
  category: string
  quantity: number
  unit_paise: number
  line_paise: number
  kcal?: number
  is_vegetarian?: boolean
  allergens?: string
}

interface Purchase {
  id: string
  student_id: string
  student_name: string
  purchased_at: string
  on_date: string
  at_time: string
  counter?: string
  total_paise: number
  mode: string
  kcal: number
  items: Item[]
}

interface Day {
  on_date: string
  total_paise: number
  kcal: number
  purchases: number
}

export default function Cafeteria() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const query = useQuery({
    queryKey: ['portal-cafeteria', studentId],
    queryFn: () =>
      api.get<{
        items: Purchase[]
        days: Day[]
        total_paise: number
        total_kcal: number
        from: string
        to: string
      }>(`/api/v1/portal/cafeteria/purchases${studentId ? `?student_id=${studentId}` : ''}`),
  })

  if (query.isLoading) return <Loading label="Looking up the canteen till…" />
  if (query.error) return <ErrorState error={query.error} />

  const purchases = query.data?.items ?? []
  const days = query.data?.days ?? []

  // Grouped by day so the timeline reads as days rather than as a ledger. The
  // day totals come from the server's own grouping of the same rows, so the
  // figure above a day can never disagree with the lines under it.
  const byDay = days.map((d) => ({
    ...d,
    rows: purchases.filter((p) => p.on_date === d.on_date),
  }))

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Canteen"
        description="Every item bought at the counter, with the time it was bought."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat
            label="Spent"
            value={formatPaise(query.data?.total_paise ?? 0)}
            icon={Wallet}
            period={query.data ? `${formatDate(query.data.from)} – ${formatDate(query.data.to)}` : undefined}
          />
          <Stat label="Purchases" value={purchases.length} icon={Utensils} />
          <Stat label="Calories" value={(query.data?.total_kcal ?? 0).toLocaleString('en-IN')} icon={Flame} />
        </CellGrid>

        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label="Child">
                <Select
                  value={chosen}
                  onChange={setChosen}
                  options={[{ value: '', label: 'All my children' }, ...childOptions(children)]}
                />
              </Field>
            </div>
          </Card>
        )}

        {byDay.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing bought"
              body="When your child buys something at the canteen counter it will appear here within minutes."
            />
          </Card>
        ) : (
          byDay.map((d) => (
            <Card key={d.on_date}>
              <CardHeader
                title={formatDate(d.on_date)}
                description={`${d.purchases} purchase${d.purchases === 1 ? '' : 's'} · ${d.kcal.toLocaleString('en-IN')} kcal`}
                action={<span className="text-[14px] font-semibold">{formatPaise(d.total_paise)}</span>}
              />
              <ul className="divide-y">
                {d.rows.map((p) => (
                  <li key={p.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <p className="text-[14px] font-medium">
                        {p.at_time}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {[p.counter, p.student_name].filter(Boolean).join(' · ')}
                        </span>
                      </p>
                      <span className="text-[14px]">{formatPaise(p.total_paise)}</span>
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {p.items.map((it, i) => (
                        <li key={`${p.id}-${i}`} className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                          <span className="text-muted-foreground">
                            {it.quantity > 1 ? `${it.quantity} × ` : ''}
                            {it.item_name}
                          </span>
                          <span className="text-muted-foreground/70">{formatPaise(it.line_paise)}</span>
                          {it.kcal != null && (
                            <span className="text-muted-foreground/70">
                              {it.kcal * it.quantity} kcal
                            </span>
                          )}
                          {it.is_vegetarian === false && <Badge tone="warning">Non-veg</Badge>}
                          {it.allergens && <Badge tone="danger">Contains {it.allergens}</Badge>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Card>
          ))
        )}
      </PageBody>
    </>
  )
}
