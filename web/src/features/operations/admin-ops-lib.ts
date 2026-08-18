/* Shared types and the base URL for the four /admin-ops screens.
 *
 * Sibling-module convention, as finance/ledger-lib.ts: the screens import from
 * here rather than each redeclaring the row shapes the Go handlers return.
 */

export const adminOpsBase = '/api/v1/admin-ops'

/** Money in, rupees out, Indian digit grouping. Paise are never dropped. */
export function inr(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—'
  return (paise / 100).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  })
}

/** Rupees typed into a form, back to paise. Rounded, never floored: a fee of
 *  ₹1,234.56 must not silently become ₹1,234.55. */
export function toPaise(v: string): number {
  const n = Number(String(v).replace(/[, ]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

export function kg(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `${v.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg`
}

// --- purchasing --------------------------------------------------------------

export interface Requisition {
  id: string
  requisition_no: string
  department?: string
  requested_by?: string
  raised_on: string
  needed_by?: string
  status: string
  estimated_total_paise: number
  approval_band?: string
  approval_permission?: string
  decided_by?: string
  decision_note?: string
  line_count: number
  order_no?: string
}

export interface RequisitionLine {
  id: string
  line_no: number
  item_id?: string
  item_code?: string
  description: string
  quantity: number
  unit: string
  rate_paise: number
}

export interface PurchaseOrder {
  id: string
  po_no: string
  vendor: string
  vendor_id: string
  requisition_no?: string
  order_date: string
  expected_on?: string
  status: string
  total_paise: number
  received_paise: number
  line_count: number
  outstanding_lines: number
  invoice_matched: boolean
}

export interface OrderLine {
  id: string
  line_no: number
  item_id?: string
  item_code?: string
  description: string
  quantity: number
  unit: string
  unit_price_paise: number
  tax_rate_bp: number
  received_qty: number
  rejected_qty: number
  outstanding_qty: number
}

export interface GoodsReceipt {
  id: string
  grn_no: string
  received_on: string
  challan_no?: string
  received_by?: string
  remarks?: string
  line_count: number
  units_received: number
  units_rejected: number
  stock_movements: number
}

export interface InvoiceMatch {
  id: string
  po_no: string
  vendor: string
  bill_no: string
  bill_date: string
  ordered_paise: number
  received_paise: number
  invoiced_paise: number
  variance_paise: number
  status: string
  matched_on: string
  decided_by?: string
  note?: string
}

export interface ApprovalBand {
  id?: string
  label: string
  up_to_paise?: number
  approver_permission: string
  sort_order: number
}

// --- mid-day meal ------------------------------------------------------------

export interface MDMDay {
  on_date: string
  enrolled: number
  present: number
  meals_served: number
  rice_kg?: number
  cost_paise: number
  menu?: string
  issues: string[]
}

export interface MDMCheck {
  code: string
  severity: 'ok' | 'warn' | 'fail'
  label: string
  detail: string
}

export interface MDMUtilisation {
  month: string
  period: { from: string; to: string }
  return: { id: string; status: string; explanation?: string | null }
  meals: {
    total: number
    serving_days: number
    working_days: number
    avg_enrolment: number
    avg_present: number
  }
  foodgrain: {
    grain: string
    opening_kg: number
    lifted_kg: number
    allotted_kg: number
    consumed_kg: number
    closing_kg: number
  }
  cooking_cost_paise: {
    opening: number
    allotted: number
    released: number
    spent: number
    closing: number
  }
  roll: { primary: number; upper_primary: number }
  checks: MDMCheck[]
  days: MDMDay[]
}

// --- 360 evaluation ----------------------------------------------------------

export interface EvalCycle {
  id: string
  name: string
  purpose?: string
  opens_on: string
  closes_on: string
  status: string
  min_responses: number
  relations: string[]
  reviewee_count: number
  invited: number
  responded: number
  question_count: number
}

export interface RelationGap {
  relation: string
  invited: number
  responded: number
  declined: number
  attributed: boolean
  meets_floor: boolean
}

export interface Reviewee {
  id: string
  employee_id: string
  name: string
  employee_code: string
  department?: string
  released: boolean
  invited: number
  responded: number
  complete: boolean
  by_relation: RelationGap[]
}

export interface EvalScore {
  question_id: string
  seq: number
  prompt: string
  kind: string
  max_rating: number
  responses: number
  average?: number
  low?: number
  high?: number
  comments: string[]
}

export interface RelationResult {
  relation: string
  responses: number
  attributed: boolean
  suppressed: boolean
  suppressed_reason?: string
  questions: EvalScore[]
}

// --- fee filing --------------------------------------------------------------

export interface FeeFiling {
  id: string
  filing_no: string
  committee_name: string
  committee_level: string
  state?: string
  academic_year?: string
  status: string
  submitted_on?: string
  acknowledgement_no?: string
  decided_on?: string
  fee_structure?: string
  version_no?: number
  line_count: number
  document_count: number
  proposed_total_paise: number
  approved_total_paise?: number
}

export interface FilingLine {
  id: string
  fee_head_id: string
  fee_head: string
  class_id?: string
  class?: string
  instalment_no: number
  proposed_paise: number
  approved_paise?: number
  modification_note?: string
}

export interface FilingDocument {
  id: string
  file_id: string
  doc_type: string
  original_name: string
  size_bytes: number
  covers_period?: string
  attached_by?: string
  attached_on: string
}

export interface VarianceRow {
  class?: string
  fee_head: string
  instalment_no: number
  approved_paise?: number
  charged_paise: number
  students: number
  variance_paise: number
  exposure_paise: number
  verdict: 'as_approved' | 'over_approved' | 'under_approved' | 'not_filed'
}

/** The four filing statuses a school reads, in the words it uses. */
export const FILING_STATUS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Filed, awaiting decision',
  approved: 'Approved as filed',
  approved_with_modification: 'Approved with modification',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}
