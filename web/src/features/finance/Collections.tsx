import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Select, Input, ErrorState } from '@/components/ui'
import { ExportRows } from '@/components/rows'
import { formatPaise, formatDate } from '@/lib/utils'
import ReceiptDialog from './ReceiptDialog'

/* COLLECTIONS: who paid, how, and to whom (owner, 2026-11-20: "where can we see
   the payments got today and month ... and who and how").

   One list for any range, with the totals by mode and by the staff member who
   took it. Admin and accounts see every collector; a clerk sees their own
   (the server decides, GET /fees/collections). */

interface Row {
  id: string; receipt_no: string; paid_on: string; at: string; amount_paise: number; mode: string; status: string
  reference: string; remarks: string; attachment_file_id?: string; collector: string
  student_id: string; admission_no: string; student: string; class_name: string; fee_types: string
}
interface Answer { from: string; to: string; all: boolean; collectors: { id: string; name: string }[]; items: Row[] }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function range(kind: string): [string, string] {
  const t = new Date()
  if (kind === 'yesterday') { const y = new Date(t); y.setDate(t.getDate() - 1); return [iso(y), iso(y)] }
  if (kind === 'week') { const m = new Date(t); m.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return [iso(m), iso(t)] }
  if (kind === 'month') return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(t)]
  if (kind === 'last_month') return [iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))]
  return [iso(t), iso(t)]
}
const MODE_LABEL: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', neft: 'NEFT / IMPS', netbanking: 'Net banking', cheque: 'Cheque', dd: 'Demand draft',
  adjustment: 'Adjustment', wallet: "Child's wallet", online: 'Online',
}
const modeName = (m: string) => MODE_LABEL[m] ?? (m ? m[0].toUpperCase() + m.slice(1) : '-')
const time = (at: string) => (at.length > 15 ? new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '')

