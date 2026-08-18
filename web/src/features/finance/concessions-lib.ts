import { useQuery } from '@tanstack/react-query'
import { api, actingInstitution, type List, type AcademicYear } from '@/lib/api'

/* Shared vocabulary for the three concessions screens.

   Money formatting re-exports ledger-lib's rather than defining a second one:
   an RTE claim total sits two menu items from the cashbook, and a figure that
   groups differently on one screen than the other is how an accountant stops
   trusting both. */

export { inr, rupees, toPaise } from './ledger-lib'

export const concessionsBase = '/api/v1/finance/concessions'

/* One query key prefix for all three screens.

   Everything under ['concessions'] so a mutation anywhere invalidates the whole
   subtree in one line. Recording a sanction changes the claim, its lines, the
   ageing report and the scheme's claim count; a screen that invalidated only
   the list it happened to be looking at would show a claim still sitting in the
   0-90 bucket after the money arrived. */
export const concessionsKey = 'concessions'

// --- the scheme registry, shared by claims and scholarships ------------------

export type SchemeKind =
  | 'rte_reimbursement'
  | 'fee_reimbursement'
  | 'nsp_scholarship'
  | 'state_scholarship'

export interface AidScheme {
  id: string
  code: string
  name: string
  kind: SchemeKind
  /** school = the school claims; student = the portal credits the child. */
  paid_to: 'school' | 'student'
  authority?: string
  portal_url?: string
  claim_frequency?: string
  is_active: boolean
  notes?: string
  claim_count: number
  award_count: number
}

export const SCHEME_KIND_LABEL: Record<SchemeKind, string> = {
  rte_reimbursement: 'RTE 25% quota reimbursement',
  fee_reimbursement: 'State fee reimbursement',
  nsp_scholarship: 'National Scholarship Portal',
  state_scholarship: 'State scholarship portal',
}

/** The schemes one screen cares about. `paid_to` is the whole split. */
export function useSchemes(paidTo: 'school' | 'student') {
  return useQuery({
    queryKey: [concessionsKey, 'schemes', paidTo],
    queryFn: () =>
      api.get<List<AidScheme>>(`${concessionsBase}/schemes?paid_to=${paidTo}&active=true`),
  })
}

export function useAcademicYears() {
  return useQuery({
    queryKey: ['academics', 'years'],
    queryFn: () => api.get<List<AcademicYear>>('/api/v1/academics/years'),
  })
}

// --- reimbursement claims ----------------------------------------------------

export interface ReimbursementRate {
  id: string
  scheme_id: string
  scheme_name: string
  academic_year_id: string
  academic_year: string
  from_level: number
  to_level: number
  annual_rate_paise: number
  notification_ref?: string
  notified_on?: string
  notes?: string
}

export type ClaimStatus =
  | 'draft'
  | 'submitted'
  | 'part_sanctioned'
  | 'sanctioned'
  | 'rejected'
  | 'closed'

export interface Claim {
  id: string
  scheme_id: string
  scheme_name: string
  scheme_code: string
  academic_year_id: string
  academic_year: string
  claim_no: string
  period_start: string
  period_end: string
  status: ClaimStatus
  child_count: number
  claimed_paise: number
  sanctioned_paise: number
  received_paise: number
  outstanding_paise: number
  age_days: number
  age_bucket: string
  submitted_on?: string
  submitted_ref?: string
  sanction_order_no?: string
  sanction_on?: string
  rejected_reason?: string
  notes?: string
  prepared_by?: string
}

export interface ClaimLine {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  class_level?: number
  rate_paise: number
  months: number
  claimed_paise: number
  sanctioned_paise?: number
  shortfall_paise: number
  disallowed_reason?: string
  has_concession: boolean
  notes?: string
}

export interface ClaimReceipt {
  id: string
  received_on: string
  amount_paise: number
  mode: string
  reference_no?: string
  treasury_voucher?: string
  bank_account?: string
  notes?: string
  recorded_by?: string
}

export interface ClaimDetail {
  claim: Claim
  lines: ClaimLine[]
  receipts: ClaimReceipt[]
}

export interface AgeingBucket {
  bucket: string
  claim_count: number
  child_count: number
  claimed_paise: number
  sanctioned_paise: number
  received_paise: number
  outstanding_paise: number
}

export interface ClaimAgeing {
  buckets: AgeingBucket[]
  oldest: Claim[]
  total_outstanding_paise: number
}

/* How a claim's state reads to somebody scanning a list.

   part_sanctioned is a warning rather than a success on purpose: the department
   said yes to some of the children and the rest is a shortfall somebody has to
   go and argue about. Painting it green is how it stops being argued about. */
