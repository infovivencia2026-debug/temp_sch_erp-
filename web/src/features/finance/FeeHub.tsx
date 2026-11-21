import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Printer, Download, Banknote } from 'lucide-react'
import type { FeeReceipt } from '@shared/api'
import { api } from '@/lib/api'
import { rupeesToPaise } from '@/lib/money'
import { saveFile } from '@/lib/save-file'
import { useDebouncedValue } from '@/lib/debounce'
import { useCan, useSession } from '@/lib/session'
import { useToast } from '@/components/Toast'
import UpiQr from '@/components/UpiQr'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { upiNote } from '@/lib/upi'
import {
  Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button, Select, Input, Textarea, Dialog, FormNotice, EmptyState, ErrorState,
  SkeletonTable, PrintButton, TAB_BAR, tabClass, Field, FormGrid,
} from '@/components/ui'
import { formatPaise, formatDate, cn } from '@/lib/utils'
import ReceiptDialog from './ReceiptDialog'
import { printHtml, receiptTwoCopiesHtml, thermalHtml } from './receipt-print'

/* FEES ALL IN ONE PLACE: the Take payment tab (owner's approved preview,
   2026-11-21). Find the child, read the account, then a side menu for
   everything done to that child's fees. Every figure comes from
   GET /fees/hub/students/{id}; a payment lands on the fee lines ticked
   here (payment_line_allocations). Status is Paid / Part paid / Unpaid. */

interface Line {
  line_id: string; invoice_id: string; invoice_no: string; instalment_no: number | null; due_on: string | null; academic_year_id: string; year: string
  fee_head_id: string; fee_type: string; description: string; account: string | null; amount_paise: number; concession_paise: number; net_paise: number
  paid_paise: number; balance_paise: number; fine_paise: number; status: 'paid' | 'part_paid' | 'unpaid'; invoice_status: string
}
interface PaidLine { fee_type: string; instalment_no: number | null; invoice_no: string; year: string; amount_paise: number }
interface Rcpt {
  id: string; txn_id: string | null; receipt_no: string; paid_on: string; created_at: string; amount_paise: number; mode: string; status: string
  reference: string; bank_name: string | null; cheque_date: string | null; receiving_account: string | null; payer_name: string | null
  remarks: string; attachment_file_id: string | null; gateway: string | null; collector: string; lines: PaidLine[]
}
interface Req {
  id: string; kind: string; payment_id: string | null; invoice_line_id: string | null; payload: Record<string, unknown>; reason: string; status: string
  requested_at: string; decided_at: string | null; decision_note: string | null; requested_by: string; decided_by: string; receipt_no: string | null
  student?: string; admission_no?: string; student_id?: string
}
interface Hub {
  student: { id: string; admission_no: string; full_name: string; status: string; admission_date: string; class_name: string | null; section_name: string | null
    roll_no: number | null; class_id: string | null; section_id: string | null; siblings: number }
  years: { id: string; name: string; is_current: boolean; starts_on: string }[]
  totals: { charged_paise: number; collected_paise: number; balance_paise: number; held_paise: number; old_dues_paise: number; due_now_paise: number; wallet_paise: number }
  lines: Line[]; receipts: Rcpt[]; requests: Req[]
  logs: { created_at: string; action: string; before: string | null; after: string | null; ip: string | null; who: string }[]
  concessions: { id: string; kind: string; percent: string | null; amount_paise: number | null; reason: string | null; status: string; created_at: string; approved_at: string | null; fee_type: string; requested_by: string; approved_by: string }[]
  refunds: { id: string; amount_paise: number; reason: string | null; status: string; mode: string | null; created_at: string }[]
  fines: { id: string; rule_name: string; amount_paise: number; days_overdue: number; status: string; as_of: string; invoice_no: string }[]
  available: { fee_head_id: string; fee_type: string; optional: boolean; plans: { structure_id: string; plan: string; class_name: string; amount_paise: number; instalments: number }[] }[]
}

export const MODE_LABEL: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', neft: 'NEFT / IMPS / RTGS', netbanking: 'Net banking', cheque: 'Cheque', dd: 'Demand draft',
  wallet: 'Adjust from advance', adjustment: 'Adjustment', online: 'Online',
}
export const modeName = (m: string) => MODE_LABEL[m] ?? (m ? m[0].toUpperCase() + m.slice(1) : '-')
const STATUS = { paid: ['Paid', 'success'], part_paid: ['Part paid', 'warning'], unpaid: ['Unpaid', 'neutral'] } as const
function LineStatus({ s }: { s: Line['status'] }) { return <Badge tone={STATUS[s][1]}>{STATUS[s][0]}</Badge> }
const inst = (n: number | null) => (n ? `Instalment ${n}` : 'One-off')
const KIND_LABEL: Record<string, string> = {
  cancel: 'Cancel receipt', change: 'Change receipt', remove_fee: 'Remove fee', edit_amount: 'Edit fee amount', transfer: 'Move money to another student', class_change: 'Change class / section',
}
const ACTION_LABEL: Record<string, string> = {
  'fee.assign': 'Plan assigned', 'fee.misc': 'Misc. fee added', 'fee.due_date': 'Due date changed', 'fee.remove': 'Fee removed', 'fee.edit_amount': 'Fee amount changed',
  'fee.class_change': 'Class / section changed', 'fee.request.rejected': 'Request rejected', 'payment.void': 'Receipt cancelled', 'payment.move': 'Receipt moved',
  'payment.change': 'Receipt changed', 'payment.force_success': 'Marked received',
}
const actionName = (a: string) => ACTION_LABEL[a] ?? (a.startsWith('fee.request.') ? 'Request: ' + (KIND_LABEL[a.slice(12)] ?? a.slice(12)) : a)
const time = (at: string) => (at && at.length > 15 ? new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : formatDate(at))
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function summary(s: string | null): string {
  if (!s) return '-'
  try {
    const o = JSON.parse(s) as Record<string, unknown>
    return Object.entries(o).filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && !k.endsWith('_id'))
      .map(([k, v]) => `${k.replace(/_paise$/, '').replace(/_/g, ' ')}: ${k.endsWith('_paise') ? formatPaise(Number(v)) : String(v)}`).join(' · ') || '-'
  } catch { return s }
}

const MENU = [
  ['entry', 'Receipt entry'], ['details', 'Fee details'], ['transactions', 'View transactions'], ['manage', 'Fee management'],
  ['bounce', 'Cheque bounce'], ['pdc', 'Post-dated cheques'], ['due', 'Due dates'], ['edit', 'Edit fee amount'], ['transfer', 'Transfer'], ['requests', 'Requests'],
] as const
type Pane = typeof MENU[number][0]

