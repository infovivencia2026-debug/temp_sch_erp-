import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'

/* Shared vocabulary for the ten accounting screens.

   The money formatter lives here rather than in each screen because the
   grouping is the part that is easy to get wrong: an Indian reader expects
   1,80,000 and every JavaScript default produces 180,000. Getting that from
   one function means a figure looks the same on the trial balance as it does
   on the cashbook. */

/** Paise to rupees, grouped the Indian way: 1,80,000 rather than 180,000. */
export const rupees = (paise: number) =>
  (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** With the symbol, for a figure standing on its own. */
export const inr = (paise: number) => `₹${rupees(paise)}`

/* A debit or credit column entry.

   Zero renders as an em dash, not as "0". A trial balance where every account
   shows a nought in both columns is unreadable; the eye needs the blank to
   find the side an account actually sits on. */
export const side = (paise: number) => (paise ? rupees(paise) : '—')

/** Rupees typed into a form back to paise, without a float rounding surprise. */
export const toPaise = (v: string) => Math.round(Number(v || 0) * 100)

/** 2026 to "2026-27", which is how every Indian financial document reads. */
export const fyLabel = (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`

/** The financial year containing a date: April to March. */
export function currentFY(d = new Date()) {
  return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear()
}

/** The last few years, newest first, for a year picker. */
export function fyOptions(back = 4) {
  const now = currentFY()
  return Array.from({ length: back + 1 }, (_, i) => ({
    value: String(now - i),
    label: fyLabel(now - i),
  }))
}

export interface LedgerAccount {
  id: string
  code: string
  name: string
  type: string
  normal_side: string
  parent_id?: string
  parent_code?: string
  is_group: boolean
  is_cash: boolean
  is_contra: boolean
  is_active: boolean
  is_system: boolean
  depth: number
  balance_paise: number
  postings: number
}

export interface LedgerSettings {
  cash_account_id?: string
  bank_account_id?: string
  petty_cash_account_id?: string
  fee_receivable_account_id?: string
  fee_income_account_id?: string
  payable_account_id?: string
  depreciation_expense_account_id?: string
  accumulated_depreciation_account_id?: string
  surplus_account_id?: string
  petty_cash_limit_paise: number
  default_depreciation_method: string
}

export interface Voucher {
  id: string
  voucher_no: string
  voucher_type: string
  entry_date: string
  fy_start_year: number
  narration: string
  source_kind?: string
  amount_paise: number
  lines: number
  posted_by?: string
  accounts: string
  year_closed: boolean
}

export interface VoucherLine {
  account_id: string
  code: string
  name: string
  debit_paise: number
  credit_paise: number
  memo?: string
}

export interface TrialRow {
  account_id: string
  code: string
  name: string
  type: string
  opening_debit_paise: number
  opening_credit_paise: number
  period_debit_paise: number
  period_credit_paise: number
  closing_debit_paise: number
  closing_credit_paise: number
}

export interface TrialBalance {
  fy_start_year: number
  fy_label: string
  from: string
  to: string
  rows: TrialRow[]
  totals: {
    opening_debit_paise: number
    opening_credit_paise: number
    period_debit_paise: number
    period_credit_paise: number
    closing_debit_paise: number
    closing_credit_paise: number
  }
  balanced: boolean
  difference_paise: number
}

export interface StatementRow {
  code: string
  name: string
  group: string
  paise: number
}

export interface Statements {
  fy_label: string
  income_expenditure: {
    income: StatementRow[]
    expenditure: StatementRow[]
    income_paise: number
    expenditure_paise: number
    surplus_paise: number
  }
  balance_sheet: {
    assets: StatementRow[]
    liabilities: StatementRow[]
    assets_paise: number
    liabilities_paise: number
    surplus_not_yet_closed: number
    liabilities_total_paise: number
    balanced: boolean
    difference_paise: number
  }
}

export interface AccountingYear {
  id: string
  fy_start_year: number
  fy_label: string
  status: string
  closed_on?: string
  closed_by?: string
  closing_voucher_no?: string
  surplus_paise?: number
  vouchers: number
  live_income_paise: number
  live_expense_paise: number
  live_surplus_paise: number
  can_close: boolean
  blocker?: string
}

export interface Vendor {
  id: string
  code: string
  name: string
  contact_person?: string
  phone?: string
  email?: string
  gstin?: string
  pan?: string
  category?: string
  payment_terms_days: number
  is_active: boolean
  bills: number
  billed_paise: number
  paid_paise: number
  outstanding_paise: number
  overdue_paise: number
}

export interface VendorBill {
  id: string
  vendor_id: string
  vendor_name: string
  bill_no: string
  bill_date: string
  due_on?: string
  expense_code: string
  expense_name: string
  taxable_paise: number
  tax_paise: number
  total_paise: number
  paid_paise: number
  outstanding_paise: number
  status: string
  payment_state: string
  days_overdue: number
  bucket: string
  voucher_no?: string
  narration?: string
}

export interface PettyVoucher {
  id: string
  voucher_no: string
  voucher_date: string
  payee: string
  particulars: string
  amount_paise: number
  expense_code: string
  expense_name: string
  status: string
  needs_approval: boolean
  approved_by?: string
  raised_by?: string
  rejected_reason?: string
  journal_voucher_no?: string
  has_receipt: boolean
}

export interface FixedAsset {
  id: string
  tag_no: string
  name: string
  category: string
  account_code: string
  account_name: string
  purchased_on: string
  cost_paise: number
  salvage_paise: number
  method: string
  useful_life_years?: number
  wdv_rate_percent?: string
  location?: string
  vendor_name?: string
  status: string
  disposed_on?: string
  accumulated_depreciation_paise: number
  written_down_value_paise: number
  years_charged: number
  age_years: number
}

export interface DepreciationPreview {
  fy_start_year: number
  fy_label: string
  dry_run: boolean
  charge_paise: number
  voucher_no?: string
  assets: {
    asset_id: string
    tag_no: string
    name: string
    method: string
    opening_wdv_paise: number
    charge_paise: number
    closing_wdv_paise: number
    note?: string
  }[]
}

export interface BudgetLine {
  id: string
  account_id: string
  code: string
  name: string
  type: string
  department?: string
  department_id?: string
  allocated_paise: number
  revised_paise?: number
  actual_paise: number
  variance_paise: number
  used_percent: number
  state: string
  notes?: string
}

export interface BudgetView {
  fy_start_year: number
  fy_label: string
  budget_id: string
  name: string
  status: string
  items: BudgetLine[]
  allocated_paise: number
  actual_paise: number
  variance_paise: number
}

export interface ExpenseHead {
  account_id: string
  code: string
  name: string
  group: string
  paise: number
  vouchers: number
  from_bills_paise: number
  from_petty_cash_paise: number
  from_other_paise: number
}

export interface CashbookAccount {
  account_id: string
  code: string
  name: string
  opening_paise: number
  in_paise: number
  out_paise: number
  closing_paise: number
  entries: {
    date: string
    voucher_no: string
    narration: string
    contra: string
    in_paise: number
    out_paise: number
    balance_paise: number
  }[]
}

export interface AuditReport {
  fy_label: string
  checks: { check: string; detail: string; count: number; paise: number; passing: boolean }[]
  years: AccountingYear[]
  failing: number
  clean: boolean
}

export interface TaxReport {
  fy_label: string
  from: string
  to: string
  vendors: {
    vendor_name: string
    gstin?: string
    pan?: string
    bills: number
    taxable_paise: number
    tax_paise: number
    tds_paise: number
  }[]
  statutory_dues: StatementRow[]
  taxable_paise: number
  tax_paise: number
  tds_withheld_paise: number
}

const BASE = '/api/v1/finance/ledgers'

/** The chart of accounts. Every screen that posts anything needs it. */
export function useAccounts() {
  return useQuery({
    queryKey: ['ledgers', 'accounts'],
    queryFn: () => api.get<List<LedgerAccount>>(`${BASE}/accounts`),
  })
}

export function useLedgerSettings() {
  return useQuery({
    queryKey: ['ledgers', 'settings'],
    queryFn: () => api.get<LedgerSettings>(`${BASE}/settings`),
  })
}

/** Postable accounts of one or more types, as Select options. */
export function accountOptions(accounts: LedgerAccount[] | undefined, ...types: string[]) {
  return (accounts ?? [])
    .filter((a) => !a.is_group && a.is_active && (types.length === 0 || types.includes(a.type)))
    .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))
}

export const ledgerBase = BASE
