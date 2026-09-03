import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { usePhone } from '@/lib/viewport'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDateTime } from '@/lib/utils'

/* WHETHER THE E-BOOKS ARE BEING OPENED.

   Opens made through this catalogue, month by month, and every holding with
   this month against last. A phone shows the list and drills into one title;
   a desktop shows the list and the title side by side. A vendor's own portal
   keeps its own numbers — nothing here guesses at them. */

interface Month { month: string; opens: number; readers: number }
interface Holding {
  id: string
  title: string
  kind: string
  access_model: string
  is_active: boolean
  opens_this_month: number
  opens_last_month: number
  readers_this_month: number
  opens_total: number
  last_opened_at?: string
}
interface Usage {
  months: Month[]
  holdings: Holding[]
  active_readers: number
  opens_this_month: number
  opens_last_month: number
}

const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })

function movement(now: number, before: number): { text: string; positive?: boolean } {
  if (before === 0 && now === 0) return { text: 'no opens' }
  if (before === 0) return { text: 'new this month', positive: true }
  const pct = Math.round(((now - before) / before) * 100)
  if (pct === 0) return { text: 'level' }
  return { text: `${pct > 0 ? '+' : ''}${pct}% on last month`, positive: pct > 0 }
}

function MonthBars({ months }: { months: Month[] }) {
  const max = Math.max(1, ...months.map((m) => m.opens))
  return (
    <div className="grid gap-2 p-5" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}>
      {months.map((m) => (
        <div key={m.month} className="flex flex-col items-center gap-1">
          <span className="text-[12px] tabular-nums text-muted-foreground">{m.opens}</span>
          <div className="flex h-24 w-full items-end">
            <div
              className="w-full rounded-t bg-primary/70"
              style={{ height: `${Math.max(2, (m.opens / max) * 100)}%` }}
              title={`${m.opens} opens, ${m.readers} readers`}
            />
          </div>
          <span className="text-[12px] text-muted-foreground">{monthLabel(m.month)}</span>
        </div>
      ))}
    </div>
  )
}

function HoldingDetail({ h, onBack }: { h: Holding; onBack?: () => void }) {
  const mv = movement(h.opens_this_month, h.opens_last_month)
  return (
    <Card>
      <CardHeader
        title={h.title}
        action={onBack && (
          <Button size="sm" variant="ghost" onClick={onBack} title="Back to the list">
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>
        )}
      />
      <div className="grid grid-cols-2 gap-4 p-5 text-[14px]">
        <div><div className="text-muted-foreground">Kind</div><div className="capitalize">{h.kind}</div></div>
        <div><div className="text-muted-foreground">Access</div><div>{h.access_model.replace(/_/g, ' ')}</div></div>
        <div><div className="text-muted-foreground">This month</div><div className="tabular-nums">{h.opens_this_month} opens · {h.readers_this_month} readers</div></div>
        <div><div className="text-muted-foreground">Last month</div><div className="tabular-nums">{h.opens_last_month} opens</div></div>
        <div><div className="text-muted-foreground">Movement</div><div className={mv.positive === false ? 'text-destructive' : ''}>{mv.text}</div></div>
        <div><div className="text-muted-foreground">Ever</div><div className="tabular-nums">{h.opens_total} opens</div></div>
        <div className="col-span-2"><div className="text-muted-foreground">Last opened</div><div>{h.last_opened_at ? formatDateTime(h.last_opened_at) : 'Never'}</div></div>
      </div>
    </Card>
  )
}

export default function DigitalUsage() {
  const phone = usePhone()
  const [openId, setOpenId] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['digital-usage'],
    queryFn: () => api.get<Usage>('/api/v1/ops/digital-library/usage?months=6'),
  })
  const open = q.data?.holdings.find((h) => h.id === openId)

  if (phone && open) {
    return (
      <>
        <PageHead eyebrow="Library" title="Digital usage" />
        <PageBody>
          <HoldingDetail h={open} onBack={() => setOpenId(null)} />
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHead eyebrow="Library" title="Digital usage" />
      <PageBody>
        {q.isLoading ? (
          <SkeletonTiles count={3} label="Counting opens…" />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Active readers" value={q.data!.active_readers} period="This month" />
              <Stat
                label="Opens"
                value={q.data!.opens_this_month}
                period="This month"
                delta={{ value: movement(q.data!.opens_this_month, q.data!.opens_last_month).text,
                  positive: movement(q.data!.opens_this_month, q.data!.opens_last_month).positive }}
              />
              <Stat label="Titles" value={q.data!.holdings.length} hint={`${q.data!.holdings.filter((h) => h.opens_total === 0).length} never opened`} />
            </CellGrid>

            <Card>
              <CardHeader title="Opens by month" />
              <MonthBars months={q.data!.months} />
            </Card>

            <div className={phone ? '' : 'grid gap-5 lg:grid-cols-[2fr_1fr]'}>
              <Card>
                <CardHeader title="By title" />
                {q.data!.holdings.length === 0 ? (
                  <EmptyState title="No digital holdings" body="Add e-books and journals in the digital library first." />
                ) : (
                  <Table head={['Title', 'This month', 'Last month', 'Readers', '']}>
                    {q.data!.holdings.map((h) => (
                      <tr key={h.id} className={h.id === openId ? 'bg-muted/40' : ''}>
                        <Td className="font-medium">
                          <button type="button" className="text-left hover:underline" onClick={() => setOpenId(h.id)}>
                            {h.title}
                          </button>
                          {!h.is_active && <span className="ml-2"><Badge>Withdrawn</Badge></span>}
                        </Td>
                        <Td className="tabular-nums">{h.opens_this_month}</Td>
                        <Td className="tabular-nums">{h.opens_last_month}</Td>
                        <Td className="tabular-nums">{h.readers_this_month}</Td>
                        <Td className="text-muted-foreground">{h.opens_total === 0 ? 'Never opened' : movement(h.opens_this_month, h.opens_last_month).text}</Td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
              {!phone && open && <HoldingDetail h={open} />}
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}