/* ------------------------------------------------------------------ find */
export function FindStudent({ studentId, onPick }: { studentId: string | null; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [klass, setKlass] = useState('')
  const [section, setSection] = useState('')
  const [status, setStatus] = useState('active')
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api.get<{ items: { id: string; name: string }[] }>('/api/v1/academics/classes') })
  const sections = useQuery({ queryKey: ['sections'], queryFn: () => api.get<{ items: { id: string; name: string; class_id: string }[] }>('/api/v1/academics/sections') })
  const needle = useDebouncedValue(q.trim())
  const on = needle.length >= 2 || !!section
  const results = useQuery({
    queryKey: ['fee-search', needle, klass, section, status],
    queryFn: () => api.call('GET /students', { query: { q: needle || undefined, class_id: klass || undefined, section_id: section || undefined, status: status === 'active' ? '' : status, limit: 50 } }),
    enabled: on,
    placeholderData: keepPreviousData,
  })
  const secs = (sections.data?.items ?? []).filter((s) => !klass || s.class_id === klass)
  return (
    <Card>
      <CardHeader title="Find student" />
      <div className="grid gap-3 p-[var(--card-pad)] sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Class">
          <Select value={klass} onChange={(v) => { setKlass(v); setSection('') }} options={[{ value: '', label: 'All classes' }, ...(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
        </Field>
        <Field label="Section">
          <Select value={section} onChange={setSection} options={[{ value: '', label: 'All sections' }, ...secs.map((s) => ({ value: s.id, label: s.name }))]} />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'left', label: 'Left' }, { value: 'all', label: 'All' }]} />
        </Field>
        <Field label="Name, admission no. or phone">
          <Input value={q} onChange={setQ} placeholder="Type at least 2 letters" />
        </Field>
      </div>
      {on && (
        <Table loading={results.isLoading} loadingRows={4} head={['Admission no.', 'Name', 'Class', 'Phone', '']} empty={!results.data?.items.length}
          emptyLabel="No student matches that search.">
          {(results.data?.items ?? []).map((s) => (
            <tr key={s.id} className={cn(s.id === studentId && 'bg-accent')}>
              <Td className="font-mono text-[12px]">{s.admission_no}</Td>
              <Td className="font-medium">{s.full_name}{s.status !== 'active' && s.status !== 'suspended' && <Badge tone="neutral" className="ml-2">Left</Badge>}</Td>
              <Td>{s.class_name ? `${s.class_name}-${s.section_name}` : '-'}</Td>
              <Td className="whitespace-nowrap text-muted-foreground">{s.primary_phone || '-'}</Td>
              <Td><Button size="sm" variant={s.id === studentId ? 'ink' : 'outline'} onClick={() => onPick(s.id)}>{s.id === studentId ? 'Selected' : 'Select'}</Button></Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ the child's account */
export function StudentFees({ studentId, preset }: { studentId: string; preset?: string[] | null }) {
  const hub = useQuery({ queryKey: ['fee-hub', studentId], queryFn: () => api.get<Hub>(`/api/v1/fees/hub/students/${studentId}`) })
  const rec = useQuery({ queryKey: ['student-record', studentId], queryFn: () => api.call('GET /students/{id}', { params: { id: studentId } }) })
  const [pane, setPane] = useState<Pane>('entry')
  useEffect(() => { setPane('entry') }, [studentId])
  if (hub.isLoading) return <SkeletonTable columns={6} />
  if (hub.error) return <ErrorState error={hub.error} onRetry={() => hub.refetch()} />
  const h = hub.data
  if (!h) return null
  const s = h.student
  const guardians = rec.data?.guardians ?? []
  const t = h.totals
  return (
    <>
      <Card>
        <div className="grid gap-x-6 gap-y-3 p-[var(--card-pad)] md:grid-cols-2">
          <div className="min-w-0">
            <h2 className="truncate text-[18px] font-semibold">{s.full_name}</h2>
            <p className="text-[13px] text-muted-foreground">
              {[s.class_name && `${s.class_name}-${s.section_name}`, s.roll_no && `Roll no ${s.roll_no}`, s.status !== 'active' && s.status].filter(Boolean).join(' · ')}
            </p>
            <dl className="mt-2 grid gap-1 text-[13px]">
              {guardians.map((g) => (
                <div key={g.id} className="flex min-w-0 gap-2"><dt className="shrink-0 capitalize text-muted-foreground">{g.relation}:</dt><dd className="min-w-0 truncate">{g.full_name}{g.phone ? ` · ${g.phone}` : ''}</dd></div>
              ))}
              <div className="flex gap-2"><dt className="text-muted-foreground">Sibling:</dt><dd>{s.siblings > 0 ? 'Yes' : 'No'}</dd></div>
            </dl>
          </div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
            {([
              ['Admission no', s.admission_no], ['Joined', formatDate(s.admission_date)], ['Advance / wallet', formatPaise(t.wallet_paise)],
              ['Total due now', formatPaise(t.due_now_paise)], ['Old year dues', formatPaise(t.old_dues_paise)],
              ['Fines', formatPaise(h.lines.reduce((a, l) => a + l.fine_paise, 0))],
            ] as const).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b py-1"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium tabular-nums">{v}</dd></div>
            ))}
          </dl>
        </div>
      </Card>
      <CellGrid cols={4}>
        <Stat label="Total charged" value={formatPaise(t.charged_paise)} />
        <Stat label="Collected" value={formatPaise(t.collected_paise)} />
        <Stat label="Balance" value={formatPaise(t.balance_paise)} delta={{ value: t.balance_paise > 0 ? 'Payable' : 'Settled', positive: t.balance_paise <= 0 }} />
        <Stat label="Cheques held" value={formatPaise(t.held_paise)} hint={t.held_paise ? 'Not yet cleared' : 'None'} />
      </CellGrid>
      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <Card className="h-max">
          <nav aria-label="This student" className="flex gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible">
            {MENU.map(([k, label]) => (
              <Button key={k} size="sm" variant={pane === k ? 'ink' : 'ghost'} className="shrink-0 lg:w-full lg:justify-start" onClick={() => setPane(k)}>
                {label}{k === 'requests' && h.requests.some((r) => r.status === 'pending') ? ` (${h.requests.filter((r) => r.status === 'pending').length})` : ''}
              </Button>
            ))}
          </nav>
        </Card>
        <div className="min-w-0 space-y-6">
          {pane === 'entry' && <ReceiptEntry hub={h} preset={preset ?? null} />}
          {pane === 'details' && <FeeDetails hub={h} />}
          {pane === 'transactions' && <Transactions hub={h} />}
          {pane === 'manage' && <FeeManagement hub={h} />}
          {pane === 'bounce' && <Cheques hub={h} kind="bounce" />}
          {pane === 'pdc' && <Cheques hub={h} kind="pdc" />}
          {pane === 'due' && <DueDates hub={h} />}
          {pane === 'edit' && <EditAmount hub={h} />}
          {pane === 'transfer' && <Transfer hub={h} />}
          {pane === 'requests' && <Requests rows={h.requests} />}
        </div>
      </div>
    </>
  )
}

function useRefresh(studentId: string) {
  const qc = useQueryClient()
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['fee-hub', studentId], refetchType: 'all' }),
    qc.invalidateQueries({ queryKey: ['fee-ledger', studentId] }),
    qc.invalidateQueries({ queryKey: ['fee-requests'] }),
    qc.invalidateQueries({ queryKey: ['finance-dashboard'] }),
  ])
}

