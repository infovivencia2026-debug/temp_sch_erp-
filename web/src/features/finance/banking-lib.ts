import { useQuery } from '@tanstack/react-query'
import { api, type List, actingInstitution } from '@/lib/api'

/* Shared vocabulary for the three banking screens.

   Money formatting deliberately re-exports ledger-lib's rather than defining a
   second one: the reconciliation sits next to the cashbook in the same menu,
   and a figure that groups differently on one screen than the other is the
   kind of detail that makes an accountant stop trusting both. */

export { inr, rupees, side, toPaise } from './ledger-lib'

export const bankingBase = '/api/v1/finance/banking'

/* Query keys, one prefix.

   Everything under ['banking'] so a mutation anywhere in the flow can
   invalidate the whole subtree in one line. Matching a bank line changes the
   statement, the residue and the account's open-period count, and a screen
   that invalidated only the list it happened to be looking at would show a
   matched line still sitting in the unmatched column. */
export const bankingQueryKey = 'banking'

export interface BankAccount {
  id: string
  label: string
  bank_name: string
  branch?: string
  account_masked: string
  ifsc: string
  account_type: string
  allows_payouts: boolean
  is_active: boolean
  ledger_account?: string
  last_import_at?: string
  open_periods: number
}

export interface Reconciliation {
  id: string
  bank_account_id: string
  account_label: string
  period_start: string
  period_end: string
  opening_balance_paise: number
  closing_balance_paise: number
  status: 'open' | 'finalised'
  line_count: number
  matched_count: number
  unmatched_count: number
  finalised_at?: string
  finalised_by?: string
  difference_paise?: number
  notes?: string
}

export interface StatementLine {
  id: string
  txn_date: string
  narration: string
  reference_no?: string
  amount_paise: number
  direction: 'credit' | 'debit'
  balance_paise?: number
  raw_line: string
  match_kind?: string
  match_id?: string
  match_confidence?: string
  matched_by?: string
  explained_as?: string
}

export interface BookEntry {
  kind: string
  id: string
  entry_date: string
  amount_paise: number
  reference?: string
  party: string
}

export interface MatchCandidate extends BookEntry {
  reason: string
  exact: boolean
  day_gap: number
}

export interface StatementImport {
  id: string
  filename: string
  imported_at: string
  imported_by?: string
  rows_read: number
  rows_inserted: number
  rows_duplicate: number
  rows_rejected: number
  rejects?: { line: number; reason: string; raw: string }[]
}

export interface Statement extends Reconciliation {
  bank_lines: StatementLine[]
  unmatched_bank: StatementLine[]
  unmatched_book: BookEntry[]
  bank_closing_paise: number
  book_closing_paise: number
  unmatched_bank_paise: number
  unmatched_book_paise: number
  difference_paise: number
  difference_explained: boolean
  imports: StatementImport[]
}

export interface PayoutBatch {
  id: string
  batch_no: string
  purpose: string
  value_date: string
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'exported' | 'cancelled'
  provider: string
  account_label: string
  bank_account_id: string
  item_count: number
  total_paise: number
  created_by: string
  created_by_id: string
  created_at: string
  approved_by?: string
  rejected_by?: string
  decision_reason?: string
  exported_at?: string
  caller_may_approve: boolean
  /** Written for a person, and reworded whenever the wording is wrong. */
  approval_blocked?: string
  /** The same refusal as a token to branch on. Never match on the sentence. */
  approval_blocked_code?: 'not_submitted' | 'no_permission' | 'assembled_by_caller'
}

export interface PayoutItem {
  id: string
  beneficiary_kind: string
  beneficiary_name: string
  account_masked: string
  ifsc: string
  amount_paise: number
  mode: string
  narration?: string
  source_kind?: string
  source_id?: string
  status: string
  utr?: string
}

export interface PayoutBatchDetail extends PayoutBatch {
  items: PayoutItem[]
}

export interface PayoutCandidate {
  source_kind: string
  source_id: string
  beneficiary_kind: string
  beneficiary_id: string
  beneficiary_name: string
  account_masked: string
  has_bank: boolean
  ifsc?: string
  amount_paise: number
  reference: string
  due_on?: string
}

export interface PayoutProvider {
  name: string
  label: string
  can_transmit: boolean
  why?: string
}

export interface StudentBankAccount {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  class_section?: string
  account_holder_name: string
  relationship: string
  guardian_name?: string
  bank_name: string
  branch?: string
  account_masked: string
  ifsc: string
  account_type: string
  is_aadhaar_seeded: boolean
  dbt_consent_on?: string
  is_primary: boolean
  is_active: boolean
  verified_at?: string
  verified_by?: string
  notes?: string
  can_reveal: boolean
}

export function useBankAccounts() {
  return useQuery({
    queryKey: [bankingQueryKey, 'accounts'],
    queryFn: () => api.get<List<BankAccount>>(`${bankingBase}/accounts`),
  })
}

export function bankAccountOptions(items?: BankAccount[], payoutsOnly = false) {
  return (items ?? [])
    .filter((a) => a.is_active && (!payoutsOnly || a.allows_payouts))
    .map((a) => ({ value: a.id, label: `${a.label} — ${a.bank_name} ${a.account_masked}` }))
}

/* The IFSC shape, checked in the browser as well as twice on the server.

   Here purely so the field can go red as it is typed. The server validates the
   same expression and a CHECK constraint validates it again, because a wrong
   IFSC is not a form nicety — it is a transfer that fails at the bank days
   later, or one that succeeds into a stranger's account. */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/

export const isValidIFSC = (s: string) => IFSC_PATTERN.test(s.trim().toUpperCase())

export const ACCOUNT_PATTERN = /^[A-Za-z0-9]{6,20}$/

export const isValidAccountNumber = (s: string) => ACCOUNT_PATTERN.test(s.trim())

/** A signed figure with its sign shown, for a statement column. */
export function signedInr(paise: number) {
  const abs = (Math.abs(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })
  return `${paise < 0 ? '−' : '+'}₹${abs}`
}

export const MATCH_KIND_LABELS: Record<string, string> = {
  payment: 'Fee receipt',
  vendor_payment: 'Vendor payment',
  payout_item: 'Payout',
  refund: 'Refund',
}

export const BATCH_TONES: Record<string, 'neutral' | 'warning' | 'success' | 'danger' | 'info'> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'info',
  exported: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
}

/*
uploadStatement posts a CSV as its own body.

  The api helper sends JSON, and the import endpoint reads the raw file so it
  can keep every line verbatim. The acting-institution header still has to
  travel or a platform operator importing into a school they picked would post
  the statement against no school at all — the same trap ImportStudents
  documents.
*/
export async function uploadStatement(
  reconciliationId: string,
  filename: string,
  csv: string,
): Promise<{
  import_id: string
  rows_read: number
  rows_inserted: number
  rows_duplicate: number
  rows_rejected: number
  rows_outside_period: number
  rejects: { line: number; reason: string; raw: string }[]
}> {
  const acting = actingInstitution()
  const res = await fetch(
    `${bankingBase}/reconciliations/${reconciliationId}/import?filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'text/csv',
        ...(acting ? { 'X-Acting-Institution': acting } : {}),
      },
      body: csv,
    },
  )
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error?.message ?? 'The statement could not be imported')
  return body
}
