import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Loading, ErrorState, Badge } from '@/components/ui'

/* What the returns still need, counted today. UDISE+, APAAR, the RTE
   register and the training return each ask for fields the office fills
   over the year; this is the list of what is missing and where it is
   filled, months before the month it is due. */

interface Item { key: string; label: string; missing: number; of: number; where: string; ok: boolean }
interface Group { key: string; title: string; items: Item[] }
interface Answer { groups: Group[]; missing_total: number; students: number; staff: number; training_rules: number }

export default function ReturnsReadiness() {
  const q = useQuery({ queryKey: ['readiness'], queryFn: () => api.get<Answer>('/api/v1/compliance/readiness') })
  if (q.isLoading) return <><PageHead eyebrow="Reports" title="Returns readiness" /><PageBody><Loading /></PageBody></>
  if (q.error) return <><PageHead eyebrow="Reports" title="Returns readiness" /><PageBody><ErrorState error={q.error} /></PageBody></>
  const d = q.data!
  const ready = d.groups.filter((g) => g.items.every((i) => i.ok)).length
  return (
    <>
      <PageHead eyebrow="Reports" title="Returns readiness" />
      <PageBody>
        <div className="space-y-4">
          <CellGrid cols={4}>
            <Stat label="Returns ready" value={`${ready} of ${d.groups.length}`} />
            <Stat label="Fields still missing" value={d.missing_total} hint="Across every return, counted today" />
            <Stat label="Children on the roll" value={d.students} />
            <Stat label="Staff on the roll" value={d.staff} />
          </CellGrid>
          {d.groups.map((g) => {
            const open = g.items.filter((i) => !i.ok)
            return (
              <Card key={g.key}>
                <CardHeader title={g.title} description={open.length ? `${open.length} ${open.length === 1 ? 'thing' : 'things'} still missing` : 'Nothing missing today'}
                  action={open.length ? <Badge tone="warning">Not ready</Badge> : <Badge tone="success">Ready</Badge>} />
                {g.items.length === 0 ? (
                  <p className="px-5 pb-5 text-[13.5px] text-muted-foreground">No training requirement is set for this year. Set one under Staff training & development and the gap shows here.</p>
                ) : (
                  <Table head={['What the return asks for', { label: 'Missing', align: 'right' }, { label: 'Of', align: 'right' }, 'Filled on']}>
                    {g.items.map((i) => (
                      <tr key={i.key} className={i.ok ? 'text-muted-foreground' : ''}>
                        <Td className={i.ok ? '' : 'font-medium'}>{i.label}</Td>
                        <Td className={`text-right tabular-nums ${i.ok ? '' : 'font-medium text-destructive'}`}>{i.missing}</Td>
                        <Td className="text-right tabular-nums">{i.of}</Td>
                        <Td>{i.where}</Td>
                      </tr>
                    ))}
                  </Table>
                )}
              </Card>
            )
          })}
        </div>
      </PageBody>
    </>
  )
}