/* ------------------------------------------------------------------ receipt entry: 3 steps */
function ReceiptEntry({ hub, preset }: { hub: Hub; preset: string[] | null }) {
  const toast = useToast()
  const refresh = useRefresh(hub.student.id)
  const session = useSession().institution
  const current = hub.years.find((y) => y.is_current)
  const yearsWithLines = hub.years.filter((y) => y.is_current || hub.lines.some((l) => l.academic_year_id === y.id))
  const [year, setYear] = useState(() => {
    if (preset?.length) { const l = hub.lines.find((x) => preset.includes(x.invoice_id)); if (l) return l.academic_year_id }
    return current?.id ?? yearsWithLines[0]?.id ?? ''
  })
  const [instalment, setInstalment] = useState('')
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [pay, setPay] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {}
    if (preset?.length) for (const l of hub.lines) if (preset.includes(l.invoice_id) && l.balance_paise > 0) o[l.line_id] = (l.balance_paise / 100).toFixed(2)
    return o
  })
  const [mode, setMode] = useState('cash')
  const [utr, setUtr] = useState('')
  const [bank, setBank] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [paidOn, setPaidOn] = useState(todayISO())
  const [account, setAccount] = useState('')
  const [payer, setPayer] = useState('')
  const [relation, setRelation] = useState('')
  const [remarks, setRemarks] = useState('')
  const [file, setFile] = useState<UploadedFile | null>(null)
  const [done, setDone] = useState<{ id: string; receipt: FeeReceipt } | null>(null)
  const [dialog, setDialog] = useState<'' | 'qr' | 'fine' | 'scholarship'>('')
  const accounts = useQuery({ queryKey: ['bank-accounts'], queryFn: () => api.get<{ items: { id: string; label: string; bank_name: string }[] }>('/api/v1/finance/banking/accounts').catch(() => ({ items: [] })) })
  const yearName = (id: string) => hub.years.find((y) => y.id === id)?.name ?? ''
  const label = (y: { id: string; name: string; starts_on: string }) => {
    if (!current || y.id === current.id) return `${y.name} (current)`
    return y.starts_on < current.starts_on ? `${y.name} · old dues` : `${y.name} · advance`
  }
  const open = hub.lines.filter((l) => l.academic_year_id === year && l.balance_paise > 0 && (!instalment || String(l.instalment_no ?? 0) === instalment))
  const instalments = [...new Set(hub.lines.filter((l) => l.academic_year_id === year).map((l) => l.instalment_no ?? 0))].sort((a, b) => a - b)
  const picked = hub.lines.filter((l) => pay[l.line_id] !== undefined)
  const amounts = picked.map((l) => ({ l, paise: rupeesToPaise(pay[l.line_id] || '0') }))
  const total = amounts.reduce((a, x) => a + x.paise, 0)
  const payable = open.reduce((a, l) => a + l.balance_paise, 0)
  const overLine = amounts.find((x) => x.paise > x.l.balance_paise || x.paise <= 0)
  const isCheque = mode === 'cheque' || mode === 'dd'
  const needsUtr = ['upi', 'neft', 'card'].includes(mode)
  const step1Block = !picked.length ? 'Tick at least one fee line.' : overLine ? `${overLine.l.fee_type} ${inst(overLine.l.instalment_no)}: enter an amount above nought and no more than ${formatPaise(overLine.l.balance_paise)}.` : ''
  const step2Block = mode === 'upi' && !/^\d{12}$/.test(utr.trim()) ? 'A UPI UTR is 12 digits.'
    : needsUtr && !utr.trim() ? 'Enter the UTR / transaction number.'
    : isCheque && (!utr.trim() || !bank.trim() || !chequeDate) ? 'A cheque or DD needs its number, bank and date.'
    : mode === 'wallet' && total > hub.totals.wallet_paise ? `The advance holds only ${formatPaise(hub.totals.wallet_paise)}.`
    : mode === 'adjustment' && !remarks.trim() ? 'Say why this adjustment is made.' : ''
  const toggle = (l: Line) => setPay((o) => { const n = { ...o }; if (n[l.line_id] !== undefined) delete n[l.line_id]; else n[l.line_id] = (l.balance_paise / 100).toFixed(2); return n })

  const save = useMutation({
    mutationFn: () => api.call('POST /fees/payments', { body: {
      student_id: hub.student.id, mode, paid_on: paidOn, reference_no: utr.trim() || undefined, bank_name: bank.trim() || undefined, cheque_date: chequeDate || undefined,
      payer_name: payer.trim() || undefined, payer_relation: relation || undefined, remarks: remarks.trim() || undefined, attachment_file_id: file?.file_id,
      receiving_account: account || undefined,
      lines: amounts.map((x) => ({ invoice_line_id: x.l.line_id, amount_paise: x.paise })),
    } as never }),
    onSuccess: async (res) => {
      const r = await api.call('GET /fees/receipts/{id}', { params: { id: res.payment_id } })
      setDone({ id: res.payment_id, receipt: r })
      setStep(3)
      toast.ok(`Receipt ${res.receipt_no} issued`)
      setPay({}); setUtr(''); setBank(''); setChequeDate(''); setRemarks(''); setFile(null); setPayer(''); setRelation('')
      await refresh()
    },
  })
  const school = { name: session?.display_name || done?.receipt.institution || '', logoUrl: session?.logo_key ? `${location.origin}/api/v1/files/${session.logo_key}?inline=1` : undefined }
  const steps = ['1. Fee details', '2. Receipt details', '3. Print receipt']
  return (
    <Card>
      <CardHeader title="Receipt entry" action={step === 1 ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setDialog('qr')}>QR code / payment link</Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('fine')}>Manage / view fine</Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('scholarship')}>View scholarship</Button>
        </div>
      ) : undefined} />
      <ol className="grid gap-2 p-[var(--card-pad)] pb-0 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s} className={cn('rounded-md border px-3 py-2 text-center text-[13px] font-medium', step === i + 1 ? 'border-primary bg-accent text-foreground' : 'text-muted-foreground')}>{s}</li>
        ))}
      </ol>
      {dialog === 'qr' && <QrDialog hub={hub} amount={total} onClose={() => setDialog('')} />}
      {dialog === 'fine' && <FineDialog hub={hub} onClose={() => setDialog('')} />}
      {dialog === 'scholarship' && <ScholarshipDialog hub={hub} onClose={() => setDialog('')} />}

      {step === 1 && (
        <>
          <div className="grid gap-3 p-[var(--card-pad)] sm:grid-cols-2">
            <Field label="Academic year">
              <Select value={year} onChange={(v) => { setYear(v); setInstalment('') }} options={hub.years.map((y) => ({ value: y.id, label: label(y) }))} />
            </Field>
            <Field label="Instalment">
              <Select value={instalment} onChange={setInstalment} options={[{ value: '', label: 'All instalments' }, ...instalments.map((n) => ({ value: String(n), label: n ? `Instalment ${n}` : 'One-off' }))]} />
            </Field>
          </div>
          <Table head={['', 'Fee type', 'Instalment', 'Due date', 'Fee', 'Concession', 'Paid', 'Balance', 'Fine', 'Pay now']} empty={!open.length}
            emptyLabel={hub.lines.some((l) => l.academic_year_id === year) ? 'Nothing is unpaid for this year.' : `No fees raised for ${yearName(year)}. Assign them under Fee management.`}>
            {open.map((l) => (
              <tr key={l.line_id}>
                <Td><input type="checkbox" checked={pay[l.line_id] !== undefined} onChange={() => toggle(l)} aria-label={`Pay ${l.fee_type} ${inst(l.instalment_no)}`} /></Td>
                <Td className="min-w-[9rem] font-medium">{l.description}<span className="block font-mono text-[11.5px] text-muted-foreground">{l.invoice_no}</span></Td>
                <Td className="whitespace-nowrap">{inst(l.instalment_no)}</Td>
                <Td className="whitespace-nowrap text-muted-foreground">{formatDate(l.due_on)}</Td>
                <Td className="whitespace-nowrap tabular-nums">{formatPaise(l.amount_paise)}</Td>
                <Td className="whitespace-nowrap tabular-nums">{formatPaise(l.concession_paise)}</Td>
                <Td className="whitespace-nowrap tabular-nums">{formatPaise(l.paid_paise)}</Td>
                <Td className="whitespace-nowrap font-medium tabular-nums">{formatPaise(l.balance_paise)}</Td>
                <Td className="whitespace-nowrap tabular-nums">{formatPaise(l.fine_paise)}</Td>
                <Td className="min-w-[8rem]">
                  {pay[l.line_id] !== undefined && <Input value={pay[l.line_id]} onChange={(v) => setPay((o) => ({ ...o, [l.line_id]: v }))} srLabel={`Amount for ${l.fee_type}`} />}
                </Td>
              </tr>
            ))}
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t p-[var(--card-pad)] text-[14px]">
            <span>Total selected: <b className="tabular-nums">{formatPaise(total)}</b> · Total payable: <b className="tabular-nums">{formatPaise(payable)}</b></span>
            <div className="flex items-center gap-3">
              {step1Block && <span className="text-[12.5px] text-muted-foreground">{step1Block}</span>}
              <Button disabled={!!step1Block} onClick={() => setStep(2)}>Next</Button>
            </div>
          </div>
        </>
      )}

      {step === 2 && (
        <div className="space-y-4 p-[var(--card-pad)]">
          <p className="text-[14px]">Receipt amount <b className="tabular-nums">{formatPaise(total)}</b> for {picked.length} fee line{picked.length === 1 ? '' : 's'}.</p>
          <FormGrid>
            <Field label="Payment mode">
              <Select value={mode} onChange={(v) => { setMode(v); setUtr('') }} options={['cash', 'upi', 'card', 'neft', 'cheque', 'dd', 'wallet', 'adjustment'].map((m) => ({ value: m, label: modeName(m) }))} />
            </Field>
            {needsUtr && <Field label="UTR / transaction no" required hint={mode === 'upi' ? '12 digits. A UTR is accepted once.' : 'A UTR is accepted once.'}><Input value={utr} onChange={setUtr} /></Field>}
            {isCheque && <Field label={mode === 'dd' ? 'DD no' : 'Cheque no'} required><Input value={utr} onChange={setUtr} /></Field>}
            {isCheque && <Field label="Bank and branch" required><Input value={bank} onChange={setBank} /></Field>}
            {isCheque && <Field label="Cheque date" required hint="Held until it clears; a later date goes to Post-dated cheques."><Input type="date" value={chequeDate} onChange={setChequeDate} /></Field>}
            <Field label="Receipt date"><Input type="date" value={paidOn} onChange={setPaidOn} max={todayISO()} /></Field>
            <Field label="Receiving account">
              <Select value={account} onChange={setAccount} options={[{ value: '', label: 'Not chosen' }, { value: 'Cash', label: 'Cash' },
                ...(accounts.data?.items ?? []).map((a) => ({ value: `${a.label} (${a.bank_name})`, label: `${a.label} (${a.bank_name})` }))]} />
            </Field>
            <Field label="Paid by"><Input value={payer} onChange={setPayer} placeholder="Name on the counterfoil" /></Field>
            <Field label="Relation">
              <Select value={relation} onChange={setRelation} options={[{ value: '', label: 'Not given' }, { value: 'Father', label: 'Father' }, { value: 'Mother', label: 'Mother' }, { value: 'Other', label: 'Other' }]} />
            </Field>
            <Field label="Remarks" wide><Textarea value={remarks} onChange={setRemarks} rows={2} /></Field>
          </FormGrid>
          <FilePicker value={file} onChange={setFile} label="Attach slip or screenshot (optional)" hint="Any type, up to 2 MB" maxBytes={2 * 1024 * 1024} />
          {mode === 'upi' && session?.upi_vpa && total > 0 && (
            <div className="mx-auto max-w-xs rounded-xl border bg-muted/30 p-4">
              <UpiQr vpa={session.upi_vpa} payeeName={session.upi_payee_name || session.name || ''} amountPaise={total} note={upiNote('Fee', hub.student.admission_no)} reference={hub.student.admission_no} size={200} />
            </div>
          )}
          <FormNotice error={save.error} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
            <div className="flex items-center gap-3">
              {step2Block && <span className="text-[12.5px] text-muted-foreground">{step2Block}</span>}
              <Button needsNetwork disabled={!!step2Block || save.isPending} onClick={() => save.mutate()}>
                <Banknote className="h-4 w-4" />{save.isPending ? 'Saving…' : `Save and generate receipt ${formatPaise(total)}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && done && (
        <div className="space-y-4 p-[var(--card-pad)]">
          <p className="text-[14px]">Receipt <b className="font-mono">{done.receipt.receipt_no}</b>{done.receipt.txn_id ? <> · Transaction ID <span className="font-mono">{done.receipt.txn_id}</span></> : null} issued for <b>{formatPaise(done.receipt.amount_paise)}</b>.</p>
          <ReceiptActions id={done.id} receipt={done.receipt} school={school} />
          <Button variant="ghost" onClick={() => { setDone(null); setStep(1) }}>New receipt</Button>
        </div>
      )}
    </Card>
  )
}

function ReceiptActions({ id, receipt, school }: { id: string; receipt: FeeReceipt; school: { name: string; logoUrl?: string } }) {
  const [saving, setSaving] = useState(false)
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => printHtml(receiptTwoCopiesHtml(receipt, school))}><Printer className="h-4 w-4" />Print (A4, 2 copies)</Button>
      <Button variant="secondary" onClick={() => printHtml(thermalHtml(receipt, school))}><Printer className="h-4 w-4" />Thermal</Button>
      <Button variant="secondary" disabled={saving} onClick={() => { setSaving(true); void saveFile(`/api/v1/fees/receipts/${id}/pdf`, `receipt-${receipt.receipt_no}.pdf`).finally(() => setSaving(false)) }}>
        <Download className="h-4 w-4" />{saving ? 'Saving…' : 'PDF'}
      </Button>
    </div>
  )
}

function useSchool(fallback = '') {
  const s = useSession().institution
  return { name: s?.display_name || s?.name || fallback, logoUrl: s?.logo_key ? `${location.origin}/api/v1/files/${s.logo_key}?inline=1` : undefined }
}

function QrDialog({ hub, amount, onClose }: { hub: Hub; amount: number; onClose: () => void }) {
  const s = useSession().institution
  const owed = hub.totals.due_now_paise
  const value = amount || owed
  return (
    <Dialog onClose={onClose} title="QR code for the parent" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {!s?.upi_vpa ? <p className="text-[14px] text-muted-foreground">No UPI ID is set for the school, so there is no code to show. It goes under Setup, School profile.</p>
        : value <= 0 ? <p className="text-[14px] text-muted-foreground">Nothing is due now. Tick fee lines in Receipt entry to make a code for that amount.</p>
        : (
          <div className="mx-auto max-w-xs space-y-2 text-center">
            <p className="text-[14px]">{formatPaise(value)} {amount ? 'for the ticked lines' : 'due now'}</p>
            <UpiQr vpa={s.upi_vpa} payeeName={s.upi_payee_name || s.name || ''} amountPaise={value} note={upiNote('Fee', hub.student.admission_no)} reference={hub.student.admission_no} size={220} />
            <p className="text-[12.5px] text-muted-foreground">The parent scans it with any UPI app. Record the receipt with the UTR once it is paid.</p>
          </div>
        )}
    </Dialog>
  )
}

function FineDialog({ hub, onClose }: { hub: Hub; onClose: () => void }) {
  const toast = useToast()
  const refresh = useRefresh(hub.student.id)
  const [invoice, setInvoice] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const bills = [...new Map(hub.lines.filter((l) => l.balance_paise > 0).map((l) => [l.invoice_id, l])).values()]
  const add = useMutation({
    mutationFn: () => api.post(`/api/v1/fees/invoices/${invoice}/penalty`, { amount: Number(amount), reason: reason.trim() }),
    onSuccess: async () => { toast.ok('Late fee added'); setAmount(''); setReason(''); await refresh() },
  })
  const waive = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/finance/fee-engine/fines/charges/${id}/waive`, { reason: 'Waived at the fee counter' }),
    onSuccess: async () => { toast.ok('Fine waived'); await refresh() },
  })
  return (
    <Dialog onClose={onClose} title="Fines" width="48rem" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <Table head={['Bill', 'Rule', 'Days late', 'Amount', 'Status', '']} empty={!hub.fines.length} emptyLabel="No fines on this account.">
        {hub.fines.map((f) => (
          <tr key={f.id}>
            <Td className="font-mono text-[12px]">{f.invoice_no}</Td><Td>{f.rule_name}</Td><Td>{f.days_overdue}</Td>
            <Td className="tabular-nums">{formatPaise(f.amount_paise)}</Td><Td><Badge tone={f.status === 'waived' ? 'neutral' : 'warning'}>{f.status}</Badge></Td>
            <Td>{f.status !== 'waived' && <Button size="sm" variant="ghost" disabled={waive.isPending} onClick={() => waive.mutate(f.id)}>Waive</Button>}</Td>
          </tr>
        ))}
      </Table>
      <h4 className="mt-5 text-[14px] font-semibold">Add a late fee to a bill</h4>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <Field label="Bill"><Select value={invoice} onChange={setInvoice} placeholder="Choose" options={bills.map((b) => ({ value: b.invoice_id, label: `${b.invoice_no} · ${b.fee_type} ${inst(b.instalment_no)}` }))} /></Field>
        <Field label="Amount (₹)"><Input value={amount} onChange={setAmount} type="number" /></Field>
        <Field label="Reason, the family sees this"><Input value={reason} onChange={setReason} /></Field>
      </div>
      <FormNotice error={add.error ?? waive.error} />
      <Button className="mt-3" disabled={!invoice || !(Number(amount) > 0) || !reason.trim() || add.isPending} onClick={() => add.mutate()}>Add late fee</Button>
    </Dialog>
  )
}

