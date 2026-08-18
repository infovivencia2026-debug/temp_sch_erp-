import { useState } from 'react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Badge, Input, Select, Checkbox, Field, FormGrid, FormNotice,
  Skeleton, ErrorState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'
import {
  feeEngineBase, gstPercent, toBasisPoints, useFeeEngineMutation, useReceiptSeries,
  type FeeHeadOption, type ReceiptSeries as Series,
} from './fee-engine-lib'

/* GST compliant receipt numbering.

   Three properties, and the schema enforces all three rather than trusting the
   application:

     gapless   — the counter advances under a row lock inside the same
                 transaction that writes the payment, so a failed collection
                 rolls the number back with it. A Postgres sequence would be the
                 obvious tool and is the wrong one: nextval is deliberately
                 non-transactional, so a failure would leave a hole, and an
                 auditor reads a missing receipt number as a suppressed sale.
     per year  — each financial year restarts at 1. reset_yearly had existed
                 since the first migration with nothing reading it, so the year
                 was printed into the number while the count ran on.
     never
     reused    — a unique index over (institution, year, sequence).

   Existing receipts keep the numbers they were issued. The counter adopted the
   year in progress rather than restarting it, so the first genuine reset falls
   on the next 1 April. */

export default function ReceiptSeries() {
  const toast = useToast()
  const can = useCan()
  const mayConfigure = can('finance.fees.write')

  const series = useReceiptSeries()
  const [editing, setEditing] = useState('')

  const items = series.data?.items ?? []
  const years = series.data?.years ?? []
  const heads = series.data?.heads ?? []
  const receipts = items.find((s) => s.kind === 'receipt')
  const totalGaps = years.reduce((n, y) => n + Math.max(y.gaps, 0), 0)
  const issuedThisYear =
    years.find((y) => y.fy === series.data?.current_fy)?.issued ?? 0

  return (
    <>
      <PageHead
        eyebrow="Collections"
        title="Receipt numbering"
        description="A gapless series per financial year, and the GST treatment of each fee head."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Financial year"
            value={series.data?.current_fy ?? '—'}
            hint="April to March"
          />
          <Stat label="Receipts issued this year" value={issuedThisYear} />
          <Stat
            label="Next receipt"
            value={receipts?.next_preview ?? '—'}
            hint={receipts?.reset_yearly ? 'Restarts each 1 April' : 'Runs continuously'}
          />
          <Stat
            label="Gaps in the series"
            value={totalGaps}
            hint={totalGaps ? 'An auditor will ask about these' : 'None — the series is intact'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Series"
            description="The shape of each number. The position of the counter is deliberately not editable here."
          />
          {series.isLoading ? (
            <Skeleton />
          ) : series.error ? (
            <ErrorState error={series.error} />
          ) : (
            <Table
              head={['Series', 'Format', 'Next number', 'Counter', 'Year', 'Last issued', '']}
              empty={!items.length}
              emptyLabel="No numbering series configured. One is created the first time a receipt is issued."
            >
              {items.map((s) => (
                <tr key={s.kind}>
                  <Td className="font-medium capitalize">{s.kind}</Td>
                  <Td className="font-mono text-[11.5px] text-muted-foreground">{s.format}</Td>
                  <Td className="font-mono font-medium">{s.next_preview}</Td>
                  <Td className="tabular-nums text-muted-foreground">{s.next_value}</Td>
                  <Td>
                    {s.reset_yearly ? (
                      <Badge tone="success">{s.current_fy ?? 'resets yearly'}</Badge>
                    ) : (
                      <Badge tone="neutral">continuous</Badge>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {s.last_number ? (
                      <>
                        <span className="font-mono">{s.last_number}</span>
                        {s.last_issued_at && (
                          <span className="block text-[11.5px]">{formatDate(s.last_issued_at)}</span>
                        )}
                      </>
                    ) : (
                      'Never used'
                    )}
                  </Td>
                  <Td>
                    {mayConfigure && (
                      <Button
                        size="sm"
                        variant={editing === s.kind ? 'primary' : 'secondary'}
                        onClick={() => setEditing(editing === s.kind ? '' : s.kind)}
                      >
                        {editing === s.kind ? 'Close' : 'Configure'}
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {editing && mayConfigure && (
          <SeriesForm
            /* Keyed by the series it is editing.

               Without this, opening Configure on a second series while the
               first was still open reused the mounted form: its state was
               initialised from the first series and useState does not run
               again, so the boxes held one series' prefix and format while the
               PUT addressed the other's kind. The receipt series was saved
               with the invoice series' shape. */
            key={editing}
            series={items.find((s) => s.kind === editing)!}
            currentFY={series.data?.current_fy ?? ''}
            onDone={(m) => {
              toast.ok(m)
              setEditing('')
            }}
          />
        )}

        <Card>
          <CardHeader
            title="The series, year by year"
            description="What GST asks about: a continuous run of numbers with nothing missing"
          />
          {series.isLoading ? (
            <Skeleton />
          ) : (
            <Table
              head={['Financial year', 'Receipts issued', 'First', 'Last', 'Gaps', 'State']}
              empty={!years.length}
              emptyLabel="No numbered receipts yet."
            >
              {years.map((y) => (
                <tr key={y.fy}>
                  <Td className="font-medium">{y.fy}</Td>
                  <Td className="tabular-nums">{y.issued}</Td>
                  <Td className="tabular-nums text-muted-foreground">{y.first_seq}</Td>
                  <Td className="tabular-nums text-muted-foreground">{y.last_seq}</Td>
                  <Td className="tabular-nums">{y.gaps > 0 ? y.gaps : '—'}</Td>
                  <Td>
                    {y.gaps > 0 ? (
                      <Badge tone="danger">has holes</Badge>
                    ) : (
                      <Badge tone="success">gapless</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <p className="px-4 pb-3 pt-1 text-[11.5px] text-muted-foreground">
            Receipts issued before numbering was tracked keep their numbers and are not counted
            here — they have a printed number but no recorded sequence, so including them would
            report holes that do not exist.
          </p>
        </Card>

        <GSTHeads heads={heads} mayConfigure={mayConfigure} onNotify={toast.ok} />
      </PageBody>
    </>
  )
}

function SeriesForm({
  series, currentFY, onDone,
}: {
  series: Series
  currentFY: string
  onDone: (message: string) => void
}) {
  const [prefix, setPrefix] = useState(series.prefix)
  const [suffix, setSuffix] = useState(series.suffix)
  const [padding, setPadding] = useState(String(series.padding))
  const [format, setFormat] = useState(series.format)
  const [resetYearly, setResetYearly] = useState(series.reset_yearly)

  const save = useFeeEngineMutation(
    () =>
      api.put(`${feeEngineBase}/receipt-series/${series.kind}`, {
        prefix,
        suffix: suffix || undefined,
        padding: Number(padding || 5),
        format,
        reset_yearly: resetYearly,
      }),
    () => onDone(`The ${series.kind} series was updated.`),
  )

  // Rendered client-side from the same placeholders the server uses, so the
  // school sees the shape before committing to a year of printed documents.
  const preview = format
    .replace('{prefix}', prefix)
    .replace('{fy}', resetYearly ? currentFY : '')
    .replace('{seq}', String(series.next_value).padStart(Number(padding || 5), '0'))
    .replace('{suffix}', suffix)
    .replace('//', '/')

  return (
    <Card>
      <CardHeader
        title={`Configure the ${series.kind} series`}
        description="Placeholders: {prefix} {fy} {seq} {suffix}. The format must contain {seq}."
      />
      <div className="space-y-4 p-5">
        <FormGrid>
          <Field label="Prefix">
            <Input value={prefix} onChange={setPrefix} placeholder="RCPT/" />
          </Field>
          <Field label="Suffix">
            <Input value={suffix} onChange={setSuffix} placeholder="None" />
          </Field>
          <Field label="Digits" hint="Zero-padded width of the sequence">
            <Select
              value={padding}
              onChange={setPadding}
              options={[3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))}
            />
          </Field>
          <Field label="Format" required hint="How the parts are laid out">
            <Input value={format} onChange={setFormat} />
          </Field>
        </FormGrid>

        <Checkbox
          checked={resetYearly}
          onChange={setResetYearly}
          label="Restart the count each financial year"
          hint="GST expects each year's series to begin at 1. Turning this off runs one continuous series instead."
        />

        <div className="rounded-md border border-border px-4 py-3">
          <p className="text-[11.5px] text-muted-foreground">The next number will read</p>
          <p className="font-mono text-lg font-medium">{preview}</p>
        </div>

        <p className="text-[11.5px] text-muted-foreground">
          The counter's position is not editable. Moving it back would reissue numbers already
          printed and handed over; moving it forward would leave a hole an auditor reads as a
          suppressed receipt.
        </p>

        <FormNotice error={save.error} />
        <Button
          onClick={() => save.mutate(undefined as never)}
          disabled={!format.includes('{seq}') || save.isPending}
        >
          Save the series
        </Button>
      </div>
    </Card>
  )
}

/* GST is not uniform across a school's income.

   Tuition at a recognised school is exempt; transport, uniforms and the canteen
   usually are not. The rate is basis points — 1800 is 18.00% — because a rate
   held as a float is a rounding argument with a tax officer. */
function GSTHeads({
  heads, mayConfigure, onNotify,
}: {
  heads: FeeHeadOption[]
  mayConfigure: boolean
  onNotify: (m: string) => void
}) {
  const [open, setOpen] = useState('')
  const taxable = heads.filter((h) => h.is_taxable)
  const missingHSN = taxable.filter((h) => !h.hsn_sac)

  return (
    <Card>
      <CardHeader
        title="GST treatment per fee head"
        description="Which heads are taxable, at what rate, and under which HSN/SAC code"
      />
      {missingHSN.length > 0 && (
        <p className="px-4 pb-2 text-[12.5px] text-warning">
          {missingHSN.length} taxable head{missingHSN.length === 1 ? '' : 's'} without an HSN/SAC
          code. An invoice carrying one cannot be filed.
        </p>
      )}
      <Table
        head={['Fee head', 'Code', 'Treatment', 'Rate', 'HSN/SAC', '']}
        empty={!heads.length}
        emptyLabel="No fee heads configured."
      >
        {heads.map((h) => (
          <tr key={h.id}>
            <Td className="font-medium">{h.name}</Td>
            <Td className="font-mono text-[11.5px] text-muted-foreground">{h.code}</Td>
            <Td>
              <Badge tone={h.is_taxable ? 'warning' : 'neutral'}>
                {h.is_taxable ? 'taxable' : 'exempt'}
              </Badge>
            </Td>
            <Td className="tabular-nums text-muted-foreground">
              {h.is_taxable ? gstPercent(h.gst_rate_bp) : '—'}
            </Td>
            <Td className="font-mono text-[11.5px] text-muted-foreground">{h.hsn_sac || '—'}</Td>
            <Td>
              {mayConfigure && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setOpen(open === h.id ? '' : h.id)}
                >
                  {open === h.id ? 'Close' : 'Edit'}
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {open && mayConfigure && (
        <GSTHeadForm
          /* Keyed by the head, for the same reason and with a worse
             consequence: editing one head and then another wrote the first
             head's rate and HSN code onto the second. That is a tax attribute
             on a fee an invoice will carry. */
          key={open}
          head={heads.find((h) => h.id === open)!}
          onDone={(m) => {
            onNotify(m)
            setOpen('')
          }}
        />
      )}
    </Card>
  )
}

function GSTHeadForm({ head, onDone }: { head: FeeHeadOption; onDone: (m: string) => void }) {
  const [taxable, setTaxable] = useState(head.is_taxable)
  const [rate, setRate] = useState(String(head.gst_rate_bp / 100))
  const [hsn, setHSN] = useState(head.hsn_sac)

  const save = useFeeEngineMutation(
    () =>
      api.put(`${feeEngineBase}/gst-heads/${head.id}`, {
        is_taxable: taxable,
        gst_rate_bp: taxable ? toBasisPoints(rate) : 0,
        hsn_sac: hsn || undefined,
      }),
    () => onDone(`GST treatment saved for ${head.name}.`),
  )

  return (
    <div className="border-t border-border px-4 py-4">
      <FormGrid>
        <Field label="Treatment">
          <Checkbox
            checked={taxable}
            onChange={setTaxable}
            label="Taxable"
            hint="Tuition at a recognised school is normally exempt"
          />
        </Field>
        {taxable && (
          <>
            <Field label="GST rate (%)" required>
              <Select
                value={rate}
                onChange={setRate}
                options={['0', '5', '12', '18', '28'].map((n) => ({ value: n, label: `${n}%` }))}
              />
            </Field>
            <Field label="HSN/SAC" required hint="Required on the invoice for a taxable supply">
              <Input value={hsn} onChange={setHSN} placeholder="9992" />
            </Field>
          </>
        )}
      </FormGrid>
      <FormNotice error={save.error} />
      <Button onClick={() => save.mutate(undefined as never)} disabled={save.isPending}>
        Save the treatment
      </Button>
    </div>
  )
}
