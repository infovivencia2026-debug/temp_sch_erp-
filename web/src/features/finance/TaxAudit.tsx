import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, ShieldAlert, Receipt, Landmark } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Select, PrintButton, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import {
  inr, rupees, fyOptions, currentFY, ledgerBase,
  type TaxReport, type AuditReport,
} from './ledger-lib'

/* What the school withheld, what it was charged, and the questions an auditor
   opens with.

   Both halves are drawn from records that already exist rather than from a tax
   module nobody would keep current: GST from the tax column on purchase bills,
   TDS from what was actually withheld at the moment of payment, and the
   statutory dues from the ledger's own liability accounts — the only place
   they can be checked against what was paid over.

   The audit checks are phrased so that passing is the boring answer. The first
   one is the only one that matters: if a voucher in the books does not
   balance, nothing else on the page is worth reading. Because the database
   refuses such a voucher at commit, a non-zero count there means something got
   round the schema rather than through it. */

export default function TaxAudit() {
  const [fy, setFy] = useState(String(currentFY()))
  const tax = useQuery({
    queryKey: ['ledgers', 'tax', fy],
    queryFn: () => api.get<TaxReport>(`${ledgerBase}/tax-report?fy=${fy}`),
  })
  const audit = useQuery({
    queryKey: ['ledgers', 'audit', fy],
    queryFn: () => api.get<AuditReport>(`${ledgerBase}/audit-report?fy=${fy}`),
  })

  if (tax.isLoading || audit.isLoading) return <Loading label="Running the checks…" />
  if (tax.error) return <ErrorState error={tax.error} />
  if (audit.error) return <ErrorState error={audit.error} />

  const t = tax.data
  const a = audit.data
  const dues = (t?.statutory_dues ?? []).filter((d) => d.paise !== 0)
  const owedOver = dues.reduce((s, d) => s + d.paise, 0)
  const missingGstin = (t?.vendors ?? []).filter((v) => v.tax_paise > 0 && !v.gstin)

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Taxation and audit"
        description="GST charged on purchases, tax withheld at source, what is still owed to the government, and the checks a reviewer runs before signing."
        width="wide"
        actions={
          <div className="flex items-center gap-2">
            <div className="w-44"><Select value={fy} onChange={setFy} options={fyOptions()} /></div>
            <PrintButton label="Print" />
          </div>
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Audit checks"
            value={a ? `${a.checks.length - a.failing} of ${a.checks.length}` : '—'}
            icon={a?.clean ? ShieldCheck : ShieldAlert}
            delta={a
              ? a.clean
                ? { value: 'Every check passes', positive: true }
                : { value: `${a.failing} need attention`, positive: false }
              : undefined} />
          <Stat label="GST on purchases" value={inr(t?.tax_paise ?? 0)} icon={Receipt}
            hint={`on ${inr(t?.taxable_paise ?? 0)} of taxable value`} />
          <Stat label="TDS withheld" value={inr(t?.tds_withheld_paise ?? 0)}
            hint="Deducted from vendors and owed to the government" />
          <Stat label="Statutory dues outstanding" value={inr(owedOver)} icon={Landmark}
            delta={owedOver
              ? { value: 'Still sitting in the school account', positive: false }
              : { value: 'Nothing outstanding', positive: true }} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Audit checks"
            description="Each of these is a question somebody would otherwise run by hand against the database."
            action={
              <Badge tone={a?.clean ? 'success' : 'danger'} solid={!a?.clean}>
                {a?.clean ? 'clean' : `${a?.failing} failing`}
              </Badge>
            }
          />
          <Table head={['Check', 'Why it matters', 'Findings', { label: 'Value', align: 'right' }, '']}
            empty={(a?.checks ?? []).length === 0}>
            {(a?.checks ?? []).map((c) => (
              <tr key={c.check}>
                <Td className="font-medium">{c.check}</Td>
                <Td className="text-[13px] text-muted-foreground">{c.detail}</Td>
                <Td className={`tabular-nums ${c.passing ? 'text-muted-foreground' : 'text-destructive'}`}>
                  {c.count === 0 ? 'none' : c.count}
                </Td>
                <Td className="text-right tabular-nums text-muted-foreground">
                  {c.paise ? rupees(c.paise) : '—'}
                </Td>
                <Td>
                  <Badge tone={c.passing ? 'success' : 'danger'}>
                    {c.passing ? 'pass' : 'look'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title="Statutory dues"
            description="What has been withheld and not yet paid over. These are liabilities to the government sitting in the school's own bank account." />
          {dues.length === 0 ? (
            <EmptyState title="Nothing withheld and unpaid"
              body="PF, ESI, professional tax, TDS and GST accounts all stand at nil." />
          ) : (
            <Table head={['Code', 'Head', { label: 'Outstanding', align: 'right' }]} empty={false}>
              {dues.map((d) => (
                <tr key={d.code}>
                  <Td className="tabular-nums text-muted-foreground">{d.code}</Td>
                  <Td className="font-medium">{d.name}</Td>
                  <Td className="text-right tabular-nums">{rupees(d.paise)}</Td>
                </tr>
              ))}
              <tr className="font-medium">
                <Td colSpan={2} className="text-right text-muted-foreground">Total</Td>
                <Td className="text-right tabular-nums">{rupees(owedOver)}</Td>
              </tr>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title={`Purchases and withholding — ${t?.fy_label ?? fy}`}
            description="A vendor charging tax without a GSTIN on file, or holding a GSTIN and charging none, is exactly what a reviewer is looking for — so both are listed rather than filtered out."
          />
          {(t?.vendors ?? []).length === 0 ? (
            <EmptyState title="No approved purchase bills this year"
              body="Approve a bill on the payables screen and it appears here." />
          ) : (
            <Table head={['Vendor', 'GSTIN', 'PAN', 'Bills',
              { label: 'Taxable', align: 'right' }, { label: 'Tax', align: 'right' },
              { label: 'TDS withheld', align: 'right' }]}
              empty={false}>
              {(t?.vendors ?? []).map((v) => (
                <tr key={v.vendor_name}>
                  <Td className="font-medium">{v.vendor_name}</Td>
                  <Td className={`text-[13px] tabular-nums ${!v.gstin && v.tax_paise ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {v.gstin ?? (v.tax_paise ? 'tax charged, none on file' : '—')}
                  </Td>
                  <Td className="text-[13px] tabular-nums text-muted-foreground">{v.pan ?? '—'}</Td>
                  <Td className="tabular-nums text-muted-foreground">{v.bills}</Td>
                  <Td className="text-right tabular-nums">{rupees(v.taxable_paise)}</Td>
                  <Td className="text-right tabular-nums">{rupees(v.tax_paise)}</Td>
                  <Td className="text-right tabular-nums">{v.tds_paise ? rupees(v.tds_paise) : '—'}</Td>
                </tr>
              ))}
              <tr className="font-medium">
                <Td colSpan={4} className="text-right text-muted-foreground">Total</Td>
                <Td className="text-right tabular-nums">{rupees(t?.taxable_paise ?? 0)}</Td>
                <Td className="text-right tabular-nums">{rupees(t?.tax_paise ?? 0)}</Td>
                <Td className="text-right tabular-nums">{rupees(t?.tds_withheld_paise ?? 0)}</Td>
              </tr>
            </Table>
          )}
          {missingGstin.length > 0 && (
            <div className="border-t p-5 text-[13px] text-destructive">
              {missingGstin.length} vendor{missingGstin.length === 1 ? '' : 's'} charged tax with no
              GSTIN on file. The credit cannot be claimed and the return will not accept the line.
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="The years"
            description="A closed year's figures are frozen at the moment of signing. They do not move when somebody corrects a later year, which is what makes them worth reporting to a board." />
          <Table head={['Year', 'Status', 'Vouchers', 'Closed on', 'Closed by',
            'Closing voucher', { label: 'Surplus', align: 'right' }]}
            empty={(a?.years ?? []).length === 0}>
            {(a?.years ?? []).map((y) => (
              <tr key={y.fy_start_year}>
                <Td className="font-medium tabular-nums">{y.fy_label}</Td>
                <Td><Badge tone={y.status === 'closed' ? 'info' : 'success'}>{y.status}</Badge></Td>
                <Td className="tabular-nums text-muted-foreground">{y.vouchers || '—'}</Td>
                <Td className="text-muted-foreground">{y.closed_on ?? '—'}</Td>
                <Td className="text-muted-foreground">{y.closed_by ?? '—'}</Td>
                <Td className="tabular-nums text-muted-foreground">{y.closing_voucher_no ?? '—'}</Td>
                <Td className="text-right tabular-nums">
                  {y.surplus_paise != null ? rupees(y.surplus_paise) : '—'}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}