function ScholarshipDialog({ hub, onClose }: { hub: Hub; onClose: () => void }) {
  return (
    <Dialog onClose={onClose} title="Scholarships and concessions" width="48rem" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <ConcessionTable hub={hub} />
    </Dialog>
  )
}

function ConcessionTable({ hub }: { hub: Hub }) {
  return (
    <Table head={['Fee type', 'Kind', 'Amount', 'Reason', 'Requested', 'Requested by', 'Status', 'Approved by']} empty={!hub.concessions.length} emptyLabel="No concessions or scholarships.">
      {hub.concessions.map((x) => (
        <tr key={x.id}>
          <Td>{x.fee_type}</Td><Td className="capitalize">{x.kind.replace(/_/g, ' ')}</Td>
          <Td className="whitespace-nowrap tabular-nums">{x.amount_paise !== null ? formatPaise(x.amount_paise) : x.percent ? `${x.percent}%` : '-'}</Td>
          <Td>{x.reason || '-'}</Td><Td className="whitespace-nowrap">{formatDate(x.created_at)}</Td><Td>{x.requested_by || '-'}</Td>
          <Td><Badge tone={x.status === 'approved' ? 'success' : x.status === 'rejected' ? 'danger' : 'warning'}>{x.status}</Badge></Td><Td>{x.approved_by || '-'}</Td>
        </tr>
      ))}
    </Table>
  )
}

/* ------------------------------------------------------------------ fee details */
function YearPick({ hub, value, onChange }: { hub: Hub; value: string; onChange: (v: string) => void }) {
  return <div className="w-56 max-w-full"><Select value={value} onChange={onChange} options={hub.years.filter((y) => y.is_current || hub.lines.some((l) => l.academic_year_id === y.id)).map((y) => ({ value: y.id, label: y.name + (y.is_current ? ' (current)' : '') }))} /></div>
}
function useYear(hub: Hub) {
  const cur = hub.years.find((y) => y.is_current)?.id ?? hub.lines[0]?.academic_year_id ?? ''
  return useState(cur)
}
function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className={cn(TAB_BAR, 'px-[var(--card-pad)]')} role="tablist">
      {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={value === k} className={tabClass(value === k)} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  )
}

