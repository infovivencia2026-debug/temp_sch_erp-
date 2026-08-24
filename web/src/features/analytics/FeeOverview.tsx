import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState, PrintButton,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import { CsvButton, pct, goodPct } from './shared'

/**
 * Fee overview — the principal's view of fees, not the accountant's.
 *
 * Four questions and no more: what did we ask for this year, what came in,
 * how old is what is still out, and what are we giving away. Receipt entry,
 * invoice generation and the student ledger stay in the finance module; this
 * screen exists so a principal does not have to open six operational screens
 * to answer a trustee.
 */

interface Totals {
  demanded_paise: number; collected_paise: number; outstanding_paise: number
  concession_paise: number; fine_paise: number
  students_billed: number; defaulters: number; collected_pct?: number
}
interface ClassRow {
  class_name: string; students: number
  demanded_paise: number; collected_paise: number
  outstanding_paise: number; concession_paise: number; collected_pct?: number
}
interface Overview { academic_year: string; totals: Totals; by_class: ClassRow[]; as_of_note: string }
interface AgeingRow { bucket: string; invoices: number; students: number; amount_paise: number }
interface ConcessionRow {
  kind: string; students: number; awards: number; pending_approval: number
  granted_amount_paise: number; percent_awards: number
}

const OVERVIEW = '/api/v1/rollups/fees/overview'
const AGEING = '/api/v1/rollups/fees/ageing'
const CONCESSIONS = '/api/v1/rollups/fees/concessions'

// Anything past due is a problem; the further past, the worse.
function ageTone(bucket: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (bucket.startsWith('Not yet')) return 'success'
  if (bucket.startsWith('No due')) return 'neutral'
  if (bucket.startsWith('Over 90') || bucket.startsWith('61')) return 'danger'
  return 'warning'
}

export default function FeeOverview() {
  const overview = useQuery({
    queryKey: ['rollup-fee-overview'],
    queryFn: () => api.get<Overview>(OVERVIEW),
  })
  const ageing = useQuery({
    queryKey: ['rollup-fee-ageing'],
    queryFn: () => api.get<List<AgeingRow>>(AGEING),
  })
  const concessions = useQuery({
    queryKey: ['rollup-fee-concessions'],
    queryFn: () => api.get<List<ConcessionRow>>(CONCESSIONS),
  })

  if (overview.isLoading) return <Loading />
  if (overview.error) return <ErrorState error={overview.error} />
  const d = overview.data
  if (!d) return null

  const t = d.totals

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Fee overview"
        description={`Collection, outstanding and concessions for ${d.academic_year}. Detailed accounting stays with Finance.`}
        actions={
          <div className="flex gap-2">
            <CsvButton href={OVERVIEW} label="Export by class" />
            <PrintButton />
          </div>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Demanded" value={formatPaise(t.demanded_paise)} period={d.academic_year} />
          {/* "Collected" alone is the word the executive dashboard uses for
              receipts banked in a period, and a month's receipts can exceed a
              year's applied collection — which is exactly how "this month
              ₹45,04,625" came to sit beside "the year ₹44,97,125" and read as
              nonsense. Both figures were right. Only one of them was named. */}
          <Stat
            label="Collected against this year's bills"
            value={formatPaise(t.collected_paise)}
            hint={`${pct(t.collected_pct)} of demanded`}
            period={d.academic_year}
          />
          <Stat
            label="Outstanding this year"
            value={formatPaise(t.outstanding_paise)}
            hint={`${t.defaulters} past due · this year's bills only`}
            period="As of now"
          />
          <Stat
            label="Concessions given"
            value={formatPaise(t.concession_paise)}
            hint="Discount applied to bills"
            period={d.academic_year}
          />
        </CellGrid>
        <p className="text-[13px] text-muted-foreground">{d.as_of_note}</p>

        <Card>
          <CardHeader
            title="By class"
            description="Demanded against collected, for the class the child sat in that year."
          />
          <Table
            head={[
              'Class', 'Students',
              { label: 'Demanded', align: 'right' },
              { label: 'Collected', align: 'right' },
              { label: 'Outstanding', align: 'right' },
              { label: 'Concession', align: 'right' },
              'Collected',
            ]}
            empty={!d.by_class.length}
          >
            {d.by_class.map((c) => (
              <tr key={c.class_name}>
                <Td className="font-medium">{c.class_name}</Td>
                <Td>{c.students}</Td>
                <Td className="text-right">{formatPaise(c.demanded_paise)}</Td>
                <Td className="text-right">{formatPaise(c.collected_paise)}</Td>
                <Td className="text-right">{formatPaise(c.outstanding_paise)}</Td>
                <Td className="text-right">{formatPaise(c.concession_paise)}</Td>
                <Td>
                  <Badge tone={goodPct(c.collected_pct)}>{pct(c.collected_pct)}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Ageing of what is outstanding"
              description="How long the money has been owed. Every unpaid invoice, including arrears carried in from earlier years — so this total is larger than the year's outstanding above."
              action={<CsvButton href={AGEING} />}
            />
            {ageing.isLoading ? (
              <Loading />
            ) : ageing.error ? (
              <ErrorState error={ageing.error} />
            ) : (
              <Table
                head={['Bucket', 'Invoices', 'Students', { label: 'Amount', align: 'right' }]}
                empty={!ageing.data?.items.length}
              >
                {(ageing.data?.items ?? []).map((a) => (
                  <tr key={a.bucket}>
                    <Td>
                      <Badge tone={ageTone(a.bucket)}>{a.bucket}</Badge>
                    </Td>
                    <Td>{a.invoices}</Td>
                    <Td>{a.students}</Td>
                    <Td className="text-right font-medium">{formatPaise(a.amount_paise)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Concession burden"
              description="By reason. Percentage awards are counted, not summed — they cannot be added to absolute ones."
              action={<CsvButton href={CONCESSIONS} />}
            />
            {concessions.isLoading ? (
              <Loading />
            ) : concessions.error ? (
              <ErrorState error={concessions.error} />
            ) : (
              <Table
                head={['Reason', 'Students', 'Awards', 'Pending', { label: 'Absolute', align: 'right' }, '% awards']}
                empty={!concessions.data?.items.length}
              >
                {(concessions.data?.items ?? []).map((c) => (
                  <tr key={c.kind}>
                    <Td className="font-medium">{c.kind}</Td>
                    <Td>{c.students}</Td>
                    <Td>{c.awards}</Td>
                    <Td>
                      {c.pending_approval > 0 ? (
                        <Badge tone="warning">{c.pending_approval}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td className="text-right">{formatPaise(c.granted_amount_paise)}</Td>
                    <Td>{c.percent_awards}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  )
}
