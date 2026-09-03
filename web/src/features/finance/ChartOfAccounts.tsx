import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Landmark, Wallet, ListTree, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Loading, SkeletonTable, ErrorState,
} from '@/components/ui'
import {
  inr, side, useAccounts, useLedgerSettings, accountOptions, ledgerBase,
  type LedgerAccount,
} from './ledger-lib'

/* The chart of accounts.

   Two jobs on one screen because they are one decision: the shape of the
   books, and which account each automatic posting uses. A school that renames
   "Bank — Current Account" and does not repoint the control account has a fee
   receipt that fails at the counter, and the only way to see both facts at
   once is to show them together.

   The tree is shown at its real depth rather than as a flat list. A chart of
   accounts is a hierarchy; flattening it is how a school ends up with four
   accounts called "Miscellaneous". */

const TYPE_TONE: Record<string, 'primary' | 'warning' | 'success' | 'danger' | 'info'> = {
  asset: 'primary',
  liability: 'warning',
  equity: 'info',
  income: 'success',
  expense: 'danger',
}

export default function ChartOfAccounts() {
  const accounts = useAccounts()
  const settings = useLedgerSettings()
  const [showAll, setShowAll] = useState(false)

  if (accounts.isLoading) return <SkeletonTable columns={6} label="Reading the chart of accounts…" />
  if (accounts.error) return <ErrorState error={accounts.error} />

  const rows = accounts.data?.items ?? []
  const shown = showAll ? rows : rows.filter((a) => a.is_group || a.postings > 0 || a.balance_paise !== 0)
  const postable = rows.filter((a) => !a.is_group)
  const used = rows.filter((a) => a.postings > 0)
  const cash = rows.filter((a) => a.is_cash)
  const cashHeld = cash.reduce((s, a) => s + a.balance_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Chart of accounts"
        description="The shape of the books, and which account each automatic posting uses. Group headings organise; only the accounts beneath them can be posted to."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Accounts" value={postable.length} icon={ListTree}
            hint={`${rows.length - postable.length} group headings above them`} />
          <Stat label="In use" value={used.length} icon={Landmark}
            hint="Accounts carrying at least one posting" />
          <Stat label="Cash and bank" value={inr(cashHeld)} icon={Wallet}
            hint={`${cash.length} accounts feed the cashbook`} />
          <Stat label="Control accounts"
            value={settings.data?.cash_account_id ? 'Set' : 'Incomplete'}
            icon={Settings2}
            delta={settings.data?.cash_account_id
              ? { value: 'Automatic postings can run', positive: true }
              : { value: 'Postings will refuse to guess', positive: false }} />
        </CellGrid>

        <ControlAccounts />
        <NewAccount accounts={rows} />

        <Card>
          <CardHeader
            title="The chart"
            description="Balances are to date across every year, so an account that looks dormant but holds money is visible here rather than only on the balance sheet."
            action={
              <Button variant="secondary" size="sm" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Only accounts in use' : `Show all ${rows.length}`}
              </Button>
            }
          />
          <Table head={['Code', 'Account', 'Type', { label: 'Balance', align: 'right' }, 'Postings', '']}
            empty={shown.length === 0}>
            {shown.map((a) => (
              <tr key={a.id} className={a.is_group ? 'font-medium' : undefined}>
                <Td className="tabular-nums text-muted-foreground">{a.code}</Td>
                <Td>
                  <span style={{ paddingLeft: `${a.depth * 16}px` }}>
                    {a.name}
                    {a.is_contra && (
                      <span className="ml-1.5 text-[12px] text-muted-foreground">(contra)</span>
                    )}
                  </span>
                </Td>
                <Td><Badge tone={TYPE_TONE[a.type] ?? 'neutral'}>{a.type}</Badge></Td>
                <Td className="text-right tabular-nums">
                  {a.is_group ? '—' : side(Math.abs(a.balance_paise))}
                  {!a.is_group && a.balance_paise !== 0 && (
                    <span className="ml-1 text-[12px] text-muted-foreground">
                      {a.balance_paise > 0 ? 'Dr' : 'Cr'}
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums text-muted-foreground">{a.postings || '—'}</Td>
                <Td className="text-muted-foreground">
                  {a.is_group && <span className="text-[12px]">heading</span>}
                  {a.is_cash && <span className="text-[12px]">cashbook</span>}
                  {!a.is_active && <span className="text-[12px] text-destructive">closed</span>}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

function NewAccount({ accounts }: { accounts: LedgerAccount[] }) {
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState('expense')
  const [parent, setParent] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${ledgerBase}/accounts`, {
        code, name, type, parent_id: parent || undefined,
      }),
    onSuccess: () => {
      setCode(''); setName('')
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  const groups = accounts
    .filter((a) => a.is_group && a.type === type)
    .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))

  return (
    <Card>
      <CardHeader title="Add an account"
        description="The seeded chart covers an ordinary school. Add to it when a head genuinely repeats — one account per recurring expense beats a Miscellaneous line nobody can explain at the year end." />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Code" required hint="Numbered by type: 1 assets, 2 liabilities, 3 corpus, 4 income, 5 expenditure">
            <Input value={code} onChange={setCode} placeholder="5915" />
          </Field>
          <Field label="Name" required>
            <Input value={name} onChange={setName} placeholder="Photocopier rental" />
          </Field>
          <Field label="Type" hint="Decides which side the account grows on, and which statement it appears in">
            <Select value={type} onChange={(v) => { setType(v); setParent('') }} options={[
              { value: 'asset', label: 'Asset' },
              { value: 'liability', label: 'Liability' },
              { value: 'equity', label: 'Corpus or reserve' },
              { value: 'income', label: 'Income' },
              { value: 'expense', label: 'Expenditure' },
            ]} />
          </Field>
          <Field label="Under" hint="The group heading it belongs beneath">
            <Select value={parent} onChange={setParent} placeholder="No heading" options={groups} />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Account added.' : undefined} />
        <Button onClick={() => save.mutate()} disabled={!code || !name || save.isPending}>
          Add the account
        </Button>
      </div>
    </Card>
  )
}

const CONTROLS: { key: string; label: string; hint: string; types: string[] }[] = [
  { key: 'cash_account_id', label: 'Cash in hand', hint: 'Counter receipts and cash payments', types: ['asset'] },
  { key: 'bank_account_id', label: 'Bank', hint: 'Transfers, cheques and vendor payments', types: ['asset'] },
  { key: 'petty_cash_account_id', label: 'Petty cash', hint: 'The tin the small slips come out of', types: ['asset'] },
  { key: 'fee_receivable_account_id', label: 'Fee receivable', hint: 'What parents owe, raised when an invoice is issued', types: ['asset'] },
  { key: 'fee_income_account_id', label: 'Fee income', hint: 'Where tuition revenue is recognised', types: ['income'] },
  { key: 'payable_account_id', label: 'Sundry creditors', hint: 'What the school owes its vendors', types: ['liability'] },
  { key: 'depreciation_expense_account_id', label: 'Depreciation', hint: 'The annual charge against the surplus', types: ['expense'] },
  { key: 'accumulated_depreciation_account_id', label: 'Accumulated depreciation', hint: 'Sits under assets and carries a credit balance', types: ['asset'] },
  { key: 'surplus_account_id', label: 'Surplus carried forward', hint: 'Where the year-end close puts the result', types: ['equity'] },
]

function ControlAccounts() {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const settings = useLedgerSettings()
  const [draft, setDraft] = useState<Record<string, string> | null>(null)

  const current: Record<string, string> = {}
  for (const c of CONTROLS) {
    current[c.key] = ((settings.data as unknown as Record<string, string>)?.[c.key]) ?? ''
  }
  const values = draft ?? current
  const set = (k: string, v: string) => setDraft({ ...values, [k]: v })

  const save = useMutation({
    mutationFn: () =>
      api.post(`${ledgerBase}/settings`, {
        ...values,
        petty_cash_limit_paise: limit,
        default_depreciation_method: method,
      }),
    onSuccess: () => {
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  const [limitDraft, setLimitDraft] = useState<string | null>(null)
  const [methodDraft, setMethodDraft] = useState<string | null>(null)
  const limit = limitDraft !== null
    ? Math.round(Number(limitDraft || 0) * 100)
    : settings.data?.petty_cash_limit_paise ?? 200000
  const method = methodDraft ?? settings.data?.default_depreciation_method ?? 'straight_line'

  if (settings.isLoading) return <Card><Loading label="Reading the settings…" /></Card>

  return (
    <Card>
      <CardHeader title="Control accounts"
        description="Which account each automatic posting uses. Nothing here is guessed: a fee receipt, a vendor payment or a depreciation run refuses rather than choosing an account for you, because the wrong control account is a mistake nobody notices for a year." />
      <div className="space-y-5 p-5">
        <FormGrid>
          {CONTROLS.map((c) => (
            <Field key={c.key} label={c.label} hint={c.hint}>
              <Select value={values[c.key]} onChange={(v) => set(c.key, v)}
                placeholder="Not set"
                options={accountOptions(accounts.data?.items, ...c.types)} />
            </Field>
          ))}
          <Field label="Petty cash limit (₹)"
            hint="Above this a slip needs a second signature. School policy, not law.">
            <Input type="number"
              value={limitDraft ?? String((settings.data?.petty_cash_limit_paise ?? 0) / 100)}
              onChange={setLimitDraft} />
          </Field>
          <Field label="Default depreciation method"
            hint="Straight line for the trust's own accounts; written-down value is what the Income Tax Act prescribes. Each asset may override this.">
            <Select value={method} onChange={setMethodDraft} options={[
              { value: 'straight_line', label: 'Straight line' },
              { value: 'wdv', label: 'Written-down value' },
            ]} />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
        <Button onClick={() => save.mutate()} disabled={save.isPending}>Save the settings</Button>
      </div>
    </Card>
  )
}