export const CLAIM_TONE: Record<ClaimStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> =
  {
    draft: 'neutral',
    submitted: 'info',
    part_sanctioned: 'warning',
    sanctioned: 'success',
    rejected: 'danger',
    closed: 'neutral',
  }

export const CLAIM_LABEL: Record<ClaimStatus, string> = {
  draft: 'Draft',
  submitted: 'With the department',
  part_sanctioned: 'Part sanctioned',
  sanctioned: 'Sanctioned',
  rejected: 'Rejected',
  closed: 'Closed',
}

/** The buckets, oldest first, matching the order the server sends them. */
export const AGE_LABEL: Record<string, string> = {
  '365+': 'Over a year',
  '181-365': '181 to 365 days',
  '91-180': '91 to 180 days',
  '0-90': 'Up to 90 days',
}

// --- NSP scholarships --------------------------------------------------------

export type AwardStage =
  | 'applied'
  | 'school_verified'
  | 'school_rejected'
  | 'sanctioned'
  | 'credited'
  | 'not_credited'
  | 'withdrawn'

export interface ScholarshipAward {
  id: string
  scheme_id: string
  scheme_name: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  student_status: string
  academic_year_id: string
  academic_year: string
  application_ref?: string
  stage: AwardStage
  verified_at?: string
  verified_by?: string
  rejected_reason?: string
  expected_paise?: number
  sanctioned_paise?: number
  credited_paise: number
  credited_on?: string
  /** Masked by the server. The full number lives only in the bank register. */
  account_masked?: string
  has_account: boolean
  is_aadhaar_seeded: boolean
  offsets_fees: boolean
  fee_credited: boolean
  notes?: string
  /** Social category. Present only on this screen — see AWARD_EXCEPTION below. */
  category?: string
  exception?: string
}

export const AWARD_STAGE_LABEL: Record<AwardStage, string> = {
  applied: 'Applied',
  school_verified: 'Verified by the school',
  school_rejected: 'School refused to verify',
  sanctioned: 'Sanctioned',
  credited: 'Credited',
  not_credited: 'Not credited',
  withdrawn: 'Withdrawn',
}

/* The exceptions, in the order a school should work them.

   The first is the reason the screen exists: money the portal said a child
   would get, which never arrived, and which nobody is chasing because everyone
   assumes the portal has it in hand. */
export const AWARD_EXCEPTION: Record<
  string,
  { label: string; tone: 'danger' | 'warning' | 'info'; why: string }
> = {
  sanctioned_not_credited: {
    label: 'Sanctioned, not credited',
    tone: 'danger',
    why: 'The portal sanctioned this and nothing has reached the account.',
  },
  student_left: {
    label: 'Student has left',
    tone: 'danger',
    why: 'Money was credited to a child who is no longer on the roll.',
  },
  amount_differs: {
    label: 'Amount differs',
    tone: 'warning',
    why: 'The portal credited something other than the sanctioned amount.',
  },
  no_award: {
    label: 'No application on record',
    tone: 'warning',
    why: 'The file credits somebody this school has no record of applying.',
  },
  duplicate: {
    label: 'Duplicate row',
    tone: 'warning',
    why: 'The same application reference appears twice in one file.',
  },
  no_bank_account: {
    label: 'No bank account',
    tone: 'warning',
    why: 'Verified, with nowhere registered for the credit to land.',
  },
  not_aadhaar_seeded: {
    label: 'Not Aadhaar-seeded',
    tone: 'info',
    why: 'DBT will refuse an account that is not seeded.',
  },
}

export interface ScholarshipImport {
  id: string
  scheme_id: string
  scheme_name: string
  academic_year: string
  filename?: string
  source: string
  row_count: number
  matched_count: number
  unmatched_count: number
  rejected_count: number
  credited_paise: number
  imported_at: string
  imported_by?: string
}

export interface DisbursementLine {
  id: string
  line_no: number
  application_ref?: string
  student_name_given?: string
  admission_no_given?: string
  amount_paise: number
  credited_on?: string
  bank_reference?: string
  /** Four digits, as the file gave them. The server stores no more. */
  account_last4?: string
  portal_status?: string
  match_kind: string
  exception?: string
  award_id?: string
  student_name?: string
  admission_no?: string
}

export interface ImportReject {
  line: number
  reason: string
  raw: string
}

export interface ImportResult {
  import_id: string
  row_count: number
  matched_count: number
  unmatched_count: number
  rejected_count: number
  credited_paise: number
  exceptions: Record<string, number>
  rejects: ImportReject[]
}

