import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Phone, Search } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Input, Button, SkeletonTable, ErrorState,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* The clinic's master file.
 *
 * Ordered so children with something recorded come first, and filterable down
 * to only those. A nurse opening this in an emergency is looking for the
 * allergy or the chronic condition; burying them under a hundred blank rows is
 * the difference between finding it and not.
 *
 * Read-only for now. The visit log and medication register are separate
 * records with no table behind them yet — this is the file they will hang off.
 */

interface HealthRow {
  student_id: string
  name: string
  admission_no: string
  class_name?: string
  blood_group?: string
  allergies?: string
  chronic_conditions?: string
  doctor_name?: string
  doctor_phone?: string
}

export default function Infirmary() {
  const [search, setSearch] = useState('')
  const [flagged, setFlagged] = useState(false)

  const q = useQuery({
    queryKey: ['health', search, flagged],
    queryFn: () =>
      api.get<List<HealthRow>>(
        `/api/v1/ops/health/students?q=${encodeURIComponent(search)}&flagged=${flagged}`,
      ),
    placeholderData: keepPreviousData,
  })

  const rows = q.data?.items ?? []
  const withAllergy = rows.filter((r) => r.allergies).length
  const withChronic = rows.filter((r) => r.chronic_conditions).length
  const noBlood = rows.filter((r) => !r.blood_group).length

  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Infirmary"
        description="Allergies, chronic conditions and emergency contacts, for the moment somebody needs them quickly."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Records" value={rows.length} />
          <Stat label="With allergies" value={withAllergy} />
          <Stat label="Chronic conditions" value={withChronic} />
          <Stat
            label="No blood group"
            value={noBlood}
            hint={noBlood ? 'Worth collecting' : 'Complete'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Health records"
            description="Children with something recorded appear first"
            action={
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={flagged ? 'primary' : 'secondary'}
                  onClick={() => setFlagged((v) => !v)}
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {flagged ? 'Showing flagged only' : 'Flagged only'}
                </Button>
                <span className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <span className="[&_input]:pl-8">
                    <Input value={search} onChange={setSearch} placeholder="Name or admission no." />
                  </span>
                </span>
              </span>
            }
          />
          {q.isLoading ? (
            <SkeletonTable columns={6} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              head={['Student', 'Class', 'Blood group', 'Allergies', 'Chronic conditions', 'Doctor']}
              empty={!rows.length}
              emptyLabel={flagged ? 'Nobody has an allergy or condition recorded.' : 'No records.'}
            >
              {rows.map((r) => {
                const flag = r.allergies || r.chronic_conditions
                return (
                  <tr key={r.student_id}>
                    <Td className="font-medium">
                      {r.name}
                      <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                        {r.admission_no}
                      </span>
                    </Td>
                    <Td className="text-muted-foreground">{r.class_name || '—'}</Td>
                    <Td className={cn('tabular-nums', !r.blood_group && 'text-muted-foreground')}>
                      {r.blood_group ?? 'not recorded'}
                    </Td>
                    <Td className={r.allergies ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                      {r.allergies ?? '—'}
                    </Td>
                    <Td className={r.chronic_conditions ? 'font-medium text-[hsl(var(--warning))]' : 'text-muted-foreground'}>
                      {r.chronic_conditions ?? '—'}
                    </Td>
                    <Td className="text-[13px]">
                      {r.doctor_name ?? '—'}
                      {r.doctor_phone && flag && (
                        <a
                          href={`tel:${r.doctor_phone}`}
                          className="mt-0.5 flex items-center gap-1 text-primary"
                        >
                          <Phone className="h-3 w-3" />
                          {r.doctor_phone}
                        </a>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
