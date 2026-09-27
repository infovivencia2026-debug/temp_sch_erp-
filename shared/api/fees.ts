/* The fee counter: a child's ledger, taking a payment, the printed receipt,
   raising a demand. internal/api/fees.go, fee_ledger.go, invoicing.go.
   Money is always integer paise. */

export interface FeeDue {
  invoice_id: string; invoice_no: string; issued_on: string; due_on?: string
  net_paise: number; paid_paise: number; balance_paise: number
  fine_paise: number; status: string; days_overdue: number
}

export interface FeeLedgerEntry {
  date: string; kind: 'invoice' | 'payment' | 'refund' | string; reference: string; description: string
  debit_paise: number; credit_paise: number; status: string; mode?: string
}

export interface FeeLedger {
  student_id: string; admission_no: string; full_name: string
  class_name?: string; section_name?: string
  charged_paise: number; paid_paise: number; balance_paise: number; pending_paise: number
  concessions: { kind: string; percent?: string; amount_paise?: number; reason?: string; fee_head?: string }[]
  dues: FeeDue[]
  entries: FeeLedgerEntry[]
}

export interface CollectPaymentRequest {
  student_id: string
  amount_paise: number
  mode: string
  paid_on?: string
  reference_no?: string
  bank_name?: string
  cheque_date?: string
  remarks?: string
  payer_name?: string
  payer_relation?: string
  /** Settle these first; otherwise oldest-due first. */
  invoice_ids?: string[]
}

export interface CollectPaymentResult {
  payment_id: string
  receipt_no: string
  amount_paise: number
  allocated: { invoice_id: string; invoice_no: string; amount_paise: number }[]
  unallocated_paise: number
  /** False for a post-dated cheque: taken, not yet money. */
  cleared: boolean
  receipt_url: string
}

/** Everything needed to print a receipt. Go sends the nullable columns as null. */
export interface FeeReceipt {
  receipt_no: string; amount_paise: number; amount_words: string
  mode: string; status: string; paid_on: string
  reference_no: string | null
  student_name: string; admission_no: string; institution: string
  class_name: string | null; section_name: string | null
  collected_by: string | null
  financial_year: string
  lines: { invoice_no: string; amount_paise: number; particulars: string }[]
}

export interface GenerateInvoicesRequest {
  fee_structure_id: string
  instalment_no?: number
  due_on?: string
  /** One child only (admissions may raise this without the invoices permission). */
  student_id?: string
  all_instalments?: boolean
}

export interface GenerateInvoicesResult {
  created: number
  skipped: number
  instalment_no: number
  due_on: string
  pending_concessions: number
  arrears_children: number
  arrears_paise: number
}

export interface FeesApi {
  'GET /fees/students/{id}/ledger': { res: FeeLedger }
  'POST /fees/payments': { body: CollectPaymentRequest; res: CollectPaymentResult }
  'GET /fees/receipts/{id}': { res: FeeReceipt }
  'POST /fees/invoices/generate': { body: GenerateInvoicesRequest; res: GenerateInvoicesResult }
}
