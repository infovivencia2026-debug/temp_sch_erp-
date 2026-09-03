import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Scale, BookOpen, FileText, Plus, Trash2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import {
  inr, side, rupees, toPaise, fyOptions, currentFY, useAccounts, accountOptions,
  ledgerBase, type TrialBalance, type Statements, type Voucher, type VoucherLine,
} from './ledger-lib'

/* The general ledger: post a voucher, read the books back.

   The trial balance is the reason this screen exists, and it is shown with the
   difference beside the totals rather than only the two columns. A reader
   asked to compare two eleven-digit numbers will decide they match. The
   database will not accept an unbalanced voucher, so the difference should
   always be nil — and saying so plainly is what makes a non-zero one
   impossible to miss. */

const TABS = [
  ['post', 'Post a voucher', Plus],
  ['register', 'Voucher register', BookOpen],
  ['trial', 'Trial balance', Scale],
  ['statements', 'Income & expenditure', FileText],
] as const

export default function GeneralLedger() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('trial')
  const [fy, setFy] = useState(String(currentFY()))

  const trial = useQuery({
    queryKey: ['ledgers', 'trial', fy],
    queryFn: () => api.get<TrialBalance>(`${ledgerBase}/trial-balance?fy=${fy}`),
  })

  const t = trial.data

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="General ledger and trial balance"
        description="Double-entry vouchers, the trial balance they add up to, and the income and expenditure account an auditor asks for."
        width="wide"
        actions={
          <div className="w-44">
            <Select value={fy} onChange={setFy} options={fyOptions()} />
          </div>
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Debits" value={t ? inr(t.totals.closing_debit_paise) : '—'}
            period={t ? `closing, ${t.fy_label}` : undefined} />
          <Stat label="Credits" value={t ? inr(t.totals.closing_credit_paise) : '—'}
            period={t ? `closing, ${t.fy_label}` : undefined} />
          <Stat label="Difference" value={t ? rupees(t.difference_paise) : '—'} icon={Scale}
            delta={t
              ? t.balanced
                ? { value: 'The books balance', positive: true }
                : { value: 'Out of balance — investigate before reading anything else', positive: false }
              : undefined} />
          <Stat label="Accounts with a balance" value={t?.rows.length ?? '—'}
            hint="Accounts never posted to are left off" />
        </CellGrid>

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-current={tab === k}
              className={tab === k
                ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'post' && <PostVoucher />}
        {tab === 'register' && <VoucherRegister fy={fy} />}
        {tab === 'trial' && <TrialBalanceTab query={trial} />}
        {tab === 'statements' && <StatementsTab fy={fy} />}
      </PageBody>
    </>
  )
}

interface DraftLine { account_id: string; debit: string; credit: string; memo: string }