export default function Collections() {
  const [period, setPeriod] = useState('today')
  const [custom, setCustom] = useState<[string, string]>(range('today'))
  const [mode, setMode] = useState('')
  const [collector, setCollector] = useState('')
  const [from, to] = period === 'custom' ? custom : range(period)

  const q = useQuery({
    queryKey: ['fee-collections', from, to, mode, collector],
    queryFn: () => api.get<Answer>(`/api/v1/fees/collections?from=${from}&to=${to}&mode=${encodeURIComponent(mode)}&collector=${encodeURIComponent(collector)}`),
  })
  const rows = q.data?.items ?? []
  const ok = rows.filter((r) => r.status === 'success')
  const total = ok.reduce((a, r) => a + r.amount_paise, 0)
  const sumBy = (key: (r: Row) => string) => {
    const m = new Map<string, { n: number; total: number }>()
    for (const r of ok) { const k = key(r); const v = m.get(k) ?? { n: 0, total: 0 }; v.n++; v.total += r.amount_paise; m.set(k, v) }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total)
  }
  const byMode = sumBy((r) => modeName(r.mode))
  const byStaff = sumBy((r) => r.collector || 'Unknown')
  const held = rows.filter((r) => r.status === 'pending').reduce((a, r) => a + r.amount_paise, 0)

  const [receiptId, setReceiptId] = useState<string | null>(null)
  const openReceipt = (id: string) => setReceiptId(id)

  return (
    <div className="space-y-6">
      {receiptId && <ReceiptDialog paymentId={receiptId} onClose={() => setReceiptId(null)} />}
      <Card>
        <div className="grid gap-3 p-[var(--card-pad)] sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Period</span>
            <div className="mt-1">
              <Select value={period} onChange={setPeriod} options={[
                { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This week' },
                { value: 'month', label: 'This month' }, { value: 'last_month', label: 'Last month' }, { value: 'custom', label: 'Pick dates' },
              ]} />
            </div>
          </label>
          {period === 'custom' && (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-1">
              <label className="block"><span className="text-[13px] text-muted-foreground">From</span>
                <Input type="date" value={custom[0]} onChange={(v) => setCustom([v, custom[1] < v ? v : custom[1]])} className="mt-1 w-full" /></label>
              <label className="block"><span className="text-[13px] text-muted-foreground">To</span>
                <Input type="date" value={custom[1]} onChange={(v) => setCustom([custom[0], v])} className="mt-1 w-full" /></label>
            </div>
          )}
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Mode</span>
            <div className="mt-1">
              <Select value={mode} onChange={setMode} options={[{ value: '', label: 'All modes' }, ...Object.entries(MODE_LABEL).map(([value, label]) => ({ value, label }))]} />
            </div>
          </label>
          {q.data?.all && (
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Taken by</span>
              <div className="mt-1">
                <Select value={collector} onChange={setCollector} options={[
                  { value: '', label: 'All staff' },
                  ...q.data.collectors.map((c) => ({ value: c.id, label: c.name || 'Unnamed' })),
                  { value: 'none', label: 'Imported / online' },
                ]} />
              </div>
            </label>
          )}
        </div>
      </Card>

      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <CellGrid>
            <Stat label="Collected" value={formatPaise(total)} hint={from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`} />
            <Stat label="Receipts" value={ok.length} />
            <Stat label="Cheques held" value={formatPaise(held)} hint={held ? 'Not yet cleared' : 'None'} />
            <Stat label="Top mode" value={byMode[0]?.[0] ?? '-'} hint={byMode[0] ? formatPaise(byMode[0][1].total) : undefined} />
          </CellGrid>

          <div className="grid gap-6 lg:grid-cols-2">
            {[['By mode', byMode], [q.data?.all ? 'By staff' : 'Taken by you', byStaff]].map(([title, list]) => (
              <Card key={title as string}>
                <CardHeader title={title as string} />
                <Table head={['', 'Receipts', 'Amount']} empty={!(list as typeof byMode).length} emptyLabel="Nothing collected in this period.">
                  {(list as typeof byMode).map(([k, v]) => (
                    <tr key={k}>
                      <Td className="font-medium">{k}</Td>
                      <Td className="tabular-nums">{v.n}</Td>
                      <Td className="tabular-nums font-medium">{formatPaise(v.total)}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader
              title="Payments"
              description={`${rows.length} in this period`}
              action={
                <ExportRows name="collections" rows={rows} columns={[
                  { header: 'Date', value: (r) => r.paid_on }, { header: 'Time', value: (r) => time(r.at) },
                  { header: 'Receipt no', value: (r) => r.receipt_no }, { header: 'Adm no', value: (r) => r.admission_no },
                  { header: 'Student', value: (r) => r.student }, { header: 'Class', value: (r) => r.class_name },
                  { header: 'Fee type', value: (r) => r.fee_types }, { header: 'Amount', value: (r) => r.amount_paise / 100 },
                  { header: 'Mode', value: (r) => modeName(r.mode) }, { header: 'UTR / ref no', value: (r) => r.reference },
                  { header: 'Taken by', value: (r) => r.collector }, { header: 'Status', value: (r) => r.status },
                  { header: 'Comment', value: (r) => r.remarks },
                ]} />
              }
            />
            <Table
              loading={q.isLoading}
              head={['Date', 'Student', 'Fee type', 'Amount', 'Mode', 'UTR / ref no', 'Receipt no', 'Taken by', 'Comment']}
              empty={!rows.length}
              emptyLabel="No payments in this period."
            >
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{formatDate(r.paid_on)}<span className="block text-[12px] text-muted-foreground">{time(r.at)}</span></Td>
                  <Td className="min-w-[11rem]">
                    <span className="font-medium">{r.student}</span>
                    <span className="block text-[12px] text-muted-foreground">{[r.admission_no, r.class_name].filter(Boolean).join(' · ')}</span>
                  </Td>
                  <Td className="min-w-[8rem] text-[13px]">{r.fee_types || '-'}</Td>
                  <Td className="whitespace-nowrap font-medium tabular-nums">
                    {formatPaise(r.amount_paise)}
                    {r.status !== 'success' && <Badge tone={r.status === 'pending' ? 'warning' : 'danger'} className="ml-2">{r.status}</Badge>}
                  </Td>
                  <Td className="whitespace-nowrap">{modeName(r.mode)}</Td>
                  <Td className="whitespace-nowrap font-mono text-[12px] text-muted-foreground">{r.reference || '-'}</Td>
                  <Td className="whitespace-nowrap font-mono text-[12px]">
                    <button type="button" onClick={() => openReceipt(r.id)} className="text-primary hover:underline">{r.receipt_no || 'View'}</button>
                  </Td>
                  <Td className="whitespace-nowrap">{r.collector || '-'}</Td>
                  <Td className="min-w-[9rem] text-[13px]">
                    {r.remarks || (r.attachment_file_id ? '' : '-')}
                    {r.attachment_file_id && (
                      <a href={`/api/v1/files/${r.attachment_file_id}?inline=1`} target="_blank" rel="noreferrer" className="block font-medium text-primary hover:underline">Open file</a>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}
