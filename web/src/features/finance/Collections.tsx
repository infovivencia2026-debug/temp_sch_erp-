import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Select, Input, ErrorState, Button, Checkbox, Dialog, PrintButton } from '@/components/ui'
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
          <DaySheet from={from} to={to} mode={mode} collector={collector} onReceipt={openReceipt} />
        </>
      )}
    </div>
  )
}

/* THE FEE DAY SHEET (owner's preview, 2026-11-21): one row per fee line a
   receipt paid, with its UTR and who took it, filtered by class, fee type
   and account on top of the period, mode and staff above. Cancelled and
   bounced receipts are one row each and count only in their own totals. */
interface SheetRow {
  payment_id: string; txn_id: string | null; receipt_no: string; paid_on: string; created_at: string; mode: string; status: string; reference: string
  account: string; remarks: string; gateway: string | null; collector: string; student_id: string; admission_no: string; student: string
  class_name: string | null; section_name: string | null; class_id: string | null; fee_head_id: string | null; fee_type: string | null; instalment_no: number | null; amount_paise: number
}
const SHEET_COLS = ['S.No', 'Admission no', 'Student', 'Class', 'Receipt no', 'Transaction ID', 'Receipt date', 'Fee type', 'Mode', 'UTR / cheque', 'Account', 'Taken by', 'Remarks', 'Amount'] as const
type SheetCol = typeof SHEET_COLS[number]
function DaySheet({ from, to, mode, collector, onReceipt }: { from: string; to: string; mode: string; collector: string; onReceipt: (id: string) => void }) {
  const [klass, setKlass] = useState('')
  const [head, setHead] = useState('')
  const [account, setAccount] = useState('')
  const [type, setType] = useState('active')
  const [dateType, setDateType] = useState('receipt')
  const [hidden, setHidden] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('erp.daysheet.hidden') ?? '[]') as string[]) } catch { return new Set() } })
  const [choose, setChoose] = useState(false)
  const q = useQuery({
    queryKey: ['fee-day-sheet', from, to, mode, collector, dateType],
    queryFn: () => api.get<{ items: SheetRow[] }>(`/api/v1/fees/hub/day-sheet?from=${from}&to=${to}&mode=${encodeURIComponent(mode)}&collector=${encodeURIComponent(collector)}&date_type=${dateType}`),
  })
  const all = q.data?.items ?? []
  const pick = (k: 'class_id' | 'fee_head_id' | 'account', label: 'class_name' | 'fee_type' | 'account') =>
    [...new Map(all.filter((r) => r[k]).map((r) => [String(r[k]), String(r[label] ?? '')])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const live = (r: SheetRow) => r.status === 'success'
  const inFilter = (r: SheetRow) => (!klass || r.class_id === klass) && (!head || r.fee_head_id === head) && (!account || r.account === account)
  const rows = all.filter((r) => (type === 'active' ? r.status !== 'cancelled' : r.status === 'cancelled') && inFilter(r))
  const sum = (f: (r: SheetRow) => boolean) => all.filter((r) => inFilter(r) && f(r)).reduce((a, r) => a + r.amount_paise, 0)
  const gross = sum(live), cancelled = sum((r) => r.status === 'cancelled'), bounced = sum((r) => r.status === 'bounced')
  const online = sum((r) => live(r) && (!!r.gateway || r.mode === 'online')), counter = gross - online
  const byHead = new Map<string, number>()
  for (const r of rows.filter(live)) { const k = r.fee_type ?? 'Unallocated'; byHead.set(k, (byHead.get(k) ?? 0) + r.amount_paise) }
  const cols = SHEET_COLS.filter((c) => !hidden.has(c))
  const show = (c: SheetCol) => !hidden.has(c)
  const setH = (n: Set<string>) => { setHidden(n); try { localStorage.setItem('erp.daysheet.hidden', JSON.stringify([...n])) } catch { /* private mode */ } }
  const opt = (label: string, list: [string, string][]) => [{ value: '', label }, ...list.map(([value, l]) => ({ value, label: l }))]
  return (
    <>
      <Card>
        <CardHeader title="Fee day sheet" action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setChoose(true)}>Columns</Button>
            <PrintButton scope="card" title="Fee day sheet" subtitle={from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`} />
          </div>
        } />
        {choose && (
          <Dialog onClose={() => setChoose(false)} title="Columns" footer={<Button onClick={() => setChoose(false)}>Done</Button>}>
            <div className="grid gap-2 sm:grid-cols-2">
              {SHEET_COLS.map((c) => <Checkbox key={c} label={c} checked={!hidden.has(c)} onChange={(v) => { const n = new Set(hidden); if (v) n.delete(c); else n.add(c); setH(n) }} />)}
            </div>
          </Dialog>
        )}
        <div className="grid gap-3 p-[var(--card-pad)] sm:grid-cols-2 lg:grid-cols-5">
          <label className="block"><span className="text-[13px] text-muted-foreground">Class</span><div className="mt-1"><Select value={klass} onChange={setKlass} options={opt('All classes', pick('class_id', 'class_name'))} /></div></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Fee type</span><div className="mt-1"><Select value={head} onChange={setHead} options={opt('All fee types', pick('fee_head_id', 'fee_type'))} /></div></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Receiving account</span><div className="mt-1"><Select value={account} onChange={setAccount} options={opt('All accounts', pick('account', 'account'))} /></div></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Type</span><div className="mt-1"><Select value={type} onChange={setType} options={[{ value: 'active', label: 'All active (incl. cheque bounce)' }, { value: 'cancelled', label: 'Cancelled only' }]} /></div></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Date type</span><div className="mt-1"><Select value={dateType} onChange={setDateType} options={[{ value: 'receipt', label: 'Receipt date' }, { value: 'entry', label: 'Entry date' }]} /></div></label>
        </div>
        {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <Table loading={q.isLoading} head={[...cols]} empty={!rows.length} emptyLabel="No fee lines in this period.">
            {rows.map((r, i) => (
              <tr key={`${r.payment_id}-${i}`}>
                {show('S.No') && <Td>{i + 1}</Td>}
                {show('Admission no') && <Td className="font-mono text-[12px]">{r.admission_no}</Td>}
                {show('Student') && <Td className="min-w-[9rem] font-medium">{r.student}</Td>}
                {show('Class') && <Td className="whitespace-nowrap">{[r.class_name, r.section_name].filter(Boolean).join('-') || '-'}</Td>}
                {show('Receipt no') && <Td className="font-mono text-[12px]"><button type="button" className="text-primary hover:underline" onClick={() => onReceipt(r.payment_id)}>{r.receipt_no || 'View'}</button></Td>}
                {show('Transaction ID') && <Td className="font-mono text-[12px]">{r.txn_id || '-'}</Td>}
                {show('Receipt date') && <Td className="whitespace-nowrap">{formatDate(r.paid_on)}</Td>}
                {show('Fee type') && <Td className="min-w-[9rem]">{r.fee_type ? `${r.fee_type}${r.instalment_no ? ` (Instalment ${r.instalment_no})` : ''}` : r.status === 'pending' ? 'Cheque held' : '-'}</Td>}
                {show('Mode') && <Td className="whitespace-nowrap">{modeName(r.mode)}{r.status !== 'success' && <Badge tone={r.status === 'pending' ? 'warning' : 'danger'} className="ml-2">{r.status === 'pending' ? 'Held' : r.status === 'bounced' ? 'Bounced' : 'Cancelled'}</Badge>}</Td>}
                {show('UTR / cheque') && <Td className="whitespace-nowrap font-mono text-[12px]">{r.reference || '-'}</Td>}
                {show('Account') && <Td>{r.account || '-'}</Td>}
                {show('Taken by') && <Td className="whitespace-nowrap">{r.collector || '-'}</Td>}
                {show('Remarks') && <Td className="min-w-[8rem] text-[13px]">{r.remarks || '-'}</Td>}
                {show('Amount') && <Td className="whitespace-nowrap font-medium tabular-nums">{formatPaise(r.amount_paise)}</Td>}
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Totals" />
          <Table head={['', 'Amount']} empty={false}>
            {([['Gross collection', gross], ['Cancelled', cancelled], ['Cheque bounce', bounced], ['Online gateway', online], ['Counter (manual)', counter], ['Net collection', gross]] as const).map(([k, v]) => (
              <tr key={k} className={k === 'Net collection' ? 'border-t-2 bg-muted/40 font-semibold' : ''}><Td className="font-medium">{k}</Td><Td className="tabular-nums">{formatPaise(v)}</Td></tr>
            ))}
          </Table>
        </Card>
        <Card>
          <CardHeader title="By fee type" />
          <Table head={['Fee type', 'Amount']} empty={!byHead.size} emptyLabel="Nothing collected.">
            {[...byHead.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => <tr key={k}><Td className="font-medium">{k}</Td><Td className="tabular-nums">{formatPaise(v)}</Td></tr>)}
          </Table>
        </Card>
      </div>
    </>
  )
}