function FeeDetails({ hub }: { hub: Hub }) {
  const [year, setYear] = useYear(hub)
  const [tab, setTab] = useState<'type' | 'instalment' | 'month' | 'refunds' | 'concessions' | 'remove'>('type')
  const lines = hub.lines.filter((l) => l.academic_year_id === year)
  const byType = useMemo(() => {
    const m = new Map<string, { fee: number; con: number; net: number; paid: number; bal: number; n: number }>()
    for (const l of lines) { const v = m.get(l.fee_type) ?? { fee: 0, con: 0, net: 0, paid: 0, bal: 0, n: 0 }; v.fee += l.amount_paise; v.con += l.concession_paise; v.net += l.net_paise; v.paid += l.paid_paise; v.bal += l.balance_paise; v.n++; m.set(l.fee_type, v) }
    return [...m.entries()]
  }, [lines])
  const sum = (k: 'amount_paise' | 'concession_paise' | 'net_paise' | 'paid_paise' | 'balance_paise') => lines.reduce((a, l) => a + l[k], 0)
  const byMonth = useMemo(() => {
    const m = new Map<string, { due: number; paid: number; bal: number }>()
    for (const l of lines) { const k = (l.due_on ?? '').slice(0, 7) || 'No date'; const v = m.get(k) ?? { due: 0, paid: 0, bal: 0 }; v.due += l.net_paise; v.paid += l.paid_paise; v.bal += l.balance_paise; m.set(k, v) }
    return [...m.entries()].sort()
  }, [lines])
  const removeReqs = hub.requests.filter((r) => r.kind === 'remove_fee')
  return (
    <Card>
      <CardHeader title="Fee details" action={<div className="flex flex-wrap items-center gap-2"><YearPick hub={hub} value={year} onChange={setYear} /><PrintButton scope="card" title="Fee details" subtitle={hub.student.full_name} /></div>} />
      <SubTabs value={tab} onChange={setTab} tabs={[['type', 'Fee type wise'], ['instalment', 'Instalment wise'], ['month', 'Month wise'], ['refunds', 'Refunds'], ['concessions', 'Concessions'], ['remove', 'Remove fees']] as const} />
      {tab === 'type' && (
        <Table head={['Fee type', 'Fee', 'Concession', 'Net', 'Paid', 'Balance', 'Status']} empty={!byType.length} emptyLabel="No fees for this year.">
          {byType.map(([k, v]) => (
            <tr key={k}><Td className="font-medium">{k}</Td><Td className="tabular-nums">{formatPaise(v.fee)}</Td><Td className="tabular-nums">{formatPaise(v.con)}</Td><Td className="tabular-nums">{formatPaise(v.net)}</Td>
              <Td className="tabular-nums">{formatPaise(v.paid)}</Td><Td className="tabular-nums font-medium">{formatPaise(v.bal)}</Td><Td><LineStatus s={v.bal <= 0 ? 'paid' : v.paid > 0 ? 'part_paid' : 'unpaid'} /></Td></tr>
          ))}
          {byType.length > 0 && <tr className="border-t-2 bg-muted/40 font-semibold"><Td>Total</Td><Td className="tabular-nums">{formatPaise(sum('amount_paise'))}</Td><Td className="tabular-nums">{formatPaise(sum('concession_paise'))}</Td><Td className="tabular-nums">{formatPaise(sum('net_paise'))}</Td><Td className="tabular-nums">{formatPaise(sum('paid_paise'))}</Td><Td className="tabular-nums">{formatPaise(sum('balance_paise'))}</Td><Td /></tr>}
        </Table>
      )}
      {tab === 'instalment' && (
        <Table head={['No', 'Instalment', 'Fee type', 'Account', 'Fee', 'Concession', 'Net', 'Paid', 'Balance', 'Due date', 'Status']} empty={!lines.length} emptyLabel="No fees for this year.">
          {lines.map((l, i) => (
            <tr key={l.line_id}><Td>{i + 1}</Td><Td className="whitespace-nowrap">{inst(l.instalment_no)}</Td><Td className="font-medium">{l.description}</Td><Td>{l.account || '-'}</Td>
              <Td className="tabular-nums">{formatPaise(l.amount_paise)}</Td><Td className="tabular-nums">{formatPaise(l.concession_paise)}</Td><Td className="tabular-nums">{formatPaise(l.net_paise)}</Td>
              <Td className="tabular-nums">{formatPaise(l.paid_paise)}</Td><Td className="tabular-nums font-medium">{formatPaise(l.balance_paise)}</Td><Td className="whitespace-nowrap">{formatDate(l.due_on)}</Td><Td><LineStatus s={l.status} /></Td></tr>
          ))}
        </Table>
      )}
      {tab === 'month' && (
        <Table head={['Month due', 'Fee', 'Paid', 'Balance', 'Status']} empty={!byMonth.length} emptyLabel="No fees for this year.">
          {byMonth.map(([m, v]) => (
            <tr key={m}><Td className="whitespace-nowrap">{m === 'No date' ? m : new Date(m + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</Td>
              <Td className="tabular-nums">{formatPaise(v.due)}</Td><Td className="tabular-nums">{formatPaise(v.paid)}</Td><Td className="tabular-nums font-medium">{formatPaise(v.bal)}</Td><Td><LineStatus s={v.bal <= 0 ? 'paid' : v.paid > 0 ? 'part_paid' : 'unpaid'} /></Td></tr>
          ))}
        </Table>
      )}
      {tab === 'refunds' && (
        <Table head={['Date', 'Amount', 'Mode', 'Reason', 'Status']} empty={!hub.refunds.length} emptyLabel="No refunds.">
          {hub.refunds.map((r) => <tr key={r.id}><Td>{formatDate(r.created_at)}</Td><Td className="tabular-nums">{formatPaise(r.amount_paise)}</Td><Td>{r.mode ? modeName(r.mode) : '-'}</Td><Td>{r.reason || '-'}</Td><Td><Badge tone={r.status === 'processed' ? 'success' : 'warning'}>{r.status}</Badge></Td></tr>)}
        </Table>
      )}
      {tab === 'concessions' && <ConcessionTable hub={hub} />}
      {tab === 'remove' && <RemoveFees hub={hub} lines={lines} reqs={removeReqs} />}
    </Card>
  )
}

function RequestForm({ hub, kind, payment, line, payload, label, minReason = 5, onDone, extra }: {
  hub: Hub; kind: string; payment?: string; line?: string; payload?: Record<string, unknown>; label: string; minReason?: number; onDone?: () => void; extra?: boolean
}) {
  const toast = useToast()
  const refresh = useRefresh(hub.student.id)
  const [reason, setReason] = useState('')
  const send = useMutation({
    mutationFn: () => api.post('/api/v1/fees/hub/requests', { student_id: hub.student.id, kind, payment_id: payment, invoice_line_id: line, payload, reason: reason.trim() }),
    onSuccess: async () => { toast.ok('Sent for approval'); setReason(''); await refresh(); onDone?.() },
  })
  return (
    <div className="space-y-2">
      <Field label={`Reason (at least ${minReason} characters)`}><Input value={reason} onChange={setReason} /></Field>
      <FormNotice error={send.error} />
      <Button needsNetwork disabled={reason.trim().length < minReason || send.isPending || extra === false} onClick={() => send.mutate()}>{label}</Button>
    </div>
  )
}

function RemoveFees({ hub, lines, reqs }: { hub: Hub; lines: Line[]; reqs: Req[] }) {
  const [line, setLine] = useState('')
  const removable = lines.filter((l) => l.paid_paise === 0)
  return (
    <div className="space-y-4 p-[var(--card-pad)]">
      <p className="text-[13px] text-muted-foreground">A fee is removed only after approval, and never once money is paid on it.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fee line"><Select value={line} onChange={setLine} placeholder="Choose" options={removable.map((l) => ({ value: l.line_id, label: `${l.description} · ${inst(l.instalment_no)} · ${formatPaise(l.net_paise)}` }))} /></Field>
        {line && <RequestForm hub={hub} kind="remove_fee" line={line} label="Send for approval" onDone={() => setLine('')} />}
      </div>
      <Requests rows={reqs} embedded />
    </div>
  )
}

/* ------------------------------------------------------------------ transactions */
function Transactions({ hub }: { hub: Hub }) {
  const [tab, setTab] = useState<'all' | 'account' | 'mode' | 'fy' | 'online' | 'cheque' | 'cancelled'>('all')
  const [view, setView] = useState<string | null>(null)
  const [req, setReq] = useState<{ id: string; kind: 'cancel' | 'change' } | null>(null)
  const school = useSchool()
  const can = useCan()
  const rows = hub.receipts.filter((r) => tab === 'online' ? !!r.gateway || r.mode === 'online' : tab === 'cheque' ? r.mode === 'cheque' || r.mode === 'dd' : tab === 'cancelled' ? r.status === 'cancelled' || r.status === 'bounced' : true)
  const group = (key: (r: Rcpt) => string) => {
    const m = new Map<string, { nos: string[]; total: number }>()
    for (const r of hub.receipts.filter((x) => x.status === 'success')) { const k = key(r); const v = m.get(k) ?? { nos: [], total: 0 }; v.nos.push(r.receipt_no); v.total += r.amount_paise; m.set(k, v) }
    return [...m.entries()]
  }
  const fy = (d: string) => { const y = Number(d.slice(0, 4)), mo = Number(d.slice(5, 7)); const s = mo < 4 ? y - 1 : y; return `FY ${s}-${String((s + 1) % 100).padStart(2, '0')}` }
  const thermal = async (id: string) => { const r = await api.call('GET /fees/receipts/{id}', { params: { id } }); printHtml(thermalHtml(r, school)) }
  const print = async (id: string) => { const r = await api.call('GET /fees/receipts/{id}', { params: { id } }); printHtml(receiptTwoCopiesHtml(r, school)) }
  const onlineStatus = (r: Rcpt) => (r.status === 'success' ? 'Paid' : r.status === 'pending' ? 'Pending' : r.status === 'failed' ? 'Failed' : r.status)
  return (
    <Card>
      {view && <ReceiptDialog paymentId={view} onClose={() => setView(null)} />}
      {req && (
        <Dialog onClose={() => setReq(null)} title={req.kind === 'cancel' ? 'Cancel this receipt' : 'Change this receipt'}>
          <p className="mb-3 text-[13px] text-muted-foreground">{req.kind === 'cancel' ? 'The receipt keeps its number and moves to Cancelled once approved. The money comes off the fee lines it paid.' : 'Mode, UTR, date or remarks change once approved. The amount and receipt number do not change.'}</p>
          {req.kind === 'change' ? <ChangeForm hub={hub} paymentId={req.id} onDone={() => setReq(null)} /> : <RequestForm hub={hub} kind="cancel" payment={req.id} label="Send for approval" minReason={10} onDone={() => setReq(null)} />}
        </Dialog>
      )}
      <CardHeader title="Transactions" action={<PrintButton scope="card" title="Transactions" subtitle={hub.student.full_name} />} />
      <SubTabs value={tab} onChange={setTab} tabs={[['all', 'Transactions'], ['account', 'Fee account'], ['mode', 'Payment mode'], ['fy', 'FY wise'], ['online', 'Online payments'], ['cheque', 'Cheque payments'], ['cancelled', 'Cancelled']] as const} />
      {(tab === 'account' || tab === 'mode' || tab === 'fy') ? (
        <Table head={[tab === 'account' ? 'Receiving account' : tab === 'mode' ? 'Mode' : 'Financial year', 'Receipts', 'Amount']} empty={!hub.receipts.length} emptyLabel="No receipts.">
          {group((r) => tab === 'account' ? r.receiving_account || 'Not recorded' : tab === 'mode' ? modeName(r.mode) : fy(r.paid_on)).map(([k, v]) => (
            <tr key={k}><Td className="font-medium">{k}</Td><Td className="font-mono text-[12px]">{v.nos.join(', ')}</Td><Td className="tabular-nums">{formatPaise(v.total)}</Td></tr>
          ))}
        </Table>
      ) : (
        <Table head={['S.No', 'Receipt date', 'Entry', 'Transaction ID / Receipt no', 'Receiving account', 'Mode', 'Fee paid', 'Total', 'Status', 'Actions']} empty={!rows.length} emptyLabel="No receipts here.">
          {rows.map((r, i) => (
            <tr key={r.id}>
              <Td>{i + 1}</Td>
              <Td className="whitespace-nowrap">{formatDate(r.paid_on)}</Td>
              <Td className="whitespace-nowrap text-muted-foreground">{time(r.created_at)}<span className="block">{r.collector ? `by ${r.collector}` : ''}</span></Td>
              <Td className="font-mono text-[12px]">{r.txn_id || '-'}<button type="button" className="block text-primary hover:underline" onClick={() => setView(r.id)}>Rec. no {r.receipt_no || '-'}</button></Td>
              <Td>{r.receiving_account || '-'}</Td>
              <Td className="whitespace-nowrap">{modeName(r.mode)}{r.reference && <span className="block font-mono text-[11.5px] text-muted-foreground">{r.mode === 'cheque' || r.mode === 'dd' ? 'No' : 'UTR'} {r.reference}</span>}</Td>
              <Td className="min-w-[12rem]">{r.lines.length ? r.lines.map((x, k) => (
                <span key={k} className="flex justify-between gap-3"><span>{x.fee_type} - {inst(x.instalment_no)}</span><span className="tabular-nums">{formatPaise(x.amount_paise)}</span></span>
              )) : <span className="text-muted-foreground">{r.status === 'pending' ? 'Lands on the fee lines when it clears' : '-'}</span>}</Td>
              <Td className="whitespace-nowrap font-medium tabular-nums">{formatPaise(r.amount_paise)}</Td>
              <Td><Badge tone={r.status === 'success' ? 'success' : r.status === 'pending' ? 'warning' : 'danger'}>{tab === 'online' ? onlineStatus(r) : r.status === 'success' ? 'Paid' : r.status === 'pending' ? 'Cheque held' : r.status === 'bounced' ? 'Bounced' : 'Cancelled'}</Badge></Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void print(r.id)}>Print</Button>
                  <Button size="sm" variant="ghost" onClick={() => void thermal(r.id)}>Thermal</Button>
                  <Button size="sm" variant="ghost" onClick={() => void saveFile(`/api/v1/fees/receipts/${r.id}/pdf`, `receipt-${r.receipt_no}.pdf`)}>PDF</Button>
                  {can('finance.payments.write') && (r.status === 'success' || r.status === 'pending') && <>
                    <Button size="sm" variant="ghost" tone="danger" onClick={() => setReq({ id: r.id, kind: 'cancel' })}>Cancel</Button>
                    <Button size="sm" variant="ghost" onClick={() => setReq({ id: r.id, kind: 'change' })}>Change request</Button>
                  </>}
                </div>
              </Td>
            </tr>
          ))}
          {rows.length > 0 && <tr className="border-t-2 bg-muted/40 font-semibold"><Td colSpan={7}>Total</Td><Td className="tabular-nums">{formatPaise(rows.filter((r) => r.status === 'success').reduce((a, r) => a + r.amount_paise, 0))}</Td><Td colSpan={2} /></tr>}
        </Table>
      )}
    </Card>
  )
}

function ChangeForm({ hub, paymentId, onDone }: { hub: Hub; paymentId: string; onDone: () => void }) {
  const r = hub.receipts.find((x) => x.id === paymentId)!
  const [mode, setMode] = useState(r.mode)
  const [ref, setRef] = useState(r.reference)
  const [paidOn, setPaidOn] = useState(r.paid_on)
  const [remarks, setRemarks] = useState('')
  return (
    <div className="space-y-3">
      <FormGrid>
        <Field label="Mode"><Select value={mode} onChange={setMode} options={['cash', 'upi', 'card', 'neft', 'cheque', 'dd'].map((m) => ({ value: m, label: modeName(m) }))} /></Field>
        <Field label="UTR / cheque no"><Input value={ref} onChange={setRef} /></Field>
        <Field label="Receipt date"><Input type="date" value={paidOn} onChange={setPaidOn} max={todayISO()} /></Field>
        <Field label="Remarks"><Input value={remarks} onChange={setRemarks} /></Field>
      </FormGrid>
      <RequestForm hub={hub} kind="change" payment={paymentId} payload={{ mode, reference_no: ref, paid_on: paidOn, remarks }} label="Send for approval" onDone={onDone} />
    </div>
  )
}

/* ------------------------------------------------------------------ fee management */
function FeeManagement({ hub }: { hub: Hub }) {
  const toast = useToast()
  const refresh = useRefresh(hub.student.id)
  const [year, setYear] = useYear(hub)
  const [tab, setTab] = useState<'regular' | 'misc' | 'log'>('regular')
  const [plan, setPlan] = useState<Record<string, string>>({})
  const lines = hub.lines.filter((l) => l.academic_year_id === year)
  const assigned = useMemo(() => {
    const m = new Map<string, { fee: number; con: number; paid: number; bal: number; n: number }>()
    for (const l of lines) { const v = m.get(l.fee_type) ?? { fee: 0, con: 0, paid: 0, bal: 0, n: 0 }; v.fee += l.amount_paise; v.con += l.concession_paise; v.paid += l.paid_paise; v.bal += l.balance_paise; v.n++; m.set(l.fee_type, v) }
    return [...m.entries()]
  }, [lines])
  const avail = useQuery({ queryKey: ['fee-hub', hub.student.id, 'avail', year], queryFn: () => api.get<Hub>(`/api/v1/fees/hub/students/${hub.student.id}?year=${year}`), select: (d) => d.available })
  const assign = useMutation({
    mutationFn: (head: string) => api.post<{ invoices: string[] }>('/api/v1/fees/hub/assign', { student_id: hub.student.id, fee_head_id: head, fee_structure_id: plan[head] }),
    onSuccess: async (r, head) => { toast.ok(`Assigned: ${r.invoices.length} instalment${r.invoices.length === 1 ? '' : 's'} billed`); setPlan((p) => { const n = { ...p }; delete n[head]; return n }); await refresh(); await avail.refetch() },
  })
  return (
    <Card>
      <CardHeader title="Fee management" action={<div className="flex flex-wrap items-center gap-2"><YearPick hub={hub} value={year} onChange={setYear} /><PrintButton scope="card" title="Fee management" subtitle={hub.student.full_name} /></div>} />
      <SubTabs value={tab} onChange={setTab} tabs={[['regular', 'Regular fee'], ['misc', 'Misc. fee'], ['log', 'Fee log']] as const} />
      {tab === 'regular' && (
        <>
          <Table head={['S.No', 'Fee type', 'Instalments', 'Fee amount', 'Concession', 'Paid', 'Balance', 'Status']} empty={!assigned.length} emptyLabel="No fees assigned for this year.">
            {assigned.map(([k, v], i) => (
              <tr key={k}><Td>{i + 1}</Td><Td className="font-medium">{k}</Td><Td>{v.n}</Td><Td className="tabular-nums">{formatPaise(v.fee)}</Td><Td className="tabular-nums">{formatPaise(v.con)}</Td>
                <Td className="tabular-nums">{formatPaise(v.paid)}</Td><Td className="tabular-nums">{formatPaise(v.bal)}</Td><Td><LineStatus s={v.bal <= 0 ? 'paid' : v.paid > 0 ? 'part_paid' : 'unpaid'} /></Td></tr>
            ))}
          </Table>
          <div className="border-t px-[var(--card-pad)] pt-4 text-[14px] font-semibold">Available fee types (not yet assigned)</div>
          <Table head={['Fee type', 'Fee plan', 'Plan amount', '']} loading={avail.isLoading} empty={!avail.data?.length} emptyLabel="Every fee type with a plan this year is assigned.">
            {(avail.data ?? []).map((a) => {
              const chosen = a.plans.find((p) => p.structure_id === plan[a.fee_head_id])
              return (
                <tr key={a.fee_head_id}>
                  <Td className="font-medium">{a.fee_type}{a.optional && <Badge tone="neutral" className="ml-2">Optional</Badge>}</Td>
                  <Td className="min-w-[14rem]"><Select value={plan[a.fee_head_id] ?? ''} onChange={(v) => setPlan((p) => ({ ...p, [a.fee_head_id]: v }))} placeholder="Select fee plan"
                    options={a.plans.map((p) => ({ value: p.structure_id, label: `${p.plan} (${p.class_name}) · ${formatPaise(p.amount_paise)}` }))} /></Td>
                  <Td className="whitespace-nowrap tabular-nums">{chosen ? `${formatPaise(chosen.amount_paise)} in ${chosen.instalments}` : '-'}</Td>
                  <Td><Button size="sm" needsNetwork disabled={!chosen || assign.isPending} onClick={() => assign.mutate(a.fee_head_id)}>Assign</Button></Td>
                </tr>
              )
            })}
          </Table>
          <div className="px-[var(--card-pad)] pb-4"><FormNotice error={assign.error} /><p className="text-[12.5px] text-muted-foreground">Transport and after-school activities are assigned the same way, by their plan (route or activity). Each instalment of the plan is billed with its own due date.</p></div>
        </>
      )}
      {tab === 'misc' && <MiscFee hub={hub} />}
      {tab === 'log' && (
        <Table head={['When', 'Who', 'What', 'Before', 'After', 'IP']} empty={!hub.logs.length} emptyLabel="No changes yet.">
          {hub.logs.map((g, i) => (
            <tr key={i}><Td className="whitespace-nowrap">{time(g.created_at)}</Td><Td>{g.who || '-'}</Td><Td>{actionName(g.action)}</Td>
              <Td className="min-w-[10rem] text-[12.5px]">{summary(g.before)}</Td><Td className="min-w-[10rem] text-[12.5px]">{summary(g.after)}</Td><Td className="font-mono text-[12px]">{g.ip || '-'}</Td></tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

function MiscFee({ hub }: { hub: Hub }) {
  const toast = useToast()
  const refresh = useRefresh(hub.student.id)
  const heads = useQuery({ queryKey: ['fee-heads'], queryFn: () => api.get<{ items: { id: string; name: string }[] }>('/api/v1/setup/fee-heads') })
  const [f, setF] = useState({ fee_head_id: '', item: '', rate: '', qty: '1', concession: '', due_on: todayISO() })
  const save = useMutation({
    mutationFn: () => api.post<{ invoice_no: string }>('/api/v1/fees/hub/misc', { student_id: hub.student.id, fee_head_id: f.fee_head_id, item: f.item, rate_paise: rupeesToPaise(f.rate), qty: Number(f.qty), concession_paise: rupeesToPaise(f.concession || '0'), due_on: f.due_on }),
    onSuccess: async (r) => { toast.ok(`Billed on ${r.invoice_no}`); setF({ ...f, item: '', rate: '', qty: '1', concession: '' }); await refresh() },
  })
  return (
    <div className="space-y-3 p-[var(--card-pad)]">
      <FormGrid>
        <Field label="Item (lost library book, uniform, ID card)"><Input value={f.item} onChange={(v) => setF({ ...f, item: v })} /></Field>
        <Field label="Fee type"><Select value={f.fee_head_id} onChange={(v) => setF({ ...f, fee_head_id: v })} placeholder="Choose" options={(heads.data?.items ?? []).map((h) => ({ value: h.id, label: h.name }))} /></Field>
        <Field label="Rate (₹)"><Input value={f.rate} onChange={(v) => setF({ ...f, rate: v })} type="number" /></Field>
        <Field label="Quantity"><Input value={f.qty} onChange={(v) => setF({ ...f, qty: v })} type="number" /></Field>
        <Field label="Concession (₹)"><Input value={f.concession} onChange={(v) => setF({ ...f, concession: v })} type="number" /></Field>
        <Field label="Due date"><Input value={f.due_on} onChange={(v) => setF({ ...f, due_on: v })} type="date" /></Field>
      </FormGrid>
      <FormNotice error={save.error} />
      <Button needsNetwork disabled={!f.item.trim() || !f.fee_head_id || !(Number(f.rate) > 0) || save.isPending} onClick={() => save.mutate()}>Assign {f.rate ? formatPaise(rupeesToPaise(f.rate) * Math.max(1, Number(f.qty) || 1) - rupeesToPaise(f.concession || '0')) : ''}</Button>
    </div>
  )
}

/* ------------------------------------------------------------------ cheques */
function Cheques({ hub, kind }: { hub: Hub; kind: 'bounce' | 'pdc' }) {
  const toast = useToast()
  const refresh = useRefresh(hub.student.id)
  const t = todayISO()
  const cheques = hub.receipts.filter((r) => r.mode === 'cheque' || r.mode === 'dd')
  const rows = kind === 'bounce' ? cheques.filter((r) => r.status === 'bounced' || r.status === 'pending') : cheques.filter((r) => r.status === 'pending' && (r.cheque_date ?? '') > t)
  const act = useMutation({
    mutationFn: (v: { id: string; what: 'clear' | 'bounce' }) => api.post(`/api/v1/fees/payments/${v.id}/${v.what}`, v.what === 'bounce' ? {} : undefined),
    onSuccess: async (_r, v) => { toast.ok(v.what === 'clear' ? 'Cheque cleared; the money is on its fee lines' : 'Cheque marked bounced'); await refresh() },
  })
  return (
    <Card>
      <CardHeader title={kind === 'bounce' ? 'Cheque bounce' : 'Post-dated cheques'} action={<PrintButton scope="card" title={kind === 'bounce' ? 'Cheque bounce' : 'Post-dated cheques'} subtitle={hub.student.full_name} />} />
      <Table head={['Cheque no', 'Bank', 'Cheque date', 'Receipt no', 'Amount', 'Status', '']} empty={!rows.length} emptyLabel={kind === 'bounce' ? 'No held or bounced cheques.' : 'No post-dated cheques.'}>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-mono text-[12px]">{r.reference || '-'}</Td><Td>{r.bank_name || '-'}</Td><Td className="whitespace-nowrap">{formatDate(r.cheque_date)}</Td>
            <Td className="font-mono text-[12px]">{r.receipt_no}</Td><Td className="tabular-nums">{formatPaise(r.amount_paise)}</Td>
            <Td><Badge tone={r.status === 'bounced' ? 'danger' : 'warning'}>{r.status === 'bounced' ? 'Bounced' : 'Held'}</Badge></Td>
            <Td>{r.status === 'pending' && (
              <div className="flex gap-1">
                <Button size="sm" variant="outline" disabled={act.isPending || (r.cheque_date ?? '') > t} title={(r.cheque_date ?? '') > t ? 'Not yet due' : undefined} onClick={() => act.mutate({ id: r.id, what: 'clear' })}>Cleared</Button>
                <Button size="sm" variant="ghost" tone="danger" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, what: 'bounce' })}>Bounced</Button>
              </div>
            )}</Td>
          </tr>
        ))}
      </Table>
      <div className="px-[var(--card-pad)] pb-4"><FormNotice error={act.error} />{kind === 'bounce' && <p className="text-[12.5px] text-muted-foreground">A bounced cheque comes off the fee lines and the school's bounce charge, if set under Fee setup, is added to the bill.</p>}</div>
    </Card>
  )
}

/* ------------------------------------------------------------------ due dates */
function DueDates({ hub }: { hub: Hub }) {
  const toast = useToast()
  const refresh = useRefresh(hub.student.id)
  const bills = [...new Map(hub.lines.filter((l) => l.balance_paise > 0).map((l) => [l.invoice_id, l])).values()]
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: (id: string) => api.post('/api/v1/fees/hub/due-date', { invoice_id: id, due_on: edit[id], reason: reason.trim() }),
    onSuccess: async () => { toast.ok('Due date saved'); await refresh() },
  })
  return (
    <Card>
      <CardHeader title="Due dates for this student" action={<PrintButton scope="card" title="Due dates" subtitle={hub.student.full_name} />} />
      <div className="p-[var(--card-pad)] pb-0"><Field label="Reason for the change (at least 5 characters)"><Input value={reason} onChange={setReason} /></Field></div>
      <Table head={['Bill', 'Fee', 'Instalment', 'Balance', 'Due date', 'New date for this student', '']} empty={!bills.length} emptyLabel="Nothing unpaid.">
        {bills.map((b) => (
          <tr key={b.invoice_id}>
            <Td className="font-mono text-[12px]">{b.invoice_no}</Td><Td>{hub.lines.filter((l) => l.invoice_id === b.invoice_id).map((l) => l.fee_type).join(', ')}</Td>
            <Td className="whitespace-nowrap">{inst(b.instalment_no)}</Td><Td className="tabular-nums">{formatPaise(hub.lines.filter((l) => l.invoice_id === b.invoice_id).reduce((a, l) => a + l.balance_paise, 0))}</Td>
            <Td className="whitespace-nowrap">{formatDate(b.due_on)}</Td>
            <Td className="min-w-[10rem]"><Input type="date" value={edit[b.invoice_id] ?? b.due_on ?? ''} onChange={(v) => setEdit((e) => ({ ...e, [b.invoice_id]: v }))} srLabel={`New due date for ${b.invoice_no}`} /></Td>
            <Td><Button size="sm" disabled={!edit[b.invoice_id] || edit[b.invoice_id] === b.due_on || reason.trim().length < 5 || save.isPending} onClick={() => save.mutate(b.invoice_id)}>Save</Button></Td>
          </tr>
        ))}
      </Table>
      <div className="px-[var(--card-pad)] pb-4"><FormNotice error={save.error} /></div>
    </Card>
  )
}

/* ------------------------------------------------------------------ edit fee amount */
function EditAmount({ hub }: { hub: Hub }) {
  const [line, setLine] = useState('')
  const [amount, setAmount] = useState('')
  const l = hub.lines.find((x) => x.line_id === line)
  return (
    <Card>
      <CardHeader title="Edit fee amount" />
      <div className="space-y-3 p-[var(--card-pad)]">
        <p className="text-[13px] text-muted-foreground">The new amount applies once approved. It cannot go below what is already paid on the line.</p>
        <FormGrid>
          <Field label="Fee line"><Select value={line} onChange={(v) => { setLine(v); setAmount('') }} placeholder="Choose" options={hub.lines.filter((x) => x.invoice_status !== 'cancelled').map((x) => ({ value: x.line_id, label: `${x.year} · ${x.description} · ${inst(x.instalment_no)} · ${formatPaise(x.amount_paise)}` }))} /></Field>
          <Field label="New amount (₹)" hint={l ? `Now ${formatPaise(l.amount_paise)}, paid ${formatPaise(l.paid_paise)}` : undefined}><Input value={amount} onChange={setAmount} type="number" /></Field>
        </FormGrid>
        {l && <RequestForm hub={hub} kind="edit_amount" line={l.line_id} payload={{ amount_paise: rupeesToPaise(amount || '0') }} label="Send for approval" extra={rupeesToPaise(amount || '0') > 0} onDone={() => { setLine(''); setAmount('') }} />}
        <Requests rows={hub.requests.filter((r) => r.kind === 'edit_amount')} embedded />
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ transfer */
function Transfer({ hub }: { hub: Hub }) {
  const [tab, setTab] = useState<'money' | 'class' | 'log'>('money')
  const [receipt, setReceipt] = useState('')
  const [to, setTo] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const needle = useDebouncedValue(q.trim())
  const found = useQuery({ queryKey: ['fee-search', needle, 'transfer'], queryFn: () => api.call('GET /students', { query: { q: needle, limit: 10 } }), enabled: needle.length >= 2 })
  const target = useQuery({ queryKey: ['fee-hub', to], queryFn: () => api.get<Hub>(`/api/v1/fees/hub/students/${to}`), enabled: !!to })
  const sections = useQuery({ queryKey: ['sections'], queryFn: () => api.get<{ items: { id: string; name: string; class_id: string; class_name?: string }[] }>('/api/v1/academics/sections') })
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api.get<{ items: { id: string; name: string }[] }>('/api/v1/academics/classes') })
  const [section, setSection] = useState('')
  const r = hub.receipts.find((x) => x.id === receipt)
  const className = (id: string) => classes.data?.items.find((c) => c.id === id)?.name ?? ''
  const moves = hub.requests.filter((x) => x.kind === 'transfer' || x.kind === 'class_change')
  return (
    <Card>
      <CardHeader title="Transfer" />
      <SubTabs value={tab} onChange={setTab} tabs={[['money', 'Move money to another student'], ['class', 'Change class / section'], ['log', 'Transfer log']] as const} />
      {tab === 'money' && (
        <div className="space-y-4 p-[var(--card-pad)]">
          <p className="text-[13px] text-muted-foreground">Paid for the wrong child, or a sibling adjustment. The whole receipt moves, keeping its number, and lands on the other child's oldest dues once approved.</p>
          <FormGrid>
            <Field label="From receipt"><Select value={receipt} onChange={setReceipt} placeholder="Choose" options={hub.receipts.filter((x) => x.status === 'success').map((x) => ({ value: x.id, label: `${x.receipt_no} · ${formatDate(x.paid_on)} · ${formatPaise(x.amount_paise)}` }))} /></Field>
            <Field label="To student"><Input value={q} onChange={setQ} placeholder="Name or admission no." /></Field>
          </FormGrid>
          {needle.length >= 2 && (
            <Table head={['Admission no.', 'Name', 'Class', '']} loading={found.isLoading} empty={!found.data?.items.filter((s) => s.id !== hub.student.id).length} emptyLabel="No other student matches.">
              {(found.data?.items ?? []).filter((s) => s.id !== hub.student.id).map((s) => (
                <tr key={s.id}><Td className="font-mono text-[12px]">{s.admission_no}</Td><Td>{s.full_name}</Td><Td>{s.class_name ? `${s.class_name}-${s.section_name}` : '-'}</Td>
                  <Td><Button size="sm" variant={to === s.id ? 'ink' : 'outline'} onClick={() => setTo(s.id)}>{to === s.id ? 'Chosen' : 'Choose'}</Button></Td></tr>
              ))}
            </Table>
          )}
          {r && to && target.data && (
            <>
              <Table head={['', 'This student', target.data.student.full_name]} empty={false}>
                <tr><Td>Balance now</Td><Td className="tabular-nums">{formatPaise(hub.totals.balance_paise)}</Td><Td className="tabular-nums">{formatPaise(target.data.totals.balance_paise)}</Td></tr>
                <tr><Td>After transfer</Td><Td className="tabular-nums">{formatPaise(hub.totals.balance_paise + r.amount_paise)}</Td><Td className="tabular-nums">{formatPaise(target.data.totals.balance_paise - r.amount_paise)}</Td></tr>
              </Table>
              <RequestForm hub={hub} kind="transfer" payment={r.id} payload={{ to_student_id: to, to_name: target.data.student.full_name, amount_paise: r.amount_paise }} label="Send for approval" minReason={10} onDone={() => { setReceipt(''); setTo(null); setQ('') }} />
            </>
          )}
        </div>
      )}
      {tab === 'class' && (
        <div className="space-y-4 p-[var(--card-pad)]">
          <p className="text-[13px] text-muted-foreground">Now {hub.student.class_name}-{hub.student.section_name}. The child keeps the same fees; money already paid stays on them. Raise a different plan afterwards under Fee management if the new class costs differently.</p>
          <Field label="Move to section"><Select value={section} onChange={setSection} placeholder="Choose" options={(sections.data?.items ?? []).filter((s) => s.id !== hub.student.section_id).map((s) => ({ value: s.id, label: `${className(s.class_id)} - ${s.name}` }))} /></Field>
          {section && <RequestForm hub={hub} kind="class_change" payload={{ section_id: section }} label="Send for approval" onDone={() => setSection('')} />}
        </div>
      )}
      {tab === 'log' && <Requests rows={moves} embedded />}
    </Card>
  )
}

/* ------------------------------------------------------------------ requests and approvals */
export function Requests({ rows, embedded, all }: { rows: Req[]; embedded?: boolean; all?: boolean }) {
  const toast = useToast()
  const can = useCan()
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) => api.post(`/api/v1/fees/hub/requests/${v.id}/decide`, { approve: v.approve, note: note.trim() }),
    onSuccess: async (_r, v) => { toast.ok(v.approve ? 'Approved and done' : 'Rejected'); setNote(''); await qc.invalidateQueries({ queryKey: ['fee-hub'] }); await qc.invalidateQueries({ queryKey: ['fee-requests'] }) },
  })
  const approver = can('finance.refunds.write')
  const detail = (r: Req) => {
    const p = r.payload
    if (r.kind === 'transfer') return `${r.receipt_no ?? ''} to ${String(p.to_name ?? '')} ${p.amount_paise ? formatPaise(Number(p.amount_paise)) : ''}`
    if (r.kind === 'edit_amount') return `New amount ${formatPaise(Number(p.amount_paise ?? 0))}`
    if (r.kind === 'change') return `${r.receipt_no ?? ''}: ${modeName(String(p.mode ?? ''))} ${String(p.reference_no ?? '')} ${p.paid_on ? formatDate(String(p.paid_on)) : ''}`
    return r.receipt_no ?? ''
  }
  const table = (
    <>
      {approver && rows.some((r) => r.status === 'pending') && <div className="p-[var(--card-pad)] pb-0"><Field label="Note with the decision (optional)"><Input value={note} onChange={setNote} /></Field></div>}
      <Table head={[...(all ? ['Student'] : []), 'Request', 'Details', 'Reason', 'Asked by', 'When', 'Status', 'Decided by', '']} empty={!rows.length} emptyLabel="No requests.">
        {rows.map((r) => (
          <tr key={r.id}>
            {all && <Td className="font-medium">{r.student}<span className="block font-mono text-[11.5px] text-muted-foreground">{r.admission_no}</span></Td>}
            <Td className="font-medium">{KIND_LABEL[r.kind] ?? r.kind}</Td><Td className="min-w-[10rem]">{detail(r)}</Td><Td className="min-w-[10rem]">{r.reason}</Td>
            <Td>{r.requested_by || '-'}</Td><Td className="whitespace-nowrap">{time(r.requested_at)}</Td>
            <Td><Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}>{r.status}</Badge></Td>
            <Td>{r.decided_by || '-'}{r.decision_note && <span className="block text-[12px] text-muted-foreground">{r.decision_note}</span>}</Td>
            <Td>{approver && r.status === 'pending' && (
              <div className="flex gap-1">
                <Button size="sm" needsNetwork disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>Approve</Button>
                <Button size="sm" variant="ghost" tone="danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false })}>Reject</Button>
              </div>
            )}</Td>
          </tr>
        ))}
      </Table>
      <div className="px-[var(--card-pad)] pb-4"><FormNotice error={decide.error} /></div>
    </>
  )
  if (embedded) return table
  return <Card><CardHeader title="Requests waiting for approval" action={<PrintButton scope="card" title="Fee requests" />} />{table}</Card>
}