function PostVoucher() {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [type, setType] = useState('journal')
  const [date, setDate] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([
    { account_id: '', debit: '', credit: '', memo: '' },
    { account_id: '', debit: '', credit: '', memo: '' },
  ])

  const set = (i: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)))

  const dr = lines.reduce((s, l) => s + toPaise(l.debit), 0)
  const cr = lines.reduce((s, l) => s + toPaise(l.credit), 0)
  const balanced = dr === cr && dr > 0
  const filled = lines.filter((l) => l.account_id && (toPaise(l.debit) || toPaise(l.credit)))

  const post = useMutation({
    mutationFn: () =>
      api.post<{ voucher_no: string }>(`${ledgerBase}/vouchers`, {
        voucher_type: type,
        entry_date: date || undefined,
        narration,
        lines: filled.map((l) => ({
          account_id: l.account_id,
          debit_paise: toPaise(l.debit) || undefined,
          credit_paise: toPaise(l.credit) || undefined,
          memo: l.memo || undefined,
        })),
      }),
    onSuccess: () => {
      setNarration('')
      setLines([
        { account_id: '', debit: '', credit: '', memo: '' },
        { account_id: '', debit: '', credit: '', memo: '' },
      ])
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  const options = accountOptions(accounts.data?.items)

  return (
    <Card>
      <CardHeader
        title="Post a voucher"
        description="Debits on the left, credits on the right, and the two must agree. The database refuses an entry that does not balance, so the running total below is a courtesy rather than the control."
        action={
          <Badge tone={balanced ? 'success' : dr || cr ? 'warning' : 'neutral'}>
            {dr || cr ? (balanced ? 'balanced' : `out by ${rupees(Math.abs(dr - cr))}`) : 'nothing entered'}
          </Badge>
        }
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Kind">
            <Select value={type} onChange={setType} options={[
              { value: 'journal', label: 'Journal' },
              { value: 'receipt', label: 'Receipt — money in' },
              { value: 'payment', label: 'Payment — money out' },
              { value: 'contra', label: 'Contra — between own accounts' },
              { value: 'purchase', label: 'Purchase' },
              { value: 'sales', label: 'Sales' },
            ]} />
          </Field>
          <Field label="Date" hint="Decides the financial year, and whether the books are still open for it">
            <Input type="date" value={date} onChange={setDate} />
          </Field>
          <Field label="Narration" required wide
            hint="What this voucher is for, in a sentence somebody can read next March">
            <Textarea value={narration} onChange={setNarration} rows={2}
              placeholder="Donation from the alumni association towards the library fund" />
          </Field>
        </FormGrid>

        <Table head={['Account', { label: 'Debit', align: 'right' }, { label: 'Credit', align: 'right' }, 'Note', '']}
          empty={false}>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <Select value={l.account_id} onChange={(v) => set(i, { account_id: v })}
                  placeholder="Choose an account" options={options} />
              </Td>
              <Td className="w-36">
                <Input type="number" value={l.debit} placeholder="0"
                  onChange={(v) => set(i, { debit: v, credit: v ? '' : l.credit })} />
              </Td>
              <Td className="w-36">
                <Input type="number" value={l.credit} placeholder="0"
                  onChange={(v) => set(i, { credit: v, debit: v ? '' : l.debit })} />
              </Td>
              <Td><Input value={l.memo} onChange={(v) => set(i, { memo: v })} /></Td>
              <Td>
                {lines.length > 2 && (
                  <Button size="sm" variant="ghost" tone="danger"
                    onClick={() => setLines(lines.filter((_, n) => n !== i))}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              </Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td className="text-right text-muted-foreground">Total</Td>
            <Td className="text-right tabular-nums">{side(dr)}</Td>
            <Td className="text-right tabular-nums">{side(cr)}</Td>
            <Td colSpan={2} className={balanced ? 'text-success' : 'text-destructive'}>
              {dr || cr ? (balanced ? 'balanced' : `out by ${rupees(Math.abs(dr - cr))}`) : ''}
            </Td>
          </tr>
        </Table>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm"
            onClick={() => setLines([...lines, { account_id: '', debit: '', credit: '', memo: '' }])}>
            Add a line
          </Button>
        </div>

        <FormNotice error={post.error}
          ok={post.isSuccess ? `Posted as ${post.data?.voucher_no}.` : undefined} />
        <Button onClick={() => post.mutate()}
          disabled={!balanced || !narration || filled.length < 2 || post.isPending}>
          Post the voucher
        </Button>
      </div>
    </Card>
  )
}

function VoucherRegister({ fy }: { fy: string }) {
  const [open, setOpen] = useState('')
  const vouchers = useQuery({
    queryKey: ['ledgers', 'vouchers', fy],
    queryFn: () => api.get<List<Voucher>>(`${ledgerBase}/vouchers?fy=${fy}`),
  })
  const detail = useQuery({
    queryKey: ['ledgers', 'voucher', open],
    queryFn: () => api.get<{ voucher: Voucher; lines: VoucherLine[] }>(`${ledgerBase}/vouchers/${open}`),
    enabled: !!open,
  })

  if (vouchers.isLoading) return <SkeletonTable columns={7} label="Reading the register…" />
  const rows = vouchers.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader title="Every voucher for the year"
          description="The value shown is the debit total, which for a balanced voucher is what the transaction was worth. Summing both sides would report each one at twice its value." />
        <Table head={['Voucher', 'Date', 'Kind', 'Narration', 'Accounts', { label: 'Value', align: 'right' }, '']}
          empty={rows.length === 0} emptyLabel="No vouchers posted for this year yet.">
          {rows.map((v) => (
            <tr key={v.id}>
              <Td className="font-medium tabular-nums">
                {v.voucher_no}
                {v.year_closed && (
                  <div className="text-[12px] font-normal text-muted-foreground">year closed</div>
                )}
              </Td>
              <Td className="text-muted-foreground">{v.entry_date}</Td>
              <Td><Badge tone={v.voucher_type === 'closing' ? 'info' : 'neutral'}>{v.voucher_type}</Badge></Td>
              <Td>{v.narration}</Td>
              <Td className="text-[13px] text-muted-foreground">{v.accounts}</Td>
              <Td className="text-right tabular-nums">{rupees(v.amount_paise)}</Td>
              <Td>
                <Button size="sm" variant="secondary"
                  onClick={() => setOpen(open === v.id ? '' : v.id)}>
                  {open === v.id ? 'Close' : 'Lines'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {open && (
        <Card>
          <CardHeader title={`Voucher ${detail.data?.voucher.voucher_no ?? ''}`}
            description={detail.data?.voucher.narration} />
          {detail.isLoading ? <SkeletonTable columns={5} /> : (
            <Table head={['Code', 'Account', 'Note', { label: 'Debit', align: 'right' }, { label: 'Credit', align: 'right' }]}
              empty={(detail.data?.lines ?? []).length === 0}>
              {(detail.data?.lines ?? []).map((l, i) => (
                <tr key={i}>
                  <Td className="tabular-nums text-muted-foreground">{l.code}</Td>
                  <Td className="font-medium">{l.name}</Td>
                  <Td className="text-muted-foreground">{l.memo ?? '—'}</Td>
                  <Td className="text-right tabular-nums">{side(l.debit_paise)}</Td>
                  <Td className="text-right tabular-nums">{side(l.credit_paise)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  )
}

function TrialBalanceTab({ query }: { query: ReturnType<typeof useQuery<TrialBalance>> }) {
  if (query.isLoading) return <SkeletonTable columns={8} label="Adding up the books…" />
  if (query.error) return <ErrorState error={query.error} />
  const t = query.data
  if (!t) return null

  return (
    <Card>
      <CardHeader
        title={`Trial balance — ${t.fy_label}`}
        description="Opening, the year's movement, and the closing position. Each pair balances for its own reason, which is why a difference in any one of them points straight at where to look."
        action={
          <Badge tone={t.balanced ? 'success' : 'danger'} solid={!t.balanced}>
            {t.balanced ? 'balanced' : `out by ${rupees(t.difference_paise)}`}
          </Badge>
        }
      />
      <Table
        head={['Code', 'Account',
          { label: 'Opening Dr', align: 'right' }, { label: 'Opening Cr', align: 'right' },
          { label: 'Debit', align: 'right' }, { label: 'Credit', align: 'right' },
          { label: 'Closing Dr', align: 'right' }, { label: 'Closing Cr', align: 'right' }]}
        empty={t.rows.length === 0}
        emptyLabel="Nothing has been posted for this year.">
        {t.rows.map((r) => (
          <tr key={r.account_id}>
            <Td className="tabular-nums text-muted-foreground">{r.code}</Td>
            <Td className="font-medium">{r.name}</Td>
            <Td className="text-right tabular-nums text-muted-foreground">{side(r.opening_debit_paise)}</Td>
            <Td className="text-right tabular-nums text-muted-foreground">{side(r.opening_credit_paise)}</Td>
            <Td className="text-right tabular-nums">{side(r.period_debit_paise)}</Td>
            <Td className="text-right tabular-nums">{side(r.period_credit_paise)}</Td>
            <Td className="text-right font-medium tabular-nums">{side(r.closing_debit_paise)}</Td>
            <Td className="text-right font-medium tabular-nums">{side(r.closing_credit_paise)}</Td>
          </tr>
        ))}
        <tr className="font-medium">
          <Td colSpan={2} className="text-right text-muted-foreground">Total</Td>
          <Td className="text-right tabular-nums">{side(t.totals.opening_debit_paise)}</Td>
          <Td className="text-right tabular-nums">{side(t.totals.opening_credit_paise)}</Td>
          <Td className="text-right tabular-nums">{side(t.totals.period_debit_paise)}</Td>
          <Td className="text-right tabular-nums">{side(t.totals.period_credit_paise)}</Td>
          <Td className="text-right tabular-nums">{side(t.totals.closing_debit_paise)}</Td>
          <Td className="text-right tabular-nums">{side(t.totals.closing_credit_paise)}</Td>
        </tr>
      </Table>
    </Card>
  )
}

function StatementsTab({ fy }: { fy: string }) {
  const q = useQuery({
    queryKey: ['ledgers', 'statements', fy],
    queryFn: () => api.get<Statements>(`${ledgerBase}/statements?fy=${fy}`),
  })
  if (q.isLoading) return <SkeletonTable columns={4} label="Drawing up the statements…" />
  if (q.error) return <ErrorState error={q.error} />
  const s = q.data
  if (!s) return null
  const ie = s.income_expenditure
  const bs = s.balance_sheet

  if (ie.income.length === 0 && ie.expenditure.length === 0) {
    return <Card><EmptyState title="Nothing posted for this year"
      body="The income and expenditure account is drawn from vouchers. Post one and it appears here." /></Card>
  }

  return (
    <>
      <Card>
        <CardHeader
          title={`Income and expenditure — ${s.fy_label}`}
          description="The year's own result. Closing vouchers are left out on purpose: a close writes every income and expense account back to nil, so counting it would report a closed year as having earned nothing."
          action={
            <Badge tone={ie.surplus_paise >= 0 ? 'success' : 'danger'}>
              {ie.surplus_paise >= 0 ? 'surplus ' : 'deficit '}
              {rupees(Math.abs(ie.surplus_paise))}
            </Badge>
          }
        />
        <Table head={['Code', 'Head', 'Group', { label: 'Amount', align: 'right' }]} empty={false}>
          <tr className="font-medium"><Td colSpan={4} className="bg-muted/40">Income</Td></tr>
          {ie.income.map((r) => (
            <tr key={r.code}>
              <Td className="tabular-nums text-muted-foreground">{r.code}</Td>
              <Td>{r.name}</Td>
              <Td className="text-muted-foreground">{r.group}</Td>
              <Td className="text-right tabular-nums">{rupees(r.paise)}</Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td colSpan={3} className="text-right text-muted-foreground">Total income</Td>
            <Td className="text-right tabular-nums">{rupees(ie.income_paise)}</Td>
          </tr>
          <tr className="font-medium"><Td colSpan={4} className="bg-muted/40">Expenditure</Td></tr>
          {ie.expenditure.map((r) => (
            <tr key={r.code}>
              <Td className="tabular-nums text-muted-foreground">{r.code}</Td>
              <Td>{r.name}</Td>
              <Td className="text-muted-foreground">{r.group}</Td>
              <Td className="text-right tabular-nums">{rupees(r.paise)}</Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td colSpan={3} className="text-right text-muted-foreground">Total expenditure</Td>
            <Td className="text-right tabular-nums">{rupees(ie.expenditure_paise)}</Td>
          </tr>
          <tr className="font-medium">
            <Td colSpan={3} className="text-right">
              {ie.surplus_paise >= 0 ? 'Surplus for the year' : 'Deficit for the year'}
            </Td>
            <Td className={`text-right tabular-nums ${ie.surplus_paise >= 0 ? 'text-success' : 'text-destructive'}`}>
              {rupees(Math.abs(ie.surplus_paise))}
            </Td>
          </tr>
        </Table>
      </Card>

      <Card>
        <CardHeader
          title={`Balance sheet as at ${s.fy_label.slice(0, 4) ? `31 March ${Number(s.fy_label.slice(0, 4)) + 1}` : ''}`}
          description="Everything ever posted, up to the year end. The surplus not yet closed appears on the liabilities side because until the year is closed the result belongs to nobody's account — leaving it out is why a balance sheet fails to tie."
          action={
            <Badge tone={bs.balanced ? 'success' : 'danger'} solid={!bs.balanced}>
              {bs.balanced ? 'ties' : `out by ${rupees(bs.difference_paise)}`}
            </Badge>
          }
        />
        <Table head={['Code', 'Head', { label: 'Amount', align: 'right' }]} empty={false}>
          <tr className="font-medium"><Td colSpan={3} className="bg-muted/40">Assets</Td></tr>
          {bs.assets.map((r) => (
            <tr key={r.code}>
              <Td className="tabular-nums text-muted-foreground">{r.code}</Td>
              <Td>{r.name}</Td>
              <Td className="text-right tabular-nums">{rupees(r.paise)}</Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td colSpan={2} className="text-right text-muted-foreground">Total assets</Td>
            <Td className="text-right tabular-nums">{rupees(bs.assets_paise)}</Td>
          </tr>
          <tr className="font-medium"><Td colSpan={3} className="bg-muted/40">Liabilities, corpus and reserves</Td></tr>
          {bs.liabilities.map((r) => (
            <tr key={r.code}>
              <Td className="tabular-nums text-muted-foreground">{r.code}</Td>
              <Td>{r.name}</Td>
              <Td className="text-right tabular-nums">{rupees(r.paise)}</Td>
            </tr>
          ))}
          {bs.surplus_not_yet_closed !== 0 && (
            <tr>
              <Td className="text-muted-foreground">—</Td>
              <Td>
                Surplus not yet closed
                <div className="text-[12px] text-muted-foreground">
                  Moves into the corpus when the year is closed
                </div>
              </Td>
              <Td className="text-right tabular-nums">{rupees(bs.surplus_not_yet_closed)}</Td>
            </tr>
          )}
          <tr className="font-medium">
            <Td colSpan={2} className="text-right text-muted-foreground">Total</Td>
            <Td className="text-right tabular-nums">{rupees(bs.liabilities_total_paise)}</Td>
          </tr>
        </Table>
      </Card>
    </>
  )
}
