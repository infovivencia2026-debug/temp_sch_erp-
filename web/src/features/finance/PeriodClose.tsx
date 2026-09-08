import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Lock, LockOpen, CalendarCheck } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  ConfirmButton, FormNotice, SkeletonTable, ErrorState, Select,
} from '@/components/ui'

/* Saying a month is finished.

   Nothing in the product recorded that September was done: the register,
   the fee counter, the payslip and the mark sheet stayed editable until the
   accounting year was signed, and the academic year never was. This screen
   is where the principal says so. A closed month refuses every write dated
   inside it with a sentence naming the month; a closed year closes all of
   its months and refuses marks and invoices for the year as well.

   Reopening is here too, on purpose. A close that cannot be undone is a
   close nobody presses, and the audit trail keeps both halves: who closed,
   who reopened. */

interface PeriodMonth {
  key: string
  label: string
  closed: boolean
  via_year: boolean
  closed_at?: string
  closed_by?: string
  future: boolean
}

interface PeriodYear {
  id: string
  name: string
  starts_on: string
  ends_on: string
  is_current: boolean
  closed: boolean
  closed_at?: string
  closed_by?: string
}

interface PeriodCloses {
  year: PeriodYear
  years: PeriodYear[]
  months: PeriodMonth[]
}

const MONTH_LOCKS =
  'attendance for its dates, fee receipts and cheque bounces dated in it, and its payroll run'
const YEAR_LOCKS =
  'every month in it, marks and moderation for its exams, and fee demands raised against it'

export default function PeriodClose() {
  const qc = useQueryClient()
  const [yearID, setYearID] = useState('')
  const q = useQuery({
    queryKey: ['period-closes', yearID],
    queryFn: () =>
      api.get<PeriodCloses>(
        `/api/v1/admin/period-closes${yearID ? `?academic_year_id=${yearID}` : ''}`,
      ),
  })
  const act = useMutation({
    mutationFn: (v: { verb: 'close' | 'reopen'; kind: 'month' | 'year'; key: string }) =>
      api.post(`/api/v1/admin/period-closes/${v.verb}`, { kind: v.kind, period_key: v.key }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['period-closes'] }),
  })

  if (q.isLoading) return <SkeletonTable columns={4} label="Reading the months…" />
  if (q.error) return <ErrorState error={q.error} />

  const data = q.data
  const year = data?.year
  const months = data?.months ?? []
  const years = data?.years ?? []
  const closedMonths = months.filter((m) => m.closed).length
  const openPast = months.filter((m) => !m.closed && !m.future).length

  return (
    <>
      <PageHead
        eyebrow="Finance"
        title="Period close"
        description="Which months of the year are finished, and the year itself. A closed month refuses any record dated inside it until it is reopened here."
        width="wide"
        actions={
          years.length > 1 ? (
            <Select
              value={year?.id ?? ''}
              onChange={setYearID}
              options={years.map((y) => ({ value: y.id, label: y.name }))}
              placeholder="Year"
            />
          ) : undefined
        }
      />
      <PageBody width="wide">
        {!year?.id ? (
          <Card>
            <CardHeader title="No academic year yet"
              description="Months belong to a year. Create one in School setup and they will appear here." />
          </Card>
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Months closed" value={closedMonths} icon={Lock} period={year.name} />
              <Stat label="Past months still open" value={openPast} icon={LockOpen}
                hint="Any record dated in these can still be changed" />
              <Stat label="The year" value={year.closed ? 'Closed' : 'Open'} icon={CalendarCheck}
                delta={year.closed
                  ? { value: `Closed ${year.closed_at ?? ''}`.trim(), positive: true }
                  : undefined} />
            </CellGrid>

            <FormNotice error={act.error}
              ok={act.isSuccess
                ? act.variables?.verb === 'close'
                  ? 'Closed. Records dated inside it are now read-only.'
                  : 'Reopened. Records dated inside it can be changed again.'
                : undefined} />

            <Card>
              <CardHeader
                title={year.name}
                description={year.closed
                  ? `Closed${year.closed_by ? ` by ${year.closed_by}` : ''}${year.closed_at ? ` on ${year.closed_at}` : ''}. Reopening the year reopens the months the year close shut; a month closed by hand before that stays closed.`
                  : `Closing the year closes ${YEAR_LOCKS}.`}
                action={
                  year.closed ? (
                    <ConfirmButton
                      confirmLabel="Reopen the year"
                      question={`Reopen ${year.name}? Marks, invoices and every month it closed become editable again.`}
                      disabled={act.isPending}
                      onConfirm={() => act.mutate({ verb: 'reopen', kind: 'year', key: year.id })}>
                      Reopen year
                    </ConfirmButton>
                  ) : (
                    <ConfirmButton
                      confirmLabel="Close the year"
                      variant="primary"
                      question={`Close ${year.name}? This makes ${YEAR_LOCKS} read-only.`}
                      disabled={act.isPending}
                      onConfirm={() => act.mutate({ verb: 'close', kind: 'year', key: year.id })}>
                      Close year
                    </ConfirmButton>
                  )
                }
              />
              <Table head={['Month', 'State', 'Closed', '']}
                empty={months.length === 0} emptyLabel="The year has no months.">
                {months.map((m) => (
                  <tr key={m.key}>
                    <Td className="font-medium">{m.label}</Td>
                    <Td>
                      {m.closed ? (
                        <Badge tone="info">{m.via_year ? 'Closed with the year' : 'Closed'}</Badge>
                      ) : m.future ? (
                        <Badge tone="neutral">Not yet</Badge>
                      ) : (
                        <Badge tone="success">Open</Badge>
                      )}
                    </Td>
                    <Td className="text-muted-foreground">
                      {m.closed_at ?? '—'}
                      {m.closed_by && <div className="text-[12px]">{m.closed_by}</div>}
                    </Td>
                    <Td>
                      {m.closed && !m.via_year && (
                        <ConfirmButton
                          confirmLabel="Reopen"
                          question={`Reopen ${m.label}? ${MONTH_LOCKS[0].toUpperCase()}${MONTH_LOCKS.slice(1)} become editable again.`}
                          disabled={act.isPending || year.closed}
                          onConfirm={() => act.mutate({ verb: 'reopen', kind: 'month', key: m.key })}>
                          Reopen
                        </ConfirmButton>
                      )}
                      {!m.closed && !m.future && !year.closed && (
                        <ConfirmButton
                          confirmLabel={`Close ${m.label}`}
                          variant="primary"
                          question={`Close ${m.label}? This makes ${MONTH_LOCKS} read-only.`}
                          disabled={act.isPending}
                          onConfirm={() => act.mutate({ verb: 'close', kind: 'month', key: m.key })}>
                          Close
                        </ConfirmButton>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card>
              <CardHeader title="What a close does"
                description="Stated plainly, so the person pressing the button does not have to take it on trust." />
              <div className="space-y-3 p-5 text-[14px] leading-relaxed text-secondary-foreground">
                <p>
                  <span className="font-medium">A month.</span> The register cannot be marked or
                  corrected for its dates, no receipt can be dated inside it, no cheque received in
                  it can be bounced, and its payroll cannot be run or recomputed. Whoever tries is
                  told the month is closed and to ask the principal.
                </p>
                <p>
                  <span className="font-medium">A year.</span> All of the above for every month in
                  it, and no marks can be entered or moderated for its exams, and no fee demand
                  can be raised against it. Promotion and the next year's setup are not affected.
                </p>
                <p className="text-muted-foreground">
                  A payroll whose salary file has already gone to the bank cannot be recomputed
                  whether or not its month is closed.
                </p>
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