export function AllRequests() {
  const [status, setStatus] = useState('pending')
  const q = useQuery({ queryKey: ['fee-requests', status], queryFn: () => api.get<{ items: Req[] }>(`/api/v1/fees/hub/requests?status=${status}`) })
  return (
    <Card>
      <CardHeader title="Fee approvals" action={<div className="flex flex-wrap items-center gap-2"><div className="w-44"><Select value={status} onChange={setStatus} options={[{ value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' }]} /></div><PrintButton scope="card" title="Fee approvals" /></div>} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? <SkeletonTable columns={6} /> : <Requests rows={q.data?.items ?? []} embedded all />}
    </Card>
  )
}

export function NoStudent() {
  return <EmptyState title="No student selected" body="Find a student above to open their fee account." />
}

/* STUDENT 360 -> FEES (owner, 2026-11-21): every fee and instalment the
   child has with Paid / Part paid / Unpaid, and every receipt with exactly
   the fee lines it paid. Shown to whoever may read payments; others see the
   tab's other cards as before. */
export function StudentFeeAccount({ studentId }: { studentId: string }) {
  const can = useCan()
  const allowed = can('finance.payments.read')
  const hub = useQuery({ queryKey: ['fee-hub', studentId], queryFn: () => api.get<Hub>(`/api/v1/fees/hub/students/${studentId}`), enabled: allowed })
  const [view, setView] = useState<string | null>(null)
  const years = hub.data ? [...new Set(hub.data.lines.map((l) => l.academic_year_id))] : []
  const [year, setYear] = useState('')
  if (!allowed || hub.isError || !hub.data || (!hub.data.lines.length && !hub.data.receipts.length)) return null
  const h = hub.data
  const y = years.includes(year) ? year : (h.years.find((x) => x.is_current && years.includes(x.id))?.id ?? years[0] ?? '')
  const lines = h.lines.filter((l) => l.academic_year_id === y)
  return (
    <>
      {view && <ReceiptDialog paymentId={view} onClose={() => setView(null)} />}
      <Card>
        <CardHeader title="Fees and instalments" action={years.length > 1 ? (
          <div className="w-44"><Select value={y} onChange={setYear} options={years.map((id) => ({ value: id, label: h.years.find((x) => x.id === id)?.name ?? '' }))} /></div>
        ) : undefined} />
        <Table head={['Fee type', 'Instalment', 'Due date', 'Amount', 'Paid', 'Balance', 'Status']} empty={!lines.length} emptyLabel="No fees for this year.">
          {lines.map((l) => (
            <tr key={l.line_id}>
              <Td className="min-w-[9rem] font-medium">{l.description}</Td><Td className="whitespace-nowrap">{inst(l.instalment_no)}</Td>
              <Td className="whitespace-nowrap text-muted-foreground">{formatDate(l.due_on)}</Td><Td className="tabular-nums">{formatPaise(l.net_paise)}</Td>
              <Td className="tabular-nums">{formatPaise(l.paid_paise)}</Td><Td className={cn('tabular-nums', l.balance_paise > 0 && 'font-medium')}>{formatPaise(l.balance_paise)}</Td>
              <Td><LineStatus s={l.status} /></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card>
        <CardHeader title="Receipts and what they paid" />
        <Table head={['Date', 'Receipt no', 'Transaction ID', 'Amount', 'Mode', 'UTR / ref no', 'Paid for', 'Status']} empty={!h.receipts.length} emptyLabel="No receipts.">
          {h.receipts.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">{formatDate(r.paid_on)}</Td>
              <Td className="font-mono text-[12px]"><button type="button" className="text-primary hover:underline" onClick={() => setView(r.id)}>{r.receipt_no || 'View'}</button></Td>
              <Td className="font-mono text-[12px]">{r.txn_id || '-'}</Td>
              <Td className="whitespace-nowrap tabular-nums">{formatPaise(r.amount_paise)}</Td>
              <Td className="whitespace-nowrap">{modeName(r.mode)}</Td>
              <Td className="whitespace-nowrap font-mono text-[12px]">{r.reference || '-'}</Td>
              <Td className="min-w-[12rem]">{r.lines.length ? r.lines.map((x, k) => (
                <span key={k} className="flex justify-between gap-3"><span>{x.fee_type} - {inst(x.instalment_no)}{x.year ? ` (${x.year})` : ''}</span><span className="tabular-nums">{formatPaise(x.amount_paise)}</span></span>
              )) : <span className="text-muted-foreground">-</span>}</Td>
              <Td><Badge tone={r.status === 'success' ? 'success' : r.status === 'pending' ? 'warning' : 'danger'}>{r.status === 'success' ? 'Paid' : r.status === 'pending' ? 'Cheque held' : r.status === 'bounced' ? 'Bounced' : 'Cancelled'}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}