/*
uploadDisbursements posts the portal's CSV as its own body.

	The api helper sends JSON, and the import endpoint reads the raw file so it
	can keep every line verbatim for diagnosis. The acting-institution header
	still has to travel, or a platform operator importing into a school they
	picked would post the file against no school at all — the trap banking-lib
	and ImportStudents both document.
*/
export async function uploadDisbursements(
  schemeId: string,
  academicYearId: string,
  filename: string,
  csv: string,
): Promise<ImportResult> {
  const acting = actingInstitution()
  const qs = new URLSearchParams({
    scheme_id: schemeId,
    academic_year_id: academicYearId,
    filename,
  })
  const res = await fetch(`${concessionsBase}/scholarships/imports?${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'text/csv',
      ...(acting ? { 'X-Acting-Institution': acting } : {}),
    },
    body: csv,
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw new Error(body?.error?.message ?? res.statusText)
  }
  return body as ImportResult
}

// --- education loans ---------------------------------------------------------

export interface LoanLender {
  id: string
  name: string
  lender_kind: string
  branch?: string
  contact_name?: string
  contact_phone?: string
  contact_email?: string
  is_active: boolean
  notes?: string
  open_count: number
}

export const LENDER_KIND_LABEL: Record<string, string> = {
  public_sector_bank: 'Public sector bank',
  private_bank: 'Private bank',
  nbfc: 'NBFC',
  cooperative: 'Cooperative bank',
  other: 'Other',
}

export type LoanStatus =
  | 'enquiry'
  | 'documents_pending'
  | 'submitted_to_lender'
  | 'under_review'
  | 'sanctioned'
  | 'declined'
  | 'withdrawn'
  | 'disbursed'

export interface LoanApplication {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  lender_id?: string
  lender_name?: string
  academic_year?: string
  reference_no?: string
  opened_on: string
  amount_sought_paise?: number
  status: LoanStatus
  status_changed_on: string
  sanctioned_amount_paise?: number
  disbursed_amount_paise?: number
  outcome_reported_on?: string
  declined_reason?: string
  assisted_by?: string
  notes?: string
  docs_total: number
  docs_outstanding: number
  days_in_status: number
}

export interface LoanDocument {
  id: string
  doc_kind: string
  label?: string
  status: 'required' | 'provided' | 'submitted' | 'verified' | 'waived'
  provided_on?: string
  waived_reason?: string
  notes?: string
  student_document_id?: string
  issued_certificate_id?: string
  certificate_serial?: string
  updated_by?: string
}

export interface LoanEvent {
  happened_at: string
  from_status?: string
  to_status: string
  note?: string
  actor?: string
}

export interface LoanDetail {
  application: LoanApplication
  documents: LoanDocument[]
  events: LoanEvent[]
  /** The server's own words about what the school is and is not doing. */
  disclosure: string
}

export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  enquiry: 'Enquiry',
  documents_pending: 'Papers being gathered',
  submitted_to_lender: 'With the lender',
  under_review: 'Under review',
  sanctioned: 'Sanctioned',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  disbursed: 'Disbursed',
}

export const LOAN_STATUS_TONE: Record<
  LoanStatus,
  'neutral' | 'info' | 'success' | 'warning' | 'danger'
> = {
  enquiry: 'neutral',
  documents_pending: 'warning',
  submitted_to_lender: 'info',
  under_review: 'info',
  sanctioned: 'success',
  declined: 'danger',
  withdrawn: 'neutral',
  disbursed: 'success',
}

/** Mirrors loanTransitions in internal/api/concessions.go. The server decides. */
export const LOAN_NEXT: Record<LoanStatus, LoanStatus[]> = {
  enquiry: ['documents_pending', 'withdrawn'],
  documents_pending: ['submitted_to_lender', 'withdrawn'],
  submitted_to_lender: ['under_review', 'sanctioned', 'declined', 'withdrawn'],
  under_review: ['sanctioned', 'declined', 'withdrawn'],
  sanctioned: ['disbursed', 'withdrawn'],
  declined: ['documents_pending'],
  withdrawn: ['documents_pending'],
  disbursed: [],
}

export const DOC_KIND_LABEL: Record<string, string> = {
  fee_structure: 'Fee structure',
  bonafide_certificate: 'Bonafide certificate',
  admission_letter: 'Admission letter',
  fee_receipts: 'Fee receipts paid so far',
  marksheet: 'Last marksheet',
  id_proof: 'Identity proof',
  address_proof: 'Address proof',
  income_proof: 'Income proof',
  photograph: 'Photograph',
  other: 'Other',
}

/** Which of the checklist the school itself issues, and therefore should not
    be sending a family away to find. */
export const SCHOOL_ISSUES = new Set([
  'fee_structure',
  'bonafide_certificate',
  'admission_letter',
  'fee_receipts',
])
